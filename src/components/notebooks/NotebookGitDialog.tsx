// Git versioning for a notebook: commit it, see its history, restore an
// earlier commit.
//
// The repository is the same per-user connection BI uses, so it can be set up
// from either place — there is one repo, not one per feature.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, GitBranch, History, Loader2, RotateCcw, UploadCloud } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gitSaveConfig } from "@/utils/gitExport.functions";
import {
  nbGitCommit,
  nbGitHistory,
  nbGitRestore,
  type NbGitVersion,
} from "@/utils/notebookGit.functions";

export function NotebookGitDialog({
  open,
  onOpenChange,
  notebookId,
  token,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  notebookId: string;
  token: string;
  /** Reload the editor — the cells on screen are no longer what's stored. */
  onRestored: () => void;
}) {
  const historyFn = useServerFn(nbGitHistory);
  const commitFn = useServerFn(nbGitCommit);
  const restoreFn = useServerFn(nbGitRestore);
  const saveConfigFn = useServerFn(gitSaveConfig);

  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [versions, setVersions] = useState<NbGitVersion[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // Connection form, shown only when there is no repo yet.
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [newRepo, setNewRepo] = useState("");
  const [newBranch, setNewBranch] = useState("main");
  const [pat, setPat] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    historyFn({ data: { access_token: token, notebook_id: notebookId } })
      .then((res) => {
        if (!res.ok) return toast.error(res.error);
        setConnected(res.connected);
        setRepo(res.repo);
        setBranch(res.branch);
        setVersions(res.versions);
        setDirty(res.dirty);
      })
      .finally(() => setLoading(false));
  }, [historyFn, notebookId, token]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function connect() {
    if (!newRepo.trim() || !pat) return toast.error("Repository and access token are required");
    setBusy(true);
    try {
      const res = await saveConfigFn({
        data: {
          access_token: token,
          provider,
          repo: newRepo.trim(),
          branch: newBranch.trim() || "main",
          token: pat,
        },
      });
      if (!res.ok) return toast.error(res.error);
      setPat("");
      toast.success("Repository connected");
      load();
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    try {
      const res = await commitFn({
        data: {
          access_token: token,
          notebook_id: notebookId,
          message: message.trim() || undefined,
        },
      });
      if (!res.ok) return toast.error(res.error);
      setMessage("");
      toast.success("Committed", {
        action: { label: "View", onClick: () => window.open(res.commit_url, "_blank") },
      });
      load();
    } finally {
      setBusy(false);
    }
  }

  async function restore(v: NbGitVersion) {
    if (
      !window.confirm(
        `Replace this notebook's cells with the version committed in ${v.commit_sha.slice(0, 7)}?\n\nAnything not committed will be lost.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await restoreFn({
        data: { access_token: token, notebook_id: notebookId, version_id: v.id },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Restored ${res.cells} cell${res.cells === 1 ? "" : "s"}`);
      onRestored();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" /> Version control (Git)
          </DialogTitle>
          <DialogDescription>
            Commit this notebook to your repository as a plain Python file, so its history lives
            alongside the rest of your code and every change is reviewable.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !connected ? (
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <p className="text-xs text-muted-foreground">
              Connect a repository first. This is the same connection used for BI dashboards and
              semantic models — setting it here sets it everywhere.
            </p>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Provider</Label>
                <Select value={provider} onValueChange={(v) => setProvider(v as typeof provider)}>
                  <SelectTrigger className="h-8 text-sm">
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
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  className="h-8 text-sm"
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
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                className="h-8 font-mono text-xs"
                placeholder="acme/analytics"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Access token (repo write)</Label>
              <Input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                className="h-8 text-sm"
                placeholder="Stored encrypted, never shown again"
              />
            </div>
            <Button size="sm" onClick={connect} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-mono">
                {repo}
                {branch ? ` · ${branch}` : ""}
              </span>
              {dirty ? (
                <Badge variant="secondary" className="text-[10px]">
                  Uncommitted changes
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  Up to date
                </Badge>
              )}
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label className="text-xs">Commit message (optional)</Label>
                <Input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="h-8 text-sm"
                  placeholder="Describe what changed"
                />
              </div>
              <Button size="sm" onClick={commit} disabled={busy} className="h-8 gap-1.5">
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="h-3.5 w-3.5" />
                )}
                Commit
              </Button>
            </div>

            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <History className="h-3.5 w-3.5" /> History
              </p>
              {versions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No commits yet — the first one creates the file in the repo.
                </p>
              ) : (
                <ul className="max-h-64 divide-y divide-border/50 overflow-y-auto rounded-lg border border-border/60">
                  {versions.map((v) => (
                    <li key={v.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground">{v.message}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          <span className="font-mono">{v.commit_sha.slice(0, 7)}</span> ·{" "}
                          {new Date(v.created_at).toLocaleString()}
                        </p>
                      </div>
                      {v.commit_url && (
                        <a
                          href={v.commit_url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          title="View commit"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 gap-1 text-xs"
                        disabled={busy}
                        onClick={() => restore(v)}
                      >
                        <RotateCcw className="h-3 w-3" /> Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
