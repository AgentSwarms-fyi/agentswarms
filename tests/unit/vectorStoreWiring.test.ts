// An install whose .env predates the vector-store wiring gets it (R417).
//
// Found on a real install: `.env.example` has selected the bundled Qdrant
// since 2026-09-15, but an installer only copies it when there is no .env at
// all. An older .env had neither line, so Qdrant ran, healthy, and searched
// nothing; RAG Settings called it "not configured" and Monitoring said "No
// problems detected". Three things change that, and this file holds them:
//
//   - both installers add QDRANT_URL and VECTOR_STORE when, and only when,
//     they are absent (a value already there is a choice);
//   - they do it before --dev rewrites QDRANT_URL to loopback;
//   - Monitoring flags a bundled Qdrant nothing is pointed at.
//
// Switching is only safe because the index fills itself from Postgres and is
// not searched until it has (vectorIndexSync.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  wiringWarnings,
  withPublishedDefaultWarnings,
  type ServiceProbe,
} from "@/lib/serviceHealth";

const rd = (p: string) => readFileSync(p, "utf8");

describe("the installers wire an older .env", () => {
  const sh = rd("scripts/setup.sh");
  const ps = rd("scripts/setup.ps1");

  it("adds each line only when it is absent", () => {
    // Run for real, both shells, five .env shapes: scratchpad r417
    // installers_wiring.py (UI_TEST_RESULTS, R417). These pin the conditions.
    expect(sh).toMatch(
      /if ! grep -qE '\^QDRANT_URL=' \.env; then[\s\S]{0,120}setenv QDRANT_URL "http:\/\/qdrant:6333"/,
    );
    expect(sh).toMatch(
      /if ! grep -qE '\^VECTOR_STORE=' \.env && \[ -n "\$\(getenv QDRANT_URL\)" \]; then[\s\S]{0,400}setenv VECTOR_STORE "qdrant"/,
    );
    expect(ps).toMatch(
      /if \(-not \(Select-String -Path \$envFile -Pattern '\^QDRANT_URL=' -Quiet\)\) \{[\s\S]{0,120}Set-EnvVar "QDRANT_URL" "http:\/\/qdrant:6333"/,
    );
    expect(ps).toMatch(
      /if \(-not \(Select-String -Path \$envFile -Pattern '\^VECTOR_STORE=' -Quiet\) -and\s+-not \[string\]::IsNullOrEmpty\(\(Get-EnvVar "QDRANT_URL"\)\)\) \{[\s\S]{0,400}Set-EnvVar "VECTOR_STORE" "qdrant"/,
    );
  });

  it("says how to keep Postgres, in both", () => {
    for (const [name, text] of [
      ["setup.sh", sh],
      ["setup.ps1", ps],
    ] as const) {
      expect(text, name).toContain("To keep searching Postgres, set VECTOR_STORE=");
    }
  });

  it("wires before --dev points QDRANT_URL at loopback, so dev still wins", () => {
    expect(sh.indexOf('setenv QDRANT_URL "http://qdrant:6333"')).toBeLessThan(
      sh.indexOf('setenv QDRANT_URL "http://127.0.0.1:6333"'),
    );
    expect(ps.indexOf('Set-EnvVar "QDRANT_URL" "http://qdrant:6333"')).toBeLessThan(
      ps.indexOf('Set-EnvVar "QDRANT_URL" "http://127.0.0.1:6333"'),
    );
  });

  it("wires before anything can stop the script", () => {
    // The required-values check exits; wiring after it would never run on an
    // .env that is still missing a Supabase key.
    expect(sh.indexOf('setenv VECTOR_STORE "qdrant"')).toBeLessThan(sh.indexOf('MISSING=""'));
    expect(ps.indexOf('Set-EnvVar "VECTOR_STORE" "qdrant"')).toBeLessThan(
      ps.indexOf("$required = @("),
    );
  });
});

describe("Monitoring flags a Qdrant nothing searches", () => {
  const up: ServiceProbe = {
    id: "qdrant",
    label: "Vector store (Qdrant)",
    purpose: "",
    status: "up",
    latencyMs: 3,
    endpoint: "http://qdrant:6333",
  };

  it("on an .env with neither line", () => {
    const w = wiringWarnings({});
    expect(w.qdrant).toMatch(/does not search it: QDRANT_URL is not set/);
    expect(w.qdrant).toContain('QDRANT_URL="http://qdrant:6333"');
    const [p] = withPublishedDefaultWarnings([up], w);
    expect(p.status).toBe("degraded");
  });

  it("not when it is wired, and not when Postgres is a stated choice", () => {
    expect(wiringWarnings({ QDRANT_URL: "http://qdrant:6333" })).toEqual({});
    expect(wiringWarnings({ VECTOR_STORE: "pgvector" })).toEqual({});
    expect(wiringWarnings({ VECTOR_STORE: " PGVECTOR " })).toEqual({});
    // `QDRANT_URL=` in .env arrives as an empty string, not as absent: that
    // operator turned it off, and the installers leave it off too.
    expect(wiringWarnings({ QDRANT_URL: "" })).toEqual({});
  });

  it("is merged into the probes the page shows", () => {
    // Whitespace-tolerant: the first version pinned one line, and Prettier
    // wrapped it (the R417 gate failed on that, not on the code).
    const fns = rd("src/utils/monitoring.functions.ts");
    expect(fns).toMatch(
      /withPublishedDefaultWarnings\(\[app, db, \.\.\.rest\], \{\s*\.\.\.publishedDefaultWarnings\(process\.env\),\s*\.\.\.wiringWarnings\(process\.env\),?\s*\}\)/,
    );
  });
});
