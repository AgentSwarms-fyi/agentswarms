// Capacity: how much of a workspace's data is materialised, and what gives
// when the budget is full.
//
// A dataset can be queried two ways. IMPORT reads a columnar mirror — fast,
// and bounded by disk. DIRECT reads the source every time — always current,
// and bounded by the source. QuickSight calls these SPICE and Direct Query;
// the trade is the same everywhere and there is no universally right answer,
// which is exactly why it should be a choice rather than an accident of which
// code path a dataset happened to take.
//
// EVICTION MUST NEVER CHANGE AN ANSWER. This is the rule the whole module is
// built around. Dropping a mirror makes a query slower — it falls back to
// reading rows from the store — and it must not make the query WRONG or make
// it silently answer from less data. That is why eviction only ever removes a
// cache, never narrows a scope, and why every eviction is reported rather than
// performed quietly. A capacity system that silently degrades results is worse
// than one that refuses, because nobody can see it happen.
//
// AND AN EXPLICIT CHOICE OUTRANKS A HEURISTIC. A dataset the user pinned to
// `import` is evicted only after every `auto` one has gone. Least-recently-used
// is a good guess about what matters; a person saying "keep this one" is not a
// guess.

export type StorageMode = "auto" | "import" | "direct";

/** What a dataset costs and when it was last read. */
export type MirrorEntry = {
  tableId: string;
  name: string;
  /** Bytes on disk. 0 or missing = not materialised. */
  bytes: number;
  rows: number;
  mode: StorageMode;
  /** ISO timestamp of the last query that read this mirror. */
  lastUsedAt?: string | null;
};

/** The effective decision for one dataset, and why. */
export type ModeDecision = {
  mode: "import" | "direct";
  /** Shown to the user — a mode nobody can explain is a mode nobody trusts. */
  reason: string;
};

/**
 * Resolve `auto` into a real decision.
 *
 * `auto` mirrors what is worth mirroring: big enough that the round-trip is
 * saved, small enough to be worth the disk. Explicit modes are returned
 * untouched — the point of choosing is that the choice is honoured.
 */
export function resolveMode(args: {
  mode: StorageMode;
  rows: number;
  /** Below this, mirroring costs more than it saves. */
  minRows: number;
  /** Above this, one dataset would monopolise the budget. */
  maxRows: number;
}): ModeDecision {
  if (args.mode === "import") {
    return { mode: "import", reason: "Set to import by you." };
  }
  if (args.mode === "direct") {
    return { mode: "direct", reason: "Set to direct query by you." };
  }
  if (args.rows < args.minRows) {
    return {
      mode: "direct",
      reason: `Only ${args.rows.toLocaleString()} rows — too small for a mirror to pay for itself.`,
    };
  }
  if (args.rows > args.maxRows) {
    return {
      mode: "direct",
      reason:
        `${args.rows.toLocaleString()} rows is above the mirror limit ` +
        `(${args.maxRows.toLocaleString()}); queries run against the source.`,
    };
  }
  return { mode: "import", reason: "Mirrored automatically — a good size for it." };
}

export type EvictionPlan = {
  /** Datasets to drop, in the order they should go. */
  evict: MirrorEntry[];
  /** Bytes still held after evicting. */
  keptBytes: number;
  /** Bytes over budget BEFORE evicting; 0 when it already fit. */
  overBy: number;
  /**
   * Every mirror had to go to fit.
   *
   * This is the honest version of "impossible": since eviction removes bytes,
   * clearing everything always gets under budget, so a plan can never truly
   * fail. What it CAN do is leave nothing materialised — which means the
   * budget is smaller than the workspace's data and the setting is doing
   * nothing but slow queries down. That is worth saying out loud.
   */
  clearedAll: boolean;
};

/**
 * Choose what to drop to get under a byte budget.
 *
 * Order: `auto` mirrors first, least-recently-used within that, then `import`
 * ones by the same rule. Something never read has no `lastUsedAt` and goes
 * before anything that has been read, because "never used" is the strongest
 * evidence a mirror is not earning its space.
 *
 * A budget of 0 or less means unlimited — an unset budget must not silently
 * evict everything, which is the failure mode of treating "" as 0.
 */
export function planEviction(entries: MirrorEntry[], budgetBytes: number): EvictionPlan {
  const held = entries.filter((e) => e.bytes > 0);
  const total = held.reduce((n, e) => n + e.bytes, 0);
  if (budgetBytes <= 0 || total <= budgetBytes) {
    return { evict: [], keptBytes: total, overBy: 0, clearedAll: false };
  }

  const rank = (e: MirrorEntry) => (e.mode === "import" ? 1 : 0);
  const used = (e: MirrorEntry) => (e.lastUsedAt ? Date.parse(e.lastUsedAt) : 0);
  const order = [...held].sort((a, b) => rank(a) - rank(b) || used(a) - used(b));

  const evict: MirrorEntry[] = [];
  let kept = total;
  for (const e of order) {
    if (kept <= budgetBytes) break;
    evict.push(e);
    kept -= e.bytes;
  }
  return {
    evict,
    keptBytes: kept,
    overBy: total - budgetBytes,
    // Nothing left materialised: the budget cannot hold this workspace's data
    // at all, so it is buying nothing and costing speed.
    clearedAll: held.length > 0 && evict.length === held.length,
  };
}

/** Bytes as something a person reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/**
 * The capacity line.
 *
 * States the budget even when there is plenty left, because "how much room do
 * I have" is the question this page exists to answer, and only showing it near
 * the limit means it is missing exactly when someone is planning.
 */
export function describeCapacity(usedBytes: number, budgetBytes: number): string {
  if (budgetBytes <= 0) {
    return `${formatBytes(usedBytes)} materialised — no budget set, so nothing is evicted.`;
  }
  const pct = Math.min(999, Math.round((usedBytes / budgetBytes) * 100));
  return `${formatBytes(usedBytes)} of ${formatBytes(budgetBytes)} used (${pct}%).`;
}

/**
 * What to tell the reader after an eviction pass.
 *
 * Names the datasets. "Some mirrors were evicted" is the kind of message that
 * makes a slow dashboard unexplainable a week later.
 */
export function describeEviction(plan: EvictionPlan): string | null {
  if (plan.evict.length === 0) return null;
  const names = plan.evict.map((e) => e.name).join(", ");
  const tail = plan.clearedAll
    ? " Nothing is mirrored now — the budget is smaller than the data, so raise it or set fewer datasets to import."
    : "";
  return (
    `Freed ${formatBytes(plan.evict.reduce((n, e) => n + e.bytes, 0))} by dropping ` +
    `${plan.evict.length} mirror${plan.evict.length === 1 ? "" : "s"}: ${names}. ` +
    `Those datasets still answer correctly — they now read from the row store, which is slower.${tail}`
  );
}

/**
 * Disclosure for a query whose scope a cap actually narrowed.
 *
 * Separate from eviction on purpose: eviction costs speed, a row cap costs
 * COMPLETENESS, and only the second one changes what the numbers mean.
 */
export function describeRowCap(args: {
  returned: number;
  cap: number;
  mode: "import" | "direct";
}): string | null {
  if (args.returned < args.cap) return null;
  return (
    `Showing the first ${args.cap.toLocaleString()} rows — the ${args.mode} limit. ` +
    `This is a partial result, not the whole table.`
  );
}
