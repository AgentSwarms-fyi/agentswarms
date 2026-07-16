import type { Notebook } from "./types";

export const mstWorkflowsNotebook: Notebook = {
  id: "mst-workflows",
  title: "Workflows — createWorkflow, createStep, .then/.parallel/.branch",
  description:
    "Mastra's typed step graphs: define createStep() units with input/output Zod schemas, then compose them with .then/.parallel/.branch/.dountil and run the whole graph as one typed call. Includes a human-in-the-loop suspend example.",
  difficulty: "intermediate",
  tags: ["agent", "structured-output"],
  subgroup: "Workflows",
  requires: ["lovable-ai"],
  cells: [
  {
    "id": "intro",
    "kind": "markdown",
    "source": "# 3 \u00b7 Workflows \u2014 typed graphs of LLM + code steps\n\nWhen an agent's job has multiple distinct phases \u2014 research, write, critique, publish \u2014 packing them all into one agent's prompt creates fragile, hard-to-debug runs. Mastra's answer is **`Workflow`**: a typed DAG of `createStep`s, each a tiny function that takes a typed input and returns a typed output, composed with a fluent builder.\n\n```ts\nimport { createWorkflow, createStep } from \"@mastra/core/workflows\";\nimport { z } from \"zod\";\n\nconst fetchTopic = createStep({\n  id: \"fetch-topic\",\n  inputSchema:  z.object({ topic: z.string() }),\n  outputSchema: z.object({ topic: z.string(), sources: z.array(z.string()) }),\n  execute: async ({ inputData }) => { /* \u2026 */ },\n});\n\nconst writeDraft = createStep({ /* takes the sources, writes a draft */ });\nconst critique   = createStep({ /* scores the draft */ });\n\nexport const blogWorkflow = createWorkflow({\n  id: \"blog-workflow\",\n  inputSchema:  z.object({ topic: z.string() }),\n  outputSchema: z.object({ post: z.string(), score: z.number() }),\n})\n  .then(fetchTopic)        // outputs of fetchTopic become inputs of writeDraft\n  .then(writeDraft)\n  .then(critique)\n  .commit();               // \u2190 required: closes the graph and freezes the type chain\n```\n\n### The composition primitives\n\n| Method | Shape |\n| --- | --- |\n| `.then(step)` | Run `step` next. Its inputSchema must accept the previous output. |\n| `.parallel([a, b, c])` | Fan out \u2014 all three run concurrently. The next step receives `{ a: outA, b: outB, c: outC }`. |\n| `.branch([[predicate1, branch1], [predicate2, branch2]])` | Conditional routing. The first matching predicate's branch runs. |\n| `.dowhile(step, predicate)` / `.dountil(step, predicate)` | Loop `step` until the predicate flips. |\n| `.map(({ inputData, getStepResult }) => ({ \u2026 }))` | Reshape data between steps without an LLM call. |\n| `.commit()` | Required terminator. Without it, types aren't sealed and `run()` won't compile. |\n\n### Why workflows are not just \"a chain of prompts\"\n\n| Benefit | What it gets you |\n| --- | --- |\n| **Each step is independently testable** | Run `writeDraft.execute({ inputData: { sources: [\u2026] } })` in isolation. |\n| **Each step has its own retry / timeout policy** | Flaky API? Add `retryConfig` to that step alone. |\n| **The graph is data** | Render it, version it, suspend it mid-run, resume it later \u2014 none of which is possible with a hand-rolled `await a(); await b();`. |\n| **`.suspend()` is first-class** | Human-in-the-loop: a step pauses, persists state, and resumes when an external event arrives. |\n\nBelow we build a real two-step research\u2192write workflow that calls the LLM at each step."
  },
  {
    "id": "md-graph",
    "kind": "markdown",
    "source": "## 1 \u00b7 A research \u2192 write \u2192 critique workflow\n\nThree steps, each calling the model. The first produces structured sources; the second consumes them to write a draft; the third grades the draft on a rubric."
  },
  {
    "id": "md-helpers",
    "kind": "markdown",
    "source": "### 1.1 \u00b7 Defining our primitives\nFirst, we define our core building blocks: a helper to call the LLM, and the `createStep` / `createWorkflow` factories that mirror Mastra's API."
  },
  {
    "id": "helpers",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const z = ctx.lc.z;\nctx.state.z = z;\n\nctx.state.llm = async ({ system, user, json = false }) => {\n  const res = await ctx.fetch(`${ctx.aiBaseURL}/chat/completions`, {\n    method: \"POST\",\n    headers: { \"Content-Type\": \"application/json\", Authorization: `Bearer ${ctx.aiApiKey}` },\n    body: JSON.stringify({\n      model: \"google/gemini-3-flash-preview\",\n      messages: [{ role: \"system\", content: system }, { role: \"user\", content: user }],\n      ...(json ? { response_format: { type: \"json_object\" } } : {}),\n    }),\n  });\n  if (!res.ok) throw new Error(\"AI call failed: \" + res.status + \" \" + await res.text());\n  const data = await res.json();\n  const msg = data.choices?.[0]?.message;\n  if (!msg) throw new Error(\"AI response did not include a message: \" + JSON.stringify(data).slice(0, 200));\n  return msg.content;\n};\n\nctx.state.createStep = ({ id, inputSchema, outputSchema, execute }) => ({\n  id, inputSchema, outputSchema,\n  run: async (data) => {\n    const parsed = inputSchema.parse(data);\n    const out = await execute({ inputData: parsed });\n    return outputSchema ? outputSchema.parse(out) : out;\n  },\n});\n\nctx.state.createWorkflow = ({ id, inputSchema, outputSchema }) => {\n  const ops = [];\n  const builder = {\n    then(step) { ops.push({ kind: \"then\", step }); return builder; },\n    parallel(steps) { ops.push({ kind: \"parallel\", steps }); return builder; },\n    commit() {\n      return {\n        id, inputSchema, outputSchema,\n        run: async (input) => {\n          let data = inputSchema.parse(input);\n          const trace = [];\n          for (const op of ops) {\n            if (op.kind === \"then\") {\n              data = await op.step.run(data);\n              trace.push({ step: op.step.id, out: data });\n            } else if (op.kind === \"parallel\") {\n              const results = await Promise.all(op.steps.map(s => s.run(data)));\n              data = Object.fromEntries(op.steps.map((s, i) => [s.id, results[i]]));\n              trace.push({ parallel: op.steps.map(s => s.id), out: data });\n            }\n          }\n          return { result: outputSchema ? outputSchema.parse(data) : data, trace };\n        }\n      };\n    }\n  };\n  return builder;\n};"
  },
  {
    "id": "md-step-fetch",
    "kind": "markdown",
    "source": "### 1.2 \u00b7 The Fetch Step\nThis step takes a topic and uses the LLM to research it, returning a list of factual bullets."
  },
  {
    "id": "step-fetch",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { createStep, llm, z } = ctx.state;\n\nctx.state.fetchStep = createStep({\n  id: \"fetch\",\n  inputSchema: z.object({ topic: z.string() }),\n  outputSchema: z.object({ topic: z.string(), bullets: z.array(z.string()).min(3) }),\n  execute: async ({ inputData }) => {\n    const raw = await llm({\n      system: 'Return STRICT JSON: { \"bullets\": string[] }. 4 concise factual bullets only.',\n      user: `Topic: ${inputData.topic}`,\n      json: true,\n    });\n    let bullets = []; try { bullets = JSON.parse(raw).bullets; } catch(e) { ctx.log(\"Parse failed\", raw); throw e; }\n    return { topic: inputData.topic, bullets: bullets.slice(0, 4) };\n  },\n});"
  },
  {
    "id": "md-step-summarize",
    "kind": "markdown",
    "source": "### 1.3 \u00b7 The Summarize Step\nNext, we take the researched bullets and transform them into a cohesive paragraph."
  },
  {
    "id": "step-summarize",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { createStep, llm, z } = ctx.state;\n\nctx.state.summarizeStep = createStep({\n  id: \"summarize\",\n  inputSchema: z.object({ topic: z.string(), bullets: z.array(z.string()) }),\n  outputSchema: z.object({ topic: z.string(), bullets: z.array(z.string()), draft: z.string() }),\n  execute: async ({ inputData }) => {\n    const draft = await llm({\n      system: \"You are a tech writer. Write a 90-word punchy paragraph that uses every bullet.\",\n      user: `Topic: ${inputData.topic}\\nBullets:\\n- ${inputData.bullets.join(\"\\n- \")}`,\n    });\n    return { ...inputData, draft: draft.trim() };\n  },\n});"
  },
  {
    "id": "md-step-judge",
    "kind": "markdown",
    "source": "### 1.4 \u00b7 The Judge Step\nFinally, a \"judge\" step scores the draft based on clarity and whether it included all the research."
  },
  {
    "id": "step-judge",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { createStep, llm, z } = ctx.state;\n\nctx.state.judgeStep = createStep({\n  id: \"judge\",\n  inputSchema: z.object({ topic: z.string(), bullets: z.array(z.string()), draft: z.string() }),\n  outputSchema: z.object({ draft: z.string(), score: z.number(), issues: z.array(z.string()) }),\n  execute: async ({ inputData }) => {\n    const raw = await llm({\n      system: 'You grade tech writing. Return STRICT JSON: { \"score\": number (1-10), \"issues\": string[] }.',\n      user: `Bullets:\\n- ${inputData.bullets.join(\"\\n- \")}\\n\\nDraft:\\n${inputData.draft}`,\n      json: true,\n    });\n    let score = 0, issues = []; try { const parsed = JSON.parse(raw); score = parsed.score; issues = parsed.issues; } catch(e) { ctx.log(\"Parse failed\", raw); throw e; }\n    return { draft: inputData.draft, score, issues: issues ?? [] };\n  },\n});"
  },
  {
    "id": "md-compose",
    "kind": "markdown",
    "source": "### 1.5 \u00b7 Composing with `.then()` and `.parallel()`\nWe use the fluent builder to chain our steps together. We can also run steps in parallel if they don't depend on each other's output."
  },
  {
    "id": "compose",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { createWorkflow, fetchStep, summarizeStep, judgeStep, z } = ctx.state;\n\nctx.state.blogWorkflow = createWorkflow({\n  id: \"blog-workflow\",\n  inputSchema: z.object({ topic: z.string() }),\n  outputSchema: z.object({ draft: z.string(), score: z.number(), issues: z.array(z.string()) }),\n})\n  .then(fetchStep)\n  .then(summarizeStep)\n  .then(judgeStep)\n  .commit();\n\nctx.log(\"Workflow composed with 3 sequential steps.\");"
  },
  {
    "id": "md-run",
    "kind": "markdown",
    "source": "### 1.6 \u00b7 Running the Workflow\nNow we execute the entire graph with a single call. The workflow handles parsing inputs, passing data between steps, and validating outputs."
  },
  {
    "id": "run",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { blogWorkflow } = ctx.state;\n\nconst { result, trace } = await blogWorkflow.run({ \n  topic: \"Why TypeScript is winning agent frameworks\" \n});\n\nctx.state.lastRun = { result, trace };\nctx.log(\"Workflow run complete.\");\nctx.log(\"Final Score:\", result.score);"
  },
  {
    "id": "md-trace",
    "kind": "markdown",
    "source": "### 1.7 \u00b7 Inspecting the Run Trace\nMastra workflows are observable. Every step execution is recorded in a trace, allowing you to see exactly what happened at each stage."
  },
  {
    "id": "trace",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { result, trace } = ctx.state.lastRun;\n\nfor (const t of trace) {\n  ctx.log(`step ${t.step ?? t.parallel} \u2192 ${JSON.stringify(t.out).slice(0, 100)}...`);\n}\n\nctx.log(\"\\n--- FINAL DRAFT ---\\n\" + result.draft);\nreturn { score: result.score, issues: result.issues };"
  },
  {
    "id": "md-suspend",
    "kind": "markdown",
    "source": "## 2 \u00b7 `.suspend()` \u2014 human-in-the-loop pause & resume\n\nWorkflows can pause mid-run. `execute` receives a `suspend()` function that **persists current state and stops the run**. A later `workflow.resume({ runId, resumeData })` rehydrates state and continues from that step.\n\n```ts\nconst approvalStep = createStep({\n  id: \"human-approval\",\n  inputSchema:  z.object({ amount: z.number(), payee: z.string() }),\n  outputSchema: z.object({ approved: z.boolean(), reviewer: z.string() }),\n  execute: async ({ inputData, suspend, resumeData }) => {\n    if (!resumeData) {\n      // First pass \u2014 pause and wait for a human.\n      await suspend({ message: `Approve $${inputData.amount} to ${inputData.payee}?` });\n      return; // never reached on the suspending pass\n    }\n    return resumeData; // second pass \u2014 the human sent { approved, reviewer }\n  },\n});\n```\n\nThe cell below simulates a suspend/resume round trip in-process so you can see the contract \u2014 in production, the suspended state would live in your storage (Postgres / Redis) and `resume` would be triggered by a webhook or an \"Approve\" button click."
  },
  {
    "id": "md-suspend-helpers",
    "kind": "markdown",
    "source": "### 2.1 \u00b7 Updating `createStep` for suspension\nTo support pausing, our `createStep` helper needs to handle a `suspend()` callback and a custom error to break execution flow."
  },
  {
    "id": "suspend-helpers",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const z = ctx.lc.z;\nctx.state.z = z;\n\nclass SuspendedError extends Error {\n  constructor(payload) { super('Suspended'); this.payload = payload; }\n}\nctx.state.SuspendedError = SuspendedError;\n\nctx.state.createStepWithSuspend = ({ id, inputSchema, outputSchema, execute }) => ({\n  id, inputSchema, outputSchema,\n  run: async (inputData, opts = {}) => {\n    const parsed = inputSchema.parse(inputData);\n    const suspend = async (p) => { throw new SuspendedError(p); };\n    try {\n      const out = await execute({ inputData: parsed, suspend, resumeData: opts.resumeData });\n      return { status: \"completed\", output: outputSchema?.parse(out) ?? out };\n    } catch (e) {\n      if (e instanceof SuspendedError) return { status: \"suspended\", suspendPayload: e.payload };\n      throw e;\n    }\n  },\n});"
  },
  {
    "id": "md-step-approval",
    "kind": "markdown",
    "source": "### 2.2 \u00b7 The Approval Step\nThis step checks if `resumeData` exists. If not, it calls `suspend()` to wait for human input."
  },
  {
    "id": "step-approval",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { createStepWithSuspend, z } = ctx.state;\n\nctx.state.approvalStep = createStepWithSuspend({\n  id: \"human-approval\",\n  inputSchema:  z.object({ amount: z.number(), payee: z.string() }),\n  outputSchema: z.object({ approved: z.boolean(), reviewer: z.string() }),\n  execute: async ({ inputData, suspend, resumeData }) => {\n    if (!resumeData) {\n      await suspend({ awaiting: \"human approval\", details: inputData });\n      return;\n    }\n    return resumeData;\n  },\n});"
  },
  {
    "id": "md-suspend-run",
    "kind": "markdown",
    "source": "### 2.3 \u00b7 Simulating a Pause and Resume\nFirst we run the step to trigger suspension, then we \"resume\" it by passing the human's decision back in."
  },
  {
    "id": "suspend-run",
    "kind": "code",
    "language": "js",
    "runtime": "browser",
    "source": "const { approvalStep } = ctx.state;\n\n// 1) First run \u2014 step suspends.\nconst first = await approvalStep.run({ amount: 4200, payee: \"Acme Tooling\" });\nctx.log(\"First pass status:\", first.status);\nctx.log(\"Payload for UI:\", JSON.stringify(first.suspendPayload));\n\n// 2) Human \"clicks\" Approve \u2014 we resume with data.\nconst resumed = await approvalStep.run(\n  { amount: 4200, payee: \"Acme Tooling\" },\n  { resumeData: { approved: true, reviewer: \"ops-lead@acme.io\" } },\n);\n\nctx.log(\"\\nSecond pass status:\", resumed.status);\nctx.log(\"Final output:\", JSON.stringify(resumed.output));\n\nreturn { firstStatus: first.status, finalOutput: resumed.output };"
  },
  {
    "id": "outro",
    "kind": "markdown",
    "source": "## Recap\n\n| Primitive | Real-Mastra equivalent | What you get |\n| --- | --- | --- |\n| `createStep` | `createStep` from `@mastra/core/workflows` | A typed, isolated unit of work with its own retry/timeout policy |\n| `createWorkflow().then().commit()` | Same | A typed graph you can run, version, suspend, resume |\n| `.parallel` / `.branch` / `.dountil` | Same | The full graph algebra \u2014 no while-loops in user code |\n| `suspend()` / `resume()` | Same | First-class human-in-the-loop \u2014 pause for hours and resume on a webhook |\n\n> **When to choose a workflow over an agent loop:** when the steps are *known in advance* \u2014 research \u2192 write \u2192 review \u2014 a workflow is more reliable, faster (steps can parallelize), cheaper (you can use small models per step), and observable (each step is its own trace span). Reach for an agent loop when the **next step is decided by the model**, like a chat assistant deciding which tool to call."
  }
],
};