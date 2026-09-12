// Shadowing a candidate version, checked in the source.
//
// The comparison arithmetic is in tests/unit/mlShadow.test.ts. These are the
// promises that arithmetic cannot keep, and the load-bearing one is short:
//
//   A SHADOW CANDIDATE NEVER ANSWERS A CALLER.
//
// Everything else about shadowing is a convenience. That one is the whole
// reason it is safe to point real traffic at an untried model, and breaking it
// would serve production from a version nobody approved — silently, because
// the answer would look exactly like any other answer.
//
// A CANARY is the deliberate exception, and it is deliberate in the strict
// sense: a candidate answers a caller only where the mode is canary AND the
// per-request roll falls inside the configured share. Those tests live in
// tests/unit/mlCanaryWiring.test.ts. What this file guards is that nothing
// ELSE can produce that outcome — no ordering, no default, no fallback.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const SERVE = rd("src/utils/ml/serve.server.ts");
const OPS = rd("src/utils/mlOps.functions.ts");
const PANEL = rd("src/components/ml/DeploymentPanel.tsx");
const MIGRATION = rd("supabase/migrations/20260909000000_ml_shadow_candidate.sql");
// Its OWN file, and that matters: 20260909 was already applied to the live
// database, so the function appended to it would have shipped to a fresh
// install and never reached the database it was written for.
const COUNTER = rd("supabase/migrations/20260910000000_ml_shadow_counter.sql");
const LIB = rd("src/lib/mlShadow.ts");
const MD = rd("docs/ML.md");
const PAGE = rd("src/routes/docs.ml.tsx");

describe("a candidate never answers a caller", () => {
  it("the candidate side is reachable ONLY through the canary decision", () => {
    // This used to read "nothing in the scoring path mentions the candidate",
    // which stopped being true the moment a canary existed. The promise it was
    // really making survives in a sharper form: there is exactly ONE place the
    // side becomes "candidate", and it is guarded by the mode AND the roll.
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    const choose = warm.slice(0, warm.indexOf("const replica = replicaToScore"));
    expect(choose).toContain(
      'dep.candidate_mode === "canary" && routeToCandidate(dep.candidate_percent, Math.random())',
    );
    // One assignment of the candidate side, not two.
    expect(choose.match(/"candidate"\s*$/gm) ?? []).toHaveLength(1);
    // And the fallback goes the safe way: a canary with no copy serves from
    // production, never the reverse.
    expect(warm).toContain('if (side === "candidate" && ready.length === 0) {');
    expect(warm).toContain('side = "primary";');
  });

  it("the mirror runs AFTER the answer is in hand, and is not awaited", () => {
    // A mirror the caller waits for is not a shadow: it is a second serving
    // path with twice the latency and twice the ways to fail.
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    expect(warm).toContain("void mirrorToCandidate(dep, args, body)");
    expect(warm).not.toContain("await mirrorToCandidate");
    // Between the primary's answer being parsed and that answer being
    // returned. Compared against `ok: true` rather than the first `return {`,
    // which is the EARLIER error return and made this assertion about the
    // wrong statement entirely.
    expect(warm.indexOf("const body = ")).toBeLessThan(warm.indexOf("void mirrorToCandidate"));
    expect(warm.indexOf("void mirrorToCandidate")).toBeLessThan(warm.indexOf("ok: true,"));
  });

  it("and a mirror that throws cannot reach the caller", () => {
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    expect(warm).toContain('.catch((e) =>\n      console.warn("[ml-shadow] mirror failed:"');
  });

  it("a copy records which version and side it is, rather than inheriting it", () => {
    // Two copies of one endpoint now hold different models. A scorer that
    // assumed the endpoint's version would mirror to whichever it picked.
    expect(MIGRATION).toContain("role text NOT NULL DEFAULT 'primary'");
    expect(MIGRATION).toContain("CHECK (role IN ('primary', 'candidate'))");
    expect(SERVE).toContain('role: args.role ?? "primary",');
    expect(SERVE).toContain("version_id: args.version.id,");
  });

  it("and every copy that already existed is backfilled as a primary", () => {
    // A null version on a live copy would leave the scorer unable to say which
    // model it was about to answer from.
    expect(MIGRATION).toContain("UPDATE public.ml_deployment_replicas r");
    expect(MIGRATION).toContain("WHERE r.deployment_id = d.id AND r.version_id IS NULL");
  });
});

describe("and no other path hands out its address either", () => {
  // scoreWarm is not the only place a replica endpoint is chosen. Each of
  // these was found by reading every listReplicas call site rather than by a
  // test failing, which is why they are all written down here.

  it("the already-serving probe returns a primary, never the candidate", () => {
    // ensureWarm returns this address to the caller, who scores against it. A
    // candidate here IS a candidate answering a caller, by a different route.
    const fn = SERVE.slice(SERVE.indexOf("let dep = await getDeployment(model.id);"));
    const probe = fn.slice(0, fn.indexOf("await markStopped(dep.id);"));
    expect(probe).toContain('listReplicas(dep.id, true, "primary")');
  });

  it("the autoscaler counts primaries, so a candidate is not spare capacity", () => {
    // Counting it makes an endpoint at its ceiling look over-provisioned, and
    // the scaler then stops a copy: the candidate, killing the shadow
    // silently, or the last primary, leaving an endpoint whose only warm copy
    // is one the scorer refuses to use.
    const fn = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    const body = fn.slice(0, fn.indexOf("const decision = scaleDecision("));
    expect(body).toContain('const replicas = await listReplicas(dep.id, true, "primary");');
  });

  it("but taking the endpoint down takes EVERY copy, candidate included", () => {
    // The opposite mistake: a filtered list here would strand a container.
    for (const marker of [
      "export async function undeploy",
      'await retireReplica(replica, "replaced")',
    ]) {
      expect(SERVE).toContain(marker);
    }
    const un = SERVE.slice(SERVE.indexOf("export async function undeploy"));
    expect(un.slice(0, 400)).toContain("await listReplicas(dep.id)");
    // ...and clears the candidate with them. SEEN LIVE: after stopping an
    // endpoint mid-shadow the row still named a candidate with no copy behind
    // it. The totals stay — they are what the run measured.
    const body = un.slice(0, un.indexOf("await markStopped(dep.id);"));
    expect(body).toContain('.update({ candidate_mode: "off", candidate_version_id: null })');
    expect(body).not.toContain("shadow_requests: 0");
  });

  it("and the panel counts primaries when it says how many are answering", () => {
    // SEEN ON SCREEN: with a candidate running the card read "2 of 2 copies
    // answering" immediately above "The candidate has never answered a
    // caller". Both came from the same handler; only one was true.
    const fn = OPS.slice(OPS.indexOf("const [dep, caps] = await Promise.all("));
    const head = fn.slice(0, fn.indexOf("let shadow:"));
    expect(head).toContain('const replicas = await listReplicas(dep.id, true, "primary");');
  });

  it("and a redeploy clears the candidate rather than leaving it described", () => {
    // Adopting a candidate IS a redeploy to it. Left set, the endpoint would
    // claim to be shadowing the version it had just started serving.
    const fn = SERVE.slice(SERVE.indexOf("const nowIso = new Date().toISOString();"));
    const upsert = fn.slice(0, fn.indexOf("const first = await startReplica("));
    expect(upsert).toContain("candidate_version_id: null,");
    expect(upsert).toContain('candidate_mode: "off",');
  });
});

describe("what the mirror compares", () => {
  it("only tasks where the same answer means the same thing", () => {
    // Clustering and anomaly labels are arbitrary between fits, so comparing
    // them would report disagreement on two identical models.
    const fn = SERVE.slice(SERVE.indexOf("async function mirrorToCandidate"));
    expect(fn).toContain('if (task !== "classification" && task !== "regression") return;');
  });

  it("lines the two answers up on the prediction column", () => {
    const fn = SERVE.slice(SERVE.indexOf("function answerPairs("));
    expect(fn.slice(0, 900)).toContain('const pi = pCols.indexOf("prediction");');
    // Comparing a row against nothing is not a disagreement.
    expect(fn.slice(0, 900)).toContain("Math.min(pRows.length, cRows.length)");
  });

  it("and the candidate's own clock is written, not voided away", () => {
    // MEASURED against the live database: a PostgREST builder issues its
    // request inside .then(), so one that is neither awaited nor given a
    // .then() never calls the database — after four mirrored requests the
    // candidate's last_used_at was still null. The repo's other fire-and-forget
    // stamps end in `.then(() => {})`, which is what makes THEM run; this one
    // had no terminal .then and silently did nothing. (`void someAsyncFn()` is
    // a different thing entirely and is fine: the function body runs.)
    const fn = SERVE.slice(SERVE.indexOf("async function mirrorToCandidate"));
    const body = fn.slice(0, fn.indexOf("const totals"));
    expect(body).toContain("await supabaseAdmin");
    expect(body).not.toContain("void supabaseAdmin");
  });

  it("a candidate that fails counts as an error, not as disagreement", () => {
    // This rule moved when the counters became atomic. It used to be the
    // `failure ? null : comparison` argument; now the call hands the error and
    // the figures over separately and the SQL is what drops the figures when
    // an error arrived with them. Asserted on both halves, because either one
    // alone would let a failed mirror contribute agreements.
    const fn = SERVE.slice(SERVE.indexOf("async function mirrorToCandidate"));
    expect(fn).toContain("p_rows: comparison?.rows ?? 0,");
    expect(fn).toContain("p_error: failure ? failure.slice(0, 2000) : null,");
    expect(COUNTER).toContain("CASE WHEN p_error IS NULL THEN COALESCE(p_rows, 0) ELSE 0 END");
  });
});

describe("the totals survive concurrent requests", () => {
  // A warm endpoint exists to answer several callers at once. Reading the four
  // totals off the deployment row the request already had, adding to them and
  // writing them back means two in-flight mirrors read the same figures and
  // the second erases the first — silently, and worst under the load that
  // matters. The platform already learned this for request_count.
  it("the counters are moved by one statement, not by a read and a write", () => {
    const fn = SERVE.slice(SERVE.indexOf("async function mirrorToCandidate"));
    expect(fn).toContain('supabaseAdmin.rpc("record_ml_shadow_result"');
    // The failure mode itself: no assignment of a total to a value computed
    // from the row in hand.
    expect(fn).not.toMatch(/shadow_(requests|rows|agreed|errors):\s*(totals|dep)\./);
  });

  it("and the SQL adds exactly what addComparison adds", () => {
    // The arithmetic now lives in two places, so this is what keeps them one
    // rule. Read out of the migration rather than restated here, because a
    // restatement is a third place to be wrong.
    expect(MIGRATION).not.toContain("record_ml_shadow_result");
    const sql = COUNTER.slice(
      COUNTER.indexOf("CREATE OR REPLACE FUNCTION public.record_ml_shadow_result"),
    );
    const body = sql.slice(sql.indexOf("UPDATE public.ml_deployments"));
    // A request always counts, whatever happened.
    expect(body).toContain("shadow_requests = shadow_requests + 1");
    // A failure contributes an error and no rows; a success the reverse.
    expect(body).toContain(
      "shadow_errors = shadow_errors + CASE WHEN p_error IS NULL THEN 0 ELSE 1 END",
    );
    for (const col of ["shadow_rows", "shadow_agreed"]) {
      expect(body).toMatch(
        new RegExp(
          `${col} = ${col} \\+ CASE WHEN p_error IS NULL THEN COALESCE\\(p_\\w+, 0\\) ELSE 0 END`,
        ),
      );
    }
    // And the last error is kept when this request did not produce one, rather
    // than being blanked by every success that follows a failure.
    expect(body).toContain("shadow_last_error = COALESCE(p_error, shadow_last_error)");
  });

  it("the oracle it is held to still says the same thing", () => {
    // If addComparison changes and the SQL does not, the assertions above go
    // on passing. This is the half that notices.
    const fn = LIB.slice(LIB.indexOf("export function addComparison"));
    const flatFn = fn.slice(0, fn.indexOf("\n}")).replace(/\s+/g, " ");
    expect(flatFn).toContain("requests: totals.requests + 1, errors: totals.errors + 1");
    expect(flatFn).toContain("rows: totals.rows + c.rows");
    expect(flatFn).toContain("agreed: totals.agreed + c.agreed");
    expect(flatFn).toContain("errors: totals.errors,");
  });
});

describe("what is kept, and what is deliberately not", () => {
  it("running totals rather than a row per mirrored request", () => {
    // An endpoint at a couple of requests a second would write a hundred and
    // fifty thousand rows a day to answer a question that is four numbers.
    for (const col of ["shadow_requests", "shadow_rows", "shadow_agreed", "shadow_errors"]) {
      expect(MIGRATION).toContain(col);
    }
  });

  it("the mirrored INPUT is never stored", () => {
    // A mirrored request carries whatever the caller sent. Keeping it would put
    // live personal data in a debugging table nobody thinks of as a data store.
    const create = MIGRATION.slice(
      MIGRATION.indexOf("CREATE TABLE IF NOT EXISTS public.ml_shadow_disagreements"),
    );
    const columns = create.slice(0, create.indexOf(");"));
    expect(columns).toContain("primary_answer");
    expect(columns).toContain("candidate_answer");
    expect(columns).not.toMatch(/\binput\b|\brows\b|\bpayload\b|\bfeatures\b/);
  });

  it("and the disagreement sample is trimmed, so it cannot grow forever", () => {
    expect(SERVE).toContain("async function trimDisagreements(");
    expect(SERVE).toContain("SHADOW_KEEP_DISAGREEMENTS");
  });
});

describe("starting and stopping", () => {
  it("a new candidate resets the totals", () => {
    // Figures gathered against a DIFFERENT candidate answer a question nobody
    // asked, and left in place they would read as evidence about this one.
    const fn = SERVE.slice(SERVE.indexOf("export async function setCandidate"));
    expect(fn).toContain("shadow_requests: 0,");
    expect(fn).toContain('.from("ml_shadow_disagreements").delete().eq("deployment_id", dep.id)');
  });

  it("only one candidate at a time", () => {
    // Two would be two answers to the question "what would the new version
    // have said".
    const fn = SERVE.slice(SERVE.indexOf("export async function setCandidate"));
    expect(fn).toContain('await retireReplica(r, "replaced by a new candidate");');
    // ...except when it is the SAME version, where the mode changes in place
    // and the already-loaded copy is kept. Promoting a shadow to a canary
    // should not cost a cold start to change one column.
    expect(fn).toContain("if (dep.candidate_version_id === version.id && running.length > 0) {");
  });

  it("shadowing the version already being served is refused", () => {
    const fn = SERVE.slice(SERVE.indexOf("export async function setCandidate"));
    expect(fn).toContain("That version is already the one being served");
  });

  it("a candidate costs a container, so it checks there is room", () => {
    const fn = SERVE.slice(SERVE.indexOf("export async function setCandidate"));
    expect(fn).toContain("const room = await replicaRoom(args.userId);");
    // And the count it checks against includes candidates. Both docs say a
    // candidate counts against the warm-container limits, which is only true
    // while this query stays blind to the role.
    const counter = SERVE.slice(SERVE.indexOf("async function countLive("));
    const body = counter.slice(0, counter.indexOf("return count ?? 0;"));
    expect(body).toContain('.in("status", [...LIVE_REPLICA])');
    expect(body).not.toContain('"role"');
  });

  it("and both starting and stopping are audited", () => {
    expect(SERVE).toContain('"ml.canary.start" : "ml.shadow.start"');
    expect(SERVE).toContain('"ml.canary.stop" : "ml.shadow.stop"');
  });
});

describe("a person can run one", () => {
  it("the control needs write access, because it spends a container", () => {
    const fn = OPS.slice(OPS.indexOf("export const mlShadowSet"));
    expect(fn.slice(0, 1200)).toContain("loadModelForUser(data.modelId, userId, { write: true })");
  });

  it("and a version from another model cannot be shadowed onto this one", () => {
    const fn = OPS.slice(OPS.indexOf("export const mlShadowSet"));
    expect(fn.slice(0, 1500)).toContain('.eq("model_id", model.id)');
  });

  it("the panel offers it, and never offers the version already serving", () => {
    expect(PANEL).toContain("Trying another version");
    expect(PANEL).toContain('v.id !== dep.version_id && v.status === "ready"');
  });

  it("and reads the candidate off the view, not a shadow-shaped field", () => {
    // The view carries one candidate with a mode, because a shadow and a
    // canary are one thing with one difference. A second field would have let
    // the two disagree about which version is being tried.
    expect(OPS).toContain('mode: "shadow" | "canary";');
    expect(PANEL).toContain("dep.candidate?.version_id");
  });

  it("and SHADOWING is not offered for tasks the mirror refuses to compare", () => {
    // serve.server.ts returns early for clustering, anomaly and recommendation.
    // Shadowing those would start a container, mirror nothing, and sit on
    // "watching" for ever with no way for a person to know why.
    //
    // A CANARY is offered for them, and that is not an inconsistency: it
    // measures failure, which means the same thing for every task, rather than
    // agreement, which does not.
    expect(PANEL).toContain(
      'const comparable = task === "classification" || task === "regression";',
    );
    expect(PANEL).toContain("disabled={busy || !comparable}");
    expect(PANEL).toContain("there is nothing to shadow");
    expect(PANEL).toContain('setShadow(id, "canary"');
  });

  it("the control has a name, not just a shape", () => {
    // A bare select is keyboard-operable but unnamed to a screen reader.
    expect(PANEL).toContain('aria-label="Version to try"');
  });

  it("and leads with a verdict rather than a percentage", () => {
    // A percentage on forty rows invites a decision nobody has evidence for,
    // which is the opposite of what shadowing is for.
    expect(PANEL).toContain("shadowVerdict(totals)");
    expect(PANEL).toContain("more rows before this means anything");
  });

  it("saying plainly that the candidate has served nobody", () => {
    expect(PANEL).toContain("The candidate has never answered a caller");
  });
});

// Prose is hard-wrapped in the markdown and prettier-wrapped in the page, at
// DIFFERENT points, so a phrase that spans a line break is present in the
// document and absent from the string. Flattening whitespace (and JSX's
// `{" "}` spacers) compares the sentence rather than the line breaking.
const flat = (src: string) => src.replace(/\{" "\}/g, " ").replace(/\s+/g, " ");

describe("the docs describe the shadow that exists", () => {
  // Every number below is read out of the source it documents, so a change to
  // a constant fails the doc that quotes it rather than leaving the doc
  // quietly wrong — which is the failure mode docs actually have.
  const num = (re: RegExp, src: string) => {
    const m = src.match(re);
    expect(m, `no match for ${re}`).not.toBeNull();
    return Number(m![1]);
  };
  // 0.035 * 100 is 3.5000000000000004, which would go looking for a percentage
  // no document will ever contain. Rounded, for the same reason the threshold
  // sweep rounds before it compares.
  const pct = (x: number) => String(Math.round(x * 1000) / 10);

  const MDF = flat(MD);
  const PAGEF = flat(PAGE);

  it("both surfaces lead with the promise, not the feature", () => {
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain("A candidate never answers a caller");
      expect(f).toContain("mirror is fired after the served answer is in hand and is not awaited");
    }
  });

  it("the regression tolerance in prose is the tolerance in code", () => {
    const tol = num(/REGRESSION_TOLERANCE = ([\d.]+)/, LIB);
    expect(tol).toBe(0.01);
    for (const f of [MDF, PAGEF]) {
      // The markdown bolds it inside a table cell and the page does not, so
      // the emphasis is optional rather than the assertion being cut down to
      // "1%" — which matches a percentage anywhere in the file.
      expect(f).toMatch(new RegExp(`Within \\*{0,2}${pct(tol)}%`));
    }
  });

  it("so are the row floor, the agreement floor and the error rate", () => {
    const rows = num(/MIN_ROWS_FOR_VERDICT = (\d+)/, LIB);
    const floor = num(/AGREEMENT_FLOOR = ([\d.]+)/, LIB);
    const errs = num(/totals\.requests \* ([\d.]+)/, LIB);
    expect([rows, floor, errs]).toEqual([100, 0.9, 0.05]);
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain(`Fewer than ${rows} rows compared`);
      expect(f).toContain(`${pct(floor)}% of rows or more agreed`);
      expect(f).toContain(`failed on ${pct(errs)}% or more of mirrored calls`);
    }
  });

  it("and the size of the disagreement sample", () => {
    const keep = num(/SHADOW_KEEP_DISAGREEMENTS = (\d+)/, SERVE);
    expect(keep).toBe(50);
    for (const f of [MDF, PAGEF]) {
      // Written as a word in both, which is why this is not /50/ — that would
      // also match a row count or a port number elsewhere in the file.
      expect(f).toContain("fifty most recent rows");
    }
  });

  it("both say plainly that the mirrored input is never stored", () => {
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain("The mirrored input is never stored");
    }
  });

  it("and that adopting a candidate is still a person switching", () => {
    for (const f of [MDF, PAGEF]) {
      expect(f).toContain("shadowing does not promote anything by itself");
    }
  });
});

describe("the gap list no longer claims shadowing is missing", () => {
  // Sliced to the list itself. Asserting against the whole file would pass on
  // the word "shadow" appearing in the section written two screens above.
  const slice = (src: string, end: string) => {
    const a = src.indexOf("Everything in the left column is shipped and tested");
    expect(a).toBeGreaterThan(-1);
    const b = src.indexOf(end, a);
    expect(b).toBeGreaterThan(a);
    return flat(src.slice(a, b));
  };
  const mdGaps = slice(MD, "## Use cases");
  const pageGaps = slice(PAGE, "<H2");

  it("shadow traffic is gone from what is left", () => {
    for (const gaps of [mdGaps, pageGaps]) {
      expect(gaps).not.toMatch(/shadow traffic/i);
      expect(gaps).not.toMatch(/mirroring traffic/i);
    }
  });

  it("and canary has gone too, because a share CAN now be split", () => {
    // This bullet has now been narrowed twice and then removed: first to drop
    // the shadow half, now to drop the rest. The code that closed it is the
    // routing decision in scoreWarm, so the gap list and the router are
    // asserted together — a list that said "no canary" while the router had
    // one would be the same stale-admission failure a third time.
    expect(SERVE).toContain("routeToCandidate(dep.candidate_percent, Math.random())");
    for (const gaps of [mdGaps, pageGaps]) {
      expect(gaps).not.toMatch(/canary/i);
      expect(gaps).not.toContain("share of real traffic");
    }
  });

  it("and the machines bullet says which backend it is talking about", () => {
    // It used to say copies "all live on one host", which stopped being true
    // for Kubernetes one milestone ago and was still sitting there.
    for (const gaps of [mdGaps, pageGaps]) {
      expect(gaps).not.toContain("all live on one host");
      // Sentence-initial in the markdown, mid-sentence in the page.
      expect(gaps).toMatch(/on Kubernetes copies do spread across/i);
    }
  });
});
