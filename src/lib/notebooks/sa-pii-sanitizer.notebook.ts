import type { Notebook } from "./types";

export const saPiiSanitizerNotebook: Notebook = {
  id: "sa-pii-sanitizer",
  title: "PII Sanitizer (Middleware Guardrails)",
  description:
    "An agent that scrubs credit cards, SSNs, emails and names from a payload before passing it downstream. Add edge cases via system instructions.",
  difficulty: "beginner",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 10 · PII Sanitizer

A common guardrail pattern: a small agent that strips sensitive data
**before** it reaches another service or model. We use structured output
so the redaction is auditable — you get the cleaned text *and* a list of
what was removed.

**Try this:** add new redaction rules in the system prompt
(e.g. "redact passport numbers and IBANs").`,
    },

    {
      id: "sanitize", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

// 👇 Edit the system prompt to catch more PII categories.
const SYSTEM = \`You are a PII sanitizer.
Redact: full names, email addresses, phone numbers, postal addresses,
credit card numbers, SSNs (US social security numbers), and dates of birth.
Replace each finding with a label like [REDACTED_NAME], [REDACTED_CARD], etc.
Return the cleaned text and a list of every redaction made.\`;

// 👇 Edit this payload — try your own fake sensitive data.
const PAYLOAD = \`Hi support team,
This is John Smith (DOB: 1985-03-12), reaching out about my order.
You can reach me at john.smith@example.com or +1 (415) 555-0199.
My card 4111-1111-1111-1111 was charged twice. My SSN on file is 123-45-6789.
Please ship the replacement to 742 Evergreen Terrace, Springfield.
Thanks!\`;

const schema = z.object({
  cleaned_text: z.string(),
  redactions: z.array(z.object({
    category: z.string().describe("e.g. NAME, EMAIL, CARD, SSN, PHONE, ADDRESS, DOB"),
    original: z.string(),
    replacement: z.string(),
  })),
});

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(schema, { name: "sanitize" });

return await llm.invoke([
  ["system", SYSTEM],
  ["human", PAYLOAD],
]);
`,
    },
    { id: "md-x", kind: "markdown", source: `In production you'd combine this with a **deterministic regex pre-pass** (for things like card numbers, where you can't tolerate a model miss) and use the LLM only for the fuzzy categories (names, addresses). Defense in depth.` },
  ],
};
