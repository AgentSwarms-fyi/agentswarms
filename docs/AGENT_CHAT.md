# Agent Chat & document generation

> Part of the [AgentSwarms docs](../README.md#documentation).

**Agent Chat** (**Build → Agent Chat**, `/playground`) is where you talk to a
saved agent in the browser. Beyond plain chat it can render a **BI chart** next
to an answer and generate fully-editable **PowerPoint / Word / Excel** files
grounded in your own data.

## Chatting with an agent

1. Pick an agent from the selector (create one first in **Agent Builder**).
2. Type a message. The agent runs with its configured system prompt, tools,
   knowledge base and model.
3. The right-hand **inspector** shows the live thinking, tool calls, and the
   full request/response for the last turn; everything is also recorded in
   **Traces**.

You can override the model per session, edit/regenerate messages, and attach
files. Conversations are saved per agent.

## Sources

Under each answer, AgentSwarms lists **what the answer actually drew on**, grouped
by kind:

| Kind               | Shown as                                                    |
| ------------------ | ----------------------------------------------------------- |
| **Web**            | The page title as a clickable link, with its hostname       |
| **Knowledge base** | Document name and the collection it belongs to              |
| **Data**           | The table(s) the query read, and how many rows came back    |
| **MCP**            | The remote tool that was called, and the server it lives on |
| **Tool**           | The tool's name, for anything else (n8n, a custom skill)    |

Sources come from what the tools **returned**, so a web answer lists links, a
SQL answer lists tables, and an answer that genuinely used several shows several
groups at once.

Knowledge base documents are a special case: they are retrieved _before_ the
model runs, so their presence proves nothing about whether the answer used them.
They are listed when the answer cites them by number (`[1]`), or when nothing
else grounded the answer — never as a tail of unrelated documents under a web
result.

## Visual BI answers

Turn on **Visual BI** to get a chart generated from your connected tables
alongside the text answer — similar to asking a question and getting both a
narrative and a visualization back.

- **Enable it per agent.** In **Agent Builder**, flip the **Visual BI answers**
  switch. The setting is saved on the agent (`tools.biVisuals`), so it also
  applies wherever the agent runs — including website **embeds**.
- **Toggle it for the session.** The **Visual BI** button in the composer bar
  is seeded from the agent's setting and can be flipped on/off for the current
  chat.

When it's on, after each answer the BI analyst (plan → SQL → execute → chart)
runs over your datasets and, if the result charts well, a widget is stored on
the message and rendered inline. It survives reload and appears in embeds. It's
best-effort: if there's no usable data or the result is table-only, no widget
is shown and the text answer is never affected.

### Which datasets it can read — read this before embedding

The widget runs **as the agent's owner**, because an anonymous embed visitor
has no data access of their own. So on a public embed, a stranger's question
decides what SQL runs over your data.

What bounds it:

- **The agent's SQL table allow-list applies.** Set it in **Agent Builder** →
  the `sql_query` tool → tables. The same list that limits the chat tool limits
  the widget: the model is only told those tables exist, and a query naming any
  other is refused. (This was not true before — the widget path ignored the
  list on both counts. See `tests/unit/embedBiAllowList.test.ts`.)
- **Read-only, single statement.** The same guard the workbench and the agent
  tool use (`lib/sqlSafety`), so no writes and no stacked statements.
- **Owner-scoped.** Own datasets, public samples, and IAM-granted tables only;
  a shared dataset keeps its row filter and column mask.

**With no allow-list set, the widget can read every dataset the owner has.**
That is deliberate — the list is opt-in, exactly as it is for the chat tool, so
turning it on cannot silently change what an existing agent can answer. But an
opt-in default is a wide default on a page anyone can load, so **set the
allow-list on any agent you embed publicly with Visual BI enabled.**

## Generating documents (PowerPoint / Word / Excel)

The **PPT**, **Word** and **Excel** buttons under the composer generate a real,
fully-editable Office file from a prompt:

1. Click a format and describe what you want (the prompt box is pre-filled with
   whatever you'd typed).
2. AgentSwarms **gathers context** — relevant knowledge-base excerpts, your
   data-table schemas + samples, and the **recent conversation**. If the prompt
   points at the internet (e.g. _"using prices from the web"_, "latest",
   "market rates"), it also runs **live web research** — a search plus the full
   text of the top results when Firecrawl is connected — and the planner grounds
   the document in those findings instead of forcing everything through your
   tables.
3. An LLM **plans** the document, then it's **built** into a native file and
   shown as a **preview card** in the chat (first-page thumbnail + a **Download**
   button) instead of auto-downloading:
   - **PowerPoint** — titled slides with bullets, tables, native (editable)
     charts and SmartArt-style diagrams.
   - **Word** — a cover page, headings, prose, bullet lists and tables, with
     level-1 sections starting new pages.
   - **Excel** — a real workbook with header rows, typed cells and **live
     formulas** (editable in Excel, not baked-in text).

Nothing is a screenshot or a flat dump — every file opens for editing in its
native app.

### Where generated files live (retention)

The generated file is uploaded to a private **`chat-docs`** storage bucket and
the preview card references it, so **Download still works after you reload** —
until the conversation is purged. How long that is comes from the agent's
**Chat history retention** setting (agent builder → **Memory**), which defaults
to **7 days** and can only be **increased** (7-day floor). A scheduled purge
deletes messages past the window and removes their stored files with them.
Without storage configured, the download works for the current session only.

### Optional server-side renderer

By default all three formats are built **in the browser**, which works on every
deploy. You can also run
the optional **[doc-gen service](../docgen-service/README.md)** (`--docgen`),
which renders server-side with the native Office toolchains — **python-pptx**
(editable charts + a LibreOffice render-verify loop), **python-docx** (cover +
updatable table of contents + fixed-width tables), and **openpyxl** (formulas
recalculated by LibreOffice so values show immediately). The browser fills the
numbers first, then posts the plan to `/api/docgen/{pptx,docx,xlsx}`; if the
service is unreachable it **falls back** to the browser build.

Because that fallback produces a file _identical_ to Browser mode, the composer
probes the service (`GET /api/docgen/status`) and greys out **Deep** with the
reason when it can't be reached — so "Deep did nothing" is visible up front
rather than after a generation.

Deep is not only a different renderer — it commissions a **bigger deck**. Fast
plans 16–22 slides using at least 8 diagram kinds; Deep plans **24–30 slides**
using **all 14** diagram kinds, with a second KPI scorecard, more data slides,
and takeaways that are asked to be a non-obvious reading of the numbers rather
than a restatement of the chart. The server renderer also adds a **Contents**
page when the deck has three or more sections.

There is **nothing to configure**: the app finds the renderer at
`http://docgen:8099` when it runs inside the compose network, or at
`http://localhost:8099` when you run `npm run dev` on the host (the container
publishes 8099 on loopback for that case). Set `DOCGEN_SERVICE_URL` only if the
renderer lives somewhere else; a value that doesn't answer falls back to the
probe, so a stale setting can't quietly turn Deep mode off.

### Sample vs. full data

The **Sample / Full data** selector in the composer bar controls how much data
is pulled in:

- **Sample** (default) — a fast, capped preview; good for a quick draft.
- **Full data** — the complete result set (up to a safety cap).

It applies to **Excel generation** and to the **Visual BI** widget's row
snapshot.

### Full-data Excel with live formulas

For Excel, the planner prefers **data-bound sheets**: instead of writing rows
itself, it emits a read-only `SELECT` over your tables plus optional
**computed columns** and a **totals** row expressed as Excel formula templates.
On build, the query runs in the browser SQL engine and fills the sheet with
**every row** (Sample scope caps it), while the formula templates are resolved
against the real cell ranges — so a computed line total or a `SUM`/`AVERAGE`
total stays a **live, editable formula** in the delivered workbook, correct for
whatever the row count turns out to be.

This is what lets a prompt like _"build a bill of materials from this pricing
sheet"_ produce a multi-sheet workbook with real unit-price calculations and
monthly/annual roll-ups. When no table applies (e.g. a knowledge-base summary)
the planner falls back to literal rows.

### Which model runs it

Document planning and Visual BI use the same **BYOK** model selection as the
rest of the app — the agent's model (or your per-session override), executed
against your connected provider's key, with the operator's shared
`OPENROUTER_API_KEY` only as a zero-config fallback, and filtered by your IAM
model rules.

## Embedding an agent

Agents can be embedded on your own site (see **Integrations → Web Embedding**,
`/embeds`). The **Visual BI answers** setting is inherited by the embed. Because
anonymous embed visitors have **no data access**, the widget is generated
server-side with the agent **owner's** data (scoped to the owner as a tenant
guard) and streamed into the embedded answer.
