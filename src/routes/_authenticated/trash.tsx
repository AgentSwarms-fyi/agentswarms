// Trash: what you deleted in the last thirty days, to restore or delete for good.
//
// A row restored or deleted stays where it was, saying so, until the page is
// left: a row that vanished pulled the next one up under the pointer, and the
// next press landed on something else.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { ArchiveRestore, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { IconTile } from "@/components/search/parts";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { deleteFromTrash, listTrash, restoreFromTrash, type TrashList } from "@/hooks/use-trash";
import { linkToObject, OBJECT_KINDS, objectKind, type ObjectKindId } from "@/lib/objectKinds";
import { countByKind } from "@/lib/objectSearch";
import { purgeLabel, TRASH_RETENTION_DAYS, type TrashEntry } from "@/lib/trash";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/trash")({
  component: TrashPage,
  head: () => ({ meta: [{ title: "Trash — AgentSwarms" }] }),
});

/** What happened to a row on this visit. */
type Done = { what: "restored" } | { what: "deleted" };

function TrashPage() {
  const [list, setList] = useState<TrashList | null>(null);
  const [done, setDone] = useState<Record<string, Done>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<ObjectKindId | null>(null);

  const load = useCallback(async () => {
    setList(null);
    setDone({});
    setList(await listTrash());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const entries = useMemo(() => (list?.state === "ok" ? list.entries : []), [list]);
  const counts = useMemo(() => countByKind(entries), [entries]);
  const kinds = OBJECT_KINDS.filter((k) => (counts.get(k.id) ?? 0) > 0);
  const chosen = kind && (counts.get(kind) ?? 0) > 0 ? kind : null;
  const shown = chosen ? entries.filter((e) => e.kind === chosen) : entries;
  const waiting = entries.filter((e) => !done[e.id]);

  const restore = async (e: TrashEntry) => {
    setBusy(e.id);
    const r = await restoreFromTrash(e.id);
    setBusy(null);
    if (!r.ok) return;
    setDone((d) => ({ ...d, [e.id]: { what: "restored" } }));
    toast.success(`Restored “${e.name || objectKind(e.kind).label}”`);
  };

  const deleteForGood = async (e: TrashEntry) => {
    const yes = await confirmAsk({
      title: `Delete “${e.name || objectKind(e.kind).label}” for good?`,
      body: "It cannot be restored after this, and nothing that belonged to it can.",
      actionLabel: "Delete for good",
    });
    if (!yes) return;
    setBusy(e.id);
    const r = await deleteFromTrash(e.id);
    setBusy(null);
    if (r.ok) setDone((d) => ({ ...d, [e.id]: { what: "deleted" } }));
  };

  const emptyAll = async () => {
    const yes = await confirmAsk({
      title: `Delete everything in the trash for good?`,
      body:
        waiting.length === 1
          ? "1 thing and everything that belonged to it. None of it can be restored after this."
          : `${waiting.length} things and everything that belonged to them. None of it can be restored after this.`,
      actionLabel: "Empty trash",
    });
    if (!yes) return;
    setBusy("all");
    const r = await deleteFromTrash();
    setBusy(null);
    if (!r.ok) return;
    toast.success(
      r.count === 1 ? "Deleted 1 thing for good" : `Deleted ${r.count} things for good`,
    );
    setDone((d) => {
      const next = { ...d };
      for (const e of waiting) next[e.id] = { what: "deleted" };
      return next;
    });
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
      <PageHeader
        title="Trash"
        description={`Restore what you deleted in the last ${TRASH_RETENTION_DAYS} days, or delete it for good; after that it is deleted by itself.`}
        actions={
          waiting.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void emptyAll()}
              className="text-destructive hover:text-destructive"
            >
              {busy === "all" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Empty trash
            </Button>
          )
        }
      />

      {kinds.length > 1 && (
        <div
          className="-mx-6 flex items-center gap-1.5 overflow-x-auto px-6 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label="Filter by kind"
        >
          <Chip active={!chosen} onClick={() => setKind(null)} label="All" count={entries.length} />
          {kinds.map((k) => (
            <Chip
              key={k.id}
              active={chosen === k.id}
              onClick={() => setKind(chosen === k.id ? null : k.id)}
              label={k.plural}
              count={counts.get(k.id) ?? 0}
            />
          ))}
        </div>
      )}

      {list === null ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading the trash…
        </div>
      ) : list.state === "missing" ? (
        <Notice>
          <p className="font-medium">The trash needs a database update.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This install runs a newer app than its database. Whoever looks after it applies the
            latest migrations, and deleting then moves things here instead of losing them.
          </p>
        </Notice>
      ) : list.state === "error" ? (
        <Notice>
          <p className="font-medium">The trash could not be read.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{list.error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Try again
          </Button>
        </Notice>
      ) : shown.length === 0 ? (
        <Notice>
          <p className="font-medium">The trash is empty.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Agents, swarms, dashboards, reports, workbooks, notebooks, workflows and the rest come
            here when you delete them. Datasets, knowledge bases, ML models, MCP projects and
            connections, ETL pipelines and lakehouse tables are deleted for good at once, and each
            of those asks first.
          </p>
        </Notice>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-card">
          {shown.map((e) => (
            <TrashRow
              key={e.id}
              entry={e}
              done={done[e.id]}
              busy={busy === e.id || busy === "all"}
              disabled={busy !== null}
              onRestore={() => void restore(e)}
              onDelete={() => void deleteForGood(e)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TrashRow(props: {
  entry: TrashEntry;
  done?: Done;
  busy: boolean;
  disabled: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { entry: e, done } = props;
  const k = objectKind(e.kind);
  const name = e.name || `Untitled ${k.label.toLowerCase()}`;
  const deleted = e.deletedAt
    ? `Deleted ${formatDistanceToNowStrict(new Date(e.deletedAt), { addSuffix: true })}`
    : "";
  const link = linkToObject({ kind: e.kind, id: e.objectId, name });
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap",
        done?.what === "deleted" && "opacity-55",
      )}
    >
      <IconTile icon={k.icon} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm", done?.what === "deleted" && "line-through")}>
          {name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {k.label}
          {deleted ? ` · ${deleted}` : ""}
          {!done && e.purgeAfter ? ` · ${purgeLabel(e.purgeAfter)}` : ""}
        </span>
      </span>
      {done?.what === "restored" ? (
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          Restored
          <Button asChild size="sm" variant="outline" className="h-7 px-2.5 text-xs">
            <Link to={link.to as never} search={(link.search ?? {}) as never}>
              Open
            </Link>
          </Button>
        </span>
      ) : done?.what === "deleted" ? (
        <span className="shrink-0 text-xs text-muted-foreground">Deleted for good</span>
      ) : (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            disabled={props.disabled}
            onClick={props.onRestore}
          >
            {props.busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArchiveRestore className="mr-1 h-3.5 w-3.5" />
            )}
            Restore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            disabled={props.disabled}
            onClick={props.onDelete}
            title="Delete for good"
            aria-label={`Delete ${name} for good`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      )}
    </li>
  );
}

function Chip(props: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition",
        props.active
          ? "border-primary/40 bg-primary/10 font-medium text-foreground"
          : "border-border/70 text-muted-foreground hover:border-primary/30 hover:text-foreground",
      )}
    >
      {props.label}
      <span className="tabular-nums opacity-70">{props.count}</span>
    </button>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card px-5 py-8 text-sm">{children}</div>;
}
