// Data & BI -> Enterprise Ontology -> one ontology: the workspace.
//
// Ten tabs over one model. The OWNER edits a draft that saves itself a moment
// after each change (revision-checked: a save from a stale tab is refused, not
// written over newer work) and publishes versions grantees can use. A GRANTEE
// works on the published version under their share's restrictions, shown in
// a banner, and changes it only by proposing: the same editors, on a private
// copy, sent to the owner for review.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  Cloud,
  CloudOff,
  Compass,
  Download,
  Eye,
  GitBranch,
  GitPullRequest,
  History,
  LayoutDashboard,
  ListChecks,
  Loader2,
  Network,
  PenLine,
  Shapes,
  ShieldAlert,
  Sigma,
  Upload,
  Zap,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useTokenRef } from "@/hooks/use-token-ref";
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
import { Textarea } from "@/components/ui/textarea";
import {
  OntologyContext,
  useOntology,
  type Focus,
  type OntologyCtx,
  type SaveState,
  type WorkspaceTab,
} from "@/components/ontology/OntologyContext";
import { OverviewTab } from "@/components/ontology/OverviewTab";
import { ModelTab } from "@/components/ontology/ModelTab";
import { ExploreTab } from "@/components/ontology/ExploreTab";
import { GraphTab } from "@/components/ontology/GraphTab";
import { MetricsTab } from "@/components/ontology/MetricsTab";
import { RulesTab } from "@/components/ontology/RulesTab";
import { AskTab } from "@/components/ontology/AskTab";
import { ActionsTab } from "@/components/ontology/ActionsTab";
import { HistoryTab } from "@/components/ontology/HistoryTab";
import { ExportTab } from "@/components/ontology/ExportTab";
import { ChangeList } from "@/components/ontology/ChangeList";
import {
  ontologyCompare,
  ontologyGet,
  ontologyPropose,
  ontologyPublish,
  ontologySave,
  type OntologyDetail,
} from "@/utils/ontology.functions";
import type { SpecDiff } from "@/lib/ontology/diff";
import type { OntologySpec } from "@/lib/ontology/spec";
import { validateSpec } from "@/lib/ontology/validate";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/ontology_/$ontologyId")({
  head: () => ({ meta: [{ title: "Enterprise Ontology — AgentSwarms" }] }),
  component: OntologyWorkspace,
});

const TABS: { id: WorkspaceTab; label: string; icon: typeof Shapes }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "model", label: "Model", icon: Shapes },
  { id: "explore", label: "Explore", icon: Compass },
  { id: "graph", label: "Graph", icon: Network },
  { id: "metrics", label: "Metrics", icon: Sigma },
  { id: "rules", label: "Rules", icon: ListChecks },
  { id: "ask", label: "Ask", icon: Bot },
  { id: "actions", label: "Actions", icon: Zap },
  { id: "history", label: "Versions", icon: History },
  { id: "export", label: "Export", icon: Download },
];

function OntologyWorkspace() {
  const { ontologyId } = Route.useParams();
  const { session } = useAuth();
  const { tokenRef, signedIn } = useTokenRef(session?.access_token);
  const getFn = useServerFn(ontologyGet);
  const saveFn = useServerFn(ontologySave);

  const [detail, setDetail] = useState<OntologyDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spec, setSpecState] = useState<OntologySpec | null>(null);
  const [revision, setRevision] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [focus, setFocus] = useState<Focus | null>(null);
  /** A grantee's private copy while they draft a proposal. */
  const [proposing, setProposing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<OntologySpec | null>(null);
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  const reload = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const res = await getFn({ data: { access_token: tokenRef.current, id: ontologyId } });
      if (!res.ok) {
        setLoadError(res.error);
        return;
      }
      setDetail(res.ontology);
      setSpecState(res.ontology.spec);
      setRevision(res.ontology.revision);
      setSaveState("saved");
      setProposing(false);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [getFn, ontologyId, tokenRef]);

  useEffect(() => {
    if (signedIn) void reload();
  }, [signedIn, reload]);

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState("saving");
    try {
      const res = await saveFn({
        data: {
          access_token: tokenRef.current,
          id: ontologyId,
          revision: revisionRef.current,
          spec: next,
        },
      });
      if (res.ok) {
        setRevision(res.revision);
        setDetail((d) =>
          d
            ? {
                ...d,
                revision: res.revision,
                issues: res.issues,
                unpublished_changes: true,
                name: next.name,
              }
            : d,
        );
        setSaveState(pending.current ? "dirty" : "saved");
      } else if ("conflict" in res) {
        setSaveState("conflict");
        toast.error(res.error);
      } else {
        setSaveState("error");
        toast.error(res.error);
      }
    } catch (e) {
      setSaveState("error");
      toast.error(`Not saved: ${(e as Error).message}`);
    }
  }, [saveFn, ontologyId, tokenRef]);

  const isOwner = detail?.role === "owner";
  const canEdit = isOwner || proposing;

  const setSpec = useCallback<OntologyCtx["setSpec"]>(
    (next) => {
      setSpecState((prev) => {
        if (!prev) return prev;
        const value = typeof next === "function" ? next(prev) : next;
        if (isOwner) {
          pending.current = value;
          setSaveState("dirty");
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => void flush(), 1200);
        }
        return value;
      });
    },
    [isOwner, flush],
  );

  // Save before leaving: a pending change is written when the tab is hidden.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && pending.current) void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  const issues = useMemo(() => (spec ? validateSpec(spec).issues : []), [spec]);
  const errors = issues.filter((i) => i.level === "error").length;

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-8">
        <Link
          to="/ontology"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Enterprise Ontology
        </Link>
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6">
          <p className="font-medium">This ontology could not be opened</p>
          <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
        </div>
      </div>
    );
  }
  if (!detail || !spec) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Opening the ontology…
      </div>
    );
  }

  const ctx: OntologyCtx = {
    id: ontologyId,
    detail: { ...detail, revision },
    spec,
    setSpec: canEdit
      ? isOwner
        ? setSpec
        : (n) => setSpecState((p) => (p ? (typeof n === "function" ? n(p) : n) : p))
      : () => {},
    canEdit,
    saveState,
    tokenRef,
    reload,
    go: (t, f) => {
      setTab(t);
      setFocus(f ?? null);
    },
    focus,
  };

  return (
    <OntologyContext.Provider value={ctx}>
      <div className="flex min-h-[calc(100vh-4rem)] flex-col">
        <header className="border-b border-border bg-card/60 px-4 pt-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <Link
                to="/ontology"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Enterprise Ontology
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="truncate font-display text-2xl font-semibold tracking-tight">
                  {spec.name}
                </h1>
                {detail.role === "viewer" ? (
                  <Badge variant="outline" className="gap-1">
                    <Eye className="h-3 w-3" /> v{detail.version} · shared with you
                  </Badge>
                ) : detail.published_version ? (
                  <Badge variant="outline" className="gap-1">
                    <GitBranch className="h-3 w-3" /> v{detail.published_version} published
                    {detail.unpublished_changes && " · draft has changes"}
                  </Badge>
                ) : (
                  <Badge variant="outline">Draft, not published</Badge>
                )}
                {proposing && (
                  <Badge className="gap-1">
                    <PenLine className="h-3 w-3" /> Drafting a proposal
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isOwner && <SaveIndicator state={saveState} onRetry={() => void reload()} />}
              {isOwner && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                    errors
                      ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  )}
                  title={
                    errors
                      ? "Problems stop a publish; see Model → Problems"
                      : "The model checks out"
                  }
                >
                  {errors ? (
                    <CircleAlert className="h-3.5 w-3.5" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  {errors ? `${errors} problem${errors === 1 ? "" : "s"}` : "Valid"}
                </span>
              )}
              {isOwner ? (
                <Button
                  size="sm"
                  onClick={() => setPublishOpen(true)}
                  disabled={saveState === "saving"}
                >
                  <Upload className="mr-1.5 h-4 w-4" /> Publish
                </Button>
              ) : proposing ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void reload()}>
                    Discard
                  </Button>
                  <Button size="sm" onClick={() => setProposeOpen(true)}>
                    <GitPullRequest className="mr-1.5 h-4 w-4" /> Send proposal
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setProposing(true)}>
                  <PenLine className="mr-1.5 h-4 w-4" /> Propose a change
                </Button>
              )}
            </div>
          </div>
          {detail.restrictions.length > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Your share limits what you see: {detail.restrictions.join(" · ")}. Every query here
                runs as you, with these limits and your own lakehouse access applied.
              </span>
            </div>
          )}
          {saveState === "conflict" && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
              <span>
                This ontology was saved from another tab or session. Your last change was not
                written.
              </span>
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                Reload
              </Button>
            </div>
          )}
          <nav
            className="-mb-px mt-4 flex gap-1 overflow-x-auto"
            role="tablist"
            aria-label="Ontology workspace"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setFocus(null);
                }}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab === t.id
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
                {t.id === "history" && isOwner && detail.open_proposals > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {detail.open_proposals}
                  </span>
                )}
                {t.id === "actions" && isOwner && detail.pending_actions > 0 && (
                  <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
                    {detail.pending_actions}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          {tab === "overview" && <OverviewTab />}
          {tab === "model" && <ModelTab />}
          {tab === "explore" && <ExploreTab />}
          {tab === "graph" && <GraphTab />}
          {tab === "metrics" && <MetricsTab />}
          {tab === "rules" && <RulesTab />}
          {tab === "ask" && <AskTab />}
          {tab === "actions" && <ActionsTab />}
          {tab === "history" && <HistoryTab />}
          {tab === "export" && <ExportTab />}
        </main>
      </div>
      {isOwner && (
        <PublishDialog
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          onPublished={() => void reload()}
          errors={errors}
          flush={flush}
        />
      )}
      {proposing && (
        <ProposeDialog
          open={proposeOpen}
          onClose={() => setProposeOpen(false)}
          onSent={() => void reload()}
        />
      )}
    </OntologyContext.Provider>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const map: Record<SaveState, { icon: typeof Cloud; text: string; cls: string }> = {
    saved: { icon: Cloud, text: "Saved", cls: "text-muted-foreground" },
    dirty: { icon: Cloud, text: "Unsaved changes", cls: "text-muted-foreground" },
    saving: { icon: Loader2, text: "Saving…", cls: "text-muted-foreground" },
    conflict: { icon: CloudOff, text: "Not saved: newer version exists", cls: "text-destructive" },
    error: { icon: CloudOff, text: "Not saved", cls: "text-destructive" },
  };
  const m = map[state];
  return (
    <button
      type="button"
      onClick={state === "error" || state === "conflict" ? onRetry : undefined}
      className={cn("inline-flex items-center gap-1 text-xs", m.cls)}
      aria-live="polite"
    >
      <m.icon className={cn("h-3.5 w-3.5", state === "saving" && "animate-spin")} /> {m.text}
    </button>
  );
}

function PublishDialog(props: {
  open: boolean;
  onClose: () => void;
  onPublished: () => void;
  errors: number;
  flush: () => Promise<void>;
}) {
  const { id, detail, tokenRef } = useOntology();
  const publishFn = useServerFn(ontologyPublish);
  const compareFn = useServerFn(ontologyCompare);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<SpecDiff | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setDiff(null);
    void (async () => {
      await props.flush();
      if (!detail.published_version) return;
      const res = await compareFn({
        data: { access_token: tokenRef.current, id, base: detail.published_version, target: null },
      });
      if (res.ok) setDiff(res.diff);
    })();
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = async () => {
    setBusy(true);
    try {
      await props.flush();
      const fresh = await latestRevision(id, tokenRef);
      const res = await publishFn({
        data: {
          access_token: tokenRef.current,
          id,
          revision: fresh ?? detail.revision,
          note: note.trim() || undefined,
        },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(`Published version ${res.version}`);
        setNote("");
        props.onClose();
        props.onPublished();
      }
    } catch (e) {
      reportFailure("publish", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish version {(detail.published_version ?? 0) + 1}</DialogTitle>
          <DialogDescription>
            A published version is what people you share with, agents and exports use. It never
            changes afterwards; the draft stays yours to keep editing.
          </DialogDescription>
        </DialogHeader>
        {props.errors > 0 ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            Fix {props.errors} problem{props.errors === 1 ? "" : "s"} first (Model → Problems).
          </p>
        ) : (
          <div className="space-y-3">
            {detail.published_version ? (
              diff ? (
                <ChangeList diff={diff} compact />
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Comparing with version{" "}
                  {detail.published_version}…
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                The first version: everything in the draft is published.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="publish-note">What changed, for the people who use it</Label>
              <Textarea
                id="publish-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Added Shipment and the delivered-after-shipped rule."
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={publish} disabled={busy || props.errors > 0}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The draft's current revision, read fresh: autosave may have moved it on. */
async function latestRevision(id: string, tokenRef: { current: string }): Promise<number | null> {
  try {
    const res = await ontologyGet({ data: { access_token: tokenRef.current, id } });
    return res.ok ? res.ontology.revision : null;
  } catch {
    return null;
  }
}

function ProposeDialog(props: { open: boolean; onClose: () => void; onSent: () => void }) {
  const { id, spec, tokenRef } = useOntology();
  const proposeFn = useServerFn(ontologyPropose);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const res = await proposeFn({
        data: {
          access_token: tokenRef.current,
          id,
          title: title.trim(),
          note: note.trim() || undefined,
          spec,
        },
      });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success("Proposal sent to the owner");
        props.onClose();
        props.onSent();
      }
    } catch (e) {
      reportFailure("send the proposal", e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send your proposal</DialogTitle>
          <DialogDescription>
            The owner sees exactly what you changed and decides whether to merge it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="prop-title">Title</Label>
            <Input
              id="prop-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a Returns object type"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prop-note">Why</Label>
            <Textarea
              id="prop-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!title.trim() || busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
