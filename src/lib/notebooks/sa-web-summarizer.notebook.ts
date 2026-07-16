import type { Notebook } from "./types";

export const saWebSummarizerNotebook: Notebook = {
  id: "sa-web-summarizer",
  title: "Web Scraper & Summarizer",
  description:
    "Use Firecrawl to fetch a URL, then summarise its core argument. Swap URLs and ask for tweets, bullets, or essays.",
  difficulty: "beginner",
  tags: ["agent", "langchain", "firecrawl"],
  requires: ["firecrawl", "lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 11 · Web Scraper & Summarizer

Firecrawl fetches the page as clean markdown (no DOM wrangling), then we
hand it to an LLM for summarisation. The prompt controls the **output
format** — bullets, tweets, exec summaries, whatever.

**Try this:**
- Change \`URL\` to any article you like.
- Change \`FORMAT\` to ask for a 280-char tweet, a 5-bullet TL;DR, or a 3-paragraph essay.`,
    },

    {
      id: "scrape-summarise", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

// 👇 Edit these two.
const URL = "https://en.wikipedia.org/wiki/Large_language_model";
const FORMAT = "5 punchy bullet points capturing the core argument, each <= 20 words.";

const scraped = await ctx.firecrawl.scrape(URL, { formats: ["markdown"], onlyMainContent: true });
const md = scraped?.markdown ?? scraped?.data?.markdown ?? "";
ctx.log("fetched", md.length, "chars");
if (!md) throw new Error("Firecrawl returned no markdown — check the URL or your connection.");

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You summarise web articles. Output exactly the requested format. No preamble."],
  ["human", "Format requested:\\n{format}\\n\\nArticle:\\n{article}"],
]);

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.4,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const chain = prompt.pipe(llm).pipe(new StringOutputParser());
return await chain.invoke({ format: FORMAT, article: md.slice(0, 12000) });
`,
    },
    { id: "md-x", kind: "markdown", source: `We cap the input at 12k characters to stay safely within most context windows. For long-form articles you'd add a **map-reduce** step: summarise each chunk, then summarise the summaries.` },
  ],
};
