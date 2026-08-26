// Reusable picker for the Model Registry. Used in AgentForm and anywhere
// else a user needs to pick a real, currently-shipping model id without
// memorising the exact slug. Pulls live data via getModelRegistry.
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Search, Boxes, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { getModelRegistry, type RegistryModel } from "@/utils/modelRegistry.functions";
import { isProviderSupported, isModelSupported } from "@/lib/providerSupport";
import { modelMatchesAnyRule, useMyModelRules } from "@/hooks/use-iam";
import { useAuth } from "@/hooks/use-auth";
import { clickable } from "@/lib/clickable";

type Props = {
  trigger: React.ReactNode;
  defaultModality?: string;
  onPick: (modelId: string) => void;
};

export function ModelRegistryPicker({ trigger, defaultModality = "text", onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [modality, setModality] = useState(defaultModality);
  const [provider, setProvider] = useState<string>("all");

  // The registry read runs AS the caller: the server fn validates an
  // { access_token } object and uses it to resolve the user before querying.
  // Calling it with no argument fails that validation before any query runs,
  // which surfaced here as a "Failed to load registry: ... expected object,
  // received undefined" toast rather than an empty list.
  const { session } = useAuth();
  const accessToken = session?.access_token;

  useEffect(() => {
    if (!open || models.length > 0 || !accessToken) return;
    setLoading(true);
    getModelRegistry({ data: { access_token: accessToken } })
      .then((res) => setModels(res.models))
      .catch((e) => toast.error(`Failed to load registry: ${(e as Error).message}`))
      .finally(() => setLoading(false));
  }, [open, models.length, accessToken]);

  const providers = useMemo(() => {
    const map = new Map<string, { slug: string; label: string; count: number }>();
    for (const m of models) {
      if (modality !== "all" && m.modality !== modality) continue;
      const cur = map.get(m.provider_slug);
      if (cur) cur.count += 1;
      else map.set(m.provider_slug, { slug: m.provider_slug, label: m.developer, count: 1 });
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [models, modality]);

  // IAM model governance: when rules apply to this user, hide models their
  // administrator hasn't allowed.
  const myRules = useMyModelRules();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models
      .filter((m) => {
        if (modality !== "all" && m.modality !== modality) return false;
        if (provider !== "all" && m.provider_slug !== provider) return false;
        if (!modelMatchesAnyRule(myRules, m.model_id)) return false;
        if (q) {
          const hay = `${m.display_name} ${m.model_id} ${m.developer}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .slice(0, 300);
  }, [models, search, modality, provider, myRules]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-primary" /> Browse Model Registry
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search by name, id, or developer"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {["text", "image", "video", "embedding", "speech-to-text", "text-to-speech", "all"].map(
              (m) => (
                <Badge
                  key={m}
                  variant={modality === m ? "default" : "outline"}
                  className="cursor-pointer capitalize"
                  onClick={() => {
                    setModality(m);
                    setProvider("all");
                  }}
                >
                  {m.replace("-", " ")}
                </Badge>
              ),
            )}
          </div>
          {providers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant={provider === "all" ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setProvider("all")}
              >
                All providers
              </Badge>
              {providers.slice(0, 12).map((p) => (
                <Badge
                  key={p.slug}
                  variant={provider === p.slug ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => setProvider(p.slug)}
                >
                  {p.label} ({p.count})
                </Badge>
              ))}
            </div>
          )}
        </div>

        <ScrollArea className="h-[50vh] pr-2 mt-2">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground p-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">
              No models match. Sync may still be pending — try the Model Registry page.
            </p>
          ) : (
            <ul className="divide-y border rounded-md">
              {filtered.map((m) => (
                <li
                  key={m.id}
                  className="p-3 hover:bg-muted/40 cursor-pointer flex items-start justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  {...clickable(() => {
                    onPick(m.model_id);
                    setOpen(false);
                    toast.success(`Selected ${m.display_name}`);
                  }, `Select model ${m.display_name}`)}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{m.display_name}</div>
                    <div className="text-xs text-muted-foreground truncate">{m.developer}</div>
                    <div className="font-mono text-[11px] mt-1 truncate">{m.model_id}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant="outline" className="text-[10px] capitalize">
                      {m.modality.replace("-", " ")}
                    </Badge>
                    {isModelSupported(m.provider_slug, m.modality) ? (
                      <Badge className="text-[10px] gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20">
                        <CheckCircle2 className="h-3 w-3" /> Available
                      </Badge>
                    ) : isProviderSupported(m.provider_slug) ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] gap-1 text-amber-700 dark:text-amber-400 border-amber-500/40 border-dashed"
                      >
                        <XCircle className="h-3 w-3" /> {m.modality.replace("-", " ")} N/A
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[10px] gap-1 text-muted-foreground border-dashed"
                      >
                        <XCircle className="h-3 w-3" /> Unsupported
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>

        <div className="text-xs text-muted-foreground pt-2">
          Showing {filtered.length} of {models.length} models · Click a row to use its id.
        </div>
      </DialogContent>
    </Dialog>
  );
}
