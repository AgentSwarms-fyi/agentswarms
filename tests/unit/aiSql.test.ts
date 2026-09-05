// AI functions in lakehouse SQL — the pure rules: which calls a statement
// makes, how arguments are read, what each function asks the model, and how
// an answer becomes a cell. Every passing case has a failing neighbour, since
// the point of a typed cell is what it refuses.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AI_SQL_FUNCTIONS,
  AI_SQL_FUNCTION_DOCS,
  aiCallIdentity,
  aiCallsOverCapMessage,
  buildAiPrompt,
  normalizeAiAnswer,
  parseAiArgs,
  splitList,
  usesAiSqlFunctions,
  type AiCall,
} from "@/utils/aiSql/core";

const PROVIDERS = ["openrouter", "openai", "anthropic", "gemini"];
const call = (over: Partial<AiCall>): AiCall => ({
  fn: "ai_complete",
  text: "hello",
  detail: null,
  maxWords: null,
  model: null,
  ...over,
});

describe("detecting AI functions in a statement", () => {
  it("finds each function once, case-insensitively, in call position only", () => {
    expect(
      usesAiSqlFunctions("SELECT AI_CLASSIFY(region, 'a, b'), ai_classify(plan, 'x') FROM t"),
    ).toEqual(["ai_classify"]);
    expect(usesAiSqlFunctions("select ai_sentiment (status), ai_filter(x, 'y') from t")).toEqual([
      "ai_sentiment",
      "ai_filter",
    ]);
  });

  it("ignores mentions inside comments and string literals", () => {
    expect(usesAiSqlFunctions("SELECT 1 -- ai_complete(x)\nFROM t")).toEqual([]);
    expect(usesAiSqlFunctions("SELECT 'ai_complete(' FROM t /* ai_filter( */")).toEqual([]);
    expect(usesAiSqlFunctions("SELECT ai_completed(x) FROM t")).toEqual([]);
  });

  it("documents every function with an example that calls it", () => {
    for (const fn of AI_SQL_FUNCTIONS) {
      const d = AI_SQL_FUNCTION_DOCS[fn];
      expect(d.signature.startsWith(`${fn}(`)).toBe(true);
      expect(usesAiSqlFunctions(d.example)).toContain(fn);
    }
  });
});

describe("reading arguments as DuckDB hands them over", () => {
  it("takes the trailing model only when it names a known provider", () => {
    const a = parseAiArgs(
      "ai_complete",
      ["write a haiku", "openrouter/google/gemini-3-flash-preview"],
      PROVIDERS,
    );
    expect(a).toEqual({
      ok: true,
      call: call({ text: "write a haiku", model: "openrouter/google/gemini-3-flash-preview" }),
    });
    // Two arguments with no provider prefix is one too many for ai_complete.
    const b = parseAiArgs("ai_complete", ["write a haiku", "about/rivers"], PROVIDERS);
    expect(b.ok).toBe(false);
    if (!b.ok)
      expect(b.error).toContain(
        "ai_complete takes a prompt and an optional model; got 2 arguments.",
      );
  });

  it("ai_summarize tells a word limit from a model", () => {
    const a = parseAiArgs("ai_summarize", ["long text", "12"], PROVIDERS);
    expect(a.ok && a.call.maxWords).toBe(12);
    const b = parseAiArgs("ai_summarize", ["long text", "12", "openai/gpt-4o-mini"], PROVIDERS);
    expect(b.ok && b.call.maxWords === 12 && b.call.model === "openai/gpt-4o-mini").toBe(true);
    const c = parseAiArgs("ai_summarize", ["long text", "many"], PROVIDERS);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain('word limit must be a positive number; got "many"');
  });

  it("the two-argument functions need their second argument", () => {
    for (const fn of ["ai_classify", "ai_extract", "ai_translate", "ai_filter"] as const) {
      const ok = parseAiArgs(fn, ["text", "something"], PROVIDERS);
      expect(ok.ok && ok.call.detail).toBe("something");
      const missing = parseAiArgs(fn, ["text"], PROVIDERS);
      expect(missing.ok).toBe(false);
      const blank = parseAiArgs(fn, ["text", "   "], PROVIDERS);
      expect(blank.ok).toBe(false);
      if (!blank.ok) expect(blank.error).toContain("the second argument is empty");
    }
  });

  it("splits label lists without duplicates and keeps their order", () => {
    expect(splitList(" emea, APAC ,emea,, Americas ")).toEqual(["emea", "APAC", "Americas"]);
  });
});

describe("what each function asks", () => {
  it("every prompt forbids prose and ai_classify names the labels", () => {
    for (const fn of AI_SQL_FUNCTIONS) {
      const p = buildAiPrompt(call({ fn, detail: "a, b", maxWords: 10 }));
      expect(p.system).toContain("Answer with the value only");
      expect(p.user).toBe("hello");
      expect(p.maxTokens).toBeGreaterThan(0);
    }
    const c = buildAiPrompt(call({ fn: "ai_classify", detail: "emea, apac" }));
    expect(c.system).toContain("emea | apac");
    expect(c.maxTokens).toBeLessThan(64);
    const s = buildAiPrompt(call({ fn: "ai_summarize", maxWords: 12 }));
    expect(s.system).toContain("at most 12 words");
    expect(buildAiPrompt(call({ fn: "ai_summarize" })).system).toContain("at most 40 words");
  });

  it("the same call to the same model has one identity; a different model does not", () => {
    const a = call({ fn: "ai_classify", text: "x", detail: "a, b" });
    expect(aiCallIdentity(a, "openrouter/m")).toBe(aiCallIdentity({ ...a }, "openrouter/m"));
    expect(aiCallIdentity(a, "openrouter/m")).not.toBe(aiCallIdentity(a, "openai/m"));
    expect(aiCallIdentity(a, "openrouter/m")).not.toBe(
      aiCallIdentity({ ...a, detail: "b, a" }, "openrouter/m"),
    );
  });
});

describe("turning an answer into a cell", () => {
  it("ai_classify returns a label verbatim, or NULL for anything else", () => {
    const c = call({ fn: "ai_classify", detail: "EMEA, APAC, Americas" });
    expect(normalizeAiAnswer(c, "apac")).toBe("APAC");
    expect(normalizeAiAnswer(c, '"EMEA".')).toBe("EMEA");
    expect(normalizeAiAnswer(c, "Label: americas")).toBe("Americas");
    expect(normalizeAiAnswer(c, "NONE")).toBeNull();
    expect(normalizeAiAnswer(c, "EMEA or APAC")).toBeNull();
  });

  it("ai_sentiment is one of four words", () => {
    const c = call({ fn: "ai_sentiment" });
    expect(normalizeAiAnswer(c, "Positive.")).toBe("positive");
    expect(normalizeAiAnswer(c, "mixed")).toBe("mixed");
    expect(normalizeAiAnswer(c, "I think it is good")).toBeNull();
  });

  it("ai_extract returns exactly the fields asked for, as JSON, tolerating fences", () => {
    const c = call({ fn: "ai_extract", detail: "first_name, last_name" });
    const out = normalizeAiAnswer(c, '```json\n{"First_Name": "Ada", "extra": 1}\n```');
    expect(JSON.parse(out ?? "{}")).toEqual({ first_name: "Ada", last_name: null });
    expect(normalizeAiAnswer(c, "Ada Lovelace")).toBeNull();
    expect(normalizeAiAnswer(c, "[1, 2]")).toBeNull();
  });

  it("ai_filter is true or false", () => {
    const c = call({ fn: "ai_filter", detail: "is a company" });
    expect(normalizeAiAnswer(c, "TRUE")).toBe("true");
    expect(normalizeAiAnswer(c, "No")).toBe("false");
    expect(normalizeAiAnswer(c, "It depends")).toBeNull();
  });

  it("free-text functions keep the text and drop fences; empty is NULL", () => {
    expect(normalizeAiAnswer(call({ fn: "ai_complete" }), "```\nHello\n```")).toBe("Hello");
    expect(normalizeAiAnswer(call({ fn: "ai_translate", detail: "fr" }), "   ")).toBeNull();
  });

  it("the cap message says what to do", () => {
    const m = aiCallsOverCapMessage(836, 200);
    expect(m).toContain("836 AI calls");
    expect(m).toContain("limit is 200");
    expect(m).toContain("Admin → Developer runtime");
  });
});

const rd = (p: string) => readFileSync(p, "utf8");

describe("the runner and its governance wiring", () => {
  it("registers ai_* as volatile ANY-vararg scalar functions and answers misses between passes", () => {
    const run = rd("src/utils/aiSql/run.server.ts");
    expect(run).toContain("conn.registerScalarFunction(");
    expect(run).toContain("varArgsType: ANY,");
    expect(run).toContain("volatile: true,");
    expect(run).toContain("returnType: isBool ? BOOLEAN : VARCHAR,");
    expect(run).toContain("session.misses.set(key, { call: parsed.call, model });");
    expect(run).toContain("await resolveAiSqlMisses(session);");
  });

  it("every model call goes through the internal chat channel as the user, with no tools or memory", () => {
    const run = rd("src/utils/aiSql/run.server.ts");
    expect(run).toContain("await internalChatText({");
    expect(run).toContain("userId: session.userId,");
    expect(run).toContain('agentName: "AI SQL",');
    const channel = rd("src/utils/internalChat.server.ts");
    expect(channel).toContain('"x-internal-run-secret": secret');
    expect(channel).toContain("internalUserId: args.userId,");
    expect(channel).toContain("temperature: args.temperature ?? 0,");
    expect(channel).toContain("enabledTools: [],");
    expect(channel).toContain("stm_enabled: false, ltm_enabled: false");
  });

  it("the cap is checked before any call, answers are cached per user, and the statement is audited", () => {
    const run = rd("src/utils/aiSql/run.server.ts");
    const cap = run.indexOf("throw new Error(aiCallsOverCapMessage(");
    const call = run.indexOf("const answer = await callModel(session, miss);");
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(call);
    expect(run).toContain('.from("ai_function_cache")');
    expect(run).toContain('.eq("user_id", session.userId)');
    expect(run).toContain('action: "lakehouse.ai_functions"');
  });

  it("the lakehouse runner wraps its read in the AI passes and reports the calls on the result", () => {
    const core = rd("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("const { result: reader, ai } = await runWithAiSql(");
    expect(core).toContain("ai: ai ?? undefined,");
    expect(core).toContain("ai?: AiSqlStats;");
  });

  it("the migration, settings and admin form carry the three knobs; the drafter knows the functions", () => {
    const sql = rd("supabase/migrations/20260865000000_ai_sql_functions.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.ai_function_cache");
    expect(sql).toContain("ALTER TABLE public.ai_function_cache ENABLE ROW LEVEL SECURITY;");
    for (const col of [
      "ai_sql_max_calls_per_statement",
      "ai_sql_default_model",
      "ai_sql_cache_ttl_days",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      expect(rd("src/utils/notebookRuntimeAdmin.functions.ts")).toContain(`${col}:`);
      expect(rd("src/components/admin/RuntimeTab.tsx")).toContain(`"${col}"`);
    }
    const cfg = rd("src/utils/notebookRuntime/config.server.ts");
    expect(cfg).toContain('envInt("AI_SQL_MAX_CALLS_PER_STATEMENT") ??');
    expect(cfg).toContain("process.env.AI_SQL_DEFAULT_MODEL");
    expect(cfg).toContain('envInt("AI_SQL_CACHE_TTL_DAYS") ??');
    expect(rd("src/routes/api/lakehouse.generate.ts")).toContain("ai_filter(text, 'condition')");
    expect(rd("src/components/docs/DocsShell.tsx")).toContain('to: "/docs/ai-sql"');
  });
});
