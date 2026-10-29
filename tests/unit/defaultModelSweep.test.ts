// No model is chosen in .env, and no code falls back to a model of its own.
//
// The default model is an admin setting (Admin → Developer runtime → AI
// services → Default model) and every surface that has no model of its own
// runs on it, through providers/defaultModel.server. Before this, the
// fallback lived in a dozen places: OPENROUTER_DEFAULT_MODEL in three routes,
// SHEETS_ASSIST_MODEL / AI_SQL_DEFAULT_MODEL / DOCUMENT_VISION_MODEL in the
// runtime settings, and `|| "openai/gpt-4o-mini"`-style literals in the chat
// route, the generators, memory, the graph builder, swarms, evals and the
// playground — each a different model, none of them the one an admin chose.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const SRC = files("src").map((p) => ({
  path: p.split("\\").join("/"),
  text: readFileSync(p, "utf8"),
}));

const RETIRED = [
  "OPENROUTER_DEFAULT_MODEL",
  "SHEETS_ASSIST_MODEL",
  "AI_SQL_DEFAULT_MODEL",
  "DOCUMENT_VISION_MODEL",
];

/** `x || "openai/gpt-4o-mini"`, `?? "google/…"`: a model written in as a fallback. */
const FALLBACK_LITERAL =
  /(\|\||\?\?)\s*["'](openrouter\/)?(openai|google|anthropic|meta-llama|mistralai|deepseek|x-ai|qwen)\/[a-z0-9.:-]+["']/;

/** Content that names models on purpose: catalogs, prices, templates and samples. */
const NAMES_MODELS_ON_PURPOSE = [
  "src/components/docs/docsIndex.ts",
  "src/lib/sampleAgentsWithSkills.ts",
  "src/lib/sampleNotebooks.ts",
  "src/lib/pythonNotebookTemplate.ts",
  "src/lib/realTemplates.ts",
  "src/lib/swarmTemplates.ts",
];

describe("the default model", () => {
  it("is not read from the environment anywhere", () => {
    const offenders = SRC.filter((f) =>
      RETIRED.some(
        (n) => f.text.includes(`process.env.${n}`) || f.text.includes(`process.env["${n}"]`),
      ),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("is the only fallback: nothing falls back to a model written into the code", () => {
    const offenders = SRC.filter((f) => !NAMES_MODELS_ON_PURPOSE.includes(f.path)).flatMap((f) =>
      f.text
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => FALLBACK_LITERAL.test(line) && !line.trim().startsWith("//"))
        .map(({ line, i }) => `${f.path}:${i + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("has one built-in value, used only until an administrator sets one", () => {
    const resolver = readFileSync("src/utils/providers/defaultModel.server.ts", "utf8");
    expect(resolver).toMatch(/export const BUILTIN_DEFAULT_MODEL = "openrouter\/[^"]+";/);
    expect(resolver).toContain('.select("default_model")');
    // Surfaces reach it through the resolver, not by reading the setting.
    const readers = SRC.filter(
      (f) =>
        f.text.includes('.select("default_model")') &&
        !f.path.endsWith("providers/defaultModel.server.ts") &&
        !f.path.endsWith("defaultModelAdmin.functions.ts"),
    ).map((f) => f.path);
    expect(readers).toEqual([]);
  });

  it("is what every model-calling route resolves through", () => {
    for (const path of [
      "src/routes/api/chat.ts",
      "src/routes/api/python-chat.ts",
      "src/routes/api/embed.ts",
      "src/routes/api/embed.chat.ts",
      "src/routes/api/etl.generate.ts",
      "src/routes/api/lakehouse.generate.ts",
      "src/routes/api/skills.generate.ts",
      "src/routes/api/kb/build-graph.ts",
      "src/utils/bi/llmJson.server.ts",
      "src/utils/aiSql/run.server.ts",
      "src/utils/sheetsAssist.functions.ts",
      "src/utils/documents/vision.server.ts",
      "src/utils/tools/kbQa.server.ts",
      "src/utils/memory/summarize.server.ts",
      "src/utils/memory/extract.server.ts",
    ]) {
      expect(readFileSync(path, "utf8"), path).toMatch(/chooseModel\(|openAiCompatTarget\(/);
    }
  });

  it("is in the .env example only as a note that it moved", () => {
    const env = readFileSync(".env.example", "utf8");
    for (const n of RETIRED) expect(env, n).not.toMatch(new RegExp(`^${n}=`, "m"));
  });

  it("shows in Traces when a call fell back to it, not only in the raw payload", () => {
    // Both writers stamp the same key...
    expect(readFileSync("src/utils/observability/recordGatewayUsage.server.ts", "utf8")).toContain(
      "requestPayload.model_fallback = args.modelFallback",
    );
    expect(readFileSync("src/routes/api/chat.ts", "utf8")).toMatch(/model_fallback: modelFallback/);
    // ...the list projects it without the payload, the detail derives it...
    const fns = readFileSync("src/utils/traceLog.functions.ts", "utf8");
    expect(fns).toContain("fell_back_from:request_payload->model_fallback->>from");
    expect(fns).toMatch(/fell_back_from: typeof from === "string" \? from : null/);
    // ...and the page marks the row and explains it.
    const ui = readFileSync("src/routes/_authenticated/traces.tsx", "utf8");
    expect(ui).toContain("fell_back_from:request_payload->model_fallback->>from");
    expect(ui).toMatch(/\{t\.fell_back_from && \(/);
    expect(ui).toContain('<Section title="Model fallback">');
  });
});
