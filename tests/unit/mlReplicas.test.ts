// More than one copy of a model answering.
//
// The decision of HOW MANY is pure arithmetic and lives in
// tests/unit/mlAutoscale.test.ts. These are the things that arithmetic cannot
// check: that a copy is a row in its own table rather than a column on the
// endpoint, that the caps count containers, that stopping one copy does not
// take the endpoint with it, and that a person can actually reach the control.
//
// The migration matters as much as the code here. An endpoint already running
// when this deploys has a sandbox recorded nowhere else, so a backfill that
// missed it would leave the row saying "ready" while the replicas table said
// there was nothing to score on — and every request would quietly take the
// cold path for ever, with nothing reporting a problem.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const SERVE = rd("src/utils/ml/serve.server.ts");
const OPS = rd("src/utils/mlOps.functions.ts");
const PANEL = rd("src/components/ml/DeploymentPanel.tsx");
const SCHEDULE = rd("src/utils/etl/schedule.server.ts");
const MIGRATION = rd("supabase/migrations/20260908000000_ml_deployment_replicas.sql");

describe("a copy is a row, not a column", () => {
  it("the sandbox moved out of the endpoint and into its own table", () => {
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS public.ml_deployment_replicas");
    // ONE source of truth: the old columns are dropped, not left as a mirror
    // of "the first replica" that agrees until one day it does not.
    expect(MIGRATION).toContain(
      "ALTER TABLE public.ml_deployments DROP COLUMN IF EXISTS session_id",
    );
    expect(MIGRATION).toContain("ALTER TABLE public.ml_deployments DROP COLUMN IF EXISTS endpoint");
  });

  it("and every endpoint already running is carried across", () => {
    // Without this a live endpoint is orphaned the moment this deploys.
    expect(MIGRATION).toContain("INSERT INTO public.ml_deployment_replicas");
    expect(MIGRATION).toContain("WHERE d.session_id IS NOT NULL");
    expect(MIGRATION).toContain("AND d.status IN ('starting', 'ready')");
    // Idempotent, because a migration that runs twice must not double them.
    expect(MIGRATION).toContain("AND NOT EXISTS (");
  });

  it("the drop happens AFTER the backfill reads those columns", () => {
    expect(MIGRATION.indexOf("INSERT INTO public.ml_deployment_replicas")).toBeLessThan(
      MIGRATION.indexOf("DROP COLUMN IF EXISTS session_id"),
    );
  });

  it("autoscaling is off until an owner asks for it", () => {
    // Each copy is a container holding sklearn resident on somebody's machine.
    expect(MIGRATION).toContain("max_replicas integer NOT NULL DEFAULT 1");
    expect(MIGRATION).toContain("CHECK (min_replicas <= max_replicas)");
  });
});

describe("the limits count containers", () => {
  it("countLive counts replicas, not deployments", () => {
    // The cap bounds resident memory, and one endpoint with four copies is
    // four sandboxes. Counting deployments would have let a single endpoint
    // walk through a limit written to protect the machine.
    const fn = SERVE.slice(SERVE.indexOf("async function countLive"));
    expect(fn.slice(0, 500)).toContain('.from("ml_deployment_replicas")');
    expect(fn.slice(0, 500)).not.toContain('.from("ml_deployments")');
  });

  it("and every new copy checks there is room first", () => {
    expect(SERVE).toContain("async function replicaRoom(");
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain("const room = await replicaRoom(dep.user_id);");
    expect(scale.indexOf("const room = await replicaRoom")).toBeLessThan(
      scale.indexOf("const started = await startReplica("),
    );
  });
});

describe("scoring spreads across the copies", () => {
  it("picks the quietest by the same rule the scaler stops by", () => {
    // Two notions of "quietest" would have the scorer and the scaler
    // disagreeing about the same endpoint, and the idle clock the scale-down
    // safety check reads would stop meaning what it says.
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    expect(warm).toContain("const replica = replicaToScore(ready);");
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain("const quietest = replicaToStop(ready);");
  });

  it("one dead copy is retired without taking the endpoint down", () => {
    const warm = SERVE.slice(SERVE.indexOf("export async function scoreWarm"));
    expect(warm).toContain("void retireReplica(replica,");
    expect(warm).not.toContain('.from("ml_deployments").update({ endpoint: null })');
  });

  it("use is recorded on both the endpoint and the copy that answered", () => {
    // The endpoint's counter is differenced into a rate; the copy's timestamp
    // is what makes stopping it safe. Neither can be derived from the other.
    expect(SERVE).toContain("async function touch(deploymentId: string, replicaId: string)");
    const touch = SERVE.slice(SERVE.indexOf("async function touch("));
    expect(touch.slice(0, 800)).toContain("increment_ml_deployment_use");
    expect(touch.slice(0, 800)).toContain('.from("ml_deployment_replicas")');
  });

  it("a version change retires every copy, not the first one", () => {
    // Leaving one behind is an endpoint answering with two different models
    // depending on which copy the round-robin picks.
    const ensure = SERVE.slice(SERVE.indexOf("export async function ensureDeployment"));
    expect(ensure).toContain('await retireReplica(replica, "replaced");');
  });

  it("and taking the endpoint down stops all of them", () => {
    const un = SERVE.slice(SERVE.indexOf("export async function undeploy"));
    expect(un.slice(0, 600)).toContain('await retireReplica(replica, "undeployed");');
  });
});

describe("the scaler measures rather than guesses", () => {
  it("takes a reading on every pass, even one that decides nothing", () => {
    // Skipping the reading would leave the next pass differencing across two
    // intervals and reporting half the real rate.
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain("const reading = {");
    expect(scale).toContain("scale_checked_count: dep.request_count,");
    // Every early return still writes it.
    const holds = scale.split("continue;").length - 1;
    expect(holds).toBeGreaterThanOrEqual(4);
  });

  it("does nothing on the first pass, having nothing to difference against", () => {
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain("if (rate === null) {");
  });

  it("adds ONE copy per pass however far behind it is", () => {
    // Starting four at once on a burst is how a machine runs out of memory
    // serving a spike that ended before they loaded.
    //
    // Scoped to the FUNCTION, not to the end of the file. Slicing to EOF also
    // swept up setShadowCandidate's own startReplica call once shadowing was
    // added, and the honest fix is a tighter slice rather than a looser count.
    const from = SERVE.indexOf("export async function autoscaleDeployments");
    const after = SERVE.slice(from + 10);
    const scale = after.slice(
      0,
      after.indexOf("/** The model and version a deployment is serving"),
    );
    expect(scale.length).toBeGreaterThan(1000);
    const ups = scale.split("startReplica(").length - 1;
    expect(ups).toBe(1);
  });

  it("a copy that has never answered is still stoppable", () => {
    // FOUND LIVE. last_used_at is null until something is routed to a copy, so
    // reading only that returned null, the safety check said "no copy is idle
    // enough to stop", and an endpoint that scaled up during a burst could
    // never shrink again.
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain(
      "(idleSeconds(quietest.last_used_at, now) ?? idleSeconds(quietest.last_started_at, now))",
    );
  });

  it("stops the copy the decision already judged safe", () => {
    // The safety check and the action must mean the same container.
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain('await retireReplica(quietest, "scaled down");');
  });

  it("records why, and audits the change", () => {
    const scale = SERVE.slice(SERVE.indexOf("export async function autoscaleDeployments"));
    expect(scale).toContain("last_scale_reason");
    expect(scale).toContain('action: "ml.scale"');
  });

  it("runs on the platform clock, after the reaper", () => {
    // Before it, a pass could measure an endpoint it is about to stop and
    // start a copy of it.
    expect(SCHEDULE).toContain("m.autoscaleDeployments()");
    expect(SCHEDULE.indexOf("m.reapIdleDeployments()")).toBeLessThan(
      SCHEDULE.indexOf("m.autoscaleDeployments()"),
    );
  });

  it("every limit is an env knob with a default", () => {
    expect(SERVE).toContain('envCount("ML_SERVE_TARGET_RPM_PER_REPLICA", 120)');
    expect(SERVE).toContain('envCount("ML_SERVE_SCALE_COOLDOWN_SECONDS", 180)');
  });
});

describe("the reaper understands copies", () => {
  it("reads every copy's clock before calling an endpoint idle", () => {
    // A copy started a moment ago means something IS happening, whatever the
    // endpoint's own timestamps say.
    const reap = SERVE.slice(SERVE.indexOf("export async function reapIdleDeployments"));
    expect(reap).toContain("...replicas.flatMap((r) => [r.last_used_at, r.last_started_at])");
    expect(reap).toContain('for (const replica of replicas) await retireReplica(replica, "idle");');
  });
});

describe("the docs say what a copy actually lands on", () => {
  const MD = rd("docs/ML.md");
  const PAGE = rd("src/routes/docs.ml.tsx");

  it("names the backend, because a copy is a container or a Pod", () => {
    // startReplica goes through startSession -> getOrchestrator, so the answer
    // is whatever backend is configured. Claiming "one machine" was wrong on
    // Kubernetes, where the scheduler may place a copy on any node.
    for (const f of [MD, PAGE]) {
      // The markdown bolds it as "Another **Pod**" and the page does not, so
      // the emphasis is optional rather than the assertion being loosened to
      // just "Pod" — which would match half the document.
      expect(f).toMatch(/Another \*{0,2}Pod/);
      expect(f).toContain("Another container on this machine");
    }
    expect(rd("src/utils/notebookRuntime/orchestrator.ts")).toContain('case "k8s"');
  });

  it("and is explicit that this is NOT a Deployment or an HPA", () => {
    // Bare Pods with no ReplicaSet and no Service: the app holds each address
    // and balances itself, so a reader looking for an HPA will not find one.
    for (const f of [MD, PAGE]) {
      expect(f).toContain("bare Pods");
      expect(f).toMatch(/HorizontalPodAutoscaler|HPA/);
    }
  });

  it("and warns that copies stop helping past the core count", () => {
    // The scorer is a ThreadingHTTPServer, so one copy already takes
    // concurrent requests; the GIL is what makes a second PROCESS the thing
    // that adds parallelism, and cores are what bound it.
    expect(rd("docker/notebook-runtime/score_server.py")).toContain("ThreadingHTTPServer");
    for (const f of [MD, PAGE]) {
      expect(f).toContain("GIL");
      // The CLAIM, not the word. /cores/ also matched "when you have cores
      // spare" two paragraphs away, so deleting the limit itself went
      // unnoticed — a mutation check found that.
      // The page writes machine&apos;s, the markdown a real apostrophe, so the
      // possessive is matched as either rather than with a wildcard that
      // silently failed on the six-character entity.
      expect(f).toMatch(/help up to roughly the machine(?:'|&apos;)s core count/);
    }
  });
});

describe("a person can see and set it", () => {
  it("the view carries the copies and the policy", () => {
    expect(OPS).toContain("min_replicas: number;");
    expect(OPS).toContain("max_replicas: number;");
    expect(OPS).toContain("last_scale_reason: string | null;");
    // Primary-filtered since shadowing: a candidate copy is not one of the
    // copies answering, and counting it made the panel read "2 of 2 copies
    // answering" directly above "The candidate has never answered a caller".
    expect(OPS).toContain('const replicas = await listReplicas(dep.id, true, "primary");');
  });

  it("the range is validated as a PAIR, not one column at a time", () => {
    // The table's constraint reads both columns, so a request changing only
    // one would otherwise be judged against the other's old value and fail
    // with a constraint name instead of a sentence.
    expect(OPS).toContain("cannot sit above a maximum of");
    expect(OPS).toContain("min_replicas: z.number().int().min(0).max(64).optional(),");
    expect(OPS).toContain("max_replicas: z.number().int().min(1).max(64).optional(),");
  });

  it("and the panel offers it, showing what the scaler last decided", () => {
    expect(PANEL).toContain("void patch({ min_replicas: n });");
    expect(PANEL).toContain("void patch({ max_replicas: n });");
    expect(PANEL).toContain("dep.last_scale_reason");
    // Built with a plural conditional, so the rendered phrase is not a
    // literal in the source. Assert the count it is built FROM.
    expect(PANEL).toContain('dep.replicas.filter((r) => r.status === "ready").length');
    expect(PANEL).toContain("answering");
  });

  it("a refused change does not linger on screen as though it took", () => {
    // FOUND FROM THE UI. Asking for a minimum of 2 against a maximum of 1 is
    // correctly refused by the server, and the box went on showing "2" beside
    // a "1" that was the truth — with the toast explaining why gone in four
    // seconds. Reloading after a failure as well as a success is what makes
    // the screen agree with the row.
    const patch = PANEL.slice(PANEL.indexOf("async function patch("));
    const body = patch.slice(0, 900);
    expect(body).toContain("if (!res.ok) toast.error(res.error);");
    expect(body).not.toContain("if (!res.ok) return toast.error(res.error);");
    // load() runs on both paths, so it sits AFTER the failure branch rather
    // than inside a success-only one.
    expect(body.indexOf("toast.error(res.error)")).toBeLessThan(body.indexOf("await load();"));
  });

  it("and says plainly that a fixed endpoint is fixed", () => {
    // An owner who never raises the maximum should not be left wondering why
    // nothing ever scales.
    expect(PANEL).toContain("Fixed at {dep.max_replicas}");
  });
});
