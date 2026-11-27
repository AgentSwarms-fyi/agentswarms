// Asking the assistant about one of your things (R552).
//
// The assistant could find a thing by name and link it, never say anything
// about it. Now a thing can be mentioned with @, and describe_my_thing reads
// it as the reader — row-level security decides — into a few lines of plain
// facts. Tested here: the words for each kind, that nothing secret is ever
// read, the read itself over a stand-in client, the mention helpers the panel
// uses, and the rules that keep the tool to the signed-in assistant.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  describeAgent,
  describeDashboard,
  describeDataset,
  describeGeneric,
  describeModel,
  describePipeline,
  describeSwarm,
  describeWorkflow,
  headline,
  listOf,
} from "@/lib/describeThing";
import {
  cleanMentions,
  insertMention,
  liveMentions,
  mentionAt,
  mentionNote,
  showMentionList,
  messagesToSend,
  parseThread,
  serializeThread,
  toolLabel,
} from "@/lib/assistantThread";
import { ASSISTANT_TOOLS, assistantSystemPrompt } from "@/lib/assistantPrompt";
import { assistantPage } from "@/lib/assistantPage";

const rd = (p: string) => readFileSync(p, "utf8");
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

describe("the words, kind by kind", () => {
  it("a headline links it and says whose", () => {
    expect(headline({ name: "Churn [v2]", href: "/ml/m1", kindLabel: "Model", mine: true })).toBe(
      "[Churn v2](/ml/m1) — Model, yours.",
    );
    expect(headline({ name: "x", href: "/x", kindLabel: "Dataset", mine: false })).toContain(
      "shared with you",
    );
    expect(
      headline({ name: "x", href: "/x", kindLabel: "Dataset", mine: false, sample: true }),
    ).toContain("a sample");
    expect(listOf(["a", "b", "c"], 2)).toBe("a, b and 1 more");
  });

  it("a model: its task, what is in production, and its health", () => {
    const lines = describeModel(
      {
        task: "classification",
        target_column: "plan",
        source: { schema: "analytics", table: "revenue_facts" },
        feature_columns: ["a", "b"],
        description: "Predicts plan",
        updated_at: "2026-11-27T10:00:00Z",
      },
      { version: 7, algorithm: "logistic_regression", metric: "f1_macro", value: 0.91234 },
      "Health: no drift on 2026-11-27 (PSI 0.11).",
    );
    expect(lines).toEqual([
      "Task: classification, predicting plan from analytics.revenue_facts (2 chosen features).",
      "In production: version 7, logistic_regression, f1_macro 0.912 at training.",
      "Health: no drift on 2026-11-27 (PSI 0.11).",
      "Description: Predicts plan",
      "Last changed 2026-11-27.",
    ]);
    expect(describeModel({ task: "regression" }, null, null)).toContain(
      "No version is in production.",
    );
  });

  it("a dataset: its columns and rows", () => {
    const lines = describeDataset({
      columns: [
        { name: "region", type: "string" },
        { name: "amount", type: "number" },
      ],
      parquet_rows: 1234,
      source_filename: "sales.csv",
      data_loaded_at: "2026-11-20T00:00:00Z",
    });
    expect(lines).toEqual([
      "2 columns: region (string), amount (number).",
      "1,234 rows.",
      "Loaded from sales.csv.",
      "Data last loaded 2026-11-20.",
    ]);
  });

  it("a dashboard: page names and visual titles, never a query or its data", () => {
    const lines = describeDashboard({
      pages: [
        {
          name: "Overview",
          widgets: [
            { title: "Revenue by region", sql: "SELECT secret_column FROM t", data: [[1]] },
            { title: "Orders" },
          ],
        },
        { name: "Detail", widgets: [] },
      ],
      published: true,
    });
    expect(lines.slice(0, 3)).toEqual([
      "2 pages, 2 visuals.",
      "- Overview: Revenue by region, Orders",
      "- Detail: no titled visuals",
    ]);
    expect(lines.join("\n")).not.toContain("SELECT");
    // A dashboard from before pages: its top-level widgets are page 1.
    expect(describeDashboard({ widgets: [{ title: "Only" }] })[1]).toBe("- Page 1: Only");
  });

  it("a workflow: its steps by name and kind, its schedule and last run", () => {
    const lines = describeWorkflow({
      graph: {
        nodes: [
          { kind: "etl_pipeline", label: "Load orders", config: { secret: "x" } },
          { kind: "condition", label: "" },
        ],
      },
      cron_expr: "0 6 * * *",
      timezone: "UTC",
      last_run_at: "2026-11-27T06:00:00Z",
      last_run_status: "succeeded",
    });
    expect(lines[0]).toMatch(/^2 steps: Load orders \(.+\), .+\.$/);
    expect(lines[1]).toBe("Runs on a schedule (0 6 * * *, UTC).");
    expect(lines[2]).toBe("Last run 2026-11-27: succeeded.");
    expect(lines.join("\n")).not.toContain("secret");
    expect(describeWorkflow({ graph: { nodes: [] } })).toContain(
      "Not scheduled: it runs when started.",
    );
  });

  it("an agent: its model and tools, never its instructions", () => {
    const lines = describeAgent({
      llm_provider: "openrouter",
      llm_model: "openai/gpt-4o-mini",
      tools: ["sql_query", "kb_search"],
      knowledge_base_id: "kb1",
      system_prompt: "You are secret.",
    } as never);
    expect(lines).toEqual([
      "Model: openrouter/openai/gpt-4o-mini.",
      "Tools: sql_query, kb_search.",
      "Answers from a knowledge base.",
    ]);
  });

  it("a swarm, a pipeline, anything else", () => {
    expect(
      describeSwarm({
        nodes: [{ data: { label: "Researcher" } }, { type: "router" }],
        is_deployed: true,
      }),
    ).toEqual(["2 nodes: Researcher, router.", "Deployed."]);
    expect(
      describePipeline({
        engine: "duckdb",
        mode: "batch",
        cron_expr: "*/15 * * * *",
        is_active: false,
      }),
    ).toEqual(["Runs on duckdb, batch.", "Scheduled (*/15 * * * *), paused."]);
    expect(describeGeneric("A note", "2026-11-01T00:00:00Z")).toEqual([
      "Description: A note",
      "Last changed 2026-11-01.",
      "Open it for the rest; the assistant reads only its name and description.",
    ]);
  });
});

describe("nothing secret is read", () => {
  // Credentials, the text of instructions, code and the secrets code uses.
  const NEVER = [
    "auth_token",
    "auth_token_enc",
    "key_hash",
    "secret",
    "secret_refs",
    "trigger_token_hash",
    "n8n_webhook_url",
    "source_code",
    "system_prompt",
    "config",
  ];

  it("no kind's column list names one", async () => {
    vi.resetModules();
    const { DESCRIBE_COLUMNS } = await import("@/utils/assistant/describe.server");
    for (const [kind, spec] of Object.entries(DESCRIBE_COLUMNS)) {
      const cols = spec!.columns.split(",").map((c) => c.trim());
      for (const bad of NEVER) expect(cols, `${kind} reads ${bad}`).not.toContain(bad);
      expect(cols, kind).not.toContain("*");
    }
  });
});

// ── The read, over a stand-in client ────────────────────────────────────

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

vi.mock("@/utils/objectSearch/sources.server", () => ({
  readObjectsByIds: vi.fn(async (_sb: unknown, _u: string, wanted: Record<string, string[]>) =>
    wanted.prompt?.includes("p1")
      ? [
          {
            kind: "prompt",
            id: "p1",
            name: "Weekly summary",
            detail: "Says what changed",
            mine: true,
            updatedAt: "2026-11-02T00:00:00Z",
          },
        ]
      : [],
  ),
}));
vi.mock("@/utils/objectSearch/extras.server", () => ({ SEALED_NAMES: {} }));
vi.mock("@/utils/ml/health.server", () => ({
  modelHealthFor: vi.fn(
    async () => new Map([["m1", { alerts: [], summary: "no drift on 2026-11-27 (PSI 0.11)" }]]),
  ),
}));

function client(tables: Record<string, Record<string, unknown>[]>) {
  const selected: string[] = [];
  const from = (table: string) => {
    let cols = "";
    const filters: [string, unknown][] = [];
    const q = {
      select(c: string) {
        cols = c;
        selected.push(`${table}:${c}`);
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push([c, v]);
        return q;
      },
      async maybeSingle() {
        const row = (tables[table] ?? []).find((r) => filters.every(([c, v]) => r[c] === v));
        if (!row) return { data: null, error: null };
        // Only the columns asked for, as PostgREST answers.
        const out: Record<string, unknown> = {};
        for (const c of cols.split(",").map((x) => x.trim())) out[c] = row[c];
        return { data: out, error: null };
      },
    };
    return q;
  };
  return { sb: { from } as never, selected };
}

describe("reading it, as the reader", () => {
  const TABLES = {
    ml_models: [
      {
        id: "m1",
        name: "Churn",
        user_id: OWNER,
        task: "classification",
        target_column: "churned",
        source: { schema: "analytics", table: "customers" },
        feature_columns: [],
        production_version_id: "v1",
        system_prompt: "never read",
      },
    ],
    ml_model_versions: [
      { id: "v1", version: 3, algorithm: "lightgbm", metrics: { f1_macro: 0.8 } },
    ],
    agents: [
      { id: "a1", name: "Helper", user_id: OTHER, tools: [], system_prompt: "You are secret." },
    ],
  };

  it("a model of the reader's: the headline, production, health", async () => {
    const { describeThing } = await import("@/utils/assistant/describe.server");
    const { sb, selected } = client(TABLES);
    const out = await describeThing(sb, OWNER, "ml_model", "m1");
    expect(out.split("\n")).toEqual([
      "[Churn](/ml/m1) — ML model, yours.",
      "Task: classification, predicting churned from analytics.customers.",
      "In production: version 3, lightgbm, f1_macro 0.800 at training.",
      "Health: no drift on 2026-11-27 (PSI 0.11).",
    ]);
    expect(selected.join(" ")).not.toContain("system_prompt");
  });

  it("someone else's agent, shared: says so, and never its instructions", async () => {
    const { describeThing } = await import("@/utils/assistant/describe.server");
    const { sb } = client(TABLES);
    const out = await describeThing(sb, OWNER, "agent", "a1");
    expect(out).toContain("shared with you");
    expect(out).not.toContain("secret");
  });

  it("what row-level security hides is not there: said plainly, not guessed", async () => {
    const { describeThing } = await import("@/utils/assistant/describe.server");
    const { sb } = client(TABLES);
    expect(await describeThing(sb, OWNER, "dashboard", "nope")).toMatch(
      /Nothing of that kind with that id is open to this user.*do not guess/i,
    );
    expect(await describeThing(sb, OWNER, "wizard", "m1")).toContain("Name the kind");
    expect(await describeThing(sb, OWNER, "ml_model", "")).toContain("Give the thing's id");
  });

  it("any other kind: what search knows, read with the same rules", async () => {
    const { describeThing } = await import("@/utils/assistant/describe.server");
    const { sb } = client(TABLES);
    const out = await describeThing(sb, OWNER, "prompt", "p1");
    expect(out).toContain("Weekly summary");
    expect(out).toContain("Description: Says what changed");
  });

  it("refuses without the reader's own token, or on a headless run", async () => {
    const { runDescribeMyThing } = await import("@/utils/assistant/describe.server");
    const { sb } = client(TABLES);
    const ctx = { userId: OWNER, sb } as never;
    expect(await runDescribeMyThing(ctx, { kind: "ml_model", id: "m1" })).toContain(
      "signed-in app",
    );
    expect(
      await runDescribeMyThing({ userId: OWNER, sb, authToken: "t", scopeUserId: OWNER } as never, {
        kind: "ml_model",
        id: "m1",
      }),
    ).toContain("signed-in app");
    expect(
      await runDescribeMyThing({ userId: OWNER, sb, authToken: "t" } as never, {
        kind: "ml_model",
        id: "m1",
      }),
    ).toContain("[Churn]");
  });
});

describe("mentions in the panel", () => {
  it("an @name just before the caret, at the start or after a space; never in an address", () => {
    expect(mentionAt("@chu", 4)).toEqual({ start: 0, query: "chu" });
    expect(mentionAt("how is @churn doing", 13)).toEqual({ start: 7, query: "churn" });
    expect(mentionAt("how is @", 8)).toEqual({ start: 7, query: "" });
    expect(mentionAt("mail me@example.com", 19)).toBeNull();
    expect(mentionAt("first line @a\nsecond", 20)).toBeNull();
  });

  it("a name of more than one word can be typed (FOUND IN THE UI TEST)", () => {
    // The list closed at the first space: "@revenue_facts pl" found nothing.
    expect(mentionAt("how is @revenue_facts pl", 24)).toEqual({
      start: 7,
      query: "revenue_facts pl",
    });
    // Once a space is typed and nothing matches, the @ was not a name.
    expect(showMentionList("revenue_facts pl", 2)).toBe(true);
    expect(showMentionList("revenue", 0)).toBe(true);
    expect(showMentionList("at noon", 0)).toBe(false);
  });

  it("a thing already chosen is not typed again: what follows it is the question", () => {
    const chosen = [{ kind: "ml_model", id: "m1", name: "Churn model" }];
    expect(mentionAt("how is @Churn model doing", 25, chosen)).toBeNull();
    // A second @ after it is.
    expect(mentionAt("how is @Churn model vs @sal", 27, chosen)).toEqual({
      start: 23,
      query: "sal",
    });
  });

  it("choosing replaces the @word with the @name, caret after it", () => {
    const at = mentionAt("how is @chu doing", 11)!;
    expect(insertMention("how is @chu doing", at, "Churn model")).toEqual({
      text: "how is @Churn model  doing",
      caret: 20,
    });
  });

  it("only mentions still in the question are sent, once each, at most five", () => {
    const m = (id: string, name: string) => ({ kind: "dashboard", id, name });
    expect(
      liveMentions("about @Sales", [m("1", "Sales"), m("2", "Costs"), m("1", "Sales")]),
    ).toEqual([m("1", "Sales")]);
    const many = Array.from({ length: 7 }, (_, i) => m(String(i), `D${i}`));
    expect(cleanMentions(many)).toHaveLength(5);
    expect(cleanMentions([{ kind: 1, id: "x", name: "y" }, null, "z"])).toEqual([]);
  });

  it("the model is told which thing each @name is, fenced as the reader's text", () => {
    expect(mentionNote([{ kind: "ml_model", id: "m1", name: "Churn <x>" }])).toBe(
      "\n\n(Mentioned:\n- @<<<Churn x>>> is kind ml_model, id m1)",
    );
    const sent = messagesToSend([
      {
        role: "user",
        content: "how is @Churn?",
        mentions: [{ kind: "ml_model", id: "m1", name: "Churn" }],
      },
    ]);
    expect(sent[0].content).toBe(
      "how is @Churn?\n\n(Mentioned:\n- @<<<Churn>>> is kind ml_model, id m1)",
    );
  });

  it("the thread keeps them across reloads", () => {
    const thread = [
      {
        role: "user" as const,
        content: "q @A",
        mentions: [{ kind: "agent", id: "a1", name: "A" }],
      },
    ];
    expect(parseThread(serializeThread(thread))[0].mentions).toEqual([
      { kind: "agent", id: "a1", name: "A" },
    ]);
  });

  it("the panel: Esc closes the list, not the panel; a click keeps the caret", () => {
    const panel = codeOnly(rd("src/components/assistant/AssistantPanel.tsx"));
    const esc = panel.slice(
      panel.indexOf(
        'if (picking && showMentionList(picking.query, choices.length) && e.key === "Escape")',
      ),
    );
    expect(esc.slice(0, 200)).toContain("e.stopPropagation();");
    expect(panel).toContain(
      "onMouseDown={(ev) => {\n                          ev.preventDefault();",
    );
    expect(panel).toContain("useObjectIndex(wantIndex)");
    expect(panel).toContain("void ask(q, prompt, where, used);");
  });
});

describe("the tool's place", () => {
  const registry = rd("src/utils/tools/registry.server.ts");
  const chat = rd("src/routes/api/chat.ts");

  it("the assistant asks for it, the prompt says when to use it, and its use is shown", () => {
    expect(ASSISTANT_TOOLS).toContain("describe_my_thing");
    expect(assistantSystemPrompt(assistantPage("/bi", {}))).toContain(
      "call describe_my_thing with its kind and id first",
    );
    expect(toolLabel({ name: "describe_my_thing", status: "running" })).toBe("Reading it…");
  });

  it("only when a request names it, with the reader's token, never on a headless run", () => {
    expect(registry).toMatch(
      /if \(allow\?\.includes\("describe_my_thing"\) && ctx\.authToken && !ctx\.scopeUserId\)/,
    );
    expect(registry).not.toMatch(/allows\("describe_my_thing"\)/);
    const allow = chat.slice(chat.indexOf("HEADLESS_AGENT_TOOL_ALLOW = new Set"));
    expect(allow.slice(0, allow.indexOf("]);"))).not.toContain("describe_my_thing");
  });
});
