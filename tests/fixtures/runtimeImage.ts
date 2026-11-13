// The sandbox image on this machine, for the tests that run Python in it.
//
// Since R470 Compose names it ghcr.io/agentswarms-fyi/notebook-runtime:<version>
// (":local" when built from a checkout). A machine whose stack was built
// before that still has agentswarms/notebook-runtime:latest, and
// NOTEBOOK_RUNTIME_IMAGE names any other. The first that is present wins;
// none present means the caller skips.
import { execFileSync } from "node:child_process";

export const RUNTIME_IMAGE_CANDIDATES = [
  process.env.NOTEBOOK_RUNTIME_IMAGE,
  "ghcr.io/agentswarms-fyi/notebook-runtime:local",
  "agentswarms/notebook-runtime:latest",
].filter((x): x is string => !!x);

export function localRuntimeImage(): string | null {
  for (const image of RUNTIME_IMAGE_CANDIDATES) {
    try {
      execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
      return image;
    } catch {
      /* not here: the next */
    }
  }
  return null;
}
