// What a model call costs reaches month-to-date spend, so a budget can see it.
//
// VA-2026-10-25-34, found in R390. /api/etl/generate, /api/lakehouse/generate,
// /api/skills/generate and /api/kb/build-graph recorded no execution trace, so
// their cost never reached the spend a monthly cap is measured on: on the live
// instance a skills draft left month-to-date spend exactly where it was. Each
// now records its call on the caller's spend (the graph build as one trace for
// the whole build, summed per chunk). And the embeddings a knowledge base makes
// when it ingests — recorded already — now ask the budget first: over it, the
// documents are kept, unembedded, with the reason.
import { readFileSync } from "node:fs";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  refusal: null as string | null,
  upstream: { ok: true, body: {} as unknown, status: 200 },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  }),
  isAuthError: () => false,
}));
vi.mock("@/integrations/supabase/nulSafeFetch", () => ({ withNulSafeFetch: (o: unknown) => o }));
vi.mock("@/utils/callerLookup.server", () => ({
  callerFailure: (_e: unknown, m: string) => m,
  callerFailureStatus: () => 401,
}));
vi.mock("@/utils/providers/credentials.server", () => ({
  resolveOpenAICompatTransport: async () => ({
    endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "test-key",
  }),
  getProviderDefaultModel: async () => null,
}));
vi.mock("@/utils/iam.server", () => ({ modelAccessRefusal: async () => null }));
// The model each generator runs on comes from the resolver (its own tests);
// here every request gets one fixed, usable OpenRouter model.
vi.mock("@/utils/providers/defaultModel.server", () => ({
  chooseModel: async (
    _u: string,
    req: { provider?: string | null; model?: string | null } | null,
  ) => {
    const model = req?.model || "openai/gpt-4o-mini";
    return {
      ok: true,
      provider: "openrouter",
      model,
      spec: `openrouter/${model}`,
      source: req?.model ? "requested" : "default",
      fellBack: null,
    };
  },
}));
// The lakehouse generator reads the schemas the caller may query first.
vi.mock("@/utils/lakehouse/core.server", () => ({
  accessibleSchemas: async () => [{ name: "analytics" }],
  lakehouseConnection: async () => ({
    run: async () => ({ getRows: () => [["analytics", "orders", "id", "INTEGER"]] }),
    closeSync: () => undefined,
  }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/utils/budgetGuard.server", () => ({ budgetRefusal: vi.fn(async () => state.refusal) }));
vi.mock("@/utils/ssrfGuard.server", () => ({
  providerFetch: vi.fn(
    async () =>
      new Response(JSON.stringify(state.upstream.body), {
        status: state.upstream.status,
        headers: { "content-type": "application/json" },
      }),
  ),
}));
vi.mock("@/utils/observability/recordGatewayUsage.server", () => ({
  recordGatewayCall: vi.fn(async () => undefined),
  extractUsage: (j: {
    usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
  }) =>
    j?.usage
      ? {
          tokensIn: j.usage.prompt_tokens,
          tokensOut: j.usage.completion_tokens,
          costUsd: j.usage.cost ?? null,
        }
      : null,
}));

import { recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import {
  addCallUsage,
  addFailedCall,
  newSpendTally,
  reportedCost,
} from "@/utils/observability/spendTally";

type Post = (a: { request: Request }) => Promise<Response>;
const handlers: Record<string, Post> = {};
beforeAll(async () => {
  for (const name of ["skills.generate", "etl.generate", "lakehouse.generate"]) {
    const { Route } = (await import(`@/routes/api/${name}.ts`)) as unknown as {
      Route: { options: { server: { handlers: { POST: Post } } } };
    };
    handlers[name] = Route.options.server.handlers.POST;
  }
}, 120_000);

const toolReply = (name: string, args: unknown) => ({
  choices: [
    {
      message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] },
    },
  ],
  usage: { prompt_tokens: 420, completion_tokens: 180, cost: 0.00031 },
});
const post = (name: string, body: unknown) =>
  handlers[name]({
    request: new Request(`http://app.test/api/${name.replace(".", "/")}`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "http://supabase.test");
  state.refusal = null;
  state.upstream = { ok: true, body: {}, status: 200 };
  vi.mocked(recordGatewayCall).mockClear();
});

describe("a generated draft is recorded on the caller's spend", () => {
  it("skills: the provider's own usage and cost, under Skills: Generate", async () => {
    state.upstream.body = toolReply("emit_skill", {
      name: "Greet",
      description: "Greets.",
      body: "---\nname: Greet\n---\n## When to use\n",
      tags: ["greeting"],
    });
    const res = await post("skills.generate", {
      brief: "Reply to a greeting",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(200);
    expect(recordGatewayCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordGatewayCall).mock.calls[0][0]).toMatchObject({
      userId: "u1",
      surface: "Skills: Generate",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      tokensIn: 420,
      tokensOut: 180,
      providerCostUsd: 0.00031,
      status: "success",
    });
  });

  it("ETL: the same, under ETL: Generate", async () => {
    state.upstream.body = toolReply("emit_pipeline", {
      code: "def entrypoint(inputs):\n    return []\n",
      requirements: "",
      notes: "A stub.",
    });
    const res = await post("etl.generate", {
      brief: "Emit one row",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(recordGatewayCall).mock.calls[0][0]).toMatchObject({
      userId: "u1",
      surface: "ETL: Generate",
      tokensIn: 420,
      tokensOut: 180,
      providerCostUsd: 0.00031,
      status: "success",
    });
  });

  it("a call the provider failed is recorded too, as an error", async () => {
    state.upstream = { ok: false, body: { error: "upstream down" }, status: 503 };
    const res = await post("etl.generate", { brief: "Emit one row", model: "m" });
    expect(res.status).toBe(502);
    expect(vi.mocked(recordGatewayCall).mock.calls[0][0]).toMatchObject({
      surface: "ETL: Generate",
      status: "error",
    });
  });

  it("nothing is recorded for a call the budget refused — none was made", async () => {
    state.refusal = "You have reached your monthly AI budget ($0.10).";
    const res = await post("skills.generate", { brief: "Reply to a greeting", model: "m" });
    expect(res.status).toBe(402);
    expect(recordGatewayCall).not.toHaveBeenCalled();
  });

  it("lakehouse: the same, under Lakehouse: Generate SQL", async () => {
    state.upstream.body = toolReply("emit_sql", {
      sql: "SELECT count(*) FROM analytics.orders",
      explanation: "Counts orders.",
    });
    const res = await post("lakehouse.generate", {
      question: "how many orders",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(recordGatewayCall).mock.calls[0][0]).toMatchObject({
      userId: "u1",
      surface: "Lakehouse: Generate SQL",
      promptText: "how many orders",
      tokensIn: 420,
      tokensOut: 180,
      providerCostUsd: 0.00031,
      status: "success",
    });
  });
});

describe("a graph build is one trace with the whole build's cost", () => {
  it("sums what each call reports, and estimates what one does not", () => {
    const t = newSpendTally();
    addCallUsage(t, { tokensIn: 100, tokensOut: 20, costUsd: 0.001 }, { prompt: "", reply: "" });
    addCallUsage(t, { tokensIn: 50, tokensOut: 10, costUsd: 0.0005 }, { prompt: "", reply: "" });
    expect(t).toMatchObject({ calls: 2, tokensIn: 150, tokensOut: 30 });
    expect(reportedCost(t)).toBeCloseTo(0.0015, 10);

    // a call with no usage block: its text stands in, and the cost is priced instead
    addCallUsage(t, null, { prompt: "x".repeat(400), reply: "y".repeat(80) });
    expect(t.tokensIn).toBeGreaterThan(150);
    expect(t.tokensOut).toBeGreaterThan(30);
    expect(reportedCost(t)).toBeNull();
  });

  it("counts a failed call, and reports nothing for a build that made none", () => {
    const t = newSpendTally();
    expect(reportedCost(t)).toBeNull();
    addFailedCall(t);
    expect(t.calls).toBe(1);
    expect(t.tokensIn).toBe(0);
  });

  it("build-graph tallies every extraction call and records once, before it can bail out", () => {
    const src = readFileSync("src/routes/api/kb/build-graph.ts", "utf8");
    expect(src).toMatch(
      /addCallUsage\(spend, extractUsage\(json\), \{ prompt, reply: content \}\)/,
    );
    expect(src).toMatch(/if \(!res\.ok\) \{\s*addFailedCall\(spend\);/);
    expect(src).toMatch(
      /await extractFromChunk\(\s*chunk,\s*transport,\s*chosen\.model,\s*spend,?\s*\)/,
    );
    const recorded = src.indexOf('surface: "KB: Graph Build"');
    expect(recorded).toBeGreaterThan(-1);
    // after the chunk loop, before the first early return on "no entities"
    expect(recorded).toBeGreaterThan(src.indexOf("await extractFromChunk(chunk"));
    expect(recorded).toBeLessThan(src.indexOf("if (entityMap.size === 0)"));
    expect(src).toMatch(/providerCostUsd: reportedCost\(spend\)/);
  });
});

describe("ingestion embeddings ask the budget first", () => {
  it("over the cap: refused with the sentence, before any embedding call", async () => {
    state.refusal = "You have reached your monthly AI budget ($0.10).";
    const { providerFetch } = await import("@/utils/ssrfGuard.server");
    vi.mocked(providerFetch).mockClear();
    const { embedAndStoreDocuments } = await import("@/utils/tools/embedding.server");
    await expect(
      embedAndStoreDocuments({
        sb: {} as never,
        docs: [
          {
            id: "d1",
            knowledge_base_id: "kb1",
            user_id: "u1",
            is_sample: false,
            content: "Hello world.",
            metadata: {},
          } as never,
        ],
        openaiKey: "k",
        userId: "u1",
      }),
    ).rejects.toThrow("You have reached your monthly AI budget ($0.10).");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("the knowledge page says why a document it added was not indexed", () => {
    // It used to log the embed step's failure and say "added" regardless, so a
    // refusal showed only as "Pending embedding" with no reason.
    const page = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");
    const at = page.indexOf("documentIds: insertedIds,");
    const block = page.slice(at - 400, at + 900);
    expect(block).toMatch(/outcome = \{ error: err \};/);
    expect(block).toMatch(/note = indexNote\(outcome\);/);
    expect(block).toMatch(
      /if \(note\) toast\.warning\(`\$\{added\}, not fully indexed`, \{ description: note \}\);/,
    );
    expect(block).not.toMatch(/console\.warn\("\[knowledge\] embedding failed:"/);
  });

  it("every ingest path already keeps the documents when embedding throws", () => {
    for (const f of [
      "src/routes/api/kb/ingest-url.ts",
      "src/routes/api/kb/ingest-github.ts",
      "src/routes/api/templates.provision.ts",
      "src/utils/kb/sync.server.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      const at = src.indexOf("await embedAndStoreDocuments(");
      expect(at, f).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, at - 260), at), f).toMatch(/try \{/);
    }
  });
});
