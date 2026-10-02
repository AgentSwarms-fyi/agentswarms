// A warm endpoint answers at the same decision line as a cold one.
//
// The threshold is the one place this platform makes a business decision:
// approve or decline, flag or pass. It lives on the version, and the batch
// path puts it in the job config every run so that "moving the line takes
// effect on the next prediction" is true.
//
// The warm scorer reused the config frozen at DEPLOY time, which never
// contained it. So the same model and the same row answered at argmax when a
// replica happened to be up and at the operator's line when it was not, and
// the warm rows carried no `threshold_applied` column to tell the two apart.
// The documentation says "The scoring is identical" and "A missing endpoint is
// slower, never wrong"; both were false for any version with a threshold.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const serve = readFileSync("src/utils/ml/serve.server.ts", "utf8");
const predict = readFileSync("src/utils/ml/predict.server.ts", "utf8");
const scorer = readFileSync("docker/notebook-runtime/score_server.py", "utf8");

describe("the decision line reaches the warm path", () => {
  it("is sent in the request body, not baked into the deployment", () => {
    // Per request, because a deploy-time copy would freeze the line until the
    // next redeploy and break the documented promise.
    expect(serve).toMatch(/decision_threshold: args\.version\.decision_threshold/);
    expect(serve).toMatch(/positive_label: args\.version\.positive_label/);
  });

  it("is not in the config built at deploy time", () => {
    // If it appears there too, the frozen copy wins on a stale replica and
    // the per-request value silently stops mattering.
    const deployCfg = serve.slice(
      serve.indexOf("const config: Record<string, unknown> = {"),
      serve.indexOf("etlPrelude"),
    );
    expect(deployCfg, "the deploy config moved; re-anchor").toContain("artifact_uri");
    expect(deployCfg).not.toContain("decision_threshold");
  });

  it("is applied by the scorer, overriding the frozen config", () => {
    expect(scorer).toMatch(/def score\(rows, threshold=None, positive_label=None\)/);
    expect(scorer).toMatch(
      /if threshold is not None:\s*\n\s*cfg\["decision_threshold"\] = threshold/,
    );
    expect(scorer).toMatch(/score\(rows, body\.get\("decision_threshold"\)/);
  });

  it("still reads the line from the version on the cold path", () => {
    // The two paths must take it from the same place, or they drift again.
    expect(predict).toMatch(/decision_threshold: b\.version\.decision_threshold/);
  });
});

describe("the shadow asks under the same rule as the primary", () => {
  it("is given the line rather than inventing one", () => {
    // Now that the primary applies a threshold, a mirror that did not would
    // report disagreement caused by the threshold and blame the candidate.
    // Before this change neither side applied one, so they agreed by both
    // being wrong.
    expect(serve).toMatch(/async function mirrorToCandidate\([\s\S]{0,400}line: number \| null/);
    expect(serve).toMatch(
      /body: JSON\.stringify\(\{ rows: args\.rows, decision_threshold: line, positive_label: label \}\)/,
    );
  });

  it("receives the primary's line at the call site", () => {
    expect(serve).toMatch(
      /mirrorToCandidate\([\s\S]{0,160}args\.version\.decision_threshold \?\? null/,
    );
  });
});
