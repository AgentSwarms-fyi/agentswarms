import type { Notebook } from "./types";

/**
 * Real-world example 3 — GitHub Issue Triager.
 *
 * Combines: structured-output classification, in-memory "codebase search"
 * tool, and an autoresponder. Demonstrates how to wire severity routing
 * to actions (labels + draft comment).
 */
export const rwGithubTriagerNotebook: Notebook = {
  id: "rw-github-triager",
  title: "GitHub Issue Triager & Auto-Responder",
  description:
    "Classify an incoming GitHub issue (severity + sentiment + labels), search a mock codebase for the most likely culprit files, and draft a contextual first-response comment — the open-source maintainer's dream tool.",
  difficulty: "intermediate",
  tags: ["agent", "structured-output", "devops", "real-world", "rag"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 🐛 GitHub Issue Triager & Auto-Responder

Anyone who maintains an open-source project knows the inbox feeling: 14 new issues since yesterday, most of them duplicates or one-liners, three of them genuinely on fire, and you have a day job.

The win here isn't replacing the maintainer — it's giving every issue a **30-second first response** so contributors know they were heard, and labelling things consistently so the actual humans can triage by severity instead of by accident.

This notebook builds that loop in three pieces:

1. **Classification** — an LLM call with \`withStructuredOutput\` returns a strict JSON object: \`severity\`, \`sentiment\`, \`labels[]\`, and the area of the codebase the bug is most likely in (\`auth\`, \`payments\`, \`ui\`, etc.).
2. **Codebase search** — we expose a tiny "grep + ranking" tool over a mock project tree so the LLM can ground its guess in real file paths instead of inventing \`src/lib/SomeComponent.tsx\`.
3. **Draft response** — a final LLM call that politely acknowledges the report, names the likely culprit file, and sets expectations.

The same pattern wraps trivially around a real GitHub webhook (\`issues.opened\`) and the Octokit REST client.`,
    },

    // ── Step 1 ────────────────────────────────────────────────────────────
    {
      id: "md-issue",
      kind: "markdown",
      source: `## Step 1 — The incoming issue

We'll work with a realistic bug report. Notice it's not perfectly written — there's no stack trace, the title is more honest than diagnostic. That's exactly what real issues look like, and exactly where structured classification earns its keep: the model has to *infer* severity and area from incomplete information.`,
    },
    {
      id: "issue",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — the new issue payload.
const issue = {
  number: 412,
  title: "Bug: Login fails when using Safari on mobile",
  body:
    "Hey, on iPhone 14 / Safari 17 I can type my password and hit Sign In, " +
    "the page flashes for a second and then I'm back on the login screen. " +
    "Works fine on desktop Chrome. No console errors visible. " +
    "Happens for both me and my co-founder, so it's not a one-off cache thing.",
  author: "octocat",
};

ctx.state.issue = issue;
return issue;
`,
      sampleOutput: {
        result: {
          number: 412,
          title: "Bug: Login fails when using Safari on mobile",
          body: "Hey, on iPhone 14 / Safari 17 I can type my password…",
          author: "octocat",
        },
      },
    },

    // ── Step 2: mock codebase ─────────────────────────────────────────────
    {
      id: "md-codebase",
      kind: "markdown",
      source: `## Step 2 — A mock codebase + a tiny search tool

We model the repo as a flat map of \`path -> contents\`. The \`searchCodebase\` tool does a simple lowercased substring scan and returns the top matches with a short snippet. In a real integration this would be a call to GitHub Code Search, Sourcegraph, or a local embeddings index — but the *contract* the tool exposes to the LLM is identical, so the rest of the agent doesn't change.`,
    },
    {
      id: "codebase",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — define a fake repo and a search tool over it.
const REPO = {
  "src/auth/session.ts":
    "// Manages the auth session cookie.\\n" +
    "export function persistSession(token: string) {\\n" +
    "  document.cookie = \`session=\${token}; path=/; samesite=strict;\`;\\n" +
    "  // NOTE: Safari ITP drops cookies without secure flag on iOS 17+\\n" +
    "}\\n",
  "src/auth/login.tsx":
    "// Login page. Calls /api/auth/login then router.push('/')\\n" +
    "import { persistSession } from './session';\\n",
  "src/payments/checkout.tsx": "// Stripe checkout flow…",
  "src/ui/header.tsx":         "// Top nav bar…",
  "src/api/auth/login.ts":     "// POST /api/auth/login — sets session cookie via Set-Cookie header",
};

function searchCodebase(query, k = 3) {
  const q = query.toLowerCase();
  return Object.entries(REPO)
    .map(([path, body]) => {
      const hay = (path + " " + body).toLowerCase();
      let score = 0;
      for (const term of q.split(/\\s+/)) {
        if (term && hay.includes(term)) score += 1;
      }
      return { path, snippet: body.slice(0, 160), score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

ctx.state.searchCodebase = searchCodebase;
return searchCodebase("safari cookie session login");
`,
      sampleOutput: {
        result: [
          { path: "src/auth/session.ts", snippet: "// Manages the auth session cookie.\\nexport function persistSession(token: string) {…", score: 3 },
          { path: "src/api/auth/login.ts", snippet: "// POST /api/auth/login — sets session cookie via Set-Cookie header", score: 3 },
          { path: "src/auth/login.tsx", snippet: "// Login page. Calls /api/auth/login then router.push('/')…", score: 2 },
        ],
      },
    },

    // ── Step 3: Classify ──────────────────────────────────────────────────
    {
      id: "md-classify",
      kind: "markdown",
      source: `## Step 3 — Classify the issue into structured JSON

This is the only "creative" LLM step. We force it through a Zod schema so the downstream code can rely on the shape — no parsing, no \`try/catch\` around \`JSON.parse\`. The model gets the title + body and returns severity, sentiment, suggested labels, and a free-form \`search_query\` it would *like* to run against the codebase. We use that query in the next step.`,
    },
    {
      id: "classify",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — structured classification.
const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

const Triage = z.object({
  severity:  z.enum(["low", "medium", "high"]),
  sentiment: z.enum(["calm", "frustrated", "angry"]),
  labels:    z.array(z.string()).min(1).max(4).describe("Short GitHub labels like 'bug', 'safari', 'auth'."),
  area:      z.enum(["auth", "payments", "ui", "api", "infra", "unknown"]),
  search_query: z.string().describe("A short space-separated query the codebase search tool can use to find the likely culprit file."),
});

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(Triage);

const triage = await llm.invoke(
  "Classify this GitHub issue.\\n\\nTITLE: " + ctx.state.issue.title +
  "\\n\\nBODY: " + ctx.state.issue.body
);

ctx.state.triage = triage;
ctx.log("🏷️  labels:", triage.labels.join(", "));
ctx.log("📊 severity:", triage.severity, "| sentiment:", triage.sentiment);
return triage;
`,
      sampleOutput: {
        logs: [
          "🏷️  labels: bug, auth, safari, mobile",
          "📊 severity: high | sentiment: calm",
        ],
        result: {
          severity: "high",
          sentiment: "calm",
          labels: ["bug", "auth", "safari", "mobile"],
          area: "auth",
          search_query: "safari cookie session login",
        },
      },
    },

    // ── Step 4: Search + Draft ────────────────────────────────────────────
    {
      id: "md-search-draft",
      kind: "markdown",
      source: `## Step 4 — Search the codebase, then draft the reply

We feed the triage's \`search_query\` into our \`searchCodebase\` tool and pass the top hits to a second LLM call. The reply is intentionally short — 2–3 sentences, naming the most likely file, setting expectations, and acknowledging the reporter's effort. **It never promises a fix.** That's a deliberate guardrail: the autoresponder is allowed to triage, not to commit a maintainer to anything.`,
    },
    {
      id: "search-and-draft",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — codebase grounding + draft response.
const { ChatOpenAI } = ctx.lc.openai;

const hits = ctx.state.searchCodebase(ctx.state.triage.search_query, 3);
ctx.log("🔍 top files:", hits.map((h) => h.path).join(", "));

const writer = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0.4,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const draft = await writer.invoke(
  "You are a friendly open-source maintainer's assistant. Write a 2–3 sentence reply to a GitHub issue.\\n" +
  "Rules: thank them, name the most likely culprit file with a backtick path, say a maintainer will look. Do NOT promise a fix or a timeline.\\n\\n" +
  "Issue title: " + ctx.state.issue.title + "\\n" +
  "Likely files:\\n" + hits.map((h) => "- " + h.path + " — " + h.snippet).join("\\n")
);

ctx.state.draft = draft.content;
return {
  labels_to_apply: ctx.state.triage.labels,
  likely_files: hits.map((h) => h.path),
  draft_comment: draft.content,
};
`,
      sampleOutput: {
        logs: ["🔍 top files: src/auth/session.ts, src/api/auth/login.ts, src/auth/login.tsx"],
        result: {
          labels_to_apply: ["bug", "auth", "safari", "mobile"],
          likely_files: ["src/auth/session.ts", "src/api/auth/login.ts", "src/auth/login.tsx"],
          draft_comment: "Thanks for the careful report, @octocat — the symptom you're describing usually points at the session-cookie handling in `src/auth/session.ts`, which has known caveats on iOS Safari 17. A maintainer will take a look shortly and follow up here.",
        },
      },
    },

    // ── Step 5: Wire to GitHub ────────────────────────────────────────────
    {
      id: "md-wire",
      kind: "markdown",
      source: `## Step 5 — What it looks like wired to a real webhook

The cell above is the entire decision layer. To ship it for real you'd add ~30 lines of glue:

\`\`\`ts
app.post("/webhooks/github", verifyHmac, async (req) => {
  if (req.body.action !== "opened") return res.sendStatus(204);
  const issue = req.body.issue;
  const triage = await classify(issue);
  const hits   = await searchCodebase(triage.search_query);
  const draft  = await draftReply(issue, hits);

  await octokit.issues.addLabels({ owner, repo, issue_number: issue.number, labels: triage.labels });
  await octokit.issues.createComment({ owner, repo, issue_number: issue.number, body: draft });
});
\`\`\`

The interesting parts — classification, retrieval, response — are already done. Everything else is plumbing.`,
    },
  ],
};
