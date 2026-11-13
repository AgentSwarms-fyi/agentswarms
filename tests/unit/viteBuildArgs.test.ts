// One image for every environment (R469, inverting what this file pinned).
//
// Vite substitutes `import.meta.env.VITE_X` by LITERAL TEXT at build time. So
// until R464 a browser setting had to be a Docker build arg: one the build did
// not receive resolved to undefined and silently did nothing in the shipped
// image. Four had drifted out of the Dockerfile when the first version of this
// test was written (VITE_BI_SNAPSHOT_ROWS_CAP, VITE_GA_ID, VITE_GTM_ID,
// VITE_NOTEBOOK_GATEWAY_PORT), and it pinned that each one was an ARG.
//
// R464 gave every setting a runtime path: the server reads PUBLIC_<NAME> (then
// VITE_<NAME>) from its environment when it starts and hands it to the page
// (src/lib/publicConfig.ts). R469 then took the build args out, so the image a
// release publishes carries no install's values. What has to hold now:
//
//   - the image is built with no VITE_* at all (Dockerfile, Compose, CI);
//   - every VITE_* the code reads has its runtime name, so dropping the build
//     arg cannot silently drop the setting;
//   - Compose hands the whole .env to the running app, so an existing install
//     that only ever set VITE_* keeps every setting.
import { readdirSync, readFileSync } from "node:fs";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { PUBLIC_CONFIG_VARS } from "../../src/lib/publicConfig";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", ".output"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every VITE_* the application code actually reads. */
function viteVarsInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of walk("src")) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
      if (!found.has(m[1])) found.set(m[1], f);
    }
  }
  return found;
}

const DOCKERFILE = readFileSync("Dockerfile", "utf8");
const COMPOSE = yaml.load(readFileSync("docker-compose.yml", "utf8")) as {
  services: Record<
    string,
    { build?: { args?: Record<string, string> }; env_file?: string | string[] }
  >;
};

describe("the app image carries no install's settings", () => {
  const inCode = viteVarsInCode();

  it("found the settings, so the check is not vacuous", () => {
    expect(inCode.size).toBeGreaterThan(3);
  });

  it("the Dockerfile takes no VITE_* build arg and sets no VITE_* env", () => {
    expect(DOCKERFILE).not.toMatch(/^ARG VITE_/m);
    expect(DOCKERFILE).not.toMatch(/\bVITE_[A-Z0-9_]+=/);
  });

  it("Compose passes none as a build arg", () => {
    const args = Object.keys(COMPOSE.services.agentswarms.build?.args ?? {});
    expect(args.filter((a) => a.startsWith("VITE_"))).toEqual([]);
  });

  it("neither CI build of the image passes one", () => {
    for (const wf of [".github/workflows/image-scan.yml", ".github/workflows/release.yml"]) {
      expect(readFileSync(wf, "utf8"), wf).not.toMatch(/--build-arg\s+VITE_/);
    }
  });

  it("every setting the code reads has a runtime name, so no build arg is needed", () => {
    const runtime = new Set(Object.values(PUBLIC_CONFIG_VARS).map((v) => v.build));
    const missing = [...inCode].filter(([name]) => !runtime.has(name));
    expect(
      missing.map(([n, f]) => `${n} (read by ${f})`),
      "read only at build time: in the published image it would be undefined",
    ).toEqual([]);
  });

  it("Compose hands the .env to the running app, VITE_* included", () => {
    const envFile = COMPOSE.services.agentswarms.env_file;
    expect([envFile].flat()).toContain(".env");
  });
});
