// A VITE_* setting that the Dockerfile cannot receive is a setting that works
// in `npm run dev` and silently does nothing in the shipped image.
//
// Vite substitutes `import.meta.env.VITE_X` by LITERAL TEXT at build time (see
// envDefine in vite.config.ts). A variable the build container never receives
// therefore does not error — it resolves to undefined, the code takes its
// fallback, and the operator who set it in .env has no way to tell. Four had
// already drifted out of the Dockerfile when this test was written:
// VITE_BI_SNAPSHOT_ROWS_CAP, VITE_GA_ID, VITE_GTM_ID and
// VITE_NOTEBOOK_GATEWAY_PORT.
import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
const COMPOSE = readFileSync("docker-compose.yml", "utf8");

describe("every VITE_ setting survives the Docker build", () => {
  const inCode = viteVarsInCode();

  it("found the settings, so the check is not vacuous", () => {
    expect(inCode.size).toBeGreaterThan(3);
  });

  it("the Dockerfile declares an ARG for each one", () => {
    const missing = [...inCode].filter(
      ([name]) => !new RegExp(`^ARG ${name}$`, "m").test(DOCKERFILE),
    );
    expect(
      missing.map(([n, f]) => `${n} (read by ${f})`),
      "read by the app but not receivable by the Docker build — it would resolve to undefined in the image",
    ).toEqual([]);
  });

  it("the Dockerfile also promotes each ARG to ENV, or the build cannot see it", () => {
    // An ARG alone is not visible to `npm run build`; it has to reach the
    // build step's environment.
    const notExported = [...inCode.keys()].filter(
      (name) => !new RegExp(`${name}=\\$${name}`).test(DOCKERFILE),
    );
    expect(notExported, "declared as ARG but never exported as ENV").toEqual([]);
  });

  it("compose passes each one as a build arg", () => {
    const missing = [...inCode.keys()].filter(
      (name) => !new RegExp(`^\\s+${name}:\\s*\\$\\{${name}`, "m").test(COMPOSE),
    );
    expect(missing, "not passed by docker compose, so `docker compose up` ignores it").toEqual([]);
  });

  it("optional ones do not break a build that omits them", () => {
    // `${VAR}` with no default makes compose warn and pass an empty string;
    // `${VAR:-}` states the intent. Required settings (Supabase) are
    // deliberately left bare so a missing one is noisy.
    for (const name of ["VITE_BI_SNAPSHOT_ROWS_CAP", "VITE_GA_ID", "VITE_GTM_ID"]) {
      expect(COMPOSE, `${name} should be optional in compose`).toContain(`\${${name}:-}`);
    }
  });
});
