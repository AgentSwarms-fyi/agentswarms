// Giving a candidate real traffic to answer, checked in the source.
//
// The arithmetic is in tests/unit/mlCanary.test.ts. These are the promises the
// arithmetic cannot keep, and they are not the same promises shadowing makes.
// A shadow's guarantee is that the candidate answers NOBODY. A canary's is
// narrower and has to be, because the whole feature is that it answers people:
//
//   1. It answers only where the mode says so, and only for its share.
//   2. Nobody is refused an answer because the canary is unavailable.
//   3. Every answer is counted — on BOTH sides — before it is returned.
//   4. A candidate failing worse than production is removed WITHOUT a person.
//   5. The row records which version actually answered.
//
// Four is the one that makes this safe to leave running overnight, and five is
// the one that makes anything measured afterwards true.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const SERVE = rd("src/utils/ml/serve.server.ts");
const PREDICT = rd("src/utils/ml/predict.server.ts");
const OPS = rd("src/utils/mlOps.functions.ts");
const PANEL = rd("src/components/ml/DeploymentPanel.tsx");
const MIGRATION = rd("supabase/migrations/20260911000000_ml_canary_traffic.sql");
const LIB = rd("src/lib/mlCanary.ts");
const MD = rd("docs/ML.md");
const PAGE = rd("src/routes/docs.ml.tsx");

const warm = () => SERVE.slice(SERVE.indexOf("export async function scoreWarm"));

/**
 * The source with its line comments removed.
 *
 * A mutation check found the reason this exists: the comment above the
 * rollback claim QUOTES the line of code it is explaining, so deleting the
 * code left the assertion passing on the prose. Anything asserted about code
 * that is also written down in English has to be read from the code.
 */
const codeOnly = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");

describe("who answers, and who is never refused", () => {
  it("the candidate answers only under the canary mode and only for its share", () => {
    const choose = warm().slice(0, warm().indexOf("const replica = replicaToScore"));
    expect(choose).toContain(
      'dep.candidate_mode === "canary" && routeToCandidate(dep.candidate_percent, Math.random())',
    );
    // The roll is taken PER REQUEST. A roll hoisted out of the request would
    // make the split sticky for the life of the process — every caller on one
    // worker getting the candidate, or none of them.
    expect(choose).toContain("Math.random()");
    expect(SERVE.indexOf("Math.random()")).toBeGreaterThan(
      SERVE.indexOf("export async function scoreWarm"),
    );
  });

  it("a canary with no copy up costs nobody their answer", () => {
    // The failure this prevents: a candidate container dies, the roll sends a
    // request to a side with nothing on it, and a real caller gets an error
    // for a version they never asked to be part of.
    const w = warm();
    expect(w).toContain('if (side === "candidate" && ready.length === 0) {');
    const fallback = w.slice(w.indexOf('if (side === "candidate" && ready.length === 0) {'));
    expect(fallback.slice(0, 400)).toContain('side = "primary";');
    expect(fallback.slice(0, 400)).toContain('listReplicas(dep.id, true, "primary")');
  });

  it("and the fallback is one-way — production never falls back to the candidate", () => {
    const w = warm();
    expect(w).not.toContain('side = "candidate";');
  });
});

describe("every answer is counted, on both sides", () => {
  it("a success, an HTTP failure and a transport failure all record", () => {
    const w = warm();
    // Three exits, three records. A path that returns without counting is a
    // request the rollback rule never sees.
    expect(w).toContain("await recordCanary(dep, side, false, null);");
    expect(w).toContain("await recordCanary(dep, side, true, message);");
    expect(w).toContain("await recordCanary(dep, side, true, (e as Error).message);");
  });

  it("including the 503 that falls back to a sandbox", () => {
    // A scorer that is loading or broken has not answered. Counting it only
    // when it returns a proper error would hide exactly the failure mode a
    // freshly deployed candidate has.
    const w = warm();
    const block = w.slice(
      w.indexOf("if (res.status === 503)") - 400,
      w.indexOf("if (res.status === 503)") + 100,
    );
    expect(block).toContain("await recordCanary(dep, side, true, message);");
    expect(block.indexOf("recordCanary")).toBeLessThan(block.indexOf("if (res.status === 503)"));
  });

  it("counting is AWAITED, unlike the shadow mirror", () => {
    // The mirror is spare work nobody waits for. This is the record of a real
    // caller served by an unapproved version, and the automatic rollback reads
    // it — a count dropped because the process moved on is a failure the
    // platform never learns about.
    expect(warm()).not.toContain("void recordCanary");
    const fn = SERVE.slice(SERVE.indexOf("async function recordCanary"));
    expect(fn.slice(0, 1200)).toContain('await supabaseAdmin.rpc("record_ml_canary_result"');
  });

  it("and counting can never be what fails a request", () => {
    const fn = SERVE.slice(SERVE.indexOf("async function recordCanary"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("catch (e)");
    expect(body).toContain('console.warn("[ml-canary] could not record:"');
  });

  it("the counters move in one statement, and count both sides", () => {
    const sql = MIGRATION.slice(MIGRATION.indexOf("CREATE OR REPLACE FUNCTION"));
    for (const col of [
      "canary_primary_requests",
      "canary_primary_errors",
      "canary_requests",
      "canary_errors",
    ]) {
      expect(sql, col).toContain(`${col} = ${col}`);
    }
    // An unknown side is ignored rather than folded into either column.
    expect(sql).toContain("p_side IN ('primary', 'candidate')");
  });
});

describe("the platform takes a failing candidate out by itself", () => {
  it("the decision is the pure rule, not a second copy of it", () => {
    const fn = SERVE.slice(SERVE.indexOf("async function maybeRollBackCanary"));
    expect(fn.slice(0, 1500)).toContain("rollbackDecision({");
    // And the rule compares against production, which is what stops an outage
    // reading as a bad model.
    expect(LIB).toContain("WORSE_THAN_PRIMARY_BY");
    expect(fn.slice(0, 1500)).toContain("primaryRequests: dep.canary_primary_requests");
  });

  it("exactly one concurrent request performs it", () => {
    // Every in-flight request that just recorded a failure reaches this line.
    // Without the claim they would all retire the copies and all write an
    // audit row, and the reader would find six rollbacks of one candidate.
    // Read from the CODE, not the file: the comment above this very line
    // quotes it, and a mutation check showed the assertion passing on the
    // comment after the code was deleted.
    const fn = codeOnly(SERVE.slice(SERVE.indexOf("async function maybeRollBackCanary")));
    expect(fn).toContain('.eq("candidate_mode", "canary")');
    expect(fn).toContain("if (!claimed) return;");
    // The claim comes BEFORE the copies are retired.
    expect(fn.indexOf("if (!claimed) return;")).toBeLessThan(fn.indexOf("retireReplica"));
  });

  it("it stops the traffic before it stops the containers", () => {
    // The other order leaves a window where the mode still says canary and the
    // copies are gone: every rolled request falls back to production, which is
    // safe, but the endpoint is lying about what it is doing.
    const fn = codeOnly(SERVE.slice(SERVE.indexOf("async function maybeRollBackCanary")));
    expect(fn.indexOf('candidate_mode: "off"')).toBeLessThan(fn.indexOf("retireReplica"));
    expect(fn).toContain("candidate_percent: 0,");
  });

  it("and says so, in the audit and on the row", () => {
    const fn = SERVE.slice(SERVE.indexOf("async function maybeRollBackCanary"));
    expect(fn).toContain('action: "ml.canary.rollback"');
    expect(fn).toContain("canary_rollback_reason: decision.reason,");
    expect(fn).toContain("canary_rolled_back_at:");
  });

  it("the reason outlives the candidate it was about", () => {
    // A rollback removes the candidate, so a reason nested inside the
    // candidate block would vanish at the moment it became the most important
    // thing on the panel.
    expect(OPS).toContain("rollback: { at: string; reason: string | null } | null;");
    expect(OPS).toContain("rollback: dep.canary_rolled_back_at");
    expect(PANEL).toContain("dep.rollback && !dep.candidate");
  });

  it("and is cleared only when a new canary starts", () => {
    const fn = SERVE.slice(SERVE.indexOf("export async function setCandidate"));
    expect(fn).toContain("canary_rolled_back_at: null,");
    // Not on stop: somebody arriving in the morning must still find out why.
    const stop = fn.slice(0, fn.indexOf("if (args.version.id === dep.version_id)"));
    expect(stop).not.toContain("canary_rolled_back_at: null,");
  });
});

describe("the record says which version answered", () => {
  it("the scorer reports it and the prediction row uses it", () => {
    // Under a canary the endpoint's version is wrong for some share of rows by
    // design. Recording it anyway would attribute a candidate's prediction to
    // production — on the row a person reads when they ask why, and in the
    // drift figures.
    expect(warm()).toContain("servedVersionId,");
    expect(PREDICT).toContain(
      'version_id: ("servedVersionId" in scored && scored.servedVersionId) || args.version.id,',
    );
  });

  it("and it comes from the copy that answered, not the endpoint", () => {
    expect(warm()).toContain("const servedVersionId = replica.version_id ?? dep.version_id;");
  });
});

describe("a warm answer is recorded as an answer", () => {
  // FOUND LIVE, and it had been wrong for six days: 21 of 21 warm predictions
  // were stored as "The sandbox finished without returning predictions" while
  // the caller was handed a correct answer. The endpoint scored fine; the
  // RECORD of it was a failure, and so was the audit row.
  //
  // The cause is one key. finalizePrediction accepts a result only if it looks
  // like the batch path's envelope, and that envelope's `ok` is set by the
  // Python entrypoint — which the warm scorer bypasses by calling `_predict`
  // directly, deliberately, to keep one scoring implementation.

  it("the validator's requirements are exactly what the warm path must supply", () => {
    // Read from the validator rather than restated, so a new requirement
    // appearing there fails here instead of silently failing every warm
    // prediction in production.
    const fn = PREDICT.slice(PREDICT.indexOf("function isPredictResult"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("r.ok === true");
    expect(body).toContain('r.mode === "predict"');
    expect(body).toContain('typeof r.row_count === "number"');
    expect(body).toContain("Array.isArray(r.columns)");
  });

  it("Python supplies three of them and the entrypoint supplies `ok`", () => {
    const TRAIN = rd("src/utils/ml/pyTrain.ts");
    // _predict's own return: mode, row_count, columns.
    expect(TRAIN).toMatch(/return \{'mode': 'predict', 'row_count': int\(len\(out\)\)/);
    // ...and `ok` comes from the entrypoint that the warm scorer does not run.
    expect(TRAIN).toContain("result.update({'ok': True,");
    expect(rd("docker/notebook-runtime/score_server.py")).toContain(
      'out = ns["_predict"](cfg, warnings)',
    );
  });

  it("so the warm path adds it, and hands over a complete envelope", () => {
    expect(warm()).toContain("raw: { ...(body ?? {}), ok: true },");
    // Not the bare body, which is what made every warm prediction a failure.
    expect(warm()).not.toContain("raw: body ?? {},");
  });
});

describe("a person can run one", () => {
  it("a canary at nothing per cent is refused", () => {
    // Otherwise the panel reports a candidate taking traffic while a container
    // runs and nobody is served by it.
    const fn = SERVE.slice(SERVE.indexOf("export async function setCandidate"));
    expect(fn.slice(0, 1200)).toContain('if (mode === "canary" && percent <= 0) {');
  });

  it("the share is bounded in the validator, not only in the UI", () => {
    const fn = OPS.slice(OPS.indexOf("export const mlShadowSet"));
    expect(fn.slice(0, 1500)).toContain('mode: z.enum(["shadow", "canary"]).optional()');
    expect(fn.slice(0, 1500)).toContain("percent: z.number().int().min(0).max(100).optional()");
  });

  it("and in the database, which is the one nothing can go around", () => {
    expect(MIGRATION).toContain("ADD CONSTRAINT ml_deployments_candidate_percent_check");
    expect(MIGRATION).toContain("candidate_percent >= 0 AND candidate_percent <= 100");
    expect(MIGRATION).toContain("CHECK (candidate_mode IN ('off', 'shadow', 'canary'))");
  });

  it("the panel shows BOTH sides' failure rates, never just the candidate's", () => {
    // A candidate at 12% next to no other number reads as bad. Next to
    // production at 11% it reads as normal, which is what it is.
    expect(PANEL).toContain("In production");
    expect(PANEL).toContain("canary.primaryErrors");
    expect(PANEL).toContain("canary.errors");
  });

  it("and shows the share it actually served, not only the one asked for", () => {
    expect(PANEL).toContain("observedShare(totals)");
    expect(PANEL).toContain("% asked for");
    expect(PANEL).toContain("served");
  });

  it("the step to real traffic is a named choice, not a toggle", () => {
    expect(PANEL).toContain("Mirror only");
    expect(PANEL).toContain("Send real traffic");
    expect(PANEL).toContain("These callers are being answered by the candidate");
  });
});

describe("the docs describe the canary that exists", () => {
  // Wrap-insensitive, because the markdown is hard-wrapped and the page is
  // prettier-wrapped at different points, and `{" "}` is a JSX spacer.
  const flat = (src: string) => src.replace(/\{" "\}/g, " ").replace(/\s+/g, " ");
  const MDF = flat(MD);
  const PAGEF = flat(PAGE);
  const num = (re: RegExp, src: string) => {
    const m = src.match(re);
    expect(m, `no match for ${re}`).not.toBeNull();
    return Number(m![1]);
  };
  const pct = (x: number) => String(Math.round(x * 1000) / 10);

  it("both surfaces say a canary cannot measure agreement", () => {
    // The single most confusable thing about this feature. A reader who thinks
    // the canary reports agreement will read its silence as agreement.
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain("cannot measure agreement");
      expect(f).toContain("each row was answered once, by one version");
    }
  });

  it("the rollback thresholds in prose are the ones in code", () => {
    const reqs = num(/MIN_CANDIDATE_REQUESTS = (\d+)/, LIB);
    const floor = num(/ERROR_FLOOR = ([\d.]+)/, LIB);
    const margin = num(/WORSE_THAN_PRIMARY_BY = ([\d.]+)/, LIB);
    expect([reqs, floor, margin]).toEqual([20, 0.1, 0.05]);
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain(`${reqs} requests`);
      expect(f).toContain(`${pct(floor)}% or more`);
      expect(f).toContain(`${pct(margin)} points worse`);
    }
  });

  it("and the default share matches the panel's", () => {
    const dflt = num(/const DEFAULT_SHARE = (\d+);/, PANEL);
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain(`the default is ${dflt}`);
    }
  });

  it("both say the platform rolls back on its own, and why that is necessary", () => {
    for (const f of [MDF, PAGEF]) {
      expect(f).toMatch(/without being asked/i);
      expect(f).toContain("three in the morning");
    }
  });

  it("both explain why production's rate is shown beside the candidate's", () => {
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain("worse than the thing it would replace");
      expect(f).toMatch(/a lakehouse outage reads as a bad model/i);
    }
  });

  it("and both say which version a prediction records", () => {
    for (const f of [MDF, PAGEF]) {
      expect(f).toMatch(/records the version that .{0,20}actually.{0,20} answered it/);
    }
  });
});
