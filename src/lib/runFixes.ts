// A run that keeps failing, and the one change that would fix it (R525).
//
// The Runs page said why a run failed and could hand the error to the
// assistant. What it could not do was change anything. Here the platform
// recognises failures it understands exactly and proposes a change to the
// thing that failed, which its owner applies or approves.
//
// RECOGNISED, NOT IMAGINED. A change applied on someone's yes has to be exact:
// the column a check reads, whether a schedule runs. So the fixes come from a
// short catalogue with rules over the run history and the table's own columns,
// and each is checked again on the server before it is applied. Everything
// else stays with the assistant, which explains an error but changes nothing.
//
// NEVER A FIX FOR AN OUTAGE OR AN ALERT. A service that was unreachable
// recovers by itself, and pausing a check because of it would hide the next
// real failure. A check that alerts on the data is working; quietening it is
// not a fix. Both get a sentence saying so, and no proposal.

/** The approvals' action_type for a suggested fix to something that keeps failing. */
export const RUN_FIX_ACTION = "run.fix";

export type FixTargetType = "data_monitor" | "etl_pipeline";
export type FixTarget = { type: FixTargetType; id: string };

export type RunFix =
  /** A freshness check reading a column that holds no dates: read this one instead. */
  | { fix: "timestamp_column"; column: string; from: string | null }
  /** Stop its schedule: it fails the same way every time and nothing else will change that. */
  | { fix: "pause" };

export type FixProposal = {
  target: FixTarget;
  name: string;
  fix: RunFix;
  /** What the change is, in a few words. */
  title: string;
  /** Why it failed, in one sentence (the dialog shows it once, as its diagnosis). */
  cause: string;
  /** Why this change fixes it. */
  why: string;
  /** What the proposal rests on: "The last 12 runs failed the same way." */
  evidence: string;
};

export type FixVerdict = {
  /** Why it failed, or why no change is proposed. */
  diagnosis: string;
  proposal: FixProposal | null;
};

/** One past run of the thing, newest first. */
export type PastRun = {
  /** The raw status word: ok, alert, error, failed, succeeded… */
  status: string;
  error: string | null;
};

export type FixInput = {
  target: FixTarget;
  name: string;
  active: boolean;
  /** A data monitor's kind (freshness, volume…). */
  monitorKind?: string | null;
  /** The column a freshness check reads now. */
  column?: string | null;
  /** The table's columns, when they could be read. */
  columns?: ReadonlyArray<{ name: string; type: string }> | null;
  runs: readonly PastRun[];
  /** True when the history read stopped at its cap, so a count is "or more". */
  capped?: boolean;
};

/** Failures that end without anyone changing anything: a service was down or busy. */
const TRANSIENT = [
  /could not connect|unable to connect|failed to connect|connection (refused|reset|closed)/i,
  /econnrefused|econnreset|etimedout|enotfound|eai_again|fetch failed|socket hang up/i,
  /timed? ?out|timeout/i,
  /interrupt(ed)?\b/i,
  /failed to attach ducklake|failed to query most recent snapshot/i,
  /docker (socket|daemon)|socket-proxy|never acquired a sandbox/i,
  /\b(429|502|503|504)\b|rate limit|too many (requests|connections)|temporarily unavailable/i,
  /a secret this pipeline uses changed while it ran/i,
];

export function isTransient(error: string | null | undefined): boolean {
  return !!error && TRANSIENT.some((re) => re.test(error));
}

/** Two errors are "the same" when they differ only in numbers, ids and spacing. */
export function errorSignature(error: string | null | undefined): string {
  return (error ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** A status that means the run could not do its job, not that the data alerted. */
const COULD_NOT_RUN = /^(error|errored|failed|failure|timeout|timed_out|crashed)$/i;

/**
 * How many of the newest runs failed the way `same` says, and how many outages
 * came between them. An outage says nothing about whether the thing itself
 * is broken, so it neither counts nor ends the streak (FOUND FROM THE UI,
 * R525: one "could not attach the catalog" during a restart made 752 failed
 * runs read as "the last 8").
 */
export function streakOf(
  runs: readonly PastRun[],
  same: (r: PastRun) => boolean,
): { count: number; outages: number } {
  let count = 0;
  let outages = 0;
  for (const r of runs) {
    if (r.error && same(r)) count++;
    else if (count > 0 && isTransient(r.error)) outages++;
    else break;
  }
  return { count, outages };
}

/** How many of the newest runs share the newest run's error, outages aside. */
export function sameFailureStreak(runs: readonly PastRun[]): number {
  const first = runs[0];
  if (!first || !first.error) return 0;
  const sig = errorSignature(first.error);
  return streakOf(runs, (r) => errorSignature(r.error) === sig).count;
}

/** The freshness check's own message when its column holds no dates. */
const NOT_A_TIME = /not a date or time/i;

const TIME_TYPE = /\b(timestamp|timestamptz|datetime|date|time)\b/i;
const NAME_RANK: ReadonlyArray<RegExp> = [
  /(^|_)(updated|modified|changed)(_?at|_?on|_?time)?$/i,
  /(^|_)(loaded|ingested|synced|refreshed|inserted)(_?at|_?on|_?time)?$/i,
  /(^|_)(created)(_?at|_?on|_?time)?$/i,
  /(_at|_time|_ts|timestamp)$/i,
  /(date|_on)$/i,
];

/**
 * The column a freshness check should read: one whose declared type is a date
 * or time, preferring the names that say when a row last changed. Null when
 * the table has none.
 */
export function pickTimestampColumn(
  columns: ReadonlyArray<{ name: string; type: string }>,
  exclude?: string | null,
): string | null {
  const ex = exclude?.trim().toLowerCase();
  const candidates = columns.filter(
    (c) => TIME_TYPE.test(c.type) && !/interval/i.test(c.type) && c.name.toLowerCase() !== ex,
  );
  if (!candidates.length) return null;
  const rank = (name: string) => {
    const i = NAME_RANK.findIndex((re) => re.test(name));
    return i === -1 ? NAME_RANK.length : i;
  };
  return [...candidates].sort((a, b) => rank(a.name) - rank(b.name))[0].name;
}

/** Repeats needed before stopping a schedule is suggested. */
export const PAUSE_AFTER = 3;

const runsWord = (n: number, capped: boolean) =>
  capped ? `The last ${n} runs or more` : n === 1 ? "The last run" : `The last ${n} runs`;

const what = (t: FixTargetType) => (t === "data_monitor" ? "check" : "pipeline");

/** Whether there is a change that would fix it, and why or why not. */
export function proposeRunFix(input: FixInput): FixVerdict {
  const latest = input.runs[0];
  if (!latest) return { diagnosis: "It has not run yet.", proposal: null };
  if (!latest.error) return { diagnosis: "Its latest run did not fail.", proposal: null };
  const noun = what(input.target.type);
  if (!input.active) {
    return {
      diagnosis: `The ${noun} is already paused, so it will not fail again.`,
      proposal: null,
    };
  }
  const sig = errorSignature(latest.error);
  const streak = streakOf(input.runs, (r) => errorSignature(r.error) === sig);
  const evidenceOf = ({ count, outages }: { count: number; outages: number }) =>
    `${runsWord(count, !!input.capped && count + outages >= input.runs.length)} failed the same way` +
    (outages
      ? ` (not counting ${outages === 1 ? "one" : outages} when a service it needs was down).`
      : ".");
  const base = { target: input.target, name: input.name };

  // A freshness check reading a column that holds no dates.
  if (
    input.target.type === "data_monitor" &&
    input.monitorKind === "freshness" &&
    NOT_A_TIME.test(latest.error)
  ) {
    const cause = `It checks how recent the newest value in ${input.column ? `"${input.column}"` : "its column"} is, and that column does not hold dates or times.`;
    // Counted by what the message says, not its text: it quotes the value it
    // found, which can change from run to run.
    const evidence = evidenceOf(streakOf(input.runs, (r) => NOT_A_TIME.test(r.error ?? "")));
    if (!input.columns) {
      return {
        diagnosis: `${cause} The table's columns could not be read, so no other column can be suggested.`,
        proposal: null,
      };
    }
    const column = pickTimestampColumn(input.columns, input.column);
    if (column) {
      return {
        diagnosis: cause,
        proposal: {
          ...base,
          fix: { fix: "timestamp_column", column, from: input.column ?? null },
          title: `Check "${column}" instead${input.column ? ` of "${input.column}"` : ""}`,
          cause,
          why: `"${column}" is the table's date or time column that says best when a row last changed.`,
          evidence,
        },
      };
    }
    return {
      diagnosis: `${cause} The table has no date or time column at all.`,
      proposal: {
        ...base,
        fix: { fix: "pause" },
        title: "Pause this check",
        cause,
        why: "No column of the table holds dates or times, so a freshness check cannot run on it.",
        evidence,
      },
    };
  }

  if (isTransient(latest.error)) {
    return {
      diagnosis:
        "A service it needs was unreachable or busy. Nothing in its settings caused this, and it runs again on its schedule.",
      proposal: null,
    };
  }
  if (!COULD_NOT_RUN.test(latest.status)) {
    return {
      diagnosis:
        "The check ran and the data broke its rule. That is the check working: fix the data, or change the rule if the rule is wrong.",
      proposal: null,
    };
  }
  if (streak.count >= PAUSE_AFTER) {
    const cause = `It fails the same way every time it runs: ${oneLine(latest.error)}`;
    return {
      diagnosis: cause,
      proposal: {
        ...base,
        fix: { fix: "pause" },
        title: `Pause this ${noun}`,
        cause,
        why: "Running it again will not change that. Turn it back on once the cause is fixed.",
        evidence: evidenceOf(streak),
      },
    };
  }
  return {
    diagnosis: `It has not failed the same way often enough to suggest stopping it (${streak.count} of ${PAUSE_AFTER}). The assistant can explain the error.`,
    proposal: null,
  };
}

function oneLine(s: string): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Same change, same thing: asked about once. */
export function fixSignature(target: FixTarget, fix: RunFix): string {
  return `${target.type}:${target.id}:${fix.fix}:${fix.fix === "timestamp_column" ? fix.column.toLowerCase() : ""}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fix read back from an approval's payload, which its owner can write: checked field by field. */
export function fixFromPayload(payload: unknown): { target: FixTarget; fix: RunFix } | null {
  const p = payload as {
    target?: { type?: unknown; id?: unknown };
    fix?: Record<string, unknown>;
  } | null;
  const type = p?.target?.type;
  const id = p?.target?.id;
  if (
    (type !== "data_monitor" && type !== "etl_pipeline") ||
    typeof id !== "string" ||
    !UUID.test(id)
  )
    return null;
  const f = p?.fix;
  if (f?.fix === "pause") return { target: { type, id }, fix: { fix: "pause" } };
  if (
    f?.fix === "timestamp_column" &&
    type === "data_monitor" &&
    typeof f.column === "string" &&
    f.column.trim() &&
    f.column.length <= 128
  ) {
    return {
      target: { type, id },
      fix: {
        fix: "timestamp_column",
        column: f.column,
        from: typeof f.from === "string" ? f.from : null,
      },
    };
  }
  return null;
}
