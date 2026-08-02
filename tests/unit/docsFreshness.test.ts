// Documentation that cannot silently rot.
//
// Prose drifts from code because nothing fails when it does. Two classes of
// rot are mechanically checkable, and both were found in real files here:
//
//   * an env var the code reads that no doc mentions — undiscoverable;
//   * an env var the docs promise that no code reads — worse, because the
//     operator sets it and then wonders why nothing changed. `.env.example`
//     asked for VITE_SUPABASE_PROJECT_ID in its REQUIRED block; nothing had
//     ever read it.
//
// Plus counts: "ten connectors" survived the connector count going to 22.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SAAS_PROVIDERS } from "@/utils/saas/types";
import { WAREHOUSE_PROVIDERS } from "@/utils/warehouse/types";

const SKIP = new Set(["node_modules", ".git", "dist", ".output", ".vinxi", "coverage"]);

function walk(dir: string, test: (p: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

/**
 * Env vars the code reads.
 *
 * Both forms are needed. Most of this codebase reads through helpers —
 * `envInt("WAREHOUSE_POOL_MAX", 4)` — so scanning for `process.env.X` alone
 * misses them and then reports correctly-documented vars as phantoms.
 * SIDECAR SERVICES COUNT: services/notebook-gateway reads its own.
 */
function envVarsInCode(): Map<string, string> {
  const files = [
    ...walk("src", (p) => /\.(ts|tsx)$/.test(p)),
    ...walk("scripts", (p) => /\.(ts|mjs|js)$/.test(p)),
    ...walk("services", (p) => /\.(ts|mjs|js)$/.test(p)),
  ];
  const found = new Map<string, string>();
  const add = (n: string, f: string) => {
    if (!found.has(n)) found.set(n, f);
  };
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) add(m[1], f);
    for (const m of s.matchAll(/process\.env\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\]/g)) {
      add(m[1], f);
    }
    for (const m of s.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g)) add(m[1], f);
    for (const m of s.matchAll(/\benv(?:Int|Num|Bool|Str)?\(\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]/g)) {
      add(m[1], f);
    }
  }
  return found;
}

/**
 * Files that describe the PAST rather than the present.
 *
 * A changelog exists to say "this used to be ten, and is not any more" and to
 * name the variable that was removed. Held to a docs-match-code rule it fails
 * by doing its job, and the only way to make it pass is to stop recording
 * history — so it is excluded on purpose, not worked around.
 *
 * It is excluded from BOTH directions: a variable mentioned only in a
 * changelog entry announcing its removal is not documented either.
 */
const HISTORICAL = new Set(["CHANGELOG.md"]);

function docText(): { file: string; text: string }[] {
  return [
    ...walk("docs", (p) => p.endsWith(".md")),
    ...readdirSync(".").filter((f) => f.endsWith(".md")),
    ...walk("src/routes", (p) => /docs[.\w-]*\.tsx$/.test(p)),
    ".env.example",
    "docker-compose.yml",
    "Dockerfile",
  ]
    .filter((p) => !HISTORICAL.has(p))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

/**
 * Vars deliberately left out of the operator docs.
 *
 * Every entry is a DECISION, not a backlog. Adding one should require saying
 * why here — which is the point of an explicit list rather than a loose regex.
 */
const UNDOCUMENTED_ON_PURPOSE = new Map<string, string>([
  // Set by the platform, not the operator.
  ["KUBERNETES_SERVICE_HOST", "injected by Kubernetes itself"],
  ["KUBERNETES_SERVICE_PORT", "injected by Kubernetes itself"],
  ["PORT", "standard, set by every PaaS and by the Dockerfile"],
  ["NODE_ENV", "standard Node convention"],
  ["DEV", "Vite's own build-time flag, not an operator setting"],
  // Appear inside GENERATED code samples the app emits, never read at runtime.
  ["ANTHROPIC_API_KEY", "text inside an exported agent scaffold"],
  ["GEMINI_API_KEY", "text inside an exported agent scaffold"],
  ["WEATHER_KEY", "placeholder in a slide deck's sample code"],
  // Developer tooling, documented in the script/file that reads them.
  ["BENCH_N", "scripts/bench-pool.ts, documented in its header"],
  ["BENCH_PG_HOST", "scripts/bench-pool.ts"],
  ["BENCH_PG_PORT", "scripts/bench-pool.ts"],
  ["BENCH_PG_DB", "scripts/bench-pool.ts"],
  ["BENCH_PG_USER", "scripts/bench-pool.ts"],
  ["BENCH_PG_PASSWORD", "scripts/bench-pool.ts"],
]);

describe("every env var the code reads is discoverable", () => {
  it("is documented somewhere, or listed as deliberately internal", () => {
    const docs = docText();
    const missing: string[] = [];
    for (const [name, file] of envVarsInCode()) {
      if (UNDOCUMENTED_ON_PURPOSE.has(name)) continue;
      // WORD BOUNDARY, not a substring. `includes("FOO")` is satisfied by
      // "FOO_BAR", so documenting NOTEBOOK_EGRESS_ALLOWLIST_PATH would mark
      // NOTEBOOK_EGRESS_ALLOWLIST as documented — exactly the confusion that
      // hid a wrong env-var name in the runtime docs.
      const re = new RegExp(`\\b${name}\\b(?![A-Z0-9_])`);
      if (docs.some((d) => re.test(d.text))) continue;
      missing.push(`${name} (read by ${file})`);
    }
    expect(
      missing,
      "Undocumented env vars. Document them, or add to UNDOCUMENTED_ON_PURPOSE with a reason.",
    ).toEqual([]);
  });
});

describe("the docs do not promise settings that do nothing", () => {
  // Narrowed to the families this project actually owns. A blanket scan for
  // every UPPER_SNAKE token drags in SQL identifiers, sample secret names and
  // doc filenames, and the noise makes the check useless.
  const OWNED =
    /^(WAREHOUSE|CONNECTOR|CONNECTION|CREDENTIAL|PARQUET|LOCAL_ENGINE|SWARM_RUN|NOTEBOOK|PREP|BI_CRON|AUDIT|OTEL|TRACE|PROVIDER_CREDS|INTERNAL_RUN|INTEGRATION_HEALTH)_[A-Z0-9_]+$/;

  /**
   * Names a doc mentions in order to say they do NOT exist.
   *
   * A plain "is this string present" check cannot tell "set this" from "there
   * is no such setting", and the second is worth writing down: people look for
   * NOTEBOOK_EGRESS_ALLOWLIST precisely because an older version of the docs
   * promised it.
   */
  const DOCUMENTED_AS_NONEXISTENT = new Set(["NOTEBOOK_EGRESS_ALLOWLIST"]);

  it("every documented setting in our own namespaces is read by something", () => {
    const inCode = envVarsInCode();
    const dead: string[] = [];
    for (const { file, text } of docText()) {
      for (const m of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
        const name = m[1];
        if (!OWNED.test(name) || inCode.has(name)) continue;
        if (DOCUMENTED_AS_NONEXISTENT.has(name)) continue;
        const entry = `${name} (promised in ${file})`;
        if (!dead.includes(entry)) dead.push(entry);
      }
    }
    expect(dead, "Documented settings that no code reads. Remove them, or fix the name.").toEqual(
      [],
    );
  });

  it("still says the non-existent ones do not exist", () => {
    // The allowlist above is only safe while the doc keeps making the negative
    // claim. If someone deletes the sentence, the name should go back to being
    // an error rather than sitting silently in an exemption list.
    const runtime = readFileSync("docs/DEVELOPER_WORKSPACE_RUNTIME.md", "utf8");
    expect(runtime).toMatch(/no\s+`?NOTEBOOK_EGRESS_ALLOWLIST`?\s+env var/i);
  });

  it("does not ask for a Supabase project id anywhere", () => {
    // Specific regression: it sat in .env.example's REQUIRED block and in the
    // Dockerfile, compose args and three docs. Nothing ever read it — the CLI
    // takes the ref as `supabase link --project-ref`, a flag, not an env var.
    for (const { file, text } of docText()) {
      expect(text, `${file} still asks for a project id env var`).not.toMatch(
        /\bVITE_SUPABASE_PROJECT_ID\b/,
      );
    }
  });
});

describe("connector counts in prose match the code", () => {
  const WORDS = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ];

  it("no doc claims a small number of connectors any more", () => {
    // "all ten connectors" and "ten kinds of external connection" both
    // outlived the count going to 22, on one page.
    //
    // Matches TOTALLING phrasings only. A first attempt matched any number-word
    // near "connectors" and flagged "paste a warehouse password into four
    // connectors" — a hypothetical in the Secrets page, not a count of
    // anything. A test that cries wolf gets deleted rather than heeded.
    const offenders: string[] = [];
    const patterns = [
      new RegExp(`\\ball\\s+(${WORDS.join("|")})\\s+connectors\\b`, "i"),
      new RegExp(`\\b(${WORDS.join("|")})\\s+kinds of external\\b`, "i"),
      new RegExp(
        `\\b(${WORDS.join("|")})\\s+(?:database|warehouse|data source)s?\\s+(?:are|is) supported`,
        "i",
      ),
    ];
    for (const { file, text } of docText()) {
      text.split("\n").forEach((line, i) => {
        for (const re of patterns) {
          const m = line.match(re);
          if (m) offenders.push(`${file}:${i + 1} — "${m[0]}"`);
        }
      });
    }
    expect(offenders, "Stale connector count").toEqual([]);
  });

  it("the numbers the docs do state are the real ones", () => {
    expect(WAREHOUSE_PROVIDERS.length).toBe(22);
    expect(SAAS_PROVIDERS.length).toBe(5);
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain(`${WAREHOUSE_PROVIDERS.length} databases and warehouses`);
    expect(readme).toContain(`${WAREHOUSE_PROVIDERS.length + SAAS_PROVIDERS.length} connectors`);
  });
});

describe("connectors are documented, not just counted", () => {
  const dataDocs = readFileSync("src/routes/docs.data.tsx", "utf8");
  const dataSources = readFileSync("docs/DATA_SOURCES.md", "utf8");

  it("names every provider that has fields of its own", () => {
    // The wire-compatible ones legitimately share a field table, and both docs
    // say so. These do not: each has fields nothing else has, so an operator
    // who cannot find them here has nowhere else to look.
    for (const p of ["sqlserver", "clickhouse", "oracle", "trino", "athena"]) {
      expect(dataDocs, `${p} missing from the in-app connector reference`).toMatch(
        new RegExp(`c-${p}|${p}`, "i"),
      );
    }
  });

  it("accounts for the wire-compatible providers rather than omitting them", () => {
    // They were absent from both pages entirely — 12 of 22 undocumented.
    for (const p of ["CockroachDB", "TimescaleDB", "SingleStore", "PlanetScale"]) {
      expect(dataDocs, `${p} unmentioned in the in-app docs`).toContain(p);
      expect(dataSources, `${p} unmentioned in DATA_SOURCES.md`).toContain(p);
    }
  });
});
