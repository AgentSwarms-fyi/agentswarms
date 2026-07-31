// Data quality tests — pure model + evaluator.
//
// No Supabase import on purpose: the server evaluator (utils/bi/quality.server)
// and the browser UI both import this, exactly like dataPrepCore.
//
// The vocabulary is dbt's / Great Expectations' on purpose. Analysts already
// know what `not_null` and `accepted_values` mean, and a test suite written
// here should be legible to someone who has never seen this app.

export type QualityTestKind =
  | "not_null"
  | "unique"
  | "accepted_values"
  | "range"
  | "row_count_min"
  | "freshness";

export type QualitySeverity = "error" | "warn";

export type QualityTestConfig = {
  /** accepted_values */
  values?: string[];
  /** range (either bound may be omitted) */
  min?: number | null;
  max?: number | null;
  /** row_count_min */
  count?: number;
  /** freshness */
  max_age_hours?: number;
};

export type QualityTest = {
  id: string;
  table_id: string;
  kind: QualityTestKind;
  column_name: string | null;
  config: QualityTestConfig;
  enabled: boolean;
  severity: QualitySeverity;
  created_at?: string;
};

export type QualityStatus = "pass" | "fail" | "error";

export type QualityOutcome = {
  status: QualityStatus;
  failingRows: number;
  totalRows: number;
  detail: string;
};

export type QualityResult = QualityOutcome & {
  id: string;
  test_id: string;
  table_id: string;
  ran_at: string;
};

/** Tests that must read the data. A freshness SLA on the dataset's load time
 *  does not, which keeps the scheduled sweep cheap for large tables. */
export function testNeedsRows(t: Pick<QualityTest, "kind" | "column_name">): boolean {
  if (t.kind === "row_count_min") return false;
  if (t.kind === "freshness") return Boolean(t.column_name);
  return true;
}

export function anyTestNeedsRows(tests: Pick<QualityTest, "kind" | "column_name">[]): boolean {
  return tests.some(testNeedsRows);
}

export const QUALITY_TEST_LABELS: Record<QualityTestKind, string> = {
  not_null: "Not null",
  unique: "Unique",
  accepted_values: "Accepted values",
  range: "Numeric range",
  row_count_min: "Minimum row count",
  freshness: "Freshness",
};

/** One-line human summary of what a test asserts. */
export function describeQualityTest(
  t: Pick<QualityTest, "kind" | "column_name" | "config">,
): string {
  const col = t.column_name ?? "";
  switch (t.kind) {
    case "not_null":
      return `${col} is never empty`;
    case "unique":
      return `${col} has no duplicates`;
    case "accepted_values":
      return `${col} is one of ${(t.config.values ?? []).slice(0, 5).join(", ")}${
        (t.config.values ?? []).length > 5 ? "…" : ""
      }`;
    case "range": {
      const { min, max } = t.config;
      if (min != null && max != null) return `${col} is between ${min} and ${max}`;
      if (min != null) return `${col} is at least ${min}`;
      if (max != null) return `${col} is at most ${max}`;
      return `${col} is numeric`;
    }
    case "row_count_min":
      return `at least ${t.config.count ?? 1} rows`;
    case "freshness":
      return col
        ? `${col} is within the last ${t.config.max_age_hours ?? 24}h`
        : `updated within the last ${t.config.max_age_hours ?? 24}h`;
  }
}

/** Reject tests that could never run. Returns an error message, or null. */
export function validateQualityTest(t: {
  kind: QualityTestKind;
  column_name?: string | null;
  config: QualityTestConfig;
}): string | null {
  const needsColumn = t.kind !== "row_count_min" && t.kind !== "freshness";
  if (needsColumn && !t.column_name?.trim()) {
    return `A ${QUALITY_TEST_LABELS[t.kind].toLowerCase()} test needs a column.`;
  }
  if (t.kind === "accepted_values") {
    const vals = t.config.values ?? [];
    if (vals.length === 0) return "List at least one accepted value.";
    if (vals.length > 500) return "Accepted-values lists are limited to 500 entries.";
  }
  if (t.kind === "range") {
    const { min, max } = t.config;
    if (min == null && max == null) return "Set a minimum, a maximum, or both.";
    if (min != null && !Number.isFinite(min)) return "The minimum must be a number.";
    if (max != null && !Number.isFinite(max)) return "The maximum must be a number.";
    if (min != null && max != null && min > max) return "The minimum cannot exceed the maximum.";
  }
  if (t.kind === "row_count_min") {
    const c = t.config.count;
    if (c == null || !Number.isFinite(c) || c < 0) return "Set a row count of zero or more.";
  }
  if (t.kind === "freshness") {
    const h = t.config.max_age_hours;
    if (h == null || !Number.isFinite(h) || h <= 0) return "Set a maximum age in hours.";
  }
  return null;
}

const SAMPLES = 3;

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Parse a cell into an epoch ms, accepting ISO strings, dates and epochs. */
export function toTimestamp(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) {
    // Bare seconds vs milliseconds: anything below ~1e11 is far too small to
    // be a plausible modern date in ms, so treat it as seconds.
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export type QualityContext = {
  /** Rows to check — may be a capped prefix of the dataset. */
  rows: Record<string, unknown>[];
  /** True total, which can exceed rows.length when the read was capped. */
  totalRows: number;
  /** rows is a prefix, not the whole dataset. */
  capped?: boolean;
  /** When the dataset itself was last written — the column-less freshness input. */
  lastLoadedAt?: string | null;
  now?: number;
};

function withCapNote(detail: string, ctx: QualityContext): string {
  return ctx.capped
    ? `${detail} (checked the first ${ctx.rows.length.toLocaleString()} rows)`
    : detail;
}

function fmtAge(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)} days`;
}

/**
 * Run one test. Never throws: an unrunnable test (missing column, unparseable
 * dates) reports status "error" so a broken assertion is visibly broken rather
 * than silently passing.
 */
export function evaluateQualityTest(
  test: Pick<QualityTest, "kind" | "column_name" | "config">,
  ctx: QualityContext,
): QualityOutcome {
  const now = ctx.now ?? Date.now();
  const total = ctx.totalRows;
  const col = test.column_name ?? "";
  const base = { failingRows: 0, totalRows: total };

  try {
    if (test.kind === "row_count_min") {
      const min = test.config.count ?? 0;
      const ok = total >= min;
      return {
        ...base,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${total.toLocaleString()} rows (minimum ${min.toLocaleString()})`
          : `Only ${total.toLocaleString()} rows — expected at least ${min.toLocaleString()}.`,
      };
    }

    if (test.kind === "freshness") {
      const maxAgeMs = (test.config.max_age_hours ?? 24) * 3_600_000;
      let stampMs: number | null;
      let label: string;
      if (col) {
        // Newest value in the watermark column.
        let newest: number | null = null;
        let parsedAny = false;
        for (const r of ctx.rows) {
          const ms = toTimestamp(r[col]);
          if (ms === null) continue;
          parsedAny = true;
          if (newest === null || ms > newest) newest = ms;
        }
        if (!parsedAny) {
          return {
            ...base,
            status: "error",
            detail: ctx.rows.length
              ? `No parseable dates in "${col}" — freshness cannot be measured.`
              : `The dataset is empty, so "${col}" has no timestamp to check.`,
          };
        }
        stampMs = newest;
        label = `newest ${col}`;
      } else {
        stampMs = ctx.lastLoadedAt ? toTimestamp(ctx.lastLoadedAt) : null;
        if (stampMs === null) {
          return { ...base, status: "error", detail: "The dataset has no recorded load time." };
        }
        label = "last loaded";
      }
      // Clock skew between the writer and this process can put a stamp in the
      // future; treat that as age zero rather than reporting a negative age.
      const age = Math.max(0, now - (stampMs ?? 0));
      const ok = age <= maxAgeMs;
      return {
        ...base,
        status: ok ? "pass" : "fail",
        failingRows: ok ? 0 : 1,
        detail: ok
          ? `${fmtAge(age)} old (${label}); limit ${test.config.max_age_hours}h`
          : `Stale: ${fmtAge(age)} old (${label}), which is past the ${test.config.max_age_hours}h limit.`,
      };
    }

    // Everything below is row-scoped and needs the column to exist.
    if (!col) return { ...base, status: "error", detail: "No column configured." };
    if (ctx.rows.length > 0 && !ctx.rows.some((r) => col in r)) {
      return { ...base, status: "error", detail: `Column "${col}" is not in this dataset.` };
    }

    if (test.kind === "not_null") {
      let bad = 0;
      for (const r of ctx.rows) if (isBlank(r[col])) bad++;
      return {
        ...base,
        failingRows: bad,
        status: bad === 0 ? "pass" : "fail",
        detail: withCapNote(
          bad === 0
            ? `No empty values in "${col}".`
            : `${bad.toLocaleString()} empty value${bad === 1 ? "" : "s"} in "${col}".`,
          ctx,
        ),
      };
    }

    if (test.kind === "unique") {
      // Nulls are ignored, matching SQL UNIQUE and dbt's unique test — pair
      // this with not_null when empties are also unacceptable.
      const counts = new Map<string, number>();
      for (const r of ctx.rows) {
        const v = r[col];
        if (isBlank(v)) continue;
        const k = String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let bad = 0;
      const worst: [string, number][] = [];
      for (const [k, n] of counts) {
        if (n > 1) {
          bad += n;
          worst.push([k, n]);
        }
      }
      worst.sort((a, b) => b[1] - a[1]);
      return {
        ...base,
        failingRows: bad,
        status: bad === 0 ? "pass" : "fail",
        detail: withCapNote(
          bad === 0
            ? `All ${counts.size.toLocaleString()} non-empty values in "${col}" are distinct.`
            : `${bad.toLocaleString()} rows share a duplicated "${col}" — e.g. ${worst
                .slice(0, SAMPLES)
                .map(([k, n]) => `${JSON.stringify(k)} ×${n}`)
                .join(", ")}.`,
          ctx,
        ),
      };
    }

    if (test.kind === "accepted_values") {
      const allowed = new Set((test.config.values ?? []).map((v) => String(v)));
      let bad = 0;
      const seen = new Set<string>();
      for (const r of ctx.rows) {
        const v = r[col];
        if (isBlank(v)) continue; // nulls are the not_null test's job
        const k = String(v);
        if (!allowed.has(k)) {
          bad++;
          if (seen.size < SAMPLES) seen.add(k);
        }
      }
      return {
        ...base,
        failingRows: bad,
        status: bad === 0 ? "pass" : "fail",
        detail: withCapNote(
          bad === 0
            ? `Every non-empty "${col}" is in the accepted list.`
            : `${bad.toLocaleString()} rows have an unexpected "${col}" — e.g. ${[...seen]
                .map((v) => JSON.stringify(v))
                .join(", ")}.`,
          ctx,
        ),
      };
    }

    // range
    const { min, max } = test.config;
    let bad = 0;
    let nonNumeric = 0;
    const seen = new Set<string>();
    for (const r of ctx.rows) {
      const v = r[col];
      if (isBlank(v)) continue;
      const n = toNumber(v);
      if (n === null) {
        nonNumeric++;
        bad++;
        if (seen.size < SAMPLES) seen.add(String(v));
        continue;
      }
      if ((min != null && n < min) || (max != null && n > max)) {
        bad++;
        if (seen.size < SAMPLES) seen.add(String(n));
      }
    }
    const bounds =
      min != null && max != null ? `${min}–${max}` : min != null ? `≥ ${min}` : `≤ ${max}`;
    return {
      ...base,
      failingRows: bad,
      status: bad === 0 ? "pass" : "fail",
      detail: withCapNote(
        bad === 0
          ? `Every non-empty "${col}" is within ${bounds}.`
          : `${bad.toLocaleString()} rows fall outside ${bounds}${
              nonNumeric ? ` (${nonNumeric.toLocaleString()} not numeric)` : ""
            } — e.g. ${[...seen].join(", ")}.`,
        ctx,
      ),
    };
  } catch (e) {
    return { ...base, status: "error", detail: (e as Error).message.slice(0, 300) };
  }
}

// ── Roll-up ──────────────────────────────────────────────────────────────

export type QualityRollup = {
  /** "unknown" = no tests, or none has ever run. */
  status: "pass" | "warn" | "fail" | "error" | "unknown";
  passed: number;
  failed: number;
  warned: number;
  errored: number;
  total: number;
  ranAt: string | null;
};

/**
 * Combine a dataset's newest result per test into one status.
 *
 * A failing `warn` test degrades to "warn", never to "fail" — that is the
 * whole point of the severity flag, and it is what keeps the certification
 * badge meaningful instead of permanently red because of one soft check.
 */
export function rollupQuality(
  tests: Pick<QualityTest, "id" | "severity" | "enabled">[],
  latest: Map<string, Pick<QualityResult, "status" | "ran_at">>,
): QualityRollup {
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let errored = 0;
  let total = 0;
  let ranAt: string | null = null;

  for (const t of tests) {
    if (!t.enabled) continue;
    total++;
    const r = latest.get(t.id);
    if (!r) continue;
    if (!ranAt || r.ran_at > ranAt) ranAt = r.ran_at;
    if (r.status === "pass") passed++;
    else if (r.status === "error") errored++;
    else if (t.severity === "warn") warned++;
    else failed++;
  }

  const status =
    total === 0 || (passed === 0 && failed === 0 && warned === 0 && errored === 0)
      ? "unknown"
      : failed > 0
        ? "fail"
        : errored > 0
          ? "error"
          : warned > 0
            ? "warn"
            : "pass";
  return { status, passed, failed, warned, errored, total, ranAt };
}
