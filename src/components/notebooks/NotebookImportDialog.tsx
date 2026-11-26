// Import a notebook from the team's repository (R543): a percent-format .py
// or a Jupyter .ipynb, from the notebooks folder or any folder named. The new
// notebook stays linked to its file, so its commits go back there and changes
// made there come in with Update from repo.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { FileCode2, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { reportFailure } from "@/lib/silentFailureNet";
import { nbGitImport, nbGitRepoFiles, type NbRepoFile } from "@/utils/notebookGit.functions";

export function NotebookImportDialog({
  open,
  onOpenChange,
  token,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string;
}) {
  const list = useServerFn(nbGitRepoFiles);
  const doImport = useServerFn(nbGitImport);
  const navigate = useNavigate();
  const [folder, setFolder] = useState("");
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; error: string }
    | { kind: "ready"; commit: string; folder: string; files: NbRepoFile[] }
  >({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  async function load(which?: string) {
    setState({ kind: "loading" });
    try {
      const res = await list({ data: { access_token: token, folder: which || undefined } });
      if (!res.ok) return setState({ kind: "error", error: res.error });
      setState({ kind: "ready", commit: res.commit, folder: res.folder, files: res.files });
      setFolder(res.folder);
    } catch (e) {
      setState({ kind: "error", error: (e as Error).message });
    }
  }

  useEffect(() => {
    if (open) void load();
    // Read when the dialog opens, not on a session refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function importFile(f: NbRepoFile) {
    if (state.kind !== "ready") return;
    setBusy(f.path);
    try {
      const res = await doImport({
        data: { access_token: token, path: f.path, commit: state.commit },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Imported ${f.name}: ${res.cells} cell${res.cells === 1 ? "" : "s"}`);
      onOpenChange(false);
      void navigate({
        to: "/notebooks/py/$pyNotebookId",
        params: { pyNotebookId: res.notebook_id },
      });
    } catch (e) {
      reportFailure(`import ${f.name}`, e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from repo</DialogTitle>
          <DialogDescription>
            Notebooks in your repository, as .py files with <code>#&nbsp;%%</code> cells or as
            Jupyter .ipynb. An imported notebook stays linked to its file: commits go back to it, in
            its own format, and changes made there come in with Update from repo.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void load(folder);
          }}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="nb-import-folder" className="text-xs">
              Folder
            </Label>
            <Input
              id="nb-import-folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="h-8 font-mono text-xs"
              placeholder="agentswarms/notebooks"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" className="h-8">
            Look
          </Button>
        </form>

        {state.kind === "loading" ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : state.kind === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
            {/Connect a Git repository|access token/i.test(state.error) ? (
              // FOUND FROM THE UI (R543): the sentence and the link ran
              // together as "…first Integrations → Git repository".
              <>
                , under{" "}
                <Link to="/integrations" search={{ tab: "git" }} className="underline">
                  Integrations → Git repository
                </Link>
                .
              </>
            ) : null}
          </p>
        ) : state.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No .py or .ipynb files in <span className="font-mono">{state.folder}</span> at{" "}
            <span className="font-mono">{state.commit.slice(0, 7)}</span>.
          </p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {state.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs" title={f.path}>
                    {f.name}
                  </span>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {f.format === "ipynb" ? "Jupyter" : "Python"}
                  </Badge>
                </span>
                {f.notebookId ? (
                  <Button size="sm" variant="ghost" asChild>
                    <Link to="/notebooks/py/$pyNotebookId" params={{ pyNotebookId: f.notebookId }}>
                      Open yours
                    </Link>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void importFile(f)}
                    aria-label={`Import ${f.name}`}
                  >
                    {busy === f.path ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Import"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
