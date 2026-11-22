// The sections of a dataset's page. Each takes what the page already loaded
// and lays it out; none reads anything itself.
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { agoLabel } from "@/lib/agoLabel";
import type { DatasetUsage } from "@/utils/datasetPage.functions";
import {
  filterSentence,
  originSentence,
  type ColumnProfile,
  type Origin,
  type SchemaChange,
  type Trust,
} from "@/lib/datasetPage";
import { linkToObject, type ObjectKindId } from "@/lib/objectKinds";
import { cn } from "@/lib/utils";

const TONE_DOT: Record<Trust["tone"], string> = {
  good: "bg-emerald-500",
  attention: "bg-amber-500",
  unknown: "bg-muted-foreground/50",
};

/** The verdict and the facts it rests on. */
export function TrustSummary({ trust }: { trust: Trust }) {
  return (
    <section aria-label="Can it be trusted" className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", TONE_DOT[trust.tone])} aria-hidden />
        <h2 className="text-sm font-semibold">{trust.headline}</h2>
      </div>
      <ul className="mt-2 space-y-1 pl-4 text-sm leading-6 text-muted-foreground">
        {trust.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

/** Small labelled facts in one row: rows, columns, size, loaded. */
export function FactRow({
  facts,
}: {
  facts: Array<{ label: string; value: ReactNode; title?: string }>;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      {facts.map((f) => (
        <div key={f.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{f.label}</dt>
          <dd className="truncate text-sm font-medium tabular-nums" title={f.title}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Where the rows come from. */
export function OriginBlock({ origins }: { origins: readonly Origin[] }) {
  return (
    <Block title="Where it comes from">
      <ul className="space-y-1.5 text-sm leading-6">
        {origins.map((o, i) => (
          <li key={i}>{originSentence(o)}</li>
        ))}
      </ul>
    </Block>
  );
}

function ObjectLinkRow({ kind, id, name }: { kind: ObjectKindId; id: string; name: string }) {
  const link = linkToObject({ kind, id, name });
  return (
    <Link
      to={link.to as never}
      search={(link.search ?? {}) as never}
      className="truncate text-primary underline-offset-2 hover:underline"
    >
      {name}
    </Link>
  );
}

/** What of the reader's is built on it. */
export function UsageBlock({
  usage,
  error,
  shared,
}: {
  usage: DatasetUsage | null;
  error: string | null;
  shared: boolean;
}) {
  const groups: Array<{ label: string; items: ReactNode[] }> = [];
  if (usage) {
    const add = (label: string, kind: ObjectKindId, list: Array<{ id: string; name: string }>) => {
      if (list.length)
        groups.push({
          label,
          items: list.map((x) => <ObjectLinkRow key={x.id} kind={kind} id={x.id} name={x.name} />),
        });
    };
    add("Dashboards", "dashboard", usage.dashboards);
    add("Semantic models", "semantic_model", usage.semanticModels);
    add("AI analysts", "ai_analyst", usage.analysts.named);
    add("Agents", "agent", usage.agents.named);
    if (usage.flowsUsing.length)
      groups.push({
        label: "Data-prep flows",
        items: usage.flowsUsing.map((f) => <span key={f.id}>{f.name}</span>),
      });
  }
  const broad = usage
    ? [
        usage.analysts.everything &&
          `${usage.analysts.everything} AI analyst${usage.analysts.everything === 1 ? "" : "s"}`,
        usage.agents.everything &&
          `${usage.agents.everything} agent${usage.agents.everything === 1 ? "" : "s"}`,
      ].filter(Boolean)
    : [];
  return (
    <Block title={shared ? "What of yours uses it" : "What uses it"}>
      {error ? (
        <p className="text-sm text-muted-foreground">What uses it could not be read: {error}</p>
      ) : !usage ? (
        <p className="text-sm text-muted-foreground">Reading…</p>
      ) : (
        <div className="space-y-3 text-sm">
          {groups.length === 0 && !usage.savedMetrics && (
            <p className="text-muted-foreground">Nothing of yours is built on it yet.</p>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <p className="text-xs text-muted-foreground">{g.label}</p>
              <ul className="mt-0.5 space-y-0.5">
                {g.items.map((it, i) => (
                  <li key={i} className="flex min-w-0">
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {usage.savedMetrics > 0 && (
            <p>
              {usage.savedMetrics} saved metric{usage.savedMetrics === 1 ? "" : "s"}
            </p>
          )}
          {broad.length > 0 && (
            <p className="text-xs leading-5 text-muted-foreground">
              Also {broad.join(" and ")} may read every dataset of yours, this one included.
            </p>
          )}
        </div>
      )}
    </Block>
  );
}

/** The first rows, as a table that scrolls on its own. */
export function SampleTable({
  rows,
  columns,
  shown,
}: {
  rows: ReadonlyArray<Record<string, unknown>>;
  columns: readonly string[];
  shown: number;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">It has no rows.</p>;
  const cell = (v: unknown) =>
    v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The first {Math.min(shown, rows.length)} rows.
      </p>
      <div className="max-h-[60vh] overflow-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              {columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-left text-xs font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r, i) => (
              <tr key={i} className="border-t">
                {columns.map((c) => (
                  <td
                    key={c}
                    className="max-w-[18rem] truncate whitespace-nowrap px-3 py-1.5 tabular-nums"
                    title={cell(r[c])}
                  >
                    {cell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** What each column holds, from the sample. */
export function ColumnProfiles({
  profiles,
  types,
}: {
  profiles: ColumnProfile[];
  types: Map<string, string>;
}) {
  if (!profiles.length) return <p className="text-sm text-muted-foreground">It has no columns.</p>;
  const n = profiles[0]?.rows ?? 0;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Read from the first {n} row{n === 1 ? "" : "s"}, not the whole dataset.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/60">
            <tr className="text-left text-xs">
              {["Column", "Holds", "Empty", "Different values", "Range", "Most common"].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.name} className="border-t align-top">
                <td className="px-3 py-2 font-medium">{p.name}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {/* The declared type only when it says more than what the values look like. */}
                  {types.get(p.name) && !p.looks.startsWith(types.get(p.name)!.toLowerCase())
                    ? `${p.looks} (${types.get(p.name)})`
                    : p.looks}
                </td>
                <td className="px-3 py-2 tabular-nums">{p.empty}</td>
                <td className="px-3 py-2 tabular-nums">{p.distinct}</td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                  {p.min !== undefined ? `${p.min} – ${p.max}` : ""}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {p.common.map((c) => `${c.value} (${c.count})`).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** How the columns changed between kept versions. */
export function SchemaChanges({
  changes,
  versions,
}: {
  changes: SchemaChange[];
  versions: number;
}) {
  if (!versions)
    return (
      <p className="text-sm text-muted-foreground">
        No earlier versions are kept yet. A version is kept each time the rows are replaced, and a
        change of columns shows here.
      </p>
    );
  if (!changes.length)
    return (
      <p className="text-sm text-muted-foreground">
        The columns have not changed across the {versions} kept version{versions === 1 ? "" : "s"}.
      </p>
    );
  return (
    <ol className="space-y-3">
      {changes.map((c) => (
        <li key={c.at} className="rounded-lg border bg-card p-3 text-sm">
          <p className="text-xs text-muted-foreground" title={new Date(c.at).toLocaleString()}>
            {agoLabel(c.at)}
          </p>
          {c.added.length > 0 && <p>Added: {c.added.join(", ")}</p>}
          {c.removed.length > 0 && <p>Removed: {c.removed.join(", ")}</p>}
        </li>
      ))}
    </ol>
  );
}

export type AccessGrant = {
  grant_id: string;
  principal_type: string;
  name: string | null;
  email: string | null;
  member_count: number | null;
  row_filter: unknown;
  column_mask: string[];
  granted_at: string;
  granted_by_name: string | null;
};

/** Who can read it, for its owner. */
export function AccessList({
  grants,
  missing,
  error,
}: {
  grants: AccessGrant[] | null;
  missing: boolean;
  error: string | null;
}) {
  if (missing)
    return (
      <p className="text-sm text-muted-foreground">
        Showing who can read it needs a database update (migration 20261123000000), for example{" "}
        <code className="rounded bg-muted px-1 font-mono text-xs">
          npx supabase db push --remote
        </code>
        .
      </p>
    );
  if (error)
    return (
      <p className="text-sm text-muted-foreground">Who can read it could not be read: {error}</p>
    );
  if (!grants) return <p className="text-sm text-muted-foreground">Reading…</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {grants.length === 0
          ? "Only you can read it."
          : `Besides you, ${grants.length === 1 ? "one grant gives" : `${grants.length} grants give`} read-only access.`}{" "}
        An administrator shares a dataset under Admin → IAM → Access.
      </p>
      {grants.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {grants.map((g) => {
            const filter = filterSentence(g.row_filter);
            const who =
              g.principal_type === "group"
                ? `${g.name ?? "A group"}${g.member_count !== null ? ` (${g.member_count} ${g.member_count === 1 ? "person" : "people"})` : ""}`
                : (g.name ?? g.email ?? "Someone");
            return (
              <li key={g.grant_id} className="space-y-0.5 p-3 text-sm">
                <p className="font-medium">
                  {who}
                  {g.principal_type === "user" && g.name && g.email && (
                    <span className="ml-2 font-normal text-muted-foreground">{g.email}</span>
                  )}
                  {g.principal_type === "group" && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">group</span>
                  )}
                </p>
                <p className="text-muted-foreground">
                  {filter ?? "Every row."}{" "}
                  {g.column_mask.length
                    ? `Hidden columns: ${g.column_mask.join(", ")}.`
                    : "Every column."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Given {agoLabel(g.granted_at)}
                  {g.granted_by_name ? ` by ${g.granted_by_name}` : ""}.
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
