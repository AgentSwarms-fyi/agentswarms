// A failed poll of a Spark query is not the query ending.
//
// FOUND IN R222: the Lakehouse editor polled a Spark query's row every two
// seconds and took a `null` reply for "The query is gone — it may have been
// cancelled elsewhere." The server returned `null` for a row it failed to read
// as well as for one that was absent, and a cancelled query keeps its row. In
// the UI, one poll answered null (its id rewritten in flight, so the server's
// own lookup found nothing) and the editor stopped watching; the query
// finished twenty seconds after it started, 3 rows, seen only in History.
//
// Two halves: the server throws on a failed read (a fake client whose read
// fails), and the editor's poll retries a failed poll and names only what it
// knows (the real helper, driven with scripted replies).
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SPARK_POLL_MAX_FAILURES, pollSparkQuery, type SparkPollView } from "@/lib/sparkPoll";

type Resp = { data: unknown; error: { message: string } | null };
const db = vi.hoisted(() => ({ resp: { data: null, error: null } as Resp }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "update"]) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve(db.resp);
      return b;
    },
  },
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: async () => {} }));

const { getSparkQuery, cancelSparkQuery } = await import("@/utils/lakehouse/sparkQuery.server");

beforeEach(() => {
  db.resp = { data: null, error: null };
});

describe("the server's read of a Spark query", () => {
  it("throws when the read fails, rather than answering that there is no such query", async () => {
    db.resp = { data: null, error: { message: "connection reset" } };
    await expect(getSparkQuery("u1", "q1")).rejects.toThrow(/connection reset/);
    await expect(cancelSparkQuery("u1", "q1")).rejects.toThrow(/connection reset/);
  });

  it("still answers null for a query that is not there", async () => {
    db.resp = { data: null, error: null };
    await expect(getSparkQuery("u1", "q1")).resolves.toBeNull();
  });
});

type View = SparkPollView<{ rows: number }>;
const view = (status: string, over: Partial<View> = {}): View => ({
  status,
  result: null,
  error: null,
  logs: null,
  ...over,
});

/** Drive the editor's poll with scripted replies: a view, null, or an Error. */
async function drive(replies: (View | null | Error)[]) {
  const seen: string[] = [];
  let i = 0;
  const poll = async () => {
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const out = await pollSparkQuery(
    poll,
    (q) => seen.push(q.status),
    async () => {},
  );
  return { out, seen, polls: i };
}

describe("the editor's wait on a Spark query", () => {
  it("rides out failed polls and still gets the result", async () => {
    const blip = new Error("Failed to fetch");
    const { out, seen } = await drive([
      view("running"),
      blip,
      blip,
      view("running"),
      view("succeeded", { result: { rows: 3 } }),
    ]);
    expect(out).toEqual({ rows: 3 });
    expect(seen).toEqual(["running", "running", "succeeded"]);
  });

  it("counts failed polls in a row, not in total: a good poll between them starts the count again", async () => {
    const blip = new Error("Failed to fetch");
    const burst = Array.from({ length: SPARK_POLL_MAX_FAILURES - 1 }, () => blip);
    const { out } = await drive([
      ...burst,
      view("running"),
      ...burst,
      view("succeeded", { result: { rows: 3 } }),
    ]);
    expect(out).toEqual({ rows: 3 });
  });

  it("gives up only after several failed polls in a row, and says the query may still be running", async () => {
    const replies = Array.from({ length: SPARK_POLL_MAX_FAILURES }, () => new Error("HTTP 503"));
    const err = await drive([view("running"), ...replies]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/may still be running/);
    expect((err as Error).message).not.toMatch(/cancel/i);
  });

  it("says a missing query is missing, without naming a cause", async () => {
    const err = await drive([view("running"), null]).catch((e: Error) => e);
    expect((err as Error).message).toBe("The server has no record of this query.");
  });

  it("returns nothing for a cancelled query, and the error and log tail for a failed one", async () => {
    expect((await drive([view("cancelled")])).out).toBeNull();
    const err = await drive([
      view("failed", { error: "AnalysisException", logs: "a\nb\nTable not found" }),
    ]).catch((e: Error) => e);
    expect((err as Error).message).toContain("AnalysisException");
    expect((err as Error).message).toContain("Table not found");
  });
});

describe("the Lakehouse editor", () => {
  const src = readFileSync("src/routes/_authenticated/lakehouse.tsx", "utf8");
  it("waits through pollSparkQuery and no longer guesses a cancellation", () => {
    expect(src).toContain("return await pollSparkQuery(");
    expect(src).not.toContain("cancelled elsewhere");
  });

  it("has the sandbox's source route answer a failed read with 503, not the 404 of an absent query", () => {
    const route = readFileSync("src/routes/api/notebook.runtime.source.ts", "utf8");
    expect(route).toMatch(
      /\} catch \(e\) \{\s*return json\(503, \{ error: \(e as Error\)\.message \}\);\s*\}\s*return "error" in out \? json\(404, out\)/,
    );
  });
});
