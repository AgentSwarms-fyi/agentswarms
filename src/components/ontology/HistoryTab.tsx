// Versions and proposals. Every publish is a version you can read, compare
// with the draft and restore; every proposal shows exactly what it would
// change, breaking changes first, before the owner merges or rejects it.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  Check,
  GitBranch,
  GitCompare,
  GitPullRequest,
  Loader2,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { ChangeList } from "@/components/ontology/ChangeList";
import { useOntology } from "@/components/ontology/OntologyContext";
import { relativeTime } from "@/components/ontology/theme";
import {
  ontologyCompare,
  ontologyDecideProposal,
  ontologyProposals,
  ontologyRestore,
  ontologyVersionGet,
  ontologyVersions,
  type OntologyVersionRow,
  type ProposalRow,
} from "@/utils/ontology.functions";
import type { SpecDiff } from "@/lib/ontology/diff";
import { cn } from "@/lib/utils";

export function HistoryTab() {
  const o = useOntology();
  const versionsFn = useServerFn(ontologyVersions);
  const versionFn = useServerFn(ontologyVersionGet);
  const compareFn = useServerFn(ontologyCompare);
  const restoreFn = useServerFn(ontologyRestore);
  const proposalsFn = useServerFn(ontologyProposals);
  const decideFn = useServerFn(ontologyDecideProposal);
  const [versions, setVersions] = useState<OntologyVersionRow[] | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[] | null>(null);
  const [view, setView] = useState<{ title: string; diff: SpecDiff } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isOwner = o.detail.role === "owner";

  const load = async () => {
    const [v, p] = await Promise.all([
      versionsFn({ data: { access_token: o.tokenRef.current, id: o.id } }),
      proposalsFn({ data: { access_token: o.tokenRef.current, id: o.id } }),
    ]);
    if (v.ok) setVersions(v.versions);
    if (p.ok) setProposals(p.proposals);
  };
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showVersion = async (v: number) => {
    setBusy(`v${v}`);
    try {
      const res = await versionFn({
        data: { access_token: o.tokenRef.current, id: o.id, version: v },
      });
      if (res.ok) setView({ title: `What version ${v} changed`, diff: res.diff });
      else toast.error(res.error);
    } catch (e) {
      reportFailure("open the version", e);
    } finally {
      setBusy(null);
    }
  };
  const compareDraft = async (v: number) => {
    setBusy(`c${v}`);
    try {
      const res = await compareFn({
        data: { access_token: o.tokenRef.current, id: o.id, base: v, target: null },
      });
      if (res.ok) setView({ title: `The draft against version ${v}`, diff: res.diff });
      else toast.error(res.error);
    } catch (e) {
      reportFailure("compare with the draft", e);
    } finally {
      setBusy(null);
    }
  };
  const restore = async (v: number) => {
    const ok = await confirmAsk({
      title: `Restore version ${v} as the draft?`,
      body:
        "The draft becomes exactly version " +
        v +
        ". Published versions are not touched; publish again to make it current.",
      actionLabel: "Restore",
    });
    if (!ok) return;
    const res = await restoreFn({
      data: { access_token: o.tokenRef.current, id: o.id, version: v, revision: o.detail.revision },
    });
    if (res.ok) {
      toast.success(`The draft is version ${v} again`);
      void o.reload();
    } else toast.error(res.error);
  };
  const decide = async (
    p: ProposalRow,
    decision: "merge" | "reject" | "withdraw",
    force = false,
  ) => {
    setBusy(p.id);
    try {
      const res = await decideFn({
        data: { access_token: o.tokenRef.current, id: o.id, proposal_id: p.id, decision, force },
      });
      if (!res.ok) {
        if (decision === "merge" && !force && /changed since/.test(res.error)) {
          const ok = await confirmAsk({
            title: "The draft moved on since this proposal",
            body: "Merging replaces the draft with the proposal's model; changes made to the draft since are lost. Review the differences first.",
            actionLabel: "Merge anyway",
          });
          if (ok) return void decide(p, decision, true);
          return;
        }
        toast.error(res.error);
        return;
      }
      toast.success(
        decision === "merge"
          ? "Merged into the draft"
          : decision === "reject"
            ? "Rejected"
            : "Withdrawn",
      );
      await load();
      void o.reload();
    } catch (e) {
      reportFailure("record the decision", e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <section className="rounded-xl border border-border bg-card">
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <GitPullRequest className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Proposals</h3>
            <span className="text-xs text-muted-foreground">
              {isOwner ? "Changes others suggest; you decide." : "Changes you suggested."}
            </span>
          </header>
          {!proposals ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
            </p>
          ) : !proposals.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No proposals.{" "}
              {isOwner
                ? "Share the ontology and people can propose changes to it."
                : "Use “Propose a change” at the top."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {proposals.map((p) => (
                <li key={p.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.title}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] capitalize",
                        p.status === "open" && "border-primary/50 text-primary",
                      )}
                    >
                      {p.status}
                    </Badge>
                    {p.stale && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-[10px] text-amber-800 dark:text-amber-300"
                      >
                        draft moved on
                      </Badge>
                    )}
                    {p.diff.breaking > 0 && (
                      <Badge
                        variant="outline"
                        className="border-rose-500/40 text-[10px] text-rose-700 dark:text-rose-300"
                      >
                        {p.diff.breaking} breaking
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.author_email ?? "someone"} · {relativeTime(p.created_at)} · +{p.diff.added} −
                    {p.diff.removed} ~{p.diff.changed}
                  </p>
                  {p.note && <p className="text-xs">{p.note}</p>}
                  {p.decision_note && (
                    <p className="text-xs italic text-muted-foreground">“{p.decision_note}”</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => setView({ title: `What “${p.title}” changes`, diff: p.diff })}
                    >
                      <GitCompare className="mr-1 h-3.5 w-3.5" /> Review changes
                    </Button>
                    {p.status === "open" && isOwner && (
                      <>
                        <Button
                          size="sm"
                          className="h-7"
                          onClick={() => void decide(p, "merge")}
                          disabled={busy === p.id}
                        >
                          <Check className="mr-1 h-3.5 w-3.5" /> Merge into draft
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          onClick={() => void decide(p, "reject")}
                          disabled={busy === p.id}
                        >
                          <X className="mr-1 h-3.5 w-3.5" /> Reject
                        </Button>
                      </>
                    )}
                    {p.status === "open" && p.mine && !isOwner && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => void decide(p, "withdraw")}
                        disabled={busy === p.id}
                      >
                        <Undo2 className="mr-1 h-3.5 w-3.5" /> Withdraw
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card">
          <header className="flex items-center gap-2 border-b border-border px-4 py-3">
            <GitBranch className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Published versions</h3>
          </header>
          {!versions ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
            </p>
          ) : !versions.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Nothing published yet. Publish makes a version people you share with can use.
            </p>
          ) : (
            <ol className="divide-y divide-border">
              {versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    v{v.version}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p>{v.note ?? <span className="text-muted-foreground">No note</span>}</p>
                    <p className="text-xs text-muted-foreground">
                      {v.publisher_email ?? "—"} · {relativeTime(v.created_at)}
                      {v.diff && ` · +${v.diff.added} −${v.diff.removed} ~${v.diff.changed}`}
                      {v.diff?.breaking ? (
                        <span className="text-rose-700 dark:text-rose-300">
                          {" "}
                          · {v.diff.breaking} breaking
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => void showVersion(v.version)}
                      disabled={!!busy}
                    >
                      Changes
                    </Button>
                    {isOwner && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => void compareDraft(v.version)}
                          disabled={!!busy}
                        >
                          vs draft
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => void restore(v.version)}
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Restore
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-4 xl:sticky xl:top-4 xl:self-start">
        {view ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">{view.title}</h3>
            <ChangeList diff={view.diff} />
          </>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Pick a version or proposal to see exactly what it changes.
          </p>
        )}
      </section>
    </div>
  );
}
