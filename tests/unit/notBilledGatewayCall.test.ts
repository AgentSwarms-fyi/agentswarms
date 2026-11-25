// The other writer of execution_traces, recordGatewayCall, had the chat route's
// fault too: a call the provider refused recorded the chars/4 estimate of its
// prompt and that estimate's price. On a self-hosted install with OpenAI out of
// credits, every knowledge-base embedding that failed with a 429 read
// "text-embedding-3-small · error · 5 tokens · $0.0000001", and budget_spend()
// summed it. The callers that saw the provider's error status now say the call
// was not billed; a failure AFTER output (unparseable JSON, a timeout) keeps its
// estimate, because that call was billed.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const h = vi.hoisted(() => ({ db: null as null | { from: (t: string) => unknown } }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (t: string) => h.db!.from(t) },
}));
vi.mock("@/lib/email/budgetAlertTrigger.server", () => ({
  checkAndNotifyBudget: async () => undefined,
  checkAndNotifyGroupBudgets: async () => undefined,
}));

import { recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { TRACE_CLEAR_KEYS } from "@/utils/observability/sealedTraces.server";
import { __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import { fakePostgrest, type FakeDb } from "../fixtures/fakePostgrest";
import { memoryKeyStore } from "../fixtures/keyStores";

let fake: FakeDb;
beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "f".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  fake = fakePostgrest({ execution_traces: [] });
  h.db = fake.client as never;
  __setKeyHierarchyForTests(memoryKeyStore().store);
});
afterEach(() => {
  __setKeyHierarchyForTests(null);
  delete process.env.DATA_KEY_CACHE_SECONDS;
  vi.restoreAllMocks();
});

const refusedEmbedding = {
  userId: ALICE,
  surface: "KB: Embedding",
  model: "text-embedding-3-small",
  kind: "embedding",
  provider: "openai",
  promptText: "Quarterly revenue by region, with the notes the finance team keeps.",
  latencyMs: 456,
  status: "error",
  errorMessage: "429: You have no credits remaining.",
} as const;

const stored = () => {
  const rows = fake.tables.execution_traces as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  return rows[0] as {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    status: string;
    request_payload: Record<string, unknown>;
  };
};

describe("a gateway call the provider refused", () => {
  it("records zero tokens and zero cost, says why, and is not flagged to reprice", async () => {
    await recordGatewayCall({ ...refusedEmbedding, notBilled: true } as never);
    const row = stored();
    expect([row.status, row.tokens_in, row.tokens_out, Number(row.cost_usd)]).toEqual([
      "error",
      0,
      0,
      0,
    ]);
    expect(row.request_payload.not_billed).toBe(true);
    expect(row.request_payload.tokens_estimated).toBeUndefined();
    expect(row.request_payload.pricing_missing).toBeUndefined();
  });

  it("a refused image call costs 0 too, though images are priced per image, not per token", async () => {
    await recordGatewayCall({
      ...refusedEmbedding,
      model: "openai/gpt-image-1",
      kind: "image",
      imageCount: 1,
      notBilled: true,
    } as never);
    expect(Number(stored().cost_usd)).toBe(0);
  });

  it("is exactly the case that used to be charged", async () => {
    await recordGatewayCall(refusedEmbedding as never);
    const row = stored();
    expect(row.tokens_in).toBeGreaterThan(0);
    expect(row.request_payload.tokens_estimated).toBe(true);
    expect(row.request_payload.not_billed).toBeUndefined();
  });

  it("an error after output (billed) keeps its figures", async () => {
    await recordGatewayCall({
      ...refusedEmbedding,
      model: "openai/gpt-4o-mini",
      kind: "text",
      tokensIn: 300,
      tokensOut: 120,
      errorMessage: "Unparseable JSON (attempt 1/2)",
    } as never);
    const row = stored();
    expect([row.tokens_in, row.tokens_out]).toEqual([300, 120]);
    expect(Number(row.cost_usd)).toBeGreaterThan(0);
  });

  it("its marker stays readable once the payload is sealed, for budgets and SQL", () => {
    expect(TRACE_CLEAR_KEYS.has("not_billed")).toBe(true);
  });
});

describe("the callers that saw the provider's error status pass notBilled", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  const near = (text: string, anchor: string, span = 500) => {
    const at = text.indexOf(anchor);
    expect(at, anchor).toBeGreaterThan(-1);
    return text.slice(at, at + span);
  };

  it("knowledge-base embeddings: a non-OK response", () => {
    expect(near(src("src/utils/tools/embedding.server.ts"), "if (!res.ok) {", 900)).toContain(
      "notBilled: true,",
    );
  });

  it("BI's JSON calls: a non-OK gateway response, but not a timeout or unparseable JSON", () => {
    const llm = src("src/utils/bi/llmJson.server.ts");
    expect(near(llm, "errorMessage: `Gateway ${r.status}:", 120)).toContain("notBilled: true,");
    expect(near(llm, "errorMessage: `Timed out after", 200)).not.toContain("notBilled");
    expect(near(llm, "`Unparseable JSON (attempt", 400)).not.toContain("notBilled");
  });

  it("skill generation: a non-OK response", () => {
    expect(
      near(src("src/routes/api/skills.generate.ts"), "errorMessage: `HTTP ${resp.status}`,", 80),
    ).toContain("notBilled: true,");
  });

  it("embedded chat: an error status, but not an OK answer with no body", () => {
    expect(
      near(src("src/routes/api/embed.chat.ts"), "errorMessage: `Upstream ${upstream.status}:", 250),
    ).toContain("notBilled: !upstream.ok,");
  });
});
