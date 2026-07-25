// Git-based versioning UI: configure a GitHub/GitLab repo and export BI
// dashboards + semantic models as sanitized JSON in one commit. Admin-gated by
// the caller. The access token is write-only — it is stored encrypted and never
// read back to the client (we only show whether one is set).
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { GitBranch, Loader2, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { gitExportNow, gitGetConfig, gitSaveConfig } from "@/utils/gitExport.functions";

export function BiGitSyncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const getConfig = useServerFn(gitGetConfig);
  const saveConfig = useServerFn(gitSaveConfig);
  const exportNow = useServerFn(gitExportNow);

  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [basePath, setBasePath] = useState("agentswarms");
  const [host, setHost] = useState("");
  const [pat, setPat] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [last, setLast] = useState<{
    at: string | null;
    status: string | null;
    error: string | null;
  }>({
    at: null,
    status: null,
    error: null,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open || !token) return;
    setLoading(true);
    getConfig({ data: { access_token: token } })
      .then((res) => {
        if (res.ok && res.config) {
          const c = res.config;
          setProvider(c.provider === "gitlab" ? "gitlab" : "github");
          setRepo(c.repo);
          setBranch(c.branch);
          setBasePath(c.base_path);
          setHost(c.host ?? "");
          setHasToken(c.has_token);
          setLast({ at: c.last_export_at, status: c.last_status, error: c.last_error });
        }
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [open, token, getConfig]);

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await saveConfig({
        data: {
          access_token: token,
          provider,
          repo: repo.trim(),
          branch: branch.trim(),
          base_path: basePath.trim() || "agentswarms",
          host: provider === "gitlab" ? host.trim() || undefined : undefined,
          // Only send the token when the user typed one (keeps the stored one otherwise).
          token: pat ? pat : undefined,
        },
      });
      if (!res.ok) throw new Error(res.error);
      if (pat) {
        setHasToken(true);
        setPat("");
      }
      toast.success("Git settings saved");
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function runExport() {
    // Persist any edits first so the export uses the latest settings.
    if (!(await save())) return;
    setExporting(true);
    try {
      const res = await exportNow({ data: { access_token: token } });
      if (!res.ok) throw new Error(res.error);
      setLast({ at: new Date().toISOString(), status: "ok", error: null });
      toast.success(`Exported ${res.files} file(s) to ${provider}`, {
        action: { label: "View commit", onClick: () => window.open(res.commit_url, "_blank") },
      });
    } catch (e) {
      setLast({ at: new Date().toISOString(), status: "error", error: (e as Error).message });
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const canSave = repo.trim() !== "" && branch.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" /> Version control (Git)
          </DialogTitle>
          <DialogDescription>
            Export your BI dashboards and semantic models as JSON to a Git repo in one commit. Data
            snapshots are stripped — definitions only. The token is stored encrypted.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <Label className="text-xs">Provider</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => setProvider(v as "github" | "gitlab")}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Branch</Label>
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {provider === "github"
                  ? "Repository (owner/name)"
                  : "Project (group/project or id)"}
              </Label>
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="h-9 font-mono text-xs"
                placeholder={provider === "github" ? "acme/analytics" : "acme/analytics"}
              />
            </div>
            {provider === "gitlab" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Host (self-hosted, optional)</Label>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  className="h-9 font-mono text-xs"
                  placeholder="https://gitlab.example.com"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Folder in repo</Label>
              <Input
                value={basePath}
                onChange={(e) => setBasePath(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Access token {hasToken && <span className="text-emerald-600">· stored</span>}
              </Label>
              <Input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                className="h-9 text-sm"
                placeholder={
                  hasToken ? "•••••••• (leave blank to keep)" : "Personal access token (repo write)"
                }
              />
            </div>
            {last.at && (
              <p className="text-[11px] text-muted-foreground">
                Last export: {last.status === "ok" ? "succeeded" : `failed — ${last.error}`}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="outline" onClick={() => void save()} disabled={!canSave || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          <Button
            onClick={() => void runExport()}
            disabled={!canSave || exporting || saving}
            className="gap-1.5"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            Export now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
