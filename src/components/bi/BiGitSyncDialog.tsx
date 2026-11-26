// Git-based versioning UI: configure a GitHub/GitLab repo and export BI
// dashboards + semantic models as sanitized JSON in one commit. Admin-gated by
// the caller. The settings are the one repository connection, also under
// Integrations → Git repository (R541); the form is shared with that tab.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
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
import { useAuth } from "@/hooks/use-auth";
import { useGitRepositorySettings } from "@/components/git/GitRepositoryFields";
import { gitExportNow } from "@/utils/gitExport.functions";

export function BiGitSyncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const exportNow = useServerFn(gitExportNow);
  const git = useGitRepositorySettings(token, open);
  const { last, setLast } = git;
  const [exporting, setExporting] = useState(false);

  async function runExport() {
    // Persist any edits first so the export uses the latest settings.
    if (!(await git.save())) return;
    setExporting(true);
    try {
      const res = await exportNow({ data: { access_token: token } });
      if (!res.ok) throw new Error(res.error);
      setLast({ at: new Date().toISOString(), status: "ok", error: null });
      toast.success(`Exported ${res.files} file(s) to ${git.provider}`, {
        action: { label: "View commit", onClick: () => window.open(res.commit_url, "_blank") },
      });
    } catch (e) {
      setLast({ at: new Date().toISOString(), status: "error", error: (e as Error).message });
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" /> Version control (Git)
          </DialogTitle>
          <DialogDescription>
            Export your BI dashboards and semantic models as JSON to a Git repo in one commit. Data
            snapshots are stripped — definitions only. The same repository holds ML pipelines;{" "}
            <Link to="/integrations" search={{ tab: "git" }} className="underline">
              Integrations → Git repository
            </Link>{" "}
            shows everything in it.
          </DialogDescription>
        </DialogHeader>

        {git.loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {git.fields}
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
          <Button
            variant="outline"
            onClick={() => void git.save()}
            disabled={!git.canSave || git.saving}
          >
            {git.saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          <Button
            onClick={() => void runExport()}
            disabled={!git.canSave || exporting || git.saving}
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
