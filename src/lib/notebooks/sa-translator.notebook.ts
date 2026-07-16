import type { Notebook } from "./types";

export const saTranslatorNotebook: Notebook = {
  id: "sa-translator",
  title: "Local Dialect Translation Agent",
  description:
    "Translate text into specific dialects — Gen-Z slang, legal jargon, Shakespearean English, your hometown's vernacular. All persona prompting.",
  difficulty: "beginner",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 15 · Local Dialect Translator

A reminder that 90% of "specialised LLM behaviour" is just a sharp
persona prompt. We translate the same sentence into multiple styles in
one batch.

**Experiments:**
- Add a new persona to the \`PERSONAS\` array.
- Edit \`SOURCE\` to your own paragraph and re-run.`,
    },

    {
      id: "translate", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

// 👇 Edit personas and source text.
const PERSONAS = [
  { name: "gen_z_slang",          instruction: "Rewrite in modern Gen-Z internet slang. Casual, emoji-friendly, lowercase." },
  { name: "legal_jargon",         instruction: "Rewrite as a formal legal memorandum. Use 'herein', 'pursuant to', 'the party of the first part'." },
  { name: "shakespearean",        instruction: "Rewrite in Early Modern English in the style of Shakespeare. Use thee/thou/hath." },
  { name: "pirate_captain",       instruction: "Rewrite as a 1700s pirate captain. Arr." },
];

const SOURCE = "We regret to inform you that your subscription has been cancelled due to a payment failure on your credit card.";

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "{instruction} Preserve the original meaning exactly. Return only the rewritten text."],
  ["human", "{text}"],
]);

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.7,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const chain = prompt.pipe(llm).pipe(new StringOutputParser());

const results = {};
for (const p of PERSONAS) {
  results[p.name] = await chain.invoke({ instruction: p.instruction, text: SOURCE });
  ctx.log(p.name, "done");
}
return results;
`,
    },
    { id: "md-x", kind: "markdown", source: `In production you'd run these in parallel with \`Promise.all\` rather than the serial \`for\` loop — same chain, ~4× faster.` },
  ],
};
