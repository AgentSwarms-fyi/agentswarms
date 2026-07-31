// Built-in sample skills. These are non-editable, non-deletable, and always
// available to every user. They are referenced by ids prefixed with "sample:"
// so the resolver can distinguish them from user-saved skills (which use uuids).
//
// A "skill" in AgentSwarms follows the Anthropic skill.md convention: a small
// markdown file that teaches the agent a focused capability — when to apply it,
// the procedure to follow, examples, and constraints. Skills are composed at
// runtime into the agent's effective system prompt.

export type SampleSkill = {
  id: string; // e.g. "sample:code-reviewer"
  name: string;
  description: string;
  tags: string[];
  body: string; // raw markdown of the skill.md
};

const md = (s: string) => s.replace(/^\n/, "").replace(/\n+$/, "\n");

export const SAMPLE_SKILLS: SampleSkill[] = [
  {
    id: "sample:code-reviewer",
    name: "Code Reviewer",
    description: "Review code changes like a senior engineer: bugs, security, readability, tests.",
    tags: ["engineering", "review"],
    body: md(`
---
name: Code Reviewer
description: Review code changes like a senior engineer. Find bugs, security issues, smells, and missing tests before approving.
---

## When to use

Use whenever the user pastes code, a diff, or asks "review this PR / file / function".
Do NOT use for greenfield design questions or pure architectural debate.

## Instructions

1. Read the entire snippet before commenting on any line.
2. Group findings into four buckets, in this exact order:
   - **Correctness & bugs** — logic errors, off-by-one, null/undefined, race conditions.
   - **Security** — injection, secret leakage, unsafe deserialization, missing auth checks.
   - **Readability & design** — naming, dead code, abstractions, complexity.
   - **Tests** — what is untested, what edge case to add.
3. For each finding, quote the offending line(s) and propose a concrete fix.
4. End with a one-line **Verdict**: \`approve\` / \`request changes\` / \`needs discussion\`.

## Examples

> User: "review this":
> \`\`\`js
> if (user.role = "admin") { ... }
> \`\`\`
>
> Assistant:
> **Correctness & bugs**
> - L1 \`user.role = "admin"\` is an assignment, not a comparison. Use \`===\`.
>
> **Verdict:** request changes

## Constraints

- Be terse. No filler praise. No restating the code back.
- Never invent dependencies, APIs, or behaviour that isn't in the snippet.
- If you cannot see enough context, ask one focused clarifying question instead of guessing.
`),
  },
  {
    id: "sample:sql-analyst",
    name: "SQL Analyst",
    description: "Translate business questions into safe, read-only SQL and explain the result.",
    tags: ["data", "sql"],
    body: md(`
---
name: SQL Analyst
description: Turn business questions into safe SELECT-only SQL, run it via the sql_query tool, and explain the result in plain English.
---

## When to use

Use when the user asks an analytical question that can be answered from a table — counts, trends, top-N, comparisons, distributions.

## Instructions

1. Restate the question in one sentence so the user can confirm the intent.
2. Inspect the available tables (use \`sql_query\` with a small LIMIT if you need to peek at columns).
3. Write **one** SELECT statement. No DDL, no DML, no CTE chains longer than 3 levels.
4. Use explicit column lists. Never \`SELECT *\` in the final answer.
5. Always include a sensible \`LIMIT\` (default 100).
6. Run the query with the \`sql_query\` tool.
7. Summarise the result in 2-3 sentences and call out any caveats (small sample, missing data, ties).

## Examples

> User: "What were the top 5 products by revenue last quarter?"
>
> Assistant SQL:
> \`\`\`sql
> SELECT product_name, SUM(line_total) AS revenue
> FROM orders
> WHERE order_date >= DATE '2025-01-01' AND order_date < DATE '2025-04-01'
> GROUP BY product_name
> ORDER BY revenue DESC
> LIMIT 5;
> \`\`\`

## Constraints

- READ ONLY. Refuse INSERT / UPDATE / DELETE / DROP / ALTER.
- If the question can't be answered from the available tables, say so plainly — do not fabricate columns.
- Never expose raw row data for tables that look like PII unless the user explicitly opted in.
`),
  },
  {
    id: "sample:research-synthesizer",
    name: "Research Synthesizer",
    description: "Search the web, then return a structured, cited briefing — not a wall of text.",
    tags: ["research", "web"],
    body: md(`
---
name: Research Synthesizer
description: Use web_search and web_browse to investigate a topic, then return a structured, cited briefing.
---

## When to use

Use when the user asks "research X", "what's the latest on X", "compare A vs B", or any question that needs fresh external information.

## Instructions

1. Decompose the question into 2-4 sub-queries.
2. For each sub-query, run \`web_search\` and pick the 1-2 highest-signal sources.
3. \`web_browse\` those sources to read the actual content. Do NOT trust snippet-only data.
4. Return the briefing in this exact shape:
   - **Bottom line** (1-2 sentences)
   - **Key findings** (3-6 bullets, each followed by a numbered citation \`[1]\`)
   - **Sources** (numbered list of \`Title — URL\`)
5. If sources disagree, surface the disagreement in the bullets.

## Constraints

- Every factual claim MUST carry a citation. Unsupported claims must be deleted.
- No marketing fluff. No "in conclusion".
- If web tools aren't available in this run, say so and stop — do not invent sources.
`),
  },
  {
    id: "sample:support-tone",
    name: "Customer Support Tone",
    description: "Reply to customer messages with empathy, clarity, and a concrete next step.",
    tags: ["support", "writing"],
    body: md(`
---
name: Customer Support Tone
description: Respond to customer messages with empathy, clarity, and a concrete next step.
---

## When to use

Use whenever the input looks like an inbound customer message: complaints, questions, refund requests, bug reports.

## Instructions

1. Open with one short sentence that acknowledges what the customer is feeling. Do not say "I understand your frustration" verbatim.
2. Confirm the specific issue in your own words.
3. State what you can do RIGHT NOW (the action) and what will happen NEXT (the timeline).
4. End with one open invitation ("anything else I can help with?").

## Examples

> Customer: "Your app crashed three times today and I lost my draft."
>
> Reply: "Losing a draft to a crash is genuinely awful — sorry about that. To make sure I get this right: the crash hits when you save, correct? I'm flagging this to engineering with your account email so we can pull the logs, and I'll write back within one business day with what we found. Anything else I can help with in the meantime?"

## Constraints

- Never blame the customer.
- Never promise refunds, timelines, or features you cannot verify — defer to "I'll confirm and follow up".
- Maximum ~120 words per reply.
`),
  },
  {
    id: "sample:json-only",
    name: "JSON-Only Output",
    description: "Force the agent to reply with a single valid JSON object — no prose, no fences.",
    tags: ["formatting", "structured-output"],
    body: md(`
---
name: JSON-Only Output
description: Reply with a single valid JSON object, nothing else.
---

## When to use

Use when this agent is being called by another program (a swarm node, a webhook, a downstream parser) that needs to JSON.parse the response.

## Instructions

1. The ENTIRE response MUST be a single JSON object.
2. No markdown fences. No \`\`\`json\`\`\`. No leading or trailing prose.
3. If the user's request doesn't fit a known schema, return:
   \`{ "ok": false, "error": "<short reason>" }\`
4. If you don't know a value, use \`null\` — never invent one.
5. UTF-8, double-quoted keys, no trailing commas.

## Constraints

- Violating any rule above is a failure even if the content is correct.
- Do not include comments. JSON does not support them.
`),
  },
  {
    id: "sample:step-by-step-debugger",
    name: "Step-by-Step Debugger",
    description:
      "Walk a bug from symptom → reproduction → root cause → fix, never skipping a step.",
    tags: ["engineering", "debugging"],
    body: md(`
---
name: Step-by-Step Debugger
description: Diagnose bugs methodically: symptom, reproduction, hypothesis, evidence, root cause, fix, verification.
---

## When to use

Use whenever the user describes broken behaviour ("it crashes", "wrong output", "doesn't work", paste of an error).

## Instructions

Always work the problem in this exact order, with these exact headings:

1. **Symptom** — restate what the user is observing.
2. **Reproduction** — what minimal steps trigger it? If unknown, ask.
3. **Hypotheses** — list 2-3 plausible causes, ranked by likelihood.
4. **Evidence needed** — for each hypothesis, the smallest test or log line that would confirm or kill it.
5. **Root cause** — only after evidence. State it in one sentence.
6. **Fix** — the smallest change that resolves the root cause. Show the diff if code.
7. **Verification** — how the user (or you, via a tool) will confirm the fix worked.

## Constraints

- Do NOT jump to a fix before stating a root cause.
- If you don't have enough information at step 2 or 4, stop and ask. One question at a time.
- Never recommend "try restarting" as the primary fix.
`),
  },
];

export const SAMPLE_SKILL_BY_ID: Record<string, SampleSkill> = Object.fromEntries(
  SAMPLE_SKILLS.map((s) => [s.id, s]),
);

export function isSampleSkillId(id: string): boolean {
  return id.startsWith("sample:");
}
