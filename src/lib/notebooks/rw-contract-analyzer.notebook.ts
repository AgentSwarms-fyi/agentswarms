import type { Notebook } from "./types";

/**
 * Real-world example 4 — Contract Risk Analyzer (LegalTech).
 *
 * Combines: clause segmentation + structured-output risk scoring against
 * an explicit rubric + tabular markdown report.
 */
export const rwContractAnalyzerNotebook: Notebook = {
  id: "rw-contract-analyzer",
  title: "Automated Contract Risk Analyzer",
  description:
    "Run a freelance contract through a structured Risk Analysis Rubric — clause segmentation, per-clause green/yellow/red scoring with rationale, and a markdown summary table you could hand to a paralegal.",
  difficulty: "advanced",
  tags: ["agent", "structured-output", "legaltech", "real-world"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 📄 Contract Risk Analyzer (LegalTech)

Lawyers (and the tens of thousands of freelancers who can't afford one) spend an enormous amount of time reading the same five clauses in slightly different fonts. Auto-NDAs, freelance MSAs, supplier agreements — the *shape* of the risk is well-known. What changes is the language each counterparty chose to bury it in.

This notebook builds a small but realistic legal-tech analyzer. It:

1. **Segments** the contract into individual clauses.
2. **Scores each clause** against an explicit rubric — Green (standard), Yellow (negotiable), Red (refuse) — with a one-sentence rationale and a suggested revision.
3. **Aggregates** the results into a markdown table you could literally paste into Notion or a follow-up email.

The model never makes a binding legal judgment, and we make that boundary explicit in the system prompt. The output is *triage*, not advice — the same role a junior associate plays before a partner reads it.`,
    },

    // ── Step 1 ────────────────────────────────────────────────────────────
    {
      id: "md-contract",
      kind: "markdown",
      source: `## Step 1 — Sample contract text

We'll use a deliberately problematic freelance service agreement so the rubric has something interesting to flag. Real contracts arrive as PDFs — you'd run them through Firecrawl, pdf-parse, or AWS Textract first; the rest of this notebook is identical regardless of the source.`,
    },
    {
      id: "contract",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — paste in the contract.
const CONTRACT = \`
1. SERVICES. The Freelancer shall provide design and development services as
described in any future Statement of Work (SOW), at the sole discretion of the
Client.

2. PAYMENT. The Client shall pay the Freelancer the agreed fee within ninety
(90) days of receipt of the Freelancer's invoice. Disputed invoices may be
withheld indefinitely pending resolution.

3. OWNERSHIP. All work product, ideas, sketches, drafts, and preliminary
materials, whether or not delivered, shall be the exclusive property of the
Client upon creation, including any pre-existing tools or libraries used by the
Freelancer in performing the Services.

4. INDEMNIFICATION. The Freelancer shall indemnify and hold harmless the Client
from and against any and all claims, losses, damages, and expenses (including
attorneys' fees), without limitation, arising out of or in connection with the
Services or this Agreement.

5. TERMINATION. The Client may terminate this Agreement at any time, with or
without cause, effective immediately. The Freelancer may terminate only with
sixty (60) days' written notice. Upon termination by the Freelancer, all unpaid
fees are forfeited.

6. CONFIDENTIALITY. Both parties shall keep confidential any information
designated as confidential, for a period of five (5) years from disclosure.
\`;

ctx.state.contract = CONTRACT.trim();
return { length: ctx.state.contract.length };
`,
      sampleOutput: { result: { length: 1186 } },
    },

    // ── Step 2: Rubric + Schema ───────────────────────────────────────────
    {
      id: "md-rubric",
      kind: "markdown",
      source: `## Step 2 — The Risk Analysis Rubric

This rubric is the heart of the system. Putting it in the *prompt* (not in the model's training data) means you can update it any time the legal team's policy changes — without retraining, redeploying, or hoping the model "remembers correctly." It's the same reason RAG works: ground the LLM in a document you control.`,
    },
    {
      id: "rubric",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — write the rubric + the per-clause output schema.
const { z } = ctx.lc;

ctx.state.RUBRIC = \`
RISK RUBRIC (apply per clause):

GREEN  — standard market language. Accept without changes.
YELLOW — negotiable / non-standard but not catastrophic. Suggest a fix.
RED    — refuse or escalate to counsel. Examples:
         • Uncapped indemnification.
         • Unilateral termination rights with no notice / no kill fee.
         • Payment terms longer than 60 days.
         • Assignment of pre-existing IP or tools.
         • Confidentiality with no time limit OR a vague definition of "confidential".
         • Vague scope ("at sole discretion") with no SOW protections.
\`;

ctx.state.ClauseSchema = z.object({
  clause_number: z.string().describe("As labelled in the contract, e.g. '4'"),
  title: z.string().describe("Short human title like 'Indemnification'"),
  risk: z.enum(["GREEN", "YELLOW", "RED"]),
  finding: z.string().describe("One sentence: what is non-standard or risky."),
  suggested_revision: z.string().describe("One sentence: how to rewrite the clause."),
});

ctx.state.ReportSchema = z.object({
  clauses: z.array(ctx.state.ClauseSchema).min(1).max(20),
  overall_recommendation: z.enum(["accept", "negotiate", "reject"]),
  summary: z.string().describe("2–3 sentences for the cover note."),
});

return { rubric_chars: ctx.state.RUBRIC.length };
`,
      sampleOutput: { result: { rubric_chars: 612 } },
    },

    // ── Step 3: Analyze ───────────────────────────────────────────────────
    {
      id: "md-analyze",
      kind: "markdown",
      source: `## Step 3 — One structured pass over the whole contract

For short contracts (<10k chars) you can analyze the whole document in a single call. For longer ones you'd split by clause first and run them in parallel — same schema, just a \`Promise.all\`. We use \`temperature: 0\` because we want deterministic findings, not creative ones.`,
    },
    {
      id: "analyze",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — run the analyzer.
const { ChatOpenAI } = ctx.lc.openai;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(ctx.state.ReportSchema);

const report = await llm.invoke(
  "You are a contracts paralegal. Score each numbered clause using the rubric.\\n" +
  "You are NOT giving legal advice — your output is triage for a human attorney.\\n\\n" +
  "RUBRIC:\\n" + ctx.state.RUBRIC + "\\n\\n" +
  "CONTRACT:\\n" + ctx.state.contract
);

ctx.state.report = report;
ctx.log("📊 overall:", report.overall_recommendation);
for (const c of report.clauses) ctx.log("  " + c.risk + " — " + c.clause_number + ". " + c.title);
return report;
`,
      sampleOutput: {
        logs: [
          "📊 overall: reject",
          "  RED — 2. Payment",
          "  RED — 3. Ownership",
          "  RED — 4. Indemnification",
          "  RED — 5. Termination",
          "  YELLOW — 1. Services",
          "  GREEN — 6. Confidentiality",
        ],
        result: {
          overall_recommendation: "reject",
          summary: "This contract contains multiple Red-rated clauses including uncapped indemnification, 90-day payment terms, and assignment of pre-existing IP. Recommend rejecting in current form and counter-drafting from a standard freelance MSA template.",
          clauses: [
            { clause_number: "1", title: "Services", risk: "YELLOW", finding: "Scope is open-ended and tied to a future SOW at Client's sole discretion.", suggested_revision: "Require any SOW to be mutually agreed in writing and to define deliverables, timeline, and fees." },
            { clause_number: "2", title: "Payment", risk: "RED", finding: "Net-90 with indefinite withholding for disputed invoices is well outside market norms.", suggested_revision: "Net-30 with disputes resolved within 15 business days." },
            { clause_number: "3", title: "Ownership", risk: "RED", finding: "Assigns pre-existing tools and libraries to the Client — would strip Freelancer of reusable assets.", suggested_revision: "Limit assignment to Deliverables created specifically for the engagement; carve out pre-existing IP." },
            { clause_number: "4", title: "Indemnification", risk: "RED", finding: "Uncapped, includes attorneys' fees, with no carve-outs.", suggested_revision: "Cap at fees paid; exclude indirect/consequential damages; mutual indemnification." },
            { clause_number: "5", title: "Termination", risk: "RED", finding: "Asymmetric termination plus forfeiture of unpaid fees on Freelancer termination.", suggested_revision: "Mutual 30-day notice; all earned fees payable on termination." },
            { clause_number: "6", title: "Confidentiality", risk: "GREEN", finding: "5-year term and mutual obligation are standard.", suggested_revision: "—" },
          ],
        },
      },
    },

    // ── Step 4: Render markdown table ─────────────────────────────────────
    {
      id: "md-render",
      kind: "markdown",
      source: `## Step 4 — Render a paste-ready markdown table

This is the artifact you'd actually deliver: a single block of markdown that drops into Notion, Google Docs, or a follow-up email. The cell does no LLM work — once the JSON is right, formatting is trivial.`,
    },
    {
      id: "render",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — markdown table.
const r = ctx.state.report;
const emoji = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" };

const rows = r.clauses
  .sort((a, b) => ({ RED: 0, YELLOW: 1, GREEN: 2 }[a.risk] - { RED: 0, YELLOW: 1, GREEN: 2 }[b.risk]))
  .map((c) =>
    "| " + c.clause_number + ". " + c.title +
    " | " + emoji[c.risk] + " " + c.risk +
    " | " + c.finding +
    " | " + (c.suggested_revision === "—" ? "—" : c.suggested_revision) + " |"
  )
  .join("\\n");

const md =
  "**Overall:** " + r.overall_recommendation.toUpperCase() + "\\n\\n" +
  r.summary + "\\n\\n" +
  "| Clause | Risk | Finding | Suggested Revision |\\n" +
  "|---|---|---|---|\\n" + rows;

return md;
`,
      sampleOutput: {
        result:
          "**Overall:** REJECT\\n\\nThis contract contains multiple Red-rated clauses…\\n\\n| Clause | Risk | Finding | Suggested Revision |\\n|---|---|---|---|\\n| 2. Payment | 🔴 RED | Net-90 with indefinite withholding… | Net-30 with disputes resolved within 15 business days. |\\n…",
      },
    },

    {
      id: "wrap",
      kind: "markdown",
      source: `## ⚖️ Important guardrails

- **Always output "triage, not advice"** — even if the customer is a lawyer. Adding "this is not legal advice" to the system prompt is cheap insurance.
- **Pin the rubric in the prompt, not in the model's memory.** That's how legal/compliance can update policy without your help.
- **Run at \`temperature: 0\`** for findings; you can crank it up to 0.4 only for the human-facing summary if you want a less robotic cover note.
- For long contracts, **split by clause and parallelize** — the model is much more reliable when asked one focused question at a time.`,
    },
  ],
};
