// The refresh decision and the exact JSON round trip behind an append (R458),
// without an engine. The engine-backed cases are in matviewIncremental.test.ts.
import { describe, expect, it } from "vitest";

import {
  decideRefresh,
  parseExact,
  stringifyExact,
  type RefreshState,
  type SourceNow,
} from "@/utils/lakehouse/matviewPlan";

const prev: RefreshState = {
  digest: "d1",
  snapshot: 10,
  sources: [{ schema: "s", table: "t", id: "7", floor: 100 }],
};
const now = (kindsSince: string[][], over: Partial<SourceNow> = {}): SourceNow[] => [
  { schema: "s", table: "t", id: "7", floor: 120, kindsSince, ...over },
];
const base = {
  prev,
  digest: "d1",
  volatile: [] as string[],
  targetIntact: true,
  appendRefusal: null,
  policed: false,
};

describe("the refresh decision", () => {
  it("skips only when nothing changed, and treats a flush or compaction as no change", () => {
    expect(decideRefresh({ ...base, tracked: now([]) }).mode).toBe("skip");
    expect(decideRefresh({ ...base, tracked: now([["flushed"], ["compacted"]]) }).mode).toBe(
      "skip",
    );
  });

  it("appends from the recorded floor when the one table only gained rows", () => {
    const d = decideRefresh({ ...base, tracked: now([["inserted"], ["flushed"]]) });
    expect(d).toEqual({ mode: "append", why: "s.t only gained rows", source: prev.sources[0] });
  });

  it("rebuilds for every reason it cannot be sure", () => {
    const why = (over: Partial<Parameters<typeof decideRefresh>[0]>) =>
      decideRefresh({ ...base, tracked: now([["inserted"]]), ...over });
    expect(why({ prev: null }).why).toBe("this is its first tracked refresh");
    expect(why({ digest: "d2" }).why).toMatch(/query or a policy/);
    expect(why({ tracked: null, untrackedWhy: "it reads a mount" }).why).toBe("it reads a mount");
    expect(why({ volatile: ["now"] }).why).toMatch(/calls now/);
    expect(why({ targetIntact: false }).why).toMatch(/its table was written/);
    expect(why({ appendRefusal: "it aggregates" }).why).toMatch(/it aggregates/);
    expect(why({ policed: true }).why).toMatch(/a policy applies/);
    expect(why({ tracked: now([["inserted", "deleted"]]) }).why).toMatch(/changed or removed/);
    expect(why({ tracked: now([["altered"]]) }).mode).toBe("rebuild");
    // A CREATE OR REPLACE of the source is a new table, whatever its name.
    expect(why({ tracked: now([], { id: "8" }) }).why).toMatch(/not the table it read/);
    // Too many changes to read is a change of every kind.
    expect(why({ tracked: now([["unknown"]]) }).mode).toBe("rebuild");
  });

  it("rebuilds when it reads other tables than last time", () => {
    const two: SourceNow[] = [
      ...now([]),
      { schema: "s", table: "u", id: "9", floor: 0, kindsSince: [] },
    ];
    expect(decideRefresh({ ...base, tracked: two }).mode).toBe("rebuild");
  });
});

describe("the exact JSON round trip", () => {
  it("keeps numbers a double would round, and leaves the rest as JSON has them", () => {
    const text =
      '{"query_location":18446744073709551615,"value":9007199254740993,"d":12345678901234567890.123456,' +
      '"small":42,"neg":-7,"f":2.5,"e":1e+30,"s":"9007199254740993 in a string","esc":"a\\"b"}';
    const parsed = parseExact(text) as Record<string, unknown>;
    expect(parsed.small).toBe(42);
    expect(parsed.s).toBe("9007199254740993 in a string");
    expect(stringifyExact(parsed)).toBe(text);
  });
});
