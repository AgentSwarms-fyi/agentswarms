// A bar race keeps its place, and stays paused when the viewer pauses it.
//
// FOUND IN R233, and the same shape as R215, R218 and R219 (see
// `useResetOnOpen.test.ts`): state reset in an effect keyed on an identity the
// parent rebuilds on every render. Here it was the frames array — a `useMemo`
// over the `rows` prop — so a dashboard re-render, which an active filter, a
// poll or a session refresh each cause, sent the race back to its first frame
// and started it playing again over a viewer who had paused it.
//
// These tests run the hook under a minimal stand-in for React's hook runtime:
// one slot per hook call, state that persists across renders, memos and
// effects recomputed only when their dependencies changed as React compares
// them (Object.is), and effect cleanups run before the effect re-runs. A
// render is explicit, as React's own re-render after a state change is.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const slots: unknown[] = [];
  const pending: (() => void)[] = [];
  const cleanups: Record<number, (() => void) | undefined> = {};
  let cursor = 0;
  return {
    slots,
    pending,
    cleanups,
    begin() {
      cursor = 0;
    },
    next() {
      return cursor++;
    },
  };
});

vi.mock("react", () => ({
  useState<T>(initial: T) {
    const i = runtime.next();
    if (!(i in runtime.slots)) runtime.slots[i] = initial;
    return [
      runtime.slots[i] as T,
      (v: T | ((p: T) => T)) => {
        runtime.slots[i] = typeof v === "function" ? (v as (p: T) => T)(runtime.slots[i] as T) : v;
      },
    ] as const;
  },
  useMemo<T>(factory: () => T, deps: unknown[]) {
    const i = runtime.next();
    const prev = runtime.slots[i] as { deps: unknown[]; value: T } | undefined;
    const changed =
      !prev || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]));
    if (changed) runtime.slots[i] = { deps, value: factory() };
    return (runtime.slots[i] as { deps: unknown[]; value: T }).value;
  },
  useEffect(effect: () => void | (() => void), deps?: unknown[]) {
    const i = runtime.next();
    const prev = runtime.slots[i] as unknown[] | undefined;
    const changed =
      !prev || !deps || deps.length !== prev.length || deps.some((d, k) => !Object.is(d, prev[k]));
    if (!changed) return;
    runtime.slots[i] = deps;
    runtime.pending.push(() => {
      runtime.cleanups[i]?.();
      const cleanup = effect();
      runtime.cleanups[i] = typeof cleanup === "function" ? cleanup : undefined;
    });
  },
}));

const { useMemo } = await import("react");
const { useRacePlayback } = await import("@/lib/racePlayback");

const FRAME_MS = 1100;

type Row = { quarter: string; country: string; twh: number };

/** The grouping `BarRace` does: rows in, one frame per period out. */
function framesOf(rows: Row[]): { frame: string; entries: [string, number][] }[] {
  const byFrame = new Map<string, [string, number][]>();
  for (const r of rows)
    byFrame.set(r.quarter, [...(byFrame.get(r.quarter) ?? []), [r.country, r.twh]]);
  return [...byFrame.keys()].sort().map((frame) => ({ frame, entries: byFrame.get(frame)! }));
}

/** `BarRace`'s own use of the hook: frames memoised over the `rows` prop. */
function Chart(rows: Row[]) {
  const frames = useMemo(() => framesOf(rows), [rows]);
  return useRacePlayback(frames, FRAME_MS);
}

/**
 * One render, then the effects whose dependencies changed.
 *
 * State an effect sets shows on the NEXT render's return, as it does in React,
 * where setting state in an effect schedules another render. So a test that
 * cares about what the viewer ends up seeing renders once more and asserts on
 * that.
 */
function render(rows: Row[]) {
  runtime.begin();
  const state = Chart(rows);
  for (const effect of runtime.pending.splice(0)) effect();
  return state;
}

/** What a dashboard hands down: the same data in a new array, as it always is. */
function sameRows(): Row[] {
  return [
    { quarter: "2024-Q1", country: "Norway", twh: 38 },
    { quarter: "2024-Q2", country: "Norway", twh: 41 },
    { quarter: "2024-Q3", country: "Norway", twh: 44 },
  ];
}

beforeEach(() => {
  runtime.slots.length = 0;
  runtime.pending.length = 0;
  for (const k of Object.keys(runtime.cleanups)) delete runtime.cleanups[Number(k)];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRacePlayback", () => {
  it("advances a frame at a time while it is playing", () => {
    render(sameRows());
    expect(render(sameRows()).idx).toBe(0);
    vi.advanceTimersByTime(FRAME_MS);
    expect(render(sameRows()).idx).toBe(1);
    vi.advanceTimersByTime(FRAME_MS);
    expect(render(sameRows()).idx).toBe(2);
    // Three frames, so it wraps rather than running off the end.
    vi.advanceTimersByTime(FRAME_MS);
    expect(render(sameRows()).idx).toBe(0);
  });

  it("leaves a paused race paused, and where it is, when the rows arrive again", () => {
    render(sameRows());
    vi.advanceTimersByTime(FRAME_MS);
    const playing = render(sameRows());
    expect(playing.idx).toBe(1);

    playing.setPlaying(false);
    const paused = render(sameRows());
    expect(paused).toMatchObject({ idx: 1, playing: false });

    // The dashboard re-renders — a filter changed elsewhere, a poll landed, the
    // session refreshed — and hands down the same series in a new array.
    for (let i = 0; i < 3; i++) {
      const after = render(sameRows());
      expect(after, `re-render ${i + 1}`).toMatchObject({ idx: 1, playing: false });
    }
    // And nothing is advancing it behind the viewer's back.
    vi.advanceTimersByTime(FRAME_MS * 4);
    expect(render(sameRows())).toMatchObject({ idx: 1, playing: false });
  });

  it("keeps advancing when the dashboard re-renders faster than a frame", () => {
    // The advance timer used to be keyed on the frames array too, so a parent
    // re-rendering every few hundred ms cleared and restarted the timeout
    // forever: a race stuck on its first frame while the button said it was
    // playing.
    render(sameRows());
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(400);
      render(sameRows());
    }
    expect(render(sameRows()).idx).toBe(1);
  });

  it("starts a genuinely different series from the beginning, playing", () => {
    render(sameRows());
    vi.advanceTimersByTime(FRAME_MS);
    const state = render(sameRows());
    expect(state.idx).toBe(1);
    state.setPlaying(false);
    render(sameRows());

    const other = sameRows().concat({ quarter: "2024-Q4", country: "Norway", twh: 47 });
    render(other); // the reset effect fires after this render…
    expect(render(other)).toMatchObject({ idx: 0, playing: true }); // …and shows on the next
  });

  it("holds its place when a frame's values change but its periods do not", () => {
    // A drill-down or a re-aggregation rewrites the numbers under the same
    // periods. The index points at a period, so it still means what it meant.
    render(sameRows());
    vi.advanceTimersByTime(FRAME_MS);
    expect(render(sameRows()).idx).toBe(1);
    const restated = sameRows().map((r) => ({ ...r, twh: r.twh * 2 }));
    render(restated);
    expect(render(restated).idx).toBe(1);
  });

  it("does not run a timer for a single-frame race", () => {
    const one: Row[] = [{ quarter: "2024-Q1", country: "Norway", twh: 38 }];
    expect(render(one)).toMatchObject({ idx: 0, playing: true });
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(render(one).idx).toBe(0);
  });
});

describe("BarRace", () => {
  const src = readFileSync("src/components/bi/BiChartParts.tsx", "utf8");

  it("takes its playback from the hook, with no effect of its own on the frames", () => {
    expect(src).toContain("useRacePlayback(frames, frameMs)");
    // The defect, pinned where it was written: any effect keyed on `frames`.
    expect(src).not.toMatch(/\[[^\]]*\bframes\b[^\]]*\]\);/);
  });
});
