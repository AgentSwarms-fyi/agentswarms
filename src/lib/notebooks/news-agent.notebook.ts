import type { Notebook } from "./types";

/**
 * "Latest news in any city" — a real LangChain tool-calling agent,
 * taught one small step at a time. Each code cell is tiny and followed
 * by an explanation of what just happened and why.
 */
export const newsAgentNotebook: Notebook = {
  id: "news-agent",
  title: "City News Agent — real LangChain, step by step",
  description:
    "Build a tool-using agent with @langchain/openai + @langchain/core that fetches today's top news for any city via Firecrawl. Real LangChain, no mocks.",
  difficulty: "beginner",
  tags: ["agent", "langchain", "firecrawl"],
  requires: ["firecrawl", "lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 🗞️ City News Agent — LangChain, step by step

Welcome! In this notebook we'll build a **tool-using agent** with the real
\`@langchain/openai\` and \`@langchain/core\` packages — the exact same APIs
you'd ship in a Node service.

We'll go one small cell at a time. After each cell, read the explanation
that follows before running the next one — that's how the agent loop builds up.

**What you'll learn**
1. How to talk to an LLM with \`ChatOpenAI\`
2. How to define a tool with \`tool()\` + Zod
3. How \`bindTools\` makes the model emit \`tool_calls\`
4. How to feed \`ToolMessage\` results back into the loop
5. How to put it all together into an agent

> Tip: **Shift+Enter** runs a cell. Edits are ephemeral — they live only in this tab.
`,
    },

    // ── Step 1 ──────────────────────────────────────────────────────────────
    {
      id: "md-step1",
      kind: "markdown",
      source: `## Step 1 — Say hi to the model

First let's just make sure we can reach the LLM. \`ChatOpenAI\` from
\`@langchain/openai\` is pointed at our **OpenAI-compatible proxy**
(\`/api/notebooks/ai/v1\`) so no API keys touch the browser.`,
    },
    {
      id: "hello-llm",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — one-shot call to the model.
const { ChatOpenAI } = ctx.lc.openai;

const model = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const res = await model.invoke("In one sentence: what is a LangChain agent?");
return res.content;
`,
      sampleOutput: {
        result:
          "A LangChain agent is an LLM-driven loop that decides which tools to call and feeds their results back into the model until it produces a final answer.",
      },
    },
    {
      id: "md-step1-explain",
      kind: "markdown",
      source: `✅ **What happened?**

- We instantiated \`ChatOpenAI\` — the genuine LangChain class.
- \`baseURL\` points at our gateway, so we can use **any** model from the Lovable AI Gateway through the standard OpenAI client.
- \`.invoke(string)\` is shorthand for sending a single \`HumanMessage\`. The return is an \`AIMessage\` whose \`.content\` is the model's text reply.

That's the smallest possible LangChain program. Now let's give it superpowers.`,
    },

    // ── Step 2 ──────────────────────────────────────────────────────────────
    {
      id: "md-step2",
      kind: "markdown",
      source: `## Step 2 — Define a tool

An **agent** is just an LLM that can call functions. In LangChain you
define those functions with \`tool()\` from \`@langchain/core/tools\` plus a
**Zod schema** that tells the model what arguments to pass.

We'll wrap Firecrawl's web search so the agent can look up real news.`,
    },
    {
      id: "define-tool",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — define a real LangChain tool backed by Firecrawl.
const { tool } = ctx.lc.tools;
const { z } = ctx.lc;

const searchCityNews = tool(
  async ({ city, limit }) => {
    const r = await ctx.firecrawl.search(\`latest news in \${city}\`, {
      limit: Math.min(limit ?? 5, 10),
      tbs: "qdr:d",                       // last 24 hours
      scrapeOptions: { formats: ["markdown"] },
    });
    const items = (r.web ?? r.data ?? [])
      .slice(0, limit ?? 5)
      .map((it) => ({
        title: it.title,
        url: it.url,
        snippet: (it.description || it.markdown || "").slice(0, 240),
      }));
    ctx.log("firecrawl returned", items.length, "items");
    return JSON.stringify(items);
  },
  {
    name: "search_city_news",
    description: "Search the web for the latest news stories in a given city.",
    schema: z.object({
      city: z.string().describe("City name, e.g. 'Bengaluru' or 'San Francisco'"),
      limit: z.number().min(1).max(10).optional().describe("How many stories (1-10)"),
    }),
  }
);

ctx.state.tools = [searchCityNews];
return { registered: searchCityNews.name, args: ["city", "limit?"] };
`,
      sampleOutput: {
        result: { registered: "search_city_news", args: ["city", "limit?"] },
      },
    },
    {
      id: "md-step2-explain",
      kind: "markdown",
      source: `✅ **What happened?**

- \`tool(fn, spec)\` produced a real LangChain \`StructuredTool\`.
- The **Zod schema** is converted into a JSON Schema and sent to the model so it knows exactly what arguments are allowed.
- The async function inside is normal JS — call any API, hit a DB, whatever. We just proxy to Firecrawl via \`ctx.firecrawl.search\`.
- We stashed the tool on \`ctx.state\` so the next cell can pick it up. \`ctx.state\` persists across cells in this notebook (just like Jupyter's \`globals()\`).

The agent doesn't run this function itself — it just decides **when** to call it. We do the actual calling. That's the core insight of agent loops.`,
    },

    // ── Step 3 ──────────────────────────────────────────────────────────────
    {
      id: "md-step3",
      kind: "markdown",
      source: `## Step 3 — Bind tools and look at the first response

\`model.bindTools([...])\` returns a **new** runnable that advertises those
tools to the model on every call. Let's invoke it once and inspect what
the model decides to do.`,
    },
    {
      id: "bind-and-call",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — bind tools, send first message, inspect tool_calls.
const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage, SystemMessage } = ctx.lc.messages;

const model = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0.3,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const llm = model.bindTools(ctx.state.tools);

const messages = [
  new SystemMessage("You are a concise news briefer. Call search_city_news when asked about a city."),
  new HumanMessage("What are the top 3 news stories in Bengaluru today?"),
];

const ai = await llm.invoke(messages);

// Save for the next cell:
ctx.state.messages = [...messages, ai];
ctx.state.llm = llm;

return {
  content: ai.content,
  tool_calls: ai.tool_calls,
};
`,
      sampleOutput: {
        result: {
          content: "",
          tool_calls: [
            { name: "search_city_news", args: { city: "Bengaluru", limit: 3 }, id: "call_1" },
          ],
        },
      },
    },
    {
      id: "md-step3-explain",
      kind: "markdown",
      source: `✅ **What happened?**

The model returned an \`AIMessage\` with:
- \`.content\` → usually empty when the model wants to call tools first
- \`.tool_calls\` → an array of \`{ name, args, id }\` describing which tools it wants invoked

Notice we did **not** execute \`search_city_news\` ourselves yet. The model only *requested* it. Now it's our job to run those tools and feed the results back.`,
    },

    // ── Step 4 ──────────────────────────────────────────────────────────────
    {
      id: "md-step4",
      kind: "markdown",
      source: `## Step 4 — Run the requested tools, append \`ToolMessage\`

For each \`tool_call\`, we call the matching tool's \`.invoke(args)\`, then
push a \`ToolMessage\` (with the same \`tool_call_id\`) back into the message
list. The model needs that link to know which result belongs to which call.`,
    },
    {
      id: "run-tools",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — execute every tool_call the model just made.
const { ToolMessage } = ctx.lc.messages;

const last = ctx.state.messages.at(-1);
const calls = last.tool_calls ?? [];
const toolsByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));

for (const call of calls) {
  ctx.log("→ invoking", call.name, JSON.stringify(call.args));
  const out = await toolsByName[call.name].invoke(call.args);
  ctx.state.messages.push(
    new ToolMessage({ content: out, tool_call_id: call.id })
  );
}

return { ran: calls.length, total_messages: ctx.state.messages.length };
`,
      sampleOutput: {
        logs: ["→ invoking search_city_news {\"city\":\"Bengaluru\",\"limit\":3}", "firecrawl returned 3 items"],
        result: { ran: 1, total_messages: 4 },
      },
    },
    {
      id: "md-step4-explain",
      kind: "markdown",
      source: `✅ **What happened?**

We turned each \`tool_call\` into a real function call and appended a
\`ToolMessage\` for each one. The conversation now looks like:

\`\`\`
system   → "You are a concise news briefer..."
human    → "What are the top 3 news stories in Bengaluru today?"
ai       → tool_calls: [search_city_news({city:"Bengaluru", limit:3})]
tool     → JSON results from Firecrawl
\`\`\`

The model has everything it needs to write a final answer.`,
    },

    // ── Step 5 ──────────────────────────────────────────────────────────────
    {
      id: "md-step5",
      kind: "markdown",
      source: `## Step 5 — Re-invoke to get the final answer

Call the same \`llm\` with the extended message list. If it's satisfied,
\`tool_calls\` will be empty and \`.content\` will contain the bulleted
summary.`,
    },
    {
      id: "final-answer",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 5 — second model turn, this time it should write the answer.
const ai = await ctx.state.llm.invoke(ctx.state.messages);
ctx.state.messages.push(ai);

return {
  more_tool_calls: ai.tool_calls?.length ?? 0,
  answer: ai.content,
};
`,
      sampleOutput: {
        result: {
          more_tool_calls: 0,
          answer:
            "- **Metro Phase 3 breaks ground in Bengaluru** — https://example.com/news/1\n- **Heavy rainfall warning issued** — https://example.com/news/2\n- **Tech layoffs at major Bengaluru firm** — https://example.com/news/3",
        },
      },
    },
    {
      id: "md-step5-explain",
      kind: "markdown",
      source: `✅ **What happened?**

\`more_tool_calls\` is \`0\` — the model has decided it's done. The
\`answer\` field holds the markdown summary, with real source URLs from
Firecrawl, never hallucinated.

You've just driven the canonical LangChain agent loop — using the real
\`ChatOpenAI\`, \`bindTools\`, \`StructuredTool\`, and \`ToolMessage\` classes
from \`@langchain/openai\` and \`@langchain/core\`. **Nothing here is mocked
or re-implemented** — these are the exact same objects a Node service
would use. The loop itself is just:

\`\`\`
while (true) {
  ai = llm.invoke(messages)            // real ChatOpenAI
  if (!ai.tool_calls.length) break     // real AIMessage.tool_calls
  for (call of ai.tool_calls) {
    out = tools[call.name].invoke(...) // real StructuredTool.invoke
    messages.push(new ToolMessage(...)) // real @langchain/core class
  }
}
\`\`\`

> LangChain ships a higher-level helper (\`AgentExecutor\` /
> \`createToolCallingAgent\`) that wraps this same loop with retries and
> tracing. We expand it inline here so you can see every message the
> model sees — once it clicks, the wrapped helper is a one-liner.`,
    },

    // ── Step 6 ──────────────────────────────────────────────────────────────
    {
      id: "md-step6",
      kind: "markdown",
      source: `## Step 6 — Wrap it in a reusable function

Now let's package what we just did into one function so you can call
\`askCityNews("Tokyo")\` repeatedly. This is the same code real production
agents ship.`,
    },
    {
      id: "agent-fn",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 6 — the full agent loop in one function.
const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

async function askCityNews(city, { maxSteps = 4, limit = 5 } = {}) {
  const llm = new ChatOpenAI({
    model: "google/gemini-3-flash-preview",
    temperature: 0.3,
    apiKey: ctx.aiApiKey,
    configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
  }).bindTools(ctx.state.tools);

  const toolsByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));
  const messages = [
    new SystemMessage("You are a concise news briefer. Use search_city_news, then summarise with source URLs."),
    new HumanMessage(\`Top \${limit} news stories in \${city} today?\`),
  ];

  for (let step = 0; step < maxSteps; step++) {
    ctx.log(\`step \${step + 1}\`);
    const ai = await llm.invoke(messages);
    messages.push(ai);
    const calls = ai.tool_calls ?? [];
    if (!calls.length) return ai.content;
    for (const c of calls) {
      ctx.log("  tool:", c.name, JSON.stringify(c.args));
      const out = await toolsByName[c.name].invoke(c.args);
      messages.push(new ToolMessage({ content: out, tool_call_id: c.id }));
    }
  }
  return "(max steps reached)";
}

return await askCityNews("Tokyo", { limit: 3 });
`,
      sampleOutput: {
        logs: ["step 1", "  tool: search_city_news {\"city\":\"Tokyo\",\"limit\":3}", "firecrawl returned 3 items", "step 2"],
        result:
          "- **Bank of Japan holds rates steady** — https://example.com/jp/1\n- **Tokyo metro fare hike announced** — https://example.com/jp/2\n- **Spring sumo tournament opens** — https://example.com/jp/3",
      },
    },

    // ── Outro ───────────────────────────────────────────────────────────────
    {
      id: "next",
      kind: "markdown",
      source: `## 🎉 You shipped a real LangChain agent

Everything you ran above is genuine \`@langchain/*\` code — same
\`ChatOpenAI\`, \`bindTools\`, \`ToolMessage\`, \`tool()\` APIs you'd use in a
Node backend.

### Try it yourself
- Change the city in the last cell to your hometown.
- Swap \`google/gemini-3-flash-preview\` for \`openai/gpt-5-mini\` and compare.
- Add a second \`tool(...)\` (e.g. \`get_weather\`) to \`ctx.state.tools\` and watch the agent pick which to call.

### Coming next
The next notebook rebuilds this exact loop as a **LangGraph \`StateGraph\`** — same idea, but explicit nodes and edges instead of a \`for\` loop.
`,
    },
  ],
};
