// An ML pipeline's file in the team's repository (R541): where it is kept,
// whether it changed here since, and the four things a person does with it —
// save it, update it from the repository, import one, and let CI deploy it.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequestArrow,
  KeyRound,
  Loader2,
  Upload,
  Workflow,
} from "lucide-react";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { relTime } from "@/components/ml/mlFormat";
import { changesLine, ciSnippets, noChanges, type DefinitionChanges } from "@/lib/workflowFile";
import {
  mlRepoFiles,
  mlRepoImport,
  mlRepoPull,
  mlRepoPullPreview,
  mlRepoSave,
  type RepoLinkView,
  type RepoSummary,
} from "@/utils/mlRepo.functions";
import { workflowRotateToken } from "@/utils/workflows.functions";

const SYNCED_BY: Record<string, string> = {
  save: "saved from here",
  pull: "updated from the repo",
  import: "imported from the repo",
  ci: "deployed by CI",
};

const providerName = (r: RepoSummary) => (r.provider === "github" ? "GitHub" : "GitLab");

/** Above the list: which repository, and Import; or how to connect one. */
export function RepoBar({
  repo,
  token,
  onChanged,
}: {
  repo: RepoSummary | null;
  token: string;
  onChanged: () => void;
}) {
  const [importing, setImporting] = useState(false);
  if (!repo) {
    return (
      // One run of text, not a flex row: as flex items the sentence, its link
      // and its full stop became three columns (FOUND FROM THE UI, R541).
      <p className="text-xs text-muted-foreground">
        <GitBranch className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
        Keep these pipelines as files in your GitHub or GitLab repository, reviewed in pull requests
        and deployed by CI: connect it under{" "}
        <Link to="/integrations" search={{ tab: "git" }} className="text-primary hover:underline">
          Integrations → Git repository
        </Link>
        .
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {providerName(repo)} <span className="font-mono text-foreground">{repo.repo}</span> ·{" "}
          <span className="font-mono">{repo.branch}</span> · files in{" "}
          <span className="font-mono">{repo.folder}/ml/pipelines</span>
        </span>
        {!repo.hasToken ? (
          <Badge variant="destructive" className="shrink-0">
            No token
          </Badge>
        ) : null}
      </p>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" asChild>
          <Link to="/integrations" search={{ tab: "git" }}>
            Settings
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
          <Download className="mr-1.5 h-3.5 w-3.5" /> Import from repo
        </Button>
      </div>
      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        token={token}
        onImported={onChanged}
      />
    </div>
  );
}

/** Under a pipeline's name: its file, and whether it changed here since. */
export function RepoLine({ link }: { link: RepoLinkView | undefined }) {
  if (!link) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <FileCode2 className="h-3.5 w-3.5" />
      {link.url ? (
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-mono hover:underline"
        >
          {link.path}
        </a>
      ) : (
        <span className="font-mono">{link.path}</span>
      )}
      <span>
        · {SYNCED_BY[link.syncedBy] ?? "synced"} {relTime(link.syncedAt)}
        {link.commit ? (
          <>
            {" "}
            at <span className="font-mono">{link.commit.slice(0, 7)}</span>
          </>
        ) : null}
      </span>
      {link.changedHere ? (
        <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
          Changed here since
        </Badge>
      ) : null}
    </p>
  );
}

type Pipeline = { id: string; name: string; has_trigger_token: boolean };

/** A pipeline's Repository menu and the dialogs it opens. */
export function PipelineRepoMenu({
  pipeline,
  repo,
  link,
  token,
  onChanged,
}: {
  pipeline: Pipeline;
  repo: RepoSummary | null;
  link: RepoLinkView | undefined;
  token: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<"save" | "pull" | "ci" | null>(null);
  if (!repo) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" aria-label={`Repository for ${pipeline.name}`}>
            <GitBranch className="mr-1.5 h-3.5 w-3.5" /> Repository
            <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onSelect={() => setOpen("save")}>
            <Upload className="mr-2 h-4 w-4" /> Save to repo…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!link} onSelect={() => setOpen("pull")}>
            <GitPullRequestArrow className="mr-2 h-4 w-4" /> Update from repo…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!link} onSelect={() => setOpen("ci")}>
            <Workflow className="mr-2 h-4 w-4" /> Deploy from CI…
          </DropdownMenuItem>
          {link ? (
            link.url ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={link.url} target="_blank" rel="noreferrer noopener">
                    <ExternalLink className="mr-2 h-4 w-4" /> Open the file on {providerName(repo)}
                  </a>
                </DropdownMenuItem>
              </>
            ) : null
          ) : (
            <p className="px-2 pb-1.5 pt-1 text-[11px] text-muted-foreground">
              Save it once to keep it in the repository; then it can be updated from there and
              deployed by CI.
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SaveDialog
        open={open === "save"}
        onOpenChange={(o) => setOpen(o ? "save" : null)}
        pipeline={pipeline}
        repo={repo}
        link={link}
        token={token}
        onSaved={onChanged}
      />
      {link ? (
        <>
          <PullDialog
            open={open === "pull"}
            onOpenChange={(o) => setOpen(o ? "pull" : null)}
            pipeline={pipeline}
            link={link}
            token={token}
            onPulled={onChanged}
          />
          <CiDialog
            open={open === "ci"}
            onOpenChange={(o) => setOpen(o ? "ci" : null)}
            pipeline={pipeline}
            repo={repo}
            link={link}
            token={token}
          />
        </>
      ) : null}
    </>
  );
}

function SaveDialog({
  open,
  onOpenChange,
  pipeline,
  repo,
  link,
  token,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pipeline: Pipeline;
  repo: RepoSummary;
  link: RepoLinkView | undefined;
  token: string;
  onSaved: () => void;
}) {
  const save = useServerFn(mlRepoSave);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setMessage(`Update ML pipeline "${pipeline.name}"`);
  }, [open, pipeline.name]);

  async function submit() {
    setBusy(true);
    try {
      const r = await save({
        data: { accessToken: token, workflowId: pipeline.id, message: message.trim() || undefined },
      });
      if (!r.ok) throw new Error(r.error);
      toast.success(`Saved ${r.path} (${r.files} file${r.files === 1 ? "" : "s"})`, {
        action: { label: "View commit", onClick: () => window.open(r.commitUrl, "_blank") },
      });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save to repo</DialogTitle>
          <DialogDescription>
            Commits this pipeline to <span className="font-mono">{repo.branch}</span> of{" "}
            <span className="font-mono">{repo.repo}</span>
            {link ? (
              <>
                {" "}
                as <span className="font-mono">{link.path}</span>
              </>
            ) : (
              <>
                {" "}
                as a new file in <span className="font-mono">{repo.folder}/ml/pipelines</span>
              </>
            )}
            , with the configuration of each model it trains or scores. Definitions only: no data,
            no keys, and approvers are counted, never named.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="repo-message" className="text-xs">
            Commit message
          </Label>
          <Input
            id="repo-message"
            value={message}
            maxLength={500}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Save to repo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeList({ changes }: { changes: DefinitionChanges }) {
  const rows: [string, string[]][] = [
    ["Added", changes.added],
    ["Removed", changes.removed],
    ["Changed", changes.changed],
    ["Settings", changes.settings],
  ];
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows
        .filter(([, v]) => v.length)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v.join(", ")}</dd>
          </div>
        ))}
      {changes.arrows ? (
        <div className="contents">
          <dt className="text-muted-foreground">Arrows</dt>
          <dd>{changes.arrows} added or removed</dd>
        </div>
      ) : null}
    </dl>
  );
}

function PullDialog({
  open,
  onOpenChange,
  pipeline,
  link,
  token,
  onPulled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pipeline: Pipeline;
  link: RepoLinkView;
  token: string;
  onPulled: () => void;
}) {
  const preview = useServerFn(mlRepoPullPreview);
  const pull = useServerFn(mlRepoPull);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; error: string }
    | { kind: "ready"; commit: string; changes: DefinitionChanges; renamed: number }
  >({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ kind: "loading" });
    preview({ data: { accessToken: token, workflowId: pipeline.id } })
      .then((r) => {
        if (!live) return;
        setState(
          r.ok
            ? { kind: "ready", commit: r.commit, changes: r.changes, renamed: r.renamed }
            : { kind: "error", error: r.error },
        );
      })
      .catch((e) => live && setState({ kind: "error", error: (e as Error).message }));
    return () => {
      live = false;
    };
    // The preview is read when the dialog opens, not on a session refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pipeline.id, preview]);

  async function apply() {
    if (state.kind !== "ready") return;
    setBusy(true);
    try {
      const r = await pull({
        data: { accessToken: token, workflowId: pipeline.id, commit: state.commit },
      });
      if (!r.ok) throw new Error(r.error);
      toast.success(
        `${pipeline.name} updated from ${r.commit.slice(0, 7)}: ${changesLine(r.changes)}`,
      );
      onOpenChange(false);
      onPulled();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const same = state.kind === "ready" && noChanges(state.changes);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update from repo</DialogTitle>
          <DialogDescription>
            Makes <span className="font-mono">{link.path}</span> at the head of the branch this
            pipeline&apos;s definition. It is checked exactly like a save from the editor.
            {link.changedHere ? " Edits made here since the last save are replaced." : ""}
          </DialogDescription>
        </DialogHeader>
        {state.kind === "loading" ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : state.kind === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              At commit <span className="font-mono">{state.commit.slice(0, 7)}</span>
              {state.renamed
                ? ` · ${state.renamed} step${state.renamed === 1 ? "" : "s"} matched to yours by name`
                : ""}
            </p>
            {same ? (
              <p className="text-sm">The pipeline here already matches the repository.</p>
            ) : (
              <ChangeList changes={state.changes} />
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void apply()} disabled={busy || state.kind !== "ready" || same}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  token,
  onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  token: string;
  onImported: () => void;
}) {
  const list = useServerFn(mlRepoFiles);
  const doImport = useServerFn(mlRepoImport);
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; error: string }
    | { kind: "ready"; commit: string; folder: string; files: { path: string; name: string }[] }
  >({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ kind: "loading" });
    list({ data: { accessToken: token } })
      .then((r) => {
        if (!live) return;
        setState(
          r.ok
            ? { kind: "ready", commit: r.commit, folder: r.folder, files: r.files }
            : { kind: "error", error: r.error },
        );
      })
      .catch((e) => live && setState({ kind: "error", error: (e as Error).message }));
    return () => {
      live = false;
    };
    // Read when the dialog opens, not on a session refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, list]);

  async function importFile(path: string) {
    if (state.kind !== "ready") return;
    setBusy(path);
    try {
      const r = await doImport({ data: { accessToken: token, path, commit: state.commit } });
      if (!r.ok) throw new Error(r.error);
      toast.success(`Imported "${r.name}", paused: check it, then switch it on`, {
        action: {
          label: "Open",
          onClick: () => void navigate({ to: "/workflows", search: { open: r.id } }),
        },
      });
      onOpenChange(false);
      onImported();
    } catch (e) {
      toast.error((e as Error).message);
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
            Pipeline files in the repository that none of your pipelines is kept in yet. An imported
            pipeline arrives paused, and each step is matched to your own models, schedules and
            connections — by id, or by the name the file gives.
          </DialogDescription>
        </DialogHeader>
        {state.kind === "loading" ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : state.kind === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : state.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other pipeline files in <span className="font-mono">{state.folder}</span> at{" "}
            <span className="font-mono">{state.commit.slice(0, 7)}</span>.
          </p>
        ) : (
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {state.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate font-mono text-xs" title={f.path}>
                  {f.path}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void importFile(f.path)}
                  aria-label={`Import ${f.name}`}
                >
                  {busy === f.path ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Import"}
                </Button>
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

function CiDialog({
  open,
  onOpenChange,
  pipeline,
  repo,
  link,
  token,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pipeline: Pipeline;
  repo: RepoSummary;
  link: RepoLinkView;
  token: string;
}) {
  const rotate = useServerFn(workflowRotateToken);
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setMinted(null);
  }, [open]);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const snippets = ciSnippets({
    origin,
    workflowId: pipeline.id,
    path: link.path,
    branch: repo.branch,
  });

  async function createToken() {
    setBusy(true);
    try {
      const r = await rotate({ data: { accessToken: token, id: pipeline.id } });
      if (!r.ok) throw new Error(r.error);
      setMinted(r.token);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy from CI</DialogTitle>
          <DialogDescription>
            When a change to <span className="font-mono">{link.path}</span> reaches{" "}
            <span className="font-mono">{repo.branch}</span>, your CI updates this pipeline from
            that commit and runs it. Only commits on {repo.branch} are deployed, and each is checked
            like a save from the editor.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-4 text-sm">
          <li className="space-y-2">
            <p>
              <span className="font-medium">1. A trigger token for this pipeline.</span>{" "}
              <span className="text-muted-foreground">
                Store it in your CI as the secret{" "}
                <code className="font-mono text-xs">AGENTSWARMS_TRIGGER_TOKEN</code>. It is shown
                once.
              </span>
            </p>
            {minted ? (
              <Textarea
                readOnly
                rows={2}
                aria-label="Trigger token"
                className="font-mono text-[11px]"
                value={minted}
                onFocus={(e) => e.currentTarget.select()}
              />
            ) : pipeline.has_trigger_token ? (
              <p className="text-xs text-muted-foreground">
                This pipeline already has one. If you no longer have it, rotate it in the
                pipeline&apos;s{" "}
                <Link
                  to="/workflows"
                  search={{ open: pipeline.id }}
                  className="text-primary hover:underline"
                >
                  settings
                </Link>{" "}
                (the old one stops working).
              </p>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void createToken()}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                )}
                Create token
              </Button>
            )}
          </li>
          <li className="space-y-2">
            <p className="font-medium">2. Add the job to your repository.</p>
            <Tabs defaultValue={repo.provider}>
              <TabsList>
                <TabsTrigger value="github">GitHub Actions</TabsTrigger>
                <TabsTrigger value="gitlab">GitLab CI</TabsTrigger>
              </TabsList>
              {(["github", "gitlab"] as const).map((k) => (
                <TabsContent key={k} value={k} className="space-y-2">
                  <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                    {snippets[k]}
                  </pre>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(snippets[k])
                        .then(() => toast.success("Copied"))
                        .catch(() => toast.error("Could not copy; select the text instead"))
                    }
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
                  </Button>
                </TabsContent>
              ))}
            </Tabs>
          </li>
          <li className="text-xs text-muted-foreground">
            The job sends <code className="font-mono">sync: true</code> with the commit. Add{" "}
            <code className="font-mono">&quot;run&quot;: false</code> to deploy without running. A
            promotion to production in the pipeline still waits for its approvers.
          </li>
        </ol>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
