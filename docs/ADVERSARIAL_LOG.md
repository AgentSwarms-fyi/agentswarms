# Adversarial pass — running log

A module-by-module hunt for the failures that do not announce themselves: a
number that is wrong rather than missing, a badge that outlives what it vouched
for, a message that names a cause it cannot support, an empty state that claims
there is nothing when the truth is that nothing could be read.

Each pass drives the real UI against the real database and **checks what the
screen says against what the data says**. A page that renders without an error
has not been tested; it has been visited.

## Method

1. Load the page in the browser, capture console and network.
2. Enumerate every control: tab, filter, toggle, menu, dialog, empty state.
3. For every displayed figure, compute the same figure independently from the
   database and compare. A match is the evidence; a plausible-looking number is
   not.
4. Push each control to its edges: zero rows, one row, a range with no data,
   a deleted referent, a value that is null for a legitimate reason.
5. Log what is found, fix it with a regression test, mutation-verify the test.

## Severity

- **S1** — states something false, or lets a wrong number reach a decision.
- **S2** — hides something true (silent failure, swallowed error, misleading empty).
- **S3** — correct but confusing, or a control that does nothing.
- **S4** — cosmetic.

## Coverage map

| #   | Module              | Route                      | Pass | Date       | Findings             |
| --- | ------------------- | -------------------------- | ---- | ---------- | -------------------- |
| 1   | Dashboard           | `/dashboard`               | ✅ 1 | 2026-08-16 | 5 (2×S1, 1×S2, 2×S3) |
| 2   | Documentation       | `/docs`                    | —    | —          | —                    |
| 3   | Agent Builder       | `/agents`                  | —    | —          | —                    |
| 4   | Knowledge Base      | `/knowledge`               | —    | —          | —                    |
| 5   | Agent Chat          | `/playground`              | —    | —          | —                    |
| 6   | Agent Swarms        | `/swarms`                  | —    | —          | —                    |
| 7   | MCP Builder         | `/mcp-builder`             | —    | —          | —                    |
| 8   | AI Analyst          | `/ai-analyst`              | —    | —          | —                    |
| 9   | Data Catalog        | `/data-sql`                | —    | —          | —                    |
| 10  | Semantic Layer      | `/semantics`               | —    | —          | —                    |
| 11  | Metrics             | `/metrics`                 | —    | —          | —                    |
| 12  | BI Workspace        | `/bi`                      | —    | —          | —                    |
| 13  | Developer workspace | `/notebooks`               | —    | —          | —                    |
| 14  | Prompt Library      | `/prompts`                 | —    | —          | —                    |
| 15  | Skill Library       | `/skills`                  | —    | —          | —                    |
| 16  | Integrations        | `/integrations`            | —    | —          | —                    |
| 17  | Web Embedding       | `/embeds`                  | —    | —          | —                    |
| 18  | Secrets             | `/secrets`                 | —    | —          | —                    |
| 19  | MCP Servers         | `/mcp`                     | —    | —          | —                    |
| 20  | Model Registry      | `/model-registry`          | —    | —          | —                    |
| 21  | Analytics           | `/analytics`               | —    | —          | —                    |
| 22  | Swarm Traces        | `/analytics/observability` | —    | —          | —                    |
| 23  | Traces & Logs       | `/traces`                  | —    | —          | —                    |
| 24  | Audit Log           | `/audit`                   | —    | —          | —                    |
| 25  | Budgets             | `/budgets`                 | —    | —          | —                    |
| 26  | Monitoring          | `/monitoring`              | —    | —          | —                    |
| 27  | Prompt Compare      | `/prompt-compare`          | —    | —          | —                    |
| 28  | Evaluations         | `/evaluations`             | —    | —          | —                    |
| 29  | Image Playground    | `/image-playground`        | —    | —          | —                    |
| 30  | IAM                 | `/admin/iam`               | —    | —          | —                    |
| 31  | Developer runtime   | `/admin/runtime`           | —    | —          | —                    |

## Findings

<!-- newest first -->

### 2026-08-16 — Module 1, Dashboard (`/dashboard`)

Five findings, all of the "renders fine, says something false" kind. Nothing on
this page threw, logged, or looked broken.

#### D1 · S1 · "Activity — last 24h" reported 51 hours

The card fetched the newest 200 traces and filtered only the RUN COUNT to 24
hours. Success rate, average latency and spend were computed over the whole
page. On this account those 200 rows spanned **51.3 hours**, so the card read:

| Figure       | Card said | True for 24h | Error     |
| ------------ | --------- | ------------ | --------- |
| Success rate | 96%       | 98%          | −2pt      |
| Avg latency  | 19.4s     | 12.2s        | +59%      |
| Spend        | $1.31     | $0.56        | **+134%** |

Fixed in `src/lib/dashboardActivity.ts` — the window is applied first and every
figure derives from it. Verified live afterwards against the server-side
aggregate (`/dashboard` Spend panel set to "Last 24 hours"): both paths now
report 59 runs, 98%, $0.54 from independent code.

`src/lib/budgetSpendClient.ts` already documented this failure mode. The fix
landed on month-to-date spend and never reached this card — worth remembering
that naming a bug class in one file does not retire it elsewhere.

#### D2 · S1 (latent) · The run count silently capped at 200

`runs24h` filtered an already-capped fetch, so above 200 calls in a day it
reported a prefix as the total with no disclosure. Today's 61 runs made it
correct by luck. Now `activityWindow` PROVES coverage — the window is complete
only when the fetch ran past its far edge — and the card renders "≥N runs" plus
an explicit notice when it cannot see the whole window.

#### D3 · S2 · "Where your tokens went" plotted run counts

Not merely a wrong label: ranking by runs put `google/gemini-3-flash-preview`
4th with 6 runs, where by tokens 4th belongs to `~anthropic/claude-haiku-latest`
with 11,873 — a different model. The leader's margin changed too, 2.3x by runs
versus 1.09x by tokens. Now ranks by tokens, prints the token count, and says
how many models the top-4 cut left out.

#### D4 · S3 · The hourly bars read backwards across midnight

Bucketing by `getHours()` into a fixed 0..23 array puts today's 00:00 on the
left and yesterday's 23:00 on the right. Now bucketed by hours-ago, so the axis
is chronological, and each bar's tooltip names the hour it actually covers.

#### D5 · S3 · "BY MODEL" showed 6 of 22 without saying so

Ranked by cost, so the six shown covered 95% of spend but only **37% of runs** —
`openai/gpt-4o-mini`, the busiest model on the account at 1,256 of 2,576 runs,
was absent from a panel headed "BY MODEL". Now discloses:
"top 6 by cost · 16 more models not shown (1,631 runs, $0.3612)".

#### Verified correct, left alone

Hero tiles (7/15/17/3/17) match the database exactly. The Spend panel's totals
($7.65, 2,576 runs, 3,601,015 tokens, 94%) match a paged recount exactly — the
server-side aggregation holds. The budget badge's 119% is arithmetically right
($5.94 month-to-date against a $5 cap); the overage is real and follows today's
repricing of 116 previously-unpriced calls, not a counting error.

A `TeamSpend` null-`.slice` crash and two failed requests in the console turned
out to be a stale buffer from earlier navigation in a long-lived tab; that crash
was fixed earlier today and all five of this page's queries return 200.

**Tests:** 26 in `tests/unit/dashboardActivity.test.ts`, mutation-verified —
five reversions applied one at a time, each killed (5/2/2/4/2 failures), restore
confirmed on disk after every run.
