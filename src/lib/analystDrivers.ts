// Driver analysis: WHY a number moved, decomposed by dimension.
//
// "Revenue fell 8%" is a fact. "Revenue fell 8% because EMEA enterprise
// renewals fell 22%, which is 140% of the total decline, partly offset by
// SMB growth" is an answer. Getting from one to the other is arithmetic,
// not judgement — so the model writes the SQL that fetches two periods by
// dimension, and THIS module does the maths.
//
// That split is deliberate. A language model asked to "work out which
// segment drove the drop" will produce a confident paragraph whose numbers
// are approximately right, and approximately right contributions are worse
// than none: they rank the wrong driver first and nobody can see why. Here
// the ranking is computed, reproducible, and the same every run.
//
// Nothing in this file talks to a database, a model, or React.

/** One dimension value's before/after pair. */
export type DriverInput = {
  label: string;
  previous: number;
  current: number;
};

export type DriverContribution = {
  label: string;
  previous: number;
  current: number;
  /** current − previous. */
  change: number;
  /** change ÷ previous, or null when previous was 0 (no percentage exists). */
  pctChange: number | null;
  /**
   * This member's share of the TOTAL change, as a fraction.
   *
   * Can exceed 1 or go negative, and that is the point: when winners and
   * losers offset, a member can account for 140% of a small net decline.
   * Clamping it to look tidy would hide exactly the story worth telling.
   * Null when the total change is 0 — every share would be a division by
   * zero, and "infinite contribution" is not a finding.
   */
  shareOfChange: number | null;
  direction: "up" | "down" | "flat";
};

export type DriverAnalysis = {
  previousTotal: number;
  currentTotal: number;
  totalChange: number;
  totalPctChange: number | null;
  /** Every member, ranked by absolute contribution (biggest mover first). */
  contributions: DriverContribution[];
  /** Members that moved the total in its own direction, biggest first. */
  drivers: DriverContribution[];
  /** Members that moved AGAINST the total — the offsets the headline hides. */
  offsets: DriverContribution[];
  /** Members present in one period only, which need saying out loud. */
  appeared: string[];
  disappeared: string[];
};

const near = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n);

/**
 * Decompose a change into per-member contributions.
 *
 * `previous`/`current` may list different members; a member missing from
 * one side counts as 0 there AND is reported in `appeared`/`disappeared`,
 * because "grew from nothing" and "grew" are different claims.
 */
export function analyseDrivers(rows: DriverInput[]): DriverAnalysis {
  const previousTotal = near(rows.reduce((a, r) => a + r.previous, 0));
  const currentTotal = near(rows.reduce((a, r) => a + r.current, 0));
  const totalChange = near(currentTotal - previousTotal);

  const contributions: DriverContribution[] = rows
    .map((r) => {
      const change = near(r.current - r.previous);
      return {
        label: r.label,
        previous: r.previous,
        current: r.current,
        change,
        pctChange: r.previous === 0 ? null : change / r.previous,
        shareOfChange: totalChange === 0 ? null : change / totalChange,
        direction:
          change > 0 ? ("up" as const) : change < 0 ? ("down" as const) : ("flat" as const),
      };
    })
    // Biggest absolute mover first: the ranking a reader wants is "what
    // moved most", not "what is alphabetically first" or "what is biggest".
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.label.localeCompare(b.label));

  const totalDir = totalChange > 0 ? "up" : totalChange < 0 ? "down" : "flat";
  return {
    previousTotal,
    currentTotal,
    totalChange,
    totalPctChange: previousTotal === 0 ? null : totalChange / previousTotal,
    contributions,
    drivers: totalDir === "flat" ? [] : contributions.filter((c) => c.direction === totalDir),
    offsets:
      totalDir === "flat"
        ? []
        : contributions.filter((c) => c.direction !== totalDir && c.direction !== "flat"),
    appeared: rows.filter((r) => r.previous === 0 && r.current !== 0).map((r) => r.label),
    disappeared: rows.filter((r) => r.previous !== 0 && r.current === 0).map((r) => r.label),
  };
}

/**
 * Read a two-period result into driver inputs.
 *
 * The SQL the model is asked for returns one row per dimension value with a
 * previous and a current measure. Column names vary by model and dialect,
 * so they are matched by INTENT rather than pinned: whatever looks like the
 * label, and whichever two numeric columns read as before/after.
 *
 * Returns null when the shape does not support the analysis. Returning a
 * guess here would be the worst option available — the numbers would look
 * exactly as authoritative as correct ones.
 */
export function driverInputsFrom(
  columns: string[],
  rows: Record<string, unknown>[],
): DriverInput[] | null {
  if (rows.length === 0) return null;
  const numeric = columns.filter((c) =>
    rows.some((r) => typeof r[c] === "number" && Number.isFinite(r[c] as number)),
  );
  if (numeric.length < 2) return null;

  const score = (c: string, kind: "prev" | "curr") => {
    const n = c.toLowerCase();
    const prevWords = ["prev", "before", "baseline", "last", "prior", "py", "lm"];
    const currWords = ["curr", "current", "after", "now", "this", "latest", "cy", "tm"];
    const words = kind === "prev" ? prevWords : currWords;
    return words.some((w) => n.includes(w)) ? 1 : 0;
  };
  const prevCol = numeric.find((c) => score(c, "prev")) ?? numeric[0];
  const currCol =
    numeric.find((c) => c !== prevCol && score(c, "curr")) ?? numeric.find((c) => c !== prevCol);
  if (!currCol) return null;

  // The label is the first non-numeric column; without one there is nothing
  // to attribute the change TO, which is the whole analysis.
  const labelCol = columns.find((c) => !numeric.includes(c));
  if (!labelCol) return null;

  return rows.map((r) => ({
    label: String(r[labelCol] ?? "(blank)"),
    previous: typeof r[prevCol] === "number" ? (r[prevCol] as number) : 0,
    current: typeof r[currCol] === "number" ? (r[currCol] as number) : 0,
  }));
}

/**
 * The contribution story as text for the write-up prompt.
 *
 * The synthesis model gets THESE numbers rather than the raw rows, so the
 * paragraph it writes cites arithmetic that was computed, not estimated.
 */
export function describeDrivers(a: DriverAnalysis, measure = "the measure"): string {
  const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  const num = (n: number) => Number(n.toFixed(4)).toLocaleString("en-US");
  const line = (c: DriverContribution) =>
    `${c.label}: ${num(c.previous)} -> ${num(c.current)} (${c.change >= 0 ? "+" : ""}${num(
      c.change,
    )}, ${pct(c.pctChange)}; ${pct(c.shareOfChange)} of the total change)`;

  const parts = [
    `${measure} moved from ${num(a.previousTotal)} to ${num(a.currentTotal)} ` +
      `(${a.totalChange >= 0 ? "+" : ""}${num(a.totalChange)}, ${pct(a.totalPctChange)}).`,
    a.drivers.length > 0
      ? `DRIVERS (moved it the same way):\n${a.drivers.map(line).join("\n")}`
      : "",
    a.offsets.length > 0
      ? `OFFSETS (moved against it — the headline hides these):\n${a.offsets.map(line).join("\n")}`
      : "",
    a.appeared.length > 0 ? `Present only in the current period: ${a.appeared.join(", ")}.` : "",
    a.disappeared.length > 0
      ? `Present only in the previous period: ${a.disappeared.join(", ")}.`
      : "",
    a.totalChange === 0
      ? "The total did not move, so no share-of-change exists; members may still have offset each other."
      : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}
