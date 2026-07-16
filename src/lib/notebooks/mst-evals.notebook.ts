import type { Notebook } from "./types";

export const mstEvalsNotebook: Notebook = {
  id: "mst-evals",
  title: "Evals & Observability — scorers, telemetry & the lifecycle hooks",
  description:
    "Mastra's evals subsystem: attach scorers (faithfulness, answer-relevancy, custom rubric) to an agent, capture every run's score in a sampled telemetry stream, and wire lifecycle hooks (onStepStart/onStepFinish, onAgentFinish) for production-grade observability.",
  difficulty: "advanced",
  tags: ["agent", "evaluation"],
  subgroup: "Evals & Observability",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 6 · Evals & Observability — scorers, telemetry, hooks

You cannot ship an agent you cannot grade. Mastra makes evals a first-class concern: every Agent and Workflow accepts an array of **scorers** that run on each completion, attach scores to the trace, and surface in the local playground / your observability backend.

\`\`\`ts
import { Agent } from "@mastra/core/agent";
import { FaithfulnessScorer, AnswerRelevancyScorer } from "@mastra/evals/llm";

const agent = new Agent({
  id: "support-agent",
  model: "openai/gpt-5",
  scorers: {
    faithfulness:    new FaithfulnessScorer({ model: "openai/gpt-5-mini" }),
    answerRelevancy: new AnswerRelevancyScorer({ model: "openai/gpt-5-mini" }),
  },
});
\`\`\`

Below we'll build our own scoring infrastructure to see how it works under the hood.`,
    },
    {
      id: "md-define-scorer",
      kind: "markdown",
      source: `## 1 · Defining a Scorer
First, we define a helper to call our LLM judge and a \`createScorer\` factory. We then instantiate a \`FaithfulnessScorer\` that checks if an answer is grounded in the provided context.`,
    },
    {
      id: "define-scorer",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `ctx.state.judge = async (prompt) => {
  const res = await ctx.fetch(\`\${ctx.aiBaseURL}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${ctx.aiApiKey}\` },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'Return STRICT JSON: { "score": number (0..1), "reason": string }.' },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error("AI judge failed: " + res.status + " " + await res.text());
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  return ((c) => { try { return JSON.parse(c); } catch { return { score: 0, reason: "Parse error: " + c.slice(0, 120) }; } })(content);
};

ctx.state.createScorer = ({ name, prompt }) => ({
  name,
  async run({ input, output, context }) {
    const result = await ctx.state.judge(prompt({ input, output, context }));
    return { name, score: Number(result.score), reason: result.reason };
  },
});

ctx.state.FaithfulnessScorer = ctx.state.createScorer({
  name: "faithfulness",
  prompt: ({ output, context }) =>
    \`Grade FAITHFULNESS on 0..1. Score is 1.0 only if EVERY factual claim in the ANSWER is directly supported by the CONTEXT.
    CONTEXT: \${context}
    ANSWER: \${output}\`,
});

ctx.log("Scorer defined and stored in ctx.state.");`,
    },
    {
      id: "md-run-sample",
      kind: "markdown",
      source: `## 2 · Running Scorer on a Sample
Let's test our faithfulness scorer on a single response. We'll provide a context about battery range and a faithful answer to see how it performs.`,
    },
    {
      id: "run-sample",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const CONTEXT = "Battery & Range: The 504Wh battery delivers 60–80 km of mixed-terrain range when new.";
const QUESTION = "How much range can I expect?";
const ANSWER = "You can expect between 60 and 80 km on mixed terrain.";

const result = await ctx.state.FaithfulnessScorer.run({ 
  input: QUESTION, 
  output: ANSWER, 
  context: CONTEXT 
});

ctx.log(\`Score: \${result.score}\`);
ctx.log(\`Reason: \${result.reason}\`);

return result;`,
    },
    {
      id: "md-multiple-scorers",
      kind: "markdown",
      source: `## 3 · Defining Multiple Scorers
Often one metric isn't enough. Here we define a second scorer, \`CitesSectionScorer\`, which checks if the agent properly cited its sources.`,
    },
    {
      id: "multiple-scorers",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `ctx.state.CitesSectionScorer = ctx.state.createScorer({
  name: "citesSection",
  prompt: ({ output }) =>
    \`Grade on 0..1. Score 1.0 only if the ANSWER ends with the literal string "Sources:" followed by at least one section name. Else 0.
    ANSWER: \${output}\`,
});

ctx.log("CitesSectionScorer added to ctx.state.");`,
    },
    {
      id: "md-eval-set",
      kind: "markdown",
      source: `## 4 · Running an Eval Set
Now we'll run both scorers against a small dataset of different answers: one faithful, one stretched, and one completely fabricated.`,
    },
    {
      id: "eval-set",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const CONTEXT = "Battery & Range: The 504Wh battery delivers 60–80 km of range. Cold weather reduces range by 20–35%.";
const QUESTION = "How much range can I expect in winter?";

const dataset = [
  { label: "faithful", output: "Below 5°C, your range will drop by 20–35%. Sources: Battery & Range" },
  { label: "stretched", output: "In winter you can probably do about 30 km. Sources: Battery & Range" },
  { label: "fabricated", output: "Lumos batteries include heated cells for full range. Sources: Battery & Range" },
];

const results = [];
for (const item of dataset) {
  const f = await ctx.state.FaithfulnessScorer.run({ input: QUESTION, output: item.output, context: CONTEXT });
  const c = await ctx.state.CitesSectionScorer.run({ input: QUESTION, output: item.output });
  results.push({ label: item.label, faithfulness: f, citesSection: c });
}

ctx.state.evalResults = results;
ctx.log(\`Evaluated \${results.length} samples.\`);
return results;`,
    },
    {
      id: "md-aggregate",
      kind: "markdown",
      source: `## 5 · Aggregating Results
After running our evaluations, we can aggregate the scores to get an overview of how our agent is performing across different metrics.`,
    },
    {
      id: "aggregate",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const results = ctx.state.evalResults;

for (const res of results) {
  ctx.log(\`─── \${res.label} ───\`);
  ctx.log(\`  Faithfulness: \${res.faithfulness.score.toFixed(2)} - \${res.faithfulness.reason}\`);
  ctx.log(\`  CitesSection: \${res.citesSection.score.toFixed(2)} - \${res.citesSection.reason}\`);
}

const avgFaith = results.reduce((acc, r) => acc + r.faithfulness.score, 0) / results.length;
ctx.log(\`\\nAverage Faithfulness: \${avgFaith.toFixed(2)}\`);`,
    },
    {
      id: "md-custom-judge",
      kind: "markdown",
      source: `## 6 · Custom Judge Scorer
Mastra allows you to define complex rubric-based scorers. Here's how you might define a "Tone" scorer that uses a specific rubric for professional communication.`,
    },
    {
      id: "custom-judge",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const ToneScorer = ctx.state.createScorer({
  name: "tone",
  prompt: ({ output }) => \`
    Rate the tone of this response on 0..1.
    1.0: Professional, empathetic, and helpful.
    0.5: Neutral but lacking empathy.
    0.0: Unprofessional, rude, or dismissive.
    
    RESPONSE: \${output}
  \`,
});

const sample = "I already told you the range drops in winter. Read the manual.";
const result = await ToneScorer.run({ output: sample });

ctx.log(\`Tone Score: \${result.score}\`);
ctx.log(\`Reason: \${result.reason}\`);
return result;`,
    },
    {
      id: "md-telemetry",
      kind: "markdown",
      source: `## 7 · Telemetry and Lifecycle Hooks
Scorers grade *what* was produced. Hooks tell you *how* it was produced. We'll simulate an agent that records every step of its execution to a telemetry stream.`,
    },
    {
      id: "telemetry",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const z = ctx.lc.z;
const trace = [];

const tools = {
  search: { id: "search", execute: async () => ({ hits: ["Doc: range drops 20%"] }) },
  finalize: { id: "finalize", execute: async ({ answer }) => ({ ok: true, answer }) },
};

// Simplified Agent with hooks
class Agent {
  constructor(hooks) { this.hooks = hooks; }
  async run(prompt) {
    await this.hooks.onStepStart?.({ step: 1 });
    const searchRes = await tools.search.execute();
    await this.hooks.onStepFinish?.({ step: 1, tool: "search", output: searchRes });
    
    await this.hooks.onStepStart?.({ step: 2 });
    const finalRes = await tools.finalize.execute({ answer: "Range drops 20%" });
    await this.hooks.onStepFinish?.({ step: 2, tool: "finalize", output: finalRes });
    
    await this.hooks.onAgentFinish?.({ totalSteps: 2, status: "success" });
  }
}

const agent = new Agent({
  onStepStart: (ev) => trace.push({ type: "start", ...ev }),
  onStepFinish: (ev) => trace.push({ type: "finish", ...ev }),
  onAgentFinish: (ev) => trace.push({ type: "complete", ...ev }),
});

await agent.run("Check winter range");

trace.forEach(t => ctx.log(JSON.stringify(t)));
return { traceLength: trace.length };`,
    },
    {
      id: "outro",
      kind: "markdown",
      source: `## Recap
You've now seen how to:
1. **Define** scorers with LLM judges.
2. **Evaluate** single responses and datasets.
3. **Aggregate** metrics for performance overview.
4. **Instrument** agents with lifecycle hooks for full observability.

Mastra's production environment automates this via OTel and the \`mastra dev\` dashboard, giving you a complete picture of your agent's reliability.`,
    },
  ],
};
