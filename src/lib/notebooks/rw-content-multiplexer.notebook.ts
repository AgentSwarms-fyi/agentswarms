import type { Notebook } from "./types";

/**
 * Real-world example 2 — Multi-platform Content Multiplexer.
 *
 * One URL → scrape with Firecrawl → fan out to two specialised agents
 * (X/Twitter thread + LinkedIn post) → return both artefacts as structured
 * output. Demonstrates a sequential-then-parallel multi-agent workflow.
 */
export const rwContentMultiplexerNotebook: Notebook = {
  id: "rw-content-multiplexer",
  title: "Multi-Platform Content Multiplexer",
  description:
    "Take any blog URL, scrape it with Firecrawl, then fan out to two specialised agents — an X/Twitter thread writer and a LinkedIn narrative writer — to produce two ready-to-publish posts from one source.",
  difficulty: "intermediate",
  tags: ["agent", "firecrawl", "multi-agent", "content", "real-world", "structured-output"],
  requires: ["firecrawl", "lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 📣 Multi-Platform Content Multiplexer

The most common ask in any "automate my marketing" project is:

> "I just published a blog post / shot a YouTube video. Turn it into the right shape for every platform without me having to babysit it."

The trick is that **each platform has different physics**. X/Twitter rewards hooks, brevity, and a clean numbered thread. LinkedIn rewards a personal narrative, generous line spacing, and a thoughtful conclusion. If you ask one prompt "rewrite this for social", you get bland output that pleases no algorithm.

So we'll build a small two-agent pipeline:

1. A **Scraper** step uses Firecrawl to pull the original article down to clean markdown.
2. Two **specialist writer agents** then run in parallel, each prompted (and *structured-output-constrained*) for its own platform.

The output is a single JSON object that your CMS or scheduler can drop straight into Buffer, Hypefury, or a homegrown queue.`,
    },

    // ── Step 1: Scrape ─────────────────────────────────────────────────────
    {
      id: "md-scrape",
      kind: "markdown",
      source: `## Step 1 — Scrape with Firecrawl

Firecrawl handles all the messy parts of the modern web (JS rendering, paywalls, lazy-loaded images, anti-bot headers) and returns clean markdown. That's exactly what an LLM wants. We ask for \`markdown\` and \`summary\` so we have both the full body (for fine-grained quotes) and a pre-cooked overview (for the writers to anchor on).`,
    },
    {
      id: "scrape",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — pull the source article.
const url = "https://blog.langchain.dev/langgraph/"; // change me

const res = await ctx.firecrawl.scrape(url, {
  formats: ["markdown", "summary"],
  onlyMainContent: true,
});

const markdown = res.markdown ?? res.data?.markdown ?? "";
const summary  = res.summary  ?? res.data?.summary  ?? "";

ctx.state.source = { url, markdown, summary };
ctx.log("📄 scraped", markdown.length, "chars,", summary.length, "char summary");

return {
  url,
  chars: markdown.length,
  summary_preview: summary.slice(0, 240),
};
`,
      sampleOutput: {
        logs: ["📄 scraped 18420 chars, 612 char summary"],
        result: {
          url: "https://blog.langchain.dev/langgraph/",
          chars: 18420,
          summary_preview: "LangGraph is a library for building stateful, multi-actor LLM applications. It introduces explicit graph constructs (nodes, edges, state) so that long-running agent workflows can be reasoned about and debugged…",
        },
      },
    },

    // ── Step 2: Structured-output schemas ─────────────────────────────────
    {
      id: "md-schemas",
      kind: "markdown",
      source: `## Step 2 — Define the output shapes

Both writers will use \`withStructuredOutput\` so we get JSON we can render directly — no regex cleanup, no "the model wrapped it in a code fence again" surprises.

- The **thread** is an array of 5–7 tweet strings; the first one is the hook.
- The **LinkedIn post** is a single body field plus a list of hashtags and an optional call-to-action.

By declaring constraints in Zod (\`min(5).max(7)\`, \`max(280)\`), we make the model's job easier and the downstream renderer's job trivial.`,
    },
    {
      id: "schemas",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — pin down what each writer is allowed to return.
const { z } = ctx.lc;

ctx.state.ThreadSchema = z.object({
  hook: z.string().max(280).describe("The first tweet — must stop the scroll. Avoid clickbait, prefer concrete claims."),
  tweets: z.array(z.string().max(280)).min(4).max(6).describe("Body tweets, each under 280 chars."),
  cta: z.string().max(280).describe("Final tweet — what to do next (read more, follow, reply)."),
});

ctx.state.LinkedInSchema = z.object({
  body: z.string().describe("The full post. Use single line breaks between sentences and double line breaks between paragraphs. 600–1200 chars."),
  hashtags: z.array(z.string().regex(/^#[A-Za-z0-9]+$/)).min(3).max(6),
  cta: z.string().describe("One-line call to action (e.g. 'What's your take?')"),
});

return { thread_fields: ["hook", "tweets[]", "cta"], linkedin_fields: ["body", "hashtags[]", "cta"] };
`,
      sampleOutput: { result: { thread_fields: ["hook", "tweets[]", "cta"], linkedin_fields: ["body", "hashtags[]", "cta"] } },
    },

    // ── Step 3: Writer agents ─────────────────────────────────────────────
    {
      id: "md-writers",
      kind: "markdown",
      source: `## Step 3 — Two specialist writers, run in parallel

We instantiate two LLM calls. They share a model but get **very different system prompts** — that's where the platform knowledge lives. We fire them with \`Promise.all\` so the latency is the slower of the two, not the sum.`,
    },
    {
      id: "writers",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — fan out: thread writer + LinkedIn writer.
const { ChatOpenAI } = ctx.lc.openai;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0.7,                    // mild creativity helps voice
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const threadAgent = llm.withStructuredOutput(ctx.state.ThreadSchema);
const linkedinAgent = llm.withStructuredOutput(ctx.state.LinkedInSchema);

const ARTICLE =
  "TITLE / SUMMARY:\\n" + ctx.state.source.summary +
  "\\n\\nFULL BODY (truncated to 6k chars):\\n" + ctx.state.source.markdown.slice(0, 6000) +
  "\\n\\nSOURCE URL: " + ctx.state.source.url;

const THREAD_SYSTEM =
  "You write high-signal X/Twitter threads. Hooks must be concrete (no 'here's what I learned'). " +
  "Each tweet must stand alone. No emojis. End with a CTA that points back to the source URL.";

const LINKEDIN_SYSTEM =
  "You write thoughtful LinkedIn posts in a first-person narrative voice. " +
  "Open with a specific moment, develop one insight, close with a question. " +
  "Use double line breaks between paragraphs. Hashtags must be relevant — no generic '#AI #Innovation'.";

ctx.log("🧵 running thread + linkedin writers in parallel…");
const [thread, post] = await Promise.all([
  threadAgent.invoke([
    { role: "system", content: THREAD_SYSTEM },
    { role: "user",   content: ARTICLE },
  ]),
  linkedinAgent.invoke([
    { role: "system", content: LINKEDIN_SYSTEM },
    { role: "user",   content: ARTICLE },
  ]),
]);

ctx.state.artifacts = { thread, post };
return { thread, post };
`,
      sampleOutput: {
        logs: ["🧵 running thread + linkedin writers in parallel…"],
        result: {
          thread: {
            hook: "LangGraph is what happens when you stop pretending an LLM 'agent' is a single magical for-loop.",
            tweets: [
              "It treats your workflow as a graph: nodes are work, edges are decisions, state is explicit.",
              "Why this matters: you can pause, inspect, replay, and resume. The same primitives that made databases trustworthy now apply to agents.",
              "Cycles are a first-class concept — a reviewer node can loop back to the coder until tests pass, with a hard MAX_ITERS guard.",
              "Human-in-the-loop becomes a one-line config: interruptBefore: ['payout']. The graph stops, persists, waits for a click, resumes.",
            ],
            cta: "Full write-up here — worth the 10 minutes if you're shipping anything agentic →",
          },
          post: {
            body: "I shipped my first 'real' agent three years ago. It was a 200-line while loop and I was terrified to deploy it.\\n\\nLangGraph is what I wish I'd had then. It turns the implicit state machine that's already in your head into a real object you can debug, persist, and restart.\\n\\nThe parts that finally clicked for me: explicit state schema, conditional edges, and the interrupt API for human approvals. None of those are exotic — they're the same primitives we already trust in databases and CI pipelines.\\n\\nIf you've been hand-rolling agent loops, this is the upgrade.",
            hashtags: ["#LangGraph", "#LLM", "#AgentDesign", "#Engineering"],
            cta: "What's the first agent you'd rebuild on top of a real graph?",
          },
        },
      },
    },

    // ── Step 4: Render ────────────────────────────────────────────────────
    {
      id: "md-render",
      kind: "markdown",
      source: `## Step 4 — Render both artifacts as preview strings

This last cell does no LLM work — it just shows what the output would look like in a scheduler UI. In a real product this is where you'd POST to Buffer or push into a moderation queue.`,
    },
    {
      id: "render",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — final render.
const { thread, post } = ctx.state.artifacts;

const renderedThread =
  [thread.hook, ...thread.tweets, thread.cta + " " + ctx.state.source.url]
    .map((t, i) => (i + 1) + "/ " + t)
    .join("\\n\\n");

const renderedLinkedIn =
  post.body + "\\n\\n" + post.cta + "\\n\\n" + post.hashtags.join(" ");

return {
  x_thread: renderedThread,
  linkedin: renderedLinkedIn,
};
`,
      sampleOutput: {
        result: {
          x_thread: "1/ LangGraph is what happens when you stop pretending an LLM 'agent' is a single magical for-loop.\\n\\n2/ It treats your workflow as a graph: nodes are work, edges are decisions, state is explicit.\\n\\n…",
          linkedin: "I shipped my first 'real' agent three years ago…\\n\\nWhat's the first agent you'd rebuild on top of a real graph?\\n\\n#LangGraph #LLM #AgentDesign #Engineering",
        },
      },
    },

    {
      id: "wrap",
      kind: "markdown",
      source: `## 🎯 Why this pattern matters

You just demonstrated the **scatter / specialist** pattern: one source → multiple platform-specific outputs, each shaped by its own structured schema, generated in parallel. The same skeleton scales to:

- Newsletter (Markdown) + Tweet thread + Instagram caption + YouTube description
- One product update → release notes + changelog entry + sales email + support doc

Once the schemas are right, swapping platforms is a 30-line change.`,
    },
  ],
};
