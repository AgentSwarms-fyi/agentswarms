// Client-side Data Catalog reads + curation writes. Sources and assets
// are owner-scoped by RLS, so plain supabase queries are safe here; only
// credential handling and crawling live in server functions.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { parseModelChoice } from "@/utils/providers/modelChoice";

export type CatalogColumn = {
  name: string;
  type: string;
  sample?: string;
  pii?: boolean;
  /** Column documentation (AI-generated or hand-written); survives re-crawls. */
  description?: string;
  /** Comment ingested from the external catalog (e.g. Unity Catalog). */
  comment?: string;
  /** Sample-based profile stats from the last crawl. */
  null_pct?: number;
  distinct_count?: number;
  min?: number;
  max?: number;
};

export type CatalogSource = {
  id: string;
  user_id: string;
  kind: "warehouse" | "object_storage" | "iceberg_rest";
  name: string;
  connection_id: string | null;
  /** Non-secret bucket config (provider, endpoint, region, bucket, prefix). */
  config: Record<string, unknown>;
  status: "pending" | "crawling" | "ready" | "error";
  crawl_schedule: "manual" | "daily" | "weekly";
  next_crawl_at: string | null;
  last_crawl_at: string | null;
  last_error: string | null;
  crawl_stats: { assets?: number; columns?: number; sampled?: number; duration_ms?: number };
  created_at: string;
};

export type CatalogAssetStatus = "draft" | "certified" | "deprecated";

export type CatalogAsset = {
  id: string;
  user_id: string;
  source_id: string;
  asset_type: "table" | "view" | "file" | "dataset";
  schema_name: string | null;
  name: string;
  fqn: string;
  columns: CatalogColumn[];
  row_count: number | null;
  size_bytes: number | null;
  format: string | null;
  file_count: number | null;
  description: string | null;
  tags: string[];
  owner: string | null;
  status: CatalogAssetStatus;
  pii: boolean;
  last_crawled_at: string;
};

function parseColumns(v: Json): CatalogColumn[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter(
    (c): c is CatalogColumn => Boolean(c) && typeof (c as CatalogColumn).name === "string",
  );
}

export async function listCatalogSources(): Promise<CatalogSource[]> {
  const { data, error } = await supabase
    .from("catalog_sources")
    .select(
      "id, user_id, kind, name, connection_id, config, status, crawl_schedule, next_crawl_at, last_crawl_at, last_error, crawl_stats, created_at",
    )
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    kind: r.kind as CatalogSource["kind"],
    status: r.status as CatalogSource["status"],
    crawl_schedule: r.crawl_schedule as CatalogSource["crawl_schedule"],
    config: (r.config ?? {}) as Record<string, unknown>,
    crawl_stats: (r.crawl_stats ?? {}) as CatalogSource["crawl_stats"],
  }));
}

export async function listCatalogAssets(): Promise<CatalogAsset[]> {
  const { data, error } = await supabase
    .from("catalog_assets")
    .select(
      "id, user_id, source_id, asset_type, schema_name, name, fqn, columns, row_count, size_bytes, format, file_count, description, tags, owner, status, pii, last_crawled_at",
    )
    .order("fqn", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    asset_type: r.asset_type as CatalogAsset["asset_type"],
    status: (r.status ?? "draft") as CatalogAssetStatus,
    columns: parseColumns(r.columns),
    tags: r.tags ?? [],
  }));
}

/** Curation fields survive re-crawls (the crawler never writes them). */
export async function updateCatalogAsset(
  id: string,
  patch: {
    description?: string | null;
    tags?: string[];
    owner?: string | null;
    status?: CatalogAssetStatus;
  },
): Promise<void> {
  const { error } = await supabase.from("catalog_assets").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Source-derived lineage (Databricks Unity Catalog system tables) ────────

export type CatalogLineageEdge = {
  upstream_fqn: string;
  downstream_fqn: string;
  upstream_column: string | null;
  downstream_column: string | null;
};

/** Match lineage FQNs (often catalog.schema.table) to catalog assets
 *  (schema.table) by their trailing two segments. */
export function lineageKey(fqn: string): string {
  return fqn.toLowerCase().split(".").slice(-2).join(".");
}

export async function loadCatalogLineage(): Promise<CatalogLineageEdge[]> {
  const { data, error } = await supabase
    .from("catalog_lineage")
    .select("upstream_fqn, downstream_fqn, upstream_column, downstream_column")
    .limit(20000);
  if (error) return [];
  return (data ?? []).map((r) => ({
    upstream_fqn: r.upstream_fqn,
    downstream_fqn: r.downstream_fqn,
    upstream_column: r.upstream_column,
    downstream_column: r.downstream_column,
  }));
}

/** Upstream + downstream neighbours of an asset (by schema.table key). */
export function sourceLineageFor(
  edges: CatalogLineageEdge[],
  assetFqn: string,
): { upstream: CatalogLineageEdge[]; downstream: CatalogLineageEdge[] } {
  const key = lineageKey(assetFqn);
  return {
    upstream: edges.filter((e) => lineageKey(e.downstream_fqn) === key),
    downstream: edges.filter((e) => lineageKey(e.upstream_fqn) === key),
  };
}

// ── Business glossary ────────────────────────────────────────────────────
// A term defines a tag: tagging an asset with the term's name links them.

export type GlossaryTerm = {
  id: string;
  term: string;
  definition: string;
  updated_at: string;
};

export async function listGlossaryTerms(): Promise<GlossaryTerm[]> {
  const { data, error } = await supabase
    .from("catalog_glossary_terms")
    .select("id, term, definition, updated_at")
    .order("term");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertGlossaryTerm(
  userId: string,
  term: string,
  definition: string,
): Promise<void> {
  const { error } = await supabase.from("catalog_glossary_terms").upsert(
    {
      user_id: userId,
      term: term.trim(),
      definition: definition.trim(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,term" },
  );
  if (error) throw new Error(error.message);
}

export async function deleteGlossaryTerm(id: string): Promise<void> {
  const { error } = await supabase.from("catalog_glossary_terms").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ── Lineage & usage ──────────────────────────────────────────────────────
//
// Lineage is derived from what already exists — no separate tracking:
//   - BI dashboard widgets store their SQL + source: FROM/JOIN refs are
//     parsed out, so a table knows every dashboard built on it;
//   - prep flows record base + joined input tables and the output table,
//     giving derived-from edges;
//   - saved metrics reference their table directly.
// The index is keyed per source space so "orders" in a warehouse never
// collides with a local "orders" CSV.

export type LineageRef = {
  kind: "dashboard" | "prep_flow" | "metric";
  id: string;
  name: string;
  /** Extra context: widget titles, or "input"/"output" for prep flows. */
  detail?: string;
};

export type AssetLineage = {
  /** Consumers built on this asset (impact analysis). */
  usedBy: LineageRef[];
  /** Prep outputs only: the tables this asset was derived from. */
  derivedFrom: string[];
};

export type LineageIndex = Map<string, AssetLineage>;

export { extractTableRefs } from "@/lib/sqlRefs";
import { extractTableRefs } from "@/lib/sqlRefs";

function entry(index: LineageIndex, key: string): AssetLineage {
  let e = index.get(key);
  if (!e) {
    e = { usedBy: [], derivedFrom: [] };
    index.set(key, e);
  }
  return e;
}

function addRef(index: LineageIndex, key: string, ref: LineageRef): void {
  const e = entry(index, key);
  const existing = e.usedBy.find((r) => r.kind === ref.kind && r.id === ref.id);
  if (existing) {
    if (ref.detail && existing.detail && !existing.detail.includes(ref.detail)) {
      existing.detail = `${existing.detail}, ${ref.detail}`;
    }
  } else {
    e.usedBy.push(ref);
  }
}

/** Build the lineage index from dashboards, prep flows and saved metrics. */
export async function loadLineageIndex(): Promise<LineageIndex> {
  const index: LineageIndex = new Map();
  const [dashRes, flowRes, metricRes] = await Promise.all([
    supabase.from("bi_dashboards").select("id, name, widgets"),
    supabase.from("user_prep_flows").select("id, name, config, output_table_name"),
    supabase.from("user_saved_metrics").select("id, name, table_id"),
  ]);

  for (const d of dashRes.data ?? []) {
    const widgets = Array.isArray(d.widgets) ? d.widgets : [];
    for (const w of widgets as {
      kind?: string;
      title?: string;
      sql?: string;
      source?: { kind?: string; connection_id?: string };
    }[]) {
      if (w.kind !== "chart" || !w.sql) continue;
      const ref: LineageRef = { kind: "dashboard", id: d.id, name: d.name, detail: w.title };
      for (const t of extractTableRefs(w.sql)) {
        if (w.source?.kind === "warehouse" && w.source.connection_id) {
          addRef(index, `wh:${w.source.connection_id}:${t}`, ref);
          const last = t.split(".").pop()!;
          if (last !== t) addRef(index, `wh:${w.source.connection_id}:${last}`, ref);
        } else {
          addRef(index, `name:${t}`, ref);
        }
      }
    }
  }

  for (const f of flowRes.data ?? []) {
    const cfg = (f.config ?? {}) as { base?: string | null; joins?: { table?: string }[] };
    const inputs = [
      ...(cfg.base ? [cfg.base] : []),
      ...(cfg.joins ?? []).map((j) => j.table).filter((t): t is string => Boolean(t)),
    ];
    for (const t of inputs) {
      addRef(index, `name:${t.toLowerCase()}`, {
        kind: "prep_flow",
        id: f.id,
        name: f.name,
        detail: "input",
      });
    }
    if (f.output_table_name) {
      const e = entry(index, `name:${f.output_table_name.toLowerCase()}`);
      e.derivedFrom = [...new Set([...e.derivedFrom, ...inputs])];
      addRef(index, `name:${f.output_table_name.toLowerCase()}`, {
        kind: "prep_flow",
        id: f.id,
        name: f.name,
        detail: "output",
      });
    }
  }

  for (const m of metricRes.data ?? []) {
    if (m.table_id) {
      addRef(index, `tid:${m.table_id}`, { kind: "metric", id: m.id, name: m.name });
    }
  }
  return index;
}

/** Lineage lookup keys for an asset (local vs warehouse source space). */
export function assetLineageKeys(
  asset: Pick<CatalogAsset, "id" | "source_id" | "name" | "fqn">,
  source: CatalogSource | undefined,
  isLocal: boolean,
): string[] {
  if (isLocal) {
    return [`name:${asset.name.toLowerCase()}`, `tid:${asset.id.replace(/^local:/, "")}`];
  }
  if (source?.kind === "warehouse" && source.connection_id) {
    const keys = [`wh:${source.connection_id}:${asset.fqn.toLowerCase()}`];
    if (asset.name.toLowerCase() !== asset.fqn.toLowerCase()) {
      keys.push(`wh:${source.connection_id}:${asset.name.toLowerCase()}`);
    }
    return keys;
  }
  return [];
}

/** Merge the index entries for an asset's keys (deduped). */
export function lookupLineage(index: LineageIndex, keys: string[]): AssetLineage {
  const usedBy: LineageRef[] = [];
  const derivedFrom = new Set<string>();
  for (const k of keys) {
    const e = index.get(k);
    if (!e) continue;
    for (const r of e.usedBy) {
      if (!usedBy.some((x) => x.kind === r.kind && x.id === r.id)) usedBy.push(r);
    }
    for (const d of e.derivedFrom) derivedFrom.add(d);
  }
  return { usedBy, derivedFrom: [...derivedFrom] };
}

// ── AI documentation ─────────────────────────────────────────────────────

/**
 * Generate an asset description + per-column docs with the user's BI model
 * (same /api/bi JSON endpoint the analyst pipeline uses) and persist them.
 * Returns the updated description and columns.
 */
export async function generateAssetDocs(
  accessToken: string,
  asset: CatalogAsset,
  /** BI model choice ("provider/model"); omit for the server-side default chain. */
  model?: string | null,
): Promise<{ description: string; columns: CatalogColumn[] }> {
  const colLines = asset.columns
    .slice(0, 60)
    .map(
      (c) =>
        `- ${c.name} (${c.type}${c.sample !== undefined ? `, e.g. ${JSON.stringify(c.sample)}` : ""})`,
    )
    .join("\n");
  const choice = parseModelChoice(model ?? undefined);
  const res = await fetch("/api/bi", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      stage: "docs",
      provider: choice?.provider,
      model: choice?.model,
      systemPrompt:
        "You are a data-catalog documentation writer. Given a dataset's name and columns, return STRICT JSON only: " +
        '{"description": "1-2 sentence summary of what the dataset contains and is used for", ' +
        '"columns": {"<column_name>": "concise one-line description", ...}}. ' +
        "Describe every column you are given. No markdown, no extra keys.",
      userPrompt: `Dataset: ${asset.fqn}\nType: ${asset.asset_type}${asset.format ? ` (${asset.format})` : ""}${
        asset.row_count != null ? `\nApprox rows: ${asset.row_count}` : ""
      }\nColumns:\n${colLines}`,
    }),
  });
  const j = (await res.json()) as {
    result?: { description?: string; columns?: Record<string, string> };
    error?: string;
  };
  if (!res.ok) throw new Error(j.error || "AI request failed");
  const parsed = j.result ?? {};
  const description = (parsed.description ?? "").trim();
  if (!description) throw new Error("The model returned no description — try again");

  const columns = asset.columns.map((c) => {
    const d = parsed.columns?.[c.name]?.trim();
    return d ? { ...c, description: d.slice(0, 200) } : c;
  });
  const { error } = await supabase
    .from("catalog_assets")
    .update({ description, columns: columns as unknown as Json })
    .eq("id", asset.id);
  if (error) throw new Error(error.message);
  return { description, columns };
}

/**
 * Re-exported from lib/piiHeuristic, which the crawler imports too. This used
 * to be a second copy of the regex labelled "client-side mirror".
 */
export { isPiiColumnName } from "@/lib/piiHeuristic";

// ── Display helpers ──────────────────────────────────────────────────────

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}
