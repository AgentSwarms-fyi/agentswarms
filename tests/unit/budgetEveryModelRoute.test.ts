// Every route that spends on a user's behalf asks the monthly AI budget first.
//
// VA-2026-10-25-17. The cap was enforced on /api/chat, the embeds,
// /api/swarm/run and the gateway — and not on /api/python-chat, /api/bi (and
// so the AI Analyst built on it), /api/etl/generate, /api/lakehouse/generate,
// /api/skills/generate or /api/kb/build-graph. Over the cap, a user could keep
// spending through any of those. Each now asks budgetRefusal() before the model
// is called and answers 402 with the same sentence /api/chat does; the BI path
// asks inside llmJsonServer, so every surface built on it is held too.
//
// Here: the shared helper's verdicts and wording, and a sweep that holds every
// model-calling route to it — so a new route cannot quietly skip the cap.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({
  budget_settings: { data: { monthly_cap_usd: 10 }, error: null } as Resp,
  /** A credential's own cap (budget_limits), e.g. an embed key's. */
  budget_limits: { data: null, error: null } as Resp,
  spend: { ok: true, spend: 12, unpriced: 0 } as
    { ok: true; spend: number; unpriced: number | null } | { ok: false; error: string },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    const answer = (): Resp => {
      if (table === "budget_settings") return db.budget_settings;
      if (table === "budget_limits") return db.budget_limits;
      if (table === "iam_group_members") return { data: [], error: null };
      return { data: null, error: null };
    };
    b.maybeSingle = () => Promise.resolve(answer());
    b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(res, rej);
    return b;
  };
  return { supabaseAdmin: { from: vi.fn((t: string) => chain(t)) } };
});

vi.mock("@/utils/budgetSpend.server", () => ({
  monthStartIso: () => "2026-10-01T00:00:00Z",
  spendSince: async () => db.spend,
}));

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { budgetRefusal, budgetRefusalText } from "@/utils/budgetGuard.server";

// The guard caches a verdict per user for a minute: one user per case.
let n = 0;
const someone = () => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;

beforeEach(() => {
  vi.stubEnv("ENFORCE_BUDGET_CAP", "true");
  vi.stubEnv("BUDGET_FAIL_CLOSED", "");
  db.budget_settings = { data: { monthly_cap_usd: 10 }, error: null };
  db.budget_limits = { data: null, error: null };
  db.spend = { ok: true, spend: 12, unpriced: 0 };
  vi.mocked(supabaseAdmin.from).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("budgetRefusal", () => {
  it("refuses over the cap, with the month's figures — the sentence /api/chat answers", async () => {
    expect(await budgetRefusal(someone())).toBe(
      "You have reached your monthly AI budget ($10.00). (spent $12.00 of $10.00 this month.)",
    );
  });

  it("lets a call through under the cap, and with no cap set", async () => {
    db.spend = { ok: true, spend: 3, unpriced: 0 };
    expect(await budgetRefusal(someone())).toBeNull();
    db.budget_settings = { data: null, error: null };
    expect(await budgetRefusal(someone())).toBeNull();
  });

  it("holds a call made through a credential to that credential's own cap", async () => {
    db.budget_settings = { data: null, error: null }; // no personal cap
    db.budget_limits = { data: { monthly_cap_usd: 5, is_active: true }, error: null };
    const key = { type: "embed_key" as const, id: someone() };
    expect(await budgetRefusal(someone(), key)).toBe(
      "This integration has reached its monthly AI budget ($5.00). Its owner can raise the limit. (spent $12.00 of $5.00 this month.)",
    );
    // the same person, not through the credential: no cap applies
    expect(await budgetRefusal(someone())).toBeNull();
  });

  it("does nothing, and reads nothing, unless the operator turned the cap on", async () => {
    vi.stubEnv("ENFORCE_BUDGET_CAP", "");
    expect(await budgetRefusal(someone())).toBeNull();
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });

  it("refuses a spend it could not read when the deployment fails closed — without made-up figures", async () => {
    vi.stubEnv("BUDGET_FAIL_CLOSED", "true");
    db.spend = { ok: false, error: "connection reset" };
    const refusal = await budgetRefusal(someone());
    expect(refusal).toMatch(/could not be checked just now/);
    expect(refusal).not.toMatch(/spent \$/);
  });

  it("the wording is the guard's own message plus the figures", () => {
    expect(budgetRefusalText({ over: true, scope: "group", spend: 51.5, cap: 50 })).toBe(
      "Your team has reached its monthly AI budget ($50.00). An administrator can raise the limit. (spent $51.50 of $50.00 this month.)",
    );
  });
});

/** Every .ts file under dir. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

// A model is called on someone's behalf: a transport resolved, a provider
// stream, the operator's OpenRouter endpoint, or the JSON helper.
const MODEL_CALL =
  /resolveOpenAICompatTransport\(|streamWithProvider\(|fetch\(OPENROUTER_CHAT_URL|llmJsonServer\(|openAICompatChatStream\(/;
const BUDGET = /budgetRefusal\(|getBudgetDecision\(/;

describe("no route spends without asking the budget", () => {
  const routes = sources("src/routes/api")
    .map((f) => ({ file: f.replace(/\\/g, "/"), text: readFileSync(f, "utf8") }))
    .filter((r) => MODEL_CALL.test(r.text));

  // Not covered here: embeddings at ingestion (they go through resolveEmbedArgs,
  // which this pattern does not match) and the routes whose spend is never
  // recorded — the assessment's VA-2026-10-25-34, fixed in its own round.

  it("finds the model-calling routes", () => {
    expect(routes.map((r) => r.file)).toEqual(
      expect.arrayContaining([
        "src/routes/api/chat.ts",
        "src/routes/api/python-chat.ts",
        "src/routes/api/etl.generate.ts",
        "src/routes/api/lakehouse.generate.ts",
        "src/routes/api/skills.generate.ts",
        "src/routes/api/kb/build-graph.ts",
        "src/routes/api/bi.ts",
      ]),
    );
  });

  /**
   * Where the route handler first reaches a model: a direct call, or a call to
   * a function of the file's own that makes one (build-graph's chunk
   * extractor is defined above the handler and called inside it).
   */
  function firstModelCall(text: string): number {
    const handler = text.indexOf("createFileRoute(");
    const helpers = [...text.matchAll(/(?:async )?function (\w+)\(/g)]
      .filter((m) => {
        // A helper runs to the next top-level declaration (a prompt template
        // can hold a bare "}" line, so a closing brace is no end marker).
        const rest = text.slice(m.index + 1);
        const next = rest.search(
          /\n(?:export )?(?:async )?function \w+\(|\nexport const |\nconst /,
        );
        return MODEL_CALL.test(next === -1 ? rest : rest.slice(0, next));
      })
      .map((m) => m[1]);
    const reach = new RegExp([MODEL_CALL.source, ...helpers.map((h) => `\\b${h}\\(`)].join("|"));
    const at = text.slice(handler).search(reach);
    return at === -1 ? -1 : handler + at;
  }

  it("each asks — itself, or through llmJsonServer — before its first model call", () => {
    for (const r of routes) {
      const call = firstModelCall(r.text);
      expect(call, `${r.file}: no model call found in its handler`).toBeGreaterThan(-1);
      if (/llmJsonServer\(/.test(r.text) && !BUDGET.test(r.text)) continue; // asked inside
      const asked = r.text.search(BUDGET);
      expect(asked, `${r.file} never asks the budget`).toBeGreaterThan(-1);
      expect(asked, `${r.file} calls a model before asking the budget`).toBeLessThan(call);
    }
  });

  it("llmJsonServer asks before it calls the provider, with the call's cost scope, and answers 402", () => {
    const src = readFileSync("src/utils/bi/llmJson.server.ts", "utf8");
    const body = src.slice(src.indexOf("export async function llmJsonServer("));
    const asked = body.indexOf("await budgetRefusal(userId, costScope)");
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(body.indexOf("await providerFetch("));
    expect(body).toMatch(
      /if \(overBudget\) return \{ ok: false, status: 402, error: overBudget \};/,
    );
  });

  it("each refusal is a 402", () => {
    for (const f of [
      "src/routes/api/python-chat.ts",
      "src/routes/api/etl.generate.ts",
      "src/routes/api/lakehouse.generate.ts",
      "src/routes/api/skills.generate.ts",
      "src/routes/api/kb/build-graph.ts",
    ]) {
      const text = readFileSync(f, "utf8");
      const at = text.indexOf("if (overBudget)");
      expect(at, f).toBeGreaterThan(-1);
      expect(text.slice(at, at + 140), f).toMatch(/402/);
    }
  });

  it("the pages show the refusal's sentence — the skills dialog no longer shows its JSON", () => {
    const skills = readFileSync("src/components/skills/SkillEditorDialog.tsx", "utf8");
    const onFail = skills.slice(skills.indexOf("if (!resp.ok) {"));
    expect(onFail.slice(0, 700)).toMatch(/JSON\.parse\(txt\)[\s\S]*?parsed\.error/);
    for (const [f, read] of [
      ["src/routes/_authenticated/etl.tsx", /throw new Error\(out\.error \?\?/],
      ["src/routes/_authenticated/lakehouse.tsx", /throw new Error\(out\.error \?\?/],
      ["src/components/knowledge/KnowledgeGraphTab.tsx", /toast\.error\(json\.error \|\|/],
    ] as const) {
      expect(readFileSync(f, "utf8"), f).toMatch(read);
    }
  });

  it("the graph build is refused before the existing graph is wiped", () => {
    const text = readFileSync("src/routes/api/kb/build-graph.ts", "utf8");
    expect(text.indexOf("await budgetRefusal(user.id)")).toBeLessThan(
      text.indexOf('kb_graph_status: "building"'),
    );
  });
});
