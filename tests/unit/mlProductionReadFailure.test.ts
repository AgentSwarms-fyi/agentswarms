// A production version that could not be read is not "no production version".
//
// FOUND IN R251, closing the sweep-7 ML row ("an unpromoted version answering
// production; a scheduled retrain auto-promoting"). Both halves are one
// statement:
//
//   pickVersion  dropped the production read's error and fell through to "the
//                newest ready version" - the rule for a model with NO
//                production version - so production traffic was answered by a
//                version nobody had promoted.
//   the retrain judge read the incumbent the same way; beatsProduction treats
//                "no incumbent" as "nothing to beat", so a retrain worse than
//                production was promoted over it, and the schedule was stamped
//                as judged so nothing looked again.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  /** The answer for a read of one version by id. */
  byId: {} as Record<string, Resp>,
  /** The answer for "the newest ready version". */
  newestReady: { data: null, error: null } as Resp,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    let id: string | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: string, v: string) => {
      if (col === "id") id = v;
      return b;
    };
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = () =>
      Promise.resolve(id ? (db.byId[id] ?? { data: null, error: null }) : db.newestReady);
    return b;
  };
  return { supabaseAdmin: { from: () => chain() } };
});

const PROD = { id: "prod-v3", model_id: "m1", version: 3, status: "ready" };
const NEWER = { id: "cand-v4", model_id: "m1", version: 4, status: "ready" };

describe("pickVersion", () => {
  it("answers with the production version when it reads (the baseline)", async () => {
    db.byId = { "prod-v3": { data: PROD, error: null } };
    db.newestReady = { data: NEWER, error: null };
    const { pickVersion } = await import("@/utils/ml/api.server");
    expect(await pickVersion("m1", undefined, "prod-v3")).toEqual(PROD);
  });

  it("does not hand production traffic to the newest unpromoted version when production cannot be read", async () => {
    db.byId = { "prod-v3": { data: null, error: { message: "connection reset" } } };
    db.newestReady = { data: NEWER, error: null };
    const { pickVersion } = await import("@/utils/ml/api.server");
    // Before R251 this resolved to NEWER, version 4, never promoted.
    await expect(pickVersion("m1", undefined, "prod-v3")).rejects.toThrow(
      /Could not read the production version/,
    );
  });

  it("refuses rather than guess when the production pointer names no row", async () => {
    db.byId = {};
    db.newestReady = { data: NEWER, error: null };
    const { pickVersion } = await import("@/utils/ml/api.server");
    await expect(pickVersion("m1", undefined, "prod-v3")).rejects.toThrow(
      /production version could not be found/,
    );
  });

  it("still serves the newest ready version for a model with no production version (ML.md's rule)", async () => {
    db.newestReady = { data: NEWER, error: null };
    const { pickVersion } = await import("@/utils/ml/api.server");
    expect(await pickVersion("m1", undefined, null)).toEqual(NEWER);
  });

  it("does not report 'no trained version' when the versions could not be read", async () => {
    db.newestReady = { data: null, error: { message: "connection reset" } };
    const { pickVersion } = await import("@/utils/ml/api.server");
    await expect(pickVersion("m1", undefined, null)).rejects.toThrow(
      /Could not read the model's versions/,
    );
  });
});

describe("the callers answer it", () => {
  it.each([["src/routes/api/ml.predict.ts"], ["src/routes/api/ml.predict.batch.ts"]])(
    "%s answers an unreadable version with 503, not a 500 or a guess",
    (path) => {
      const src = readFileSync(path, "utf8");
      expect(src).toMatch(
        /try \{\s*version = await pickVersion\([\s\S]*?\} catch \(e\) \{[\s\S]*?return mlJson\(\{ error: [^}]*\}, 503\);/,
      );
    },
  );
});

describe("the retrain judge", () => {
  const src = readFileSync("src/utils/ml/schedule.server.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function evaluateScheduledVersions"));

  it("does not judge a candidate against an incumbent it could not read", () => {
    const check = fn.indexOf("if (incumbentErr) {");
    const judge = fn.indexOf("const better = beatsProduction(");
    expect(check).toBeGreaterThan(-1);
    // The check comes first, and it leaves the loop body before anything is
    // promoted or stamped.
    expect(check).toBeLessThan(judge);
    expect(fn.slice(check, judge)).toMatch(/continue;/);
  });

  it("still promotes over nothing when the model truly has no production version", async () => {
    const { beatsProduction } = await import("@/utils/ml/schedule.server");
    expect(beatsProduction("classification", NEWER as never, null)).toBe(true);
  });
});
