// Cell model + starter template for user-authored Python notebooks.
// Every new notebook opens with usage notes (how to call models through the
// `agentswarms` helper) and runnable sample cells.

export type PyCell = {
  id: string;
  type: "markdown" | "code";
  source: string;
};

function cell(type: PyCell["type"], source: string): PyCell {
  return { id: crypto.randomUUID(), type, source };
}

export function newPythonNotebookCells(): PyCell[] {
  return [
    cell(
      "markdown",
      `# Your Python notebook

This notebook runs **entirely in your browser** (CPython via Pyodide). The first run downloads the runtime (~10 MB) — after that, cells run instantly. All cells share one interpreter, so variables from one cell are available in the next, and top-level \`await\` is supported.

## Calling models

The built-in \`agentswarms\` module routes model calls through **your** AgentSwarms account:

- \`provider\` — any OpenAI-compatible provider you've connected under **Integrations** (\`openrouter\`, \`openai\`, \`gemini\`, \`groq\`, \`grok\`, \`qwen\`, \`ollama\`, \`vllm\`, \`nvidia\`). If this instance has a default OpenRouter key, \`"openrouter"\` works with zero setup.
- \`model\` — that provider's model id (on OpenRouter e.g. \`openai/gpt-4o-mini\`, \`anthropic/claude-sonnet-4.5\`, \`google/gemini-2.5-flash\`).
- Your administrator's model-access rules apply, and every call is logged in **Traces** and counts toward your budget.

\`\`\`python
reply = await agentswarms.chat("Hello!", provider="openrouter", model="openai/gpt-4o-mini")
\`\`\`

## Installing packages

Scientific packages bundled with Pyodide (\`numpy\`, \`pandas\`, \`scipy\`, \`scikit-learn\`, …) download automatically the first time you import them. Pure-Python packages from PyPI install via micropip:

\`\`\`python
import micropip
await micropip.install("titlecase")
\`\`\`
`,
    ),
    cell(
      "code",
      `import agentswarms

# Point these at any provider/model available to your account.
# "openrouter" works out of the box when the instance has a default key;
# connect other providers under Integrations to use them here.
PROVIDER = "openrouter"
MODEL = "openai/gpt-4o-mini"

reply = await agentswarms.chat(
    "In two sentences: why are multi-agent systems harder to debug than single agents?",
    provider=PROVIDER,
    model=MODEL,
    temperature=0.7,
)
print(reply)
`,
    ),
    cell(
      "markdown",
      `## Structured output

Same helper, but asking the model for JSON you can parse and use downstream — the bread and butter of agent pipelines.`,
    ),
    cell(
      "code",
      `import json

raw = await agentswarms.chat(
    "Return ONLY a JSON array of 3 objects with keys 'framework' and 'best_for', "
    "covering LangGraph, CrewAI and AutoGen. No prose, no code fences.",
    provider=PROVIDER,
    model=MODEL,
    temperature=0.2,
)

frameworks = json.loads(raw)
for f in frameworks:
    print(f"{f['framework']:>10}  ->  {f['best_for']}")

f"Parsed {len(frameworks)} frameworks"
`,
    ),
    cell(
      "markdown",
      `## Pure Python — no model needed

Anything CPython can do, this notebook can do. The last expression in a cell is displayed as its result (like Jupyter).`,
    ),
    cell(
      "code",
      `import statistics

latencies_ms = [220, 340, 180, 950, 310, 290, 1450, 260]
print("mean:", round(statistics.mean(latencies_ms), 1), "ms")
print("p50 :", statistics.median(latencies_ms), "ms")
print("max :", max(latencies_ms), "ms")

slow = [x for x in latencies_ms if x > 500]
f"{len(slow)} slow calls out of {len(latencies_ms)}"
`,
    ),
  ];
}
