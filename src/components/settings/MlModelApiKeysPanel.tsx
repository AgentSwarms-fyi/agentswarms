// ML Model API Keys — picks a published model, then opens the exact same
// key-management dialog /ml/$modelId uses. Keys are inherently per-model (a
// key scopes predict/train/read against one model's endpoint), so unlike the
// other panels there's no single flat list — picking the model IS the first
// step of managing its keys, not a detour to another page.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Boxes, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { listClaim } from "@/lib/listClaim";
import { mlListModels, type MlModelSummary } from "@/utils/ml.functions";
import { MlApiKeysDialog } from "@/components/ml/MlApiKeysDialog";

export function MlModelApiKeysPanel() {
  const { session } = useAuth();
  const token = session?.access_token;
  const listFn = useServerFn(mlListModels);

  const [models, setModels] = useState<MlModelSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keysFor, setKeysFor] = useState<MlModelSummary | null>(null);

  const reload = useCallback(() => {
    if (!token) return;
    setLoadError(null);
    listFn({ data: { access_token: token } })
      .then((res) => setModels(res.models))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "Could not reach the server";
        setLoadError(msg);
        setModels([]);
      });
  }, [token, listFn]);

  useEffect(() => {
    reload();
  }, [reload]);

  const claim = listClaim({
    loaded: models !== null,
    error: loadError,
    count: models?.length ?? 0,
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each key scopes predict / train / read against one specific model's serving endpoint — pick
        a model to mint or revoke its keys.
      </p>
      {models === null && !loadError ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : claim.message === "error" ? (
        <div role="alert" className="py-6 text-center text-sm">
          <p className="text-warning">Your models could not be loaded — {loadError}.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => reload()}>
            Try again
          </Button>
        </div>
      ) : models!.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
          No models yet — publish one from the ML Models page first.
        </p>
      ) : (
        <div className="space-y-2">
          {models!.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Boxes className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{m.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{m.task}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {m.production ? "Published" : "Draft"}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => setKeysFor(m)}
                >
                  <KeyRound className="h-3 w-3" /> Manage keys
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {keysFor && token && (
        <MlApiKeysDialog
          open={!!keysFor}
          onOpenChange={(v) => !v && setKeysFor(null)}
          modelId={keysFor.id}
          token={token}
          // The curl example only needs to look like a feature row — the real
          // schema isn't loaded here, so an empty one keeps the snippet honest
          // (obviously a placeholder) rather than guessing field names.
          exampleRow={{}}
        />
      )}
    </div>
  );
}
