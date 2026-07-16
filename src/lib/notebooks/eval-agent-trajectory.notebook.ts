import type { Notebook } from "./types";

/**
 * Agentic Evals #6 — Trajectory & Path Efficiency.
 * Score not just the final answer, but the sequence of tool calls.
 */
export const evalAgentTrajectoryNotebook: Notebook = {
  id: "eval-agent-trajectory",
  title: "Agent Trajectory & Path Efficiency",
  description:
    "Grade the path, not just the destination. Build a tiny pricing agent, capture its tool-call trajectory, then score it on tool-selection accuracy, redundancy, and total cost. Tighten the system prompt and watch efficiency improve.",
  difficulty: "intermediate",
  tags: ["evaluation", "agent"],
  subgroup: "RAG & Agent Evaluation",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 6 · Agent Trajectory Evaluation

A correct final answer hides a lot of sins. An agent that finds the cheapest server region by calling the pricing API **15 times** is technically right and practically broken — slow, expensive, and brittle.

This notebook teaches **trajectory evaluation**: grading the sequence of tool calls between the user prompt and the final answer.

We measure four things:

1. **Task success** — did the agent reach the correct final answer?
2. **Tool-selection accuracy** — did it call the right tool for each step?
3. **Redundancy** — how many calls were duplicates / unnecessary?
4. **Tool-call budget** — total calls vs. an ideal minimum.

Then we tweak the system prompt and watch the trajectory shrink without losing correctness.`,
    },

    // ───────── tools + agent
    {
      id: "md-t",
      kind: "markdown",
      source: `## Step 1 · A tiny pricing agent with tools

Two mock tools:

- \`listRegions()\` → returns 4 cloud regions.
- \`getPrice({ region })\` → returns USD per hour for one region.

The task: *find the cheapest region*. The **ideal trajectory** is \`listRegions → getPrice×4 → answer\` = 5 calls total.

We log every tool call so we can score the trajectory afterwards.`,
    },
    {
      id: "tools",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"];
const PRICES  = { "us-east-1": 0.12, "us-west-2": 0.10, "eu-central-1": 0.14, "ap-northeast-1": 0.18 };

const TOOLS = [
  { type: "function", function: {
    name: "listRegions", description: "Return all available cloud regions.",
    parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: {
    name: "getPrice", description: "Return the USD-per-hour price for a region.",
    parameters: { type: "object", properties: { region: { type: "string" } }, required: ["region"] } } },
];

function dispatch(name, args) {
  if (name === "listRegions") return { regions: REGIONS };
  if (name === "getPrice") return { region: args.region, usd_per_hour: PRICES[args.region] ?? null };
  return { error: "unknown tool" };
}

ctx.state.runAgent = async (systemPrompt) => {
  const trajectory = []; // { name, args, result }
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: "Find the cheapest region and tell me its name and price." },
  ];
  const MAX_TURNS = 20;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash", temperature: 0,
        messages, tools: TOOLS,
      }),
    });
    const j = await res.json();
    const msg = j.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { finalAnswer: msg.content ?? "", trajectory, turns: turn + 1 };
    }
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments || "{}");
      const result = dispatch(tc.function.name, args);
      trajectory.push({ name: tc.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { finalAnswer: "(max turns)", trajectory, turns: MAX_TURNS };
};
return "agent ready";
`,
    },

    // ───────── 1. lax run
    {
      id: "md-1",
      kind: "markdown",
      source: `## Step 2 · Run with a lax system prompt

A vague prompt invites wasteful behavior — the agent may re-list regions, look up the same price twice, or check redundant info.`,
    },
    {
      id: "lax",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const LAX = "You are a cloud pricing assistant. Use any tools you need to answer the user.";
const out = await ctx.state.runAgent(LAX);
ctx.state.laxRun = out;
return { finalAnswer: out.finalAnswer, turns: out.turns, tool_calls: out.trajectory.length,
         trajectory: out.trajectory.map((t) => ({ name: t.name, args: t.args })) };
`,
    },

    // ───────── trajectory scorer
    {
      id: "md-2",
      kind: "markdown",
      source: `## Step 3 · The trajectory scorer

Given:

- The agent's full \`trajectory\` of tool calls.
- The expected ideal call count (\`1 listRegions + N getPrice\`).

We compute:

- **task_success** — does the final answer name the correct cheapest region?
- **tool_selection_ok** — every call uses one of the allowed tool names.
- **redundant_calls** — duplicates with identical args.
- **efficiency** — \`ideal_calls / actual_calls\` (1.0 = optimal).`,
    },
    {
      id: "scorer",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"];
const PRICES  = { "us-east-1": 0.12, "us-west-2": 0.10, "eu-central-1": 0.14, "ap-northeast-1": 0.18 };
const ALLOWED = new Set(["listRegions", "getPrice"]);

function scoreTrajectory(run) {
  const calls = run.trajectory;
  const cheapest = Object.entries(PRICES).sort((a, b) => a[1] - b[1])[0][0];
  const task_success = run.finalAnswer.toLowerCase().includes(cheapest.toLowerCase());

  const tool_selection_ok = calls.every((c) => ALLOWED.has(c.name));

  // Redundancy: same (name + args) repeated
  const seen = new Map();
  let redundant_calls = 0;
  for (const c of calls) {
    const key = c.name + ":" + JSON.stringify(c.args);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const n of seen.values()) if (n > 1) redundant_calls += (n - 1);

  const ideal = 1 + REGIONS.length;   // 1 listRegions + N getPrice
  const efficiency = +(ideal / Math.max(calls.length, 1)).toFixed(2);

  return {
    task_success, expected_region: cheapest,
    actual_calls: calls.length, ideal_calls: ideal,
    tool_selection_ok, redundant_calls, efficiency,
    flag: redundant_calls > 0 || efficiency < 0.7 ? "⚠️ Path Inefficiency" : "✅ Efficient",
  };
}

ctx.state.scoreTrajectory = scoreTrajectory;
return scoreTrajectory(ctx.state.laxRun);
`,
    },

    // ───────── 3. tighten
    {
      id: "md-3",
      kind: "markdown",
      source: `## Step 4 · Tighten the system prompt and re-score

The fix is almost always: **make the plan explicit in the system prompt**. We tell the agent the exact procedure and forbid duplicates.`,
    },
    {
      id: "strict",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const STRICT = \`You are a cloud pricing assistant. To answer "cheapest region":

1. Call listRegions ONCE to get all regions.
2. For each region, call getPrice EXACTLY ONCE.
3. Pick the lowest, then reply with the region name and its price.

Never repeat a tool call with identical arguments. Never call a tool you don't need.\`;

const out = await ctx.state.runAgent(STRICT);
const score = ctx.state.scoreTrajectory(out);
return {
  trajectory: out.trajectory.map((t) => ({ name: t.name, args: t.args })),
  score,
  finalAnswer: out.finalAnswer,
};
`,
    },
    {
      id: "md-3x",
      kind: "markdown",
      source: `Typical results: lax prompt → 6–10 tool calls and \`redundant_calls > 0\`. Strict prompt → exactly 5 tool calls and efficiency 1.0.

### Why this matters in production

Every redundant tool call is:

- **Latency** the user feels.
- **Cost** on your bill.
- **Quota** consumed at downstream APIs.
- **Surface area** for failures (any one call can time out).

### What to log per request

A production agent should emit one structured log per run:

\`\`\`json
{ "task_success": true, "actual_calls": 5, "ideal_calls": 5,
  "redundant_calls": 0, "efficiency": 1.0, "duration_ms": 1240 }
\`\`\`

Aggregate by agent version. The day an LLM provider ships a regression, your *efficiency* histogram will slide left before your *task_success* number does — early warning.

### Up next
Notebook 7: **Red Team & Guardrails** — adversarial evals.`,
    },
  ],
};
