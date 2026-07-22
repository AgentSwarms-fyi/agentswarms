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
  /** Sample-based profile stats from the last crawl. */
  null_pct?: number;
  distinct_count?: number;
  min?: number;
  max?: number;
};

export type CatalogSource = {
  id: string;
  kind: "warehouse" | "object_storage";
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
      "id, kind, name, connection_id, config, status, crawl_schedule, next_crawl_at, last_crawl_at, last_error, crawl_stats, created_at",
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
      "id, source_id, asset_type, schema_name, name, fqn, columns, row_count, size_bytes, format, file_count, description, tags, owner, status, pii, last_crawled_at",
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
 * Client-side mirror of the crawler's PII column-name heuristic — used to
 * badge local tables, which are cataloged in the browser without a crawl.
 */
const PII_RE =
  /(^|[_\s-])(email|e[-_]?mail|phone|mobile|ssn|social[-_]?security|passport|dob|birth[-_]?date|birthday|address|street|zip[-_]?code|postal[-_]?code|salary|income|iban|swift|credit[-_]?card|card[-_]?number|cvv|tax[-_]?id|national[-_]?id|driver[-_]?license|first[-_]?name|last[-_]?name|full[-_]?name|surname|gender|ip[-_]?address)([_\s-]|$)/i;

export function isPiiColumnName(name: string): boolean {
  return PII_RE.test(name);
}

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
