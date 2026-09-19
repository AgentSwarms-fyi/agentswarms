// Checking the numbers an AI wrote against the numbers the data produced.
//
// An insight card headed "What the data shows" once reported regional shares of
// 48% / 39% / 19% — three shares of one total, summing to 106%. Handing the
// model computed facts stopped it inventing that particular figure, but it only
// made the mistake less likely. Nothing checked.
//
// This checks. Every numeral in generated prose is extracted and matched
// against what the query actually returned: the row values, the totals, ranges
// and means computed over every row, and the shares. A numeral that matches
// nothing is not evidence of a lie — but it is a number no reader can verify
// and no author can defend, and it should not reach a page headed "what the
// data shows".
//
// Deterministic on purpose. No model call, no cost, the same verdict every
// time — the same choice the insight sweep makes, and the reason anyone can
// trust its answer. The model proposes; this decides.
//
// It is also the first half of citations: once a figure is matched to the fact
// that produced it, showing the reader WHICH fact is presentation over data
// this already computes.
import type { InsightFacts } from "@/lib/biInsightFacts";

/** A numeral found in prose, with the value it denotes. */
export type NumericClaim = {
  /** Exactly as written, e.g. "$1.2M", "48%", "410,379.26". */
  raw: string;
  /** Character offset in the prose, so a caller can annotate in place. */
  at: number;
  /** The value it denotes: "1.2M" → 1200000, "48%" → 48. */
  value: number;
  /** A percentage is checked against shares, not against row values. */
  isPercent: boolean;
  /**
   * Half the last place the writer chose to show.
   *
   * "$1.0M" is not a claim about 1,000,000 — it is a claim about anything that
   * rounds to 1.0M, so the admissible window is ±50,000. Deriving tolerance
   * from the written precision is what lets a card round for readability, as
   * the prompt asks it to, without the check becoming meaningless.
   */
  tolerance: number;
};

export type ClaimVerdict = NumericClaim & {
  /** What the figure matched, when it matched something. */
  matched: {
    kind: "row" | "total" | "min" | "max" | "mean" | "share" | "count";
    label: string;
  } | null;
};

const SUFFIX: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
};

// A currency mark, digits with optional thousands separators and decimal, an
// optional magnitude, an optional percent.
//
// The magnitude rule is the fiddly part, and it is the one that bit. A single
// LETTER must sit directly against the digits — "$1.2M", "3.4k" — because
// allowing a space between them turned "March 2024 both recording…" into
// 2024 BILLION: the "b" of "both" was read as the suffix, which also meant the
// value stopped looking like a year and got flagged as unverifiable. The same
// trap waits in "300 basis points" and "12 bottles". A spelled-out magnitude
// may take a space, since "$2.3 million" cannot be misread that way.
const NUMERAL = new RegExp(
  String.raw`(?<![\w.])([$€£¥]\s?)?(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)` +
    String.raw`(?:\s?(thousand|million|billion|trillion)\b|([kKmMbBtT])(?![A-Za-z]))?\s?(%)?`,
  "gi",
);

/** Decimal places written, ignoring thousands separators. */
function decimalsOf(digits: string): number {
  const dot = digits.indexOf(".");
  return dot === -1 ? 0 : digits.length - dot - 1;
}

/**
 * Every figure a reader would take as a claim about the data.
 *
 * Skips numerals that are plainly not measurements — a four-digit year, and
 * anything inside a word like an id — because flagging "2024" in "revenue in
 * 2024" as unverifiable would train everyone to ignore the flag.
 */
export function extractClaims(prose: string): NumericClaim[] {
  const out: NumericClaim[] = [];
  NUMERAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMERAL.exec(prose)) !== null) {
    const [, currency, digits, word, letter, percent] = m;
    const suffix = word ?? letter;
    const at = m.index;
    const raw = m[0].trim();
    const plain = digits.replace(/,/g, "");
    const base = Number(plain);
    if (!Number.isFinite(base)) continue;

    const mult = suffix ? SUFFIX[suffix.toLowerCase()] : 1;
    const isPercent = Boolean(percent);

    // A bare four-digit integer with no currency, suffix or percent reads as a
    // year in this context far more often than as a measurement.
    if (!currency && !suffix && !percent && !plain.includes(".") && base >= 1000 && base <= 9999) {
      continue;
    }

    const dp = decimalsOf(plain);
    // The last place shown: 1.2M → 0.1M; 410,379.26 → 0.01; 48% → 1%.
    const lastPlace = Math.pow(10, -dp) * mult;
    out.push({
      raw,
      at,
      value: base * mult,
      isPercent,
      tolerance: lastPlace / 2,
    });
  }
  return out;
}

type GroundKind = NonNullable<ClaimVerdict["matched"]>["kind"];
type Ground = { v: number; kind: GroundKind; label: string };

/** Values the prose is allowed to state, each with the name of its source. */
function groundingSet(
  facts: InsightFacts | null,
  rows: Record<string, unknown>[],
): { values: Ground[]; percents: { v: number; label: string }[] } {
  const values: Ground[] = [];
  const percents: { v: number; label: string }[] = [];

  // The row count is a number a card legitimately states ("across 36 months").
  values.push({ v: rows.length, kind: "count", label: "row count" });

  for (const r of rows) {
    for (const [k, raw] of Object.entries(r)) {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (Number.isFinite(n)) values.push({ v: n, kind: "row", label: k });
    }
  }

  if (facts) {
    for (const m of facts.measures) {
      values.push({ v: m.total, kind: "total", label: m.name });
      values.push({ v: m.min, kind: "min", label: m.name });
      values.push({ v: m.max, kind: "max", label: m.name });
      values.push({ v: m.mean, kind: "mean", label: m.name });
    }
    for (const s of facts.shares) {
      values.push({ v: s.value, kind: "share", label: s.label });
      percents.push({ v: s.pct, label: s.label });
    }
  }
  return { values, percents };
}

/**
 * Verify every figure in generated prose against the data behind it.
 *
 * A verdict with `matched: null` is the interesting one: a number the reader
 * cannot check. The caller decides what to do about it — this only decides
 * whether it is true, because that part must not be a judgement call.
 */
export function verifyClaims(
  prose: string,
  facts: InsightFacts | null,
  rows: Record<string, unknown>[],
): ClaimVerdict[] {
  const { values, percents } = groundingSet(facts, rows);
  return extractClaims(prose).map((c) => {
    const pool = c.isPercent
      ? percents.map((p) => ({ v: p.v, kind: "share" as const, label: p.label }))
      : values;
    // Percentages are also legitimately stated as a plain change or rate that
    // happens to equal a row value, so fall back to the value pool rather than
    // flagging a figure the data does contain.
    const hit =
      pool.find((p) => Math.abs(p.v - c.value) <= c.tolerance) ??
      (c.isPercent ? values.find((p) => Math.abs(p.v - c.value) <= c.tolerance) : undefined);
    return { ...c, matched: hit ? { kind: hit.kind, label: hit.label } : null };
  });
}

/** The figures a reader could not check, as written. */
export function unsupportedFigures(verdicts: ClaimVerdict[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of verdicts) {
    if (v.matched || seen.has(v.raw)) continue;
    seen.add(v.raw);
    out.push(v.raw);
  }
  return out;
}
