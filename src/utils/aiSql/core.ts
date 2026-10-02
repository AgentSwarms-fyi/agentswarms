// AI functions in SQL, the pure half: which functions exist, how their
// arguments are read, the prompt each one sends, and how a model's answer is
// turned back into a cell. No I/O here — the runner (run.server.ts) owns the
// DuckDB registration, the cache and the model calls — so every rule below is
// unit-testable and shared with the UI's function reference.
//
// The shape follows what the warehouses ship (Snowflake AI_COMPLETE /
// AI_CLASSIFY / AI_FILTER, BigQuery ML.GENERATE_TEXT, Databricks ai_query):
// a scalar function you call per row, with the model as an optional last
// argument, defaulting to the instance's choice.

export const AI_SQL_FUNCTIONS = [
  "ai_complete",
  "ai_classify",
  "ai_extract",
  "ai_sentiment",
  "ai_summarize",
  "ai_translate",
  "ai_filter",
] as const;
export type AiSqlFunction = (typeof AI_SQL_FUNCTIONS)[number];

export const AI_SENTIMENTS = ["positive", "negative", "neutral", "mixed"] as const;

/** Reference shown in the SQL editor and the docs. Examples run as written. */
export const AI_SQL_FUNCTION_DOCS: Record<
  AiSqlFunction,
  { signature: string; returns: string; description: string; example: string }
> = {
  ai_complete: {
    signature: "ai_complete(prompt [, model])",
    returns: "VARCHAR",
    description: "The model's answer to the prompt, as text.",
    example:
      "SELECT ai_complete('One-line tagline for the ' || plan || ' plan') FROM analytics.revenue_facts LIMIT 5",
  },
  ai_classify: {
    signature: "ai_classify(text, labels [, model])",
    returns: "VARCHAR — one of the labels, or NULL",
    description: "Picks the label that fits the text best. Labels are comma-separated.",
    example:
      "SELECT region, ai_classify(region, 'americas, emea, apac') AS zone FROM analytics.revenue_facts LIMIT 20",
  },
  ai_extract: {
    signature: "ai_extract(text, fields [, model])",
    returns: "VARCHAR — a JSON object with the fields",
    description: "Pulls named fields out of free text into JSON; missing fields are null.",
    example:
      "SELECT ai_extract(customer_name, 'first_name, last_name') AS parts FROM analytics.revenue_facts LIMIT 10",
  },
  ai_sentiment: {
    signature: "ai_sentiment(text [, model])",
    returns: "VARCHAR — positive, negative, neutral or mixed",
    description: "The overall sentiment of the text.",
    example: "SELECT status, ai_sentiment(status) FROM analytics.revenue_facts LIMIT 10",
  },
  ai_summarize: {
    signature: "ai_summarize(text [, max_words] [, model])",
    returns: "VARCHAR",
    description: "A short summary, at most max_words words (default 40).",
    example:
      "SELECT ai_summarize(customer_name || ' on the ' || plan || ' plan', 12) FROM analytics.revenue_facts LIMIT 5",
  },
  ai_translate: {
    signature: "ai_translate(text, language [, model])",
    returns: "VARCHAR",
    description: "The text translated into the language named.",
    example: "SELECT ai_translate(plan, 'French') FROM analytics.revenue_facts LIMIT 5",
  },
  ai_filter: {
    signature: "ai_filter(text, condition [, model])",
    returns: "BOOLEAN",
    description: "Whether the text satisfies the condition, for WHERE clauses.",
    example:
      "SELECT customer_name FROM analytics.revenue_facts WHERE ai_filter(customer_name, 'looks like a company, not a person') LIMIT 10",
  },
};

/** Short names for pickers. */
export const AI_SQL_FUNCTION_LABELS: Record<AiSqlFunction, string> = {
  ai_complete: "Ask the model (free prompt)",
  ai_classify: "Classify into labels",
  ai_extract: "Extract fields (JSON)",
  ai_sentiment: "Sentiment",
  ai_summarize: "Summarize",
  ai_translate: "Translate",
  ai_filter: "True or false judgement",
};

/** What the second argument is called, per function; empty when there is none. */
export const AI_SQL_DETAIL_LABELS: Record<AiSqlFunction, string> = {
  ai_complete: "Prompt",
  ai_classify: "Labels (comma-separated)",
  ai_extract: "Fields (comma-separated)",
  ai_sentiment: "",
  ai_summarize: "Word limit",
  ai_translate: "Language",
  ai_filter: "Condition",
};

/** One resolved call: the function, its text arguments, and the model asked for. */
export type AiCall = {
  fn: AiSqlFunction;
  text: string;
  /** Labels, fields, language or condition — the second argument where it exists. */
  detail: string | null;
  maxWords: number | null;
  /** "provider/model" as the caller wrote it, or null for the instance default. */
  model: string | null;
};

const FN_RE = new RegExp(`\\b(${AI_SQL_FUNCTIONS.join("|")})\\s*\\(`, "gi");

/**
 * The distinct AI functions a statement calls, so the runner registers them
 * only when needed. String literals and comments are stripped first so a
 * mention in a comment costs nothing.
 */
export function usesAiSqlFunctions(sql: string): AiSqlFunction[] {
  const bare = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
  const found = new Set<AiSqlFunction>();
  for (const m of bare.matchAll(FN_RE)) found.add(m[1].toLowerCase() as AiSqlFunction);
  return AI_SQL_FUNCTIONS.filter((f) => found.has(f));
}

/** Does this look like a model spec ("openrouter/google/gemini-…") rather than a value? */
function looksLikeModel(s: string, providers: readonly string[]): boolean {
  const i = s.indexOf("/");
  return i > 0 && providers.includes(s.slice(0, i).toLowerCase());
}

/**
 * Read a call's arguments as DuckDB hands them over (every argument cast to
 * VARCHAR, NULLs already short-circuited by the engine). The optional trailing
 * model is told apart from a value by its provider prefix, so
 * ai_summarize(text, 12) and ai_summarize(text, 'openrouter/…') both parse.
 */
export function parseAiArgs(
  fn: AiSqlFunction,
  values: string[],
  providers: readonly string[],
): { ok: true; call: AiCall } | { ok: false; error: string } {
  const args = [...values];
  let model: string | null = null;
  if (args.length >= 2 && looksLikeModel(args[args.length - 1], providers)) model = args.pop()!;
  const need = (min: number, max: number, usage: string) => {
    if (args.length < min || args.length > max) {
      return `${fn} takes ${usage}; got ${values.length} argument${values.length === 1 ? "" : "s"}.`;
    }
    return null;
  };
  switch (fn) {
    case "ai_complete": {
      const e = need(1, 1, "a prompt and an optional model");
      if (e) return { ok: false, error: e };
      return { ok: true, call: { fn, text: args[0], detail: null, maxWords: null, model } };
    }
    case "ai_sentiment": {
      const e = need(1, 1, "a text and an optional model");
      if (e) return { ok: false, error: e };
      return { ok: true, call: { fn, text: args[0], detail: null, maxWords: null, model } };
    }
    case "ai_summarize": {
      const e = need(1, 2, "a text, an optional word limit and an optional model");
      if (e) return { ok: false, error: e };
      let maxWords: number | null = null;
      if (args.length === 2) {
        const n = Number(args[1]);
        if (!Number.isFinite(n) || n < 1) {
          return {
            ok: false,
            error: `ai_summarize's word limit must be a positive number; got "${args[1]}".`,
          };
        }
        maxWords = Math.floor(n);
      }
      return { ok: true, call: { fn, text: args[0], detail: null, maxWords, model } };
    }
    case "ai_classify":
    case "ai_extract":
    case "ai_translate":
    case "ai_filter": {
      const second =
        fn === "ai_classify"
          ? "the labels"
          : fn === "ai_extract"
            ? "the fields"
            : fn === "ai_translate"
              ? "the language"
              : "the condition";
      const e = need(2, 2, `a text, ${second} and an optional model`);
      if (e) return { ok: false, error: e };
      if (!args[1].trim())
        return { ok: false, error: `${fn} needs ${second}; the second argument is empty.` };
      return { ok: true, call: { fn, text: args[0], detail: args[1], maxWords: null, model } };
    }
  }
}

/** Comma-separated labels or fields, trimmed, de-duplicated, order kept. */
export function splitList(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(",")) {
    const v = part.trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/** The string a cache key is derived from: same call, same answer. */
export function aiCallIdentity(call: AiCall, resolvedModel: string): string {
  return JSON.stringify([call.fn, resolvedModel, call.text, call.detail, call.maxWords]);
}

/** The prompt for one call. Temperature is zero everywhere: a cell, not a chat. */
export function buildAiPrompt(call: AiCall): { system: string; user: string; maxTokens: number } {
  const base =
    "You are a function inside a SQL engine. Answer with the value only: no preamble, no explanation, no markdown.";
  switch (call.fn) {
    case "ai_complete":
      return { system: base, user: call.text, maxTokens: 1024 };
    case "ai_classify": {
      const labels = splitList(call.detail ?? "");
      return {
        system: `${base} Classify the text into exactly one of these labels and answer with that label verbatim: ${labels.join(" | ")}. If none fits, answer NONE.`,
        user: call.text,
        maxTokens: 32,
      };
    }
    case "ai_extract": {
      const fields = splitList(call.detail ?? "");
      return {
        system: `${base} Extract these fields from the text and answer with one JSON object whose keys are exactly ${JSON.stringify(fields)}. Use null for a field the text does not give. Strings for values unless the text gives a number.`,
        user: call.text,
        maxTokens: 512,
      };
    }
    case "ai_sentiment":
      return {
        system: `${base} Answer with the overall sentiment of the text as one word: ${AI_SENTIMENTS.join(", ")}.`,
        user: call.text,
        maxTokens: 8,
      };
    case "ai_summarize": {
      const n = call.maxWords ?? 40;
      return {
        system: `${base} Summarize the text in at most ${n} words, in its own language.`,
        user: call.text,
        maxTokens: Math.min(2048, 16 + n * 4),
      };
    }
    case "ai_translate":
      return {
        system: `${base} Translate the text into ${call.detail}. Keep names, numbers and formatting.`,
        user: call.text,
        maxTokens: 2048,
      };
    case "ai_filter":
      return {
        system: `${base} Decide whether the text satisfies this condition: ${call.detail}. Answer true or false.`,
        user: call.text,
        maxTokens: 8,
      };
  }
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * A model's answer as the cell the function promised. Anything that does not
 * fit the contract becomes NULL rather than a sentence in a column that is
 * supposed to hold a label — a NULL is visible and countable, a stray
 * sentence poisons a GROUP BY.
 */
export function normalizeAiAnswer(call: AiCall, raw: string): string | null {
  const text = stripFences(raw);
  switch (call.fn) {
    case "ai_complete":
    case "ai_summarize":
    case "ai_translate":
      return text || null;
    case "ai_classify": {
      const labels = splitList(call.detail ?? "");
      const answer = text
        .replace(/^["'`]+|["'`.]+$/g, "")
        .trim()
        .toLowerCase();
      const hit = labels.find((l) => l.toLowerCase() === answer);
      if (hit) return hit;
      // A model that says "Label: emea" or "emea." still means emea.
      const contained = labels.filter((l) => answer.includes(l.toLowerCase()));
      return contained.length === 1 ? contained[0] : null;
    }
    case "ai_sentiment": {
      const answer = text.toLowerCase();
      const hit = AI_SENTIMENTS.find((s) => answer === s || answer.startsWith(s));
      return hit ?? null;
    }
    case "ai_extract": {
      const fields = splitList(call.detail ?? "");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      try {
        const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
        const out: Record<string, unknown> = {};
        for (const f of fields) {
          const key = Object.keys(obj).find((k) => k.toLowerCase() === f.toLowerCase());
          out[f] = key === undefined ? null : (obj[key] ?? null);
        }
        return JSON.stringify(out);
      } catch {
        return null;
      }
    }
    case "ai_filter": {
      const answer = text.toLowerCase().replace(/[^a-z]/g, "");
      if (answer.startsWith("true") || answer === "yes") return "true";
      if (answer.startsWith("false") || answer === "no") return "false";
      return null;
    }
  }
}

/** The message when a statement would need more model calls than the instance allows. */
export function aiCallsOverCapMessage(needed: number, cap: number): string {
  return (
    `This statement needs ${needed} AI calls; the limit is ${cap} per statement. ` +
    `Narrow the rows (a WHERE or a LIMIT), or raise "AI calls per statement" under Admin → Developer runtime.`
  );
}
