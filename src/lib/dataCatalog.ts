// Client-side Data Catalog reads + curation writes. Sources and assets
// are owner-scoped by RLS, so plain supabase queries are safe here; only
// credential handling and crawling live in server functions.
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";

export type CatalogColumn = { name: string; type: string; sample?: string; pii?: boolean };

export type CatalogSource = {
  id: string;
  kind: "warehouse" | "object_storage";
  name: string;
  connection_id: string | null;
  /** Non-secret bucket config (provider, endpoint, region, bucket, prefix). */
  config: Record<string, unknown>;
  status: "pending" | "crawling" | "ready" | "error";
  last_crawl_at: string | null;
  last_error: string | null;
  crawl_stats: { assets?: number; columns?: number; sampled?: number; duration_ms?: number };
  created_at: string;
};

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
    .select("id, kind, name, connection_id, config, status, last_crawl_at, last_error, crawl_stats, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    kind: r.kind as CatalogSource["kind"],
    status: r.status as CatalogSource["status"],
    config: (r.config ?? {}) as Record<string, unknown>,
    crawl_stats: (r.crawl_stats ?? {}) as CatalogSource["crawl_stats"],
  }));
}

export async function listCatalogAssets(): Promise<CatalogAsset[]> {
  const { data, error } = await supabase
    .from("catalog_assets")
    .select(
      "id, source_id, asset_type, schema_name, name, fqn, columns, row_count, size_bytes, format, file_count, description, tags, pii, last_crawled_at",
    )
    .order("fqn", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    ...r,
    asset_type: r.asset_type as CatalogAsset["asset_type"],
    columns: parseColumns(r.columns),
    tags: r.tags ?? [],
  }));
}

/** Curation: description + tags survive re-crawls (crawler never writes them). */
export async function updateCatalogAsset(
  id: string,
  patch: { description?: string | null; tags?: string[] },
): Promise<void> {
  const { error } = await supabase.from("catalog_assets").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
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
