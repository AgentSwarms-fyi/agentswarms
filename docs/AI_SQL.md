# AI in SQL

Seven scalar functions you can call in any lakehouse statement, answered by a
model: classify a value, pull fields out of free text, judge sentiment,
summarize, translate, filter rows by a condition a formula cannot express,
or ask anything. They work where a `lower()` works — a SELECT list, a WHERE,
a CREATE TABLE AS — and every call goes through the platform's own model
channel, so the model rules in IAM, the budget, the trace and the cost
accounting apply per call. Find them under **Data & BI → Lakehouse → Query**,
behind the **AI functions** button beside the editor.

## The functions

| Function                                     | Returns                                      | What it does                                                         |
| -------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `ai_complete(prompt [, model])`              | VARCHAR                                      | The model's answer to the prompt.                                    |
| `ai_classify(text, labels [, model])`        | VARCHAR — one of the labels, or NULL         | Picks the label that fits best. Labels are comma-separated.          |
| `ai_extract(text, fields [, model])`         | VARCHAR — a JSON object with the fields      | Pulls named fields out of free text; a field the text lacks is null. |
| `ai_sentiment(text [, model])`               | VARCHAR — positive, negative, neutral, mixed | The overall sentiment.                                               |
| `ai_summarize(text [, max_words] [, model])` | VARCHAR                                      | A summary of at most `max_words` words (default 40).                 |
| `ai_translate(text, language [, model])`     | VARCHAR                                      | The text in the language named.                                      |
| `ai_filter(text, condition [, model])`       | BOOLEAN                                      | Whether the text satisfies the condition — for WHERE clauses.        |

The model is always the optional last argument, written `provider/model`
(`openrouter/openai/gpt-4o-mini`, `openai/gpt-4o`); leave it out
and the instance default applies. Arguments may be any type — a number, a
date, a decimal reads as its natural text. A NULL in any argument gives NULL
without a call, the way every scalar function behaves.

```sql
-- Group free-text regions into three zones
SELECT region, ai_classify(region, 'americas, emea, apac') AS zone, count(*)
FROM analytics.revenue_facts
GROUP BY 1, 2;

-- Split a name column into fields
SELECT ai_extract(customer_name, 'first_name, last_name')->>'last_name' AS last_name
FROM analytics.revenue_facts LIMIT 20;

-- Keep only the rows a model judges to be companies
SELECT customer_name FROM analytics.revenue_facts
WHERE ai_filter(customer_name, 'looks like a company, not a person') LIMIT 10;

-- Enrich a table once, then query the enrichment forever
CREATE TABLE analytics.revenue_facts_zoned AS
SELECT *, ai_classify(region, 'americas, emea, apac') AS zone FROM analytics.revenue_facts;
```

Typed cells are the point: `ai_classify` returns a label verbatim or NULL,
never a sentence; `ai_sentiment` is one of four words; `ai_extract` is a JSON
object with exactly the fields you named; `ai_filter` is true or false. An
answer that does not fit the contract becomes NULL — visible and countable,
where a stray sentence would poison a GROUP BY.

## How a statement runs

A DuckDB scalar function is synchronous and a model call is not, so the
engine runs the statement in passes. The first pass evaluates every `ai_*`
call against the session's answers; a call it cannot answer returns NULL and
is written down. The misses are then answered — the durable cache first,
then the model, several calls in flight at once — and the statement runs
again, now answered. Two passes cover any statement whose AI calls do not
feed each other; a nested `ai_summarize(ai_translate(...))` takes one more.

Answers are cached **per user and per model** for the cache's lifetime (30
days by default), so the same call costs once: re-running a query, or a
dashboard built on it, is free, and a user never reads an answer they could
not have asked for themselves. Distinct inputs are what cost — a column with
five distinct values on a million rows is five calls.

The result line under the editor shows what a statement cost: `12 AI calls ·
40 cached`, with the models and the reported cost in the tooltip.

## In Data Prep

The same functions are a step in **Data & BI → BI Workspace → Data
preparation**: add an
**AI column**, pick what the model does, the column it reads (or, for a free
prompt, write the prompt with `{column}` placeholders), name the output and
optionally the model. The step compiles to the matching `ai_*` call, so it
runs wherever the flow runs on a DuckDB engine — the lakehouse, or the local
engine for uploaded datasets — with the same cache, cap and governance. A
warehouse flow cannot push an AI column down to the warehouse; the flow runs
that step locally and the pushdown panel says so. Incremental refresh keeps
working, since the step keeps one output row per input row.

## Cost, limits and governance

- **Per-statement cap.** A statement may make at most **AI calls per
  statement** model calls (200 by default, under **Admin → Developer
  runtime → AI in SQL**, or `AI_SQL_MAX_CALLS_PER_STATEMENT`). A statement
  that would exceed it fails before any call is made, and the message says
  how many it needed; narrow the rows, or raise the limit.
- **Default model** and **answer cache (days)** live beside it
  (`AI_SQL_DEFAULT_MODEL`, `AI_SQL_CACHE_TTL_DAYS`). None of them is capped
  by the application.
- **IAM.** A model the caller's role may not use is refused per call
  (`model_not_allowed`), exactly as in Agent Chat; the statement fails with
  the model named.
- **Budget.** Every call is a chat turn on the internal channel, so a
  budget that would be exceeded refuses it (402) and the statement fails
  with the budget's message.
- **Audit and traces.** Each model call leaves an execution trace under the
  agent name **AI SQL**, with tokens and cost; each statement that made or
  reused calls leaves one `lakehouse.ai_functions` audit event with the
  functions, models, calls, cached answers and cost. The lakehouse read
  itself is audited as every read is.
- **The SQL drafter** (Draft SQL, the AI Analyst) knows the functions and
  reaches for them only when a question needs a judgement a formula cannot
  make, and adds a LIMIT unless you asked for every row.

## Troubleshooting

| You see                                                   | What it means                                                                                                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This statement needs N AI calls; the limit is M"         | More distinct inputs than the cap. Add a WHERE or a LIMIT, or raise the limit under Admin → Developer runtime.                                              |
| "Unknown model "x""                                       | The last argument looked like a model but named no provider. Write `provider/model`, or drop it for the default.                                            |
| "The model … is not allowed for your role"                | An IAM model rule excludes it. Pick another model or ask an administrator.                                                                                  |
| `ai_classify` returns NULL for a row                      | The model found no label that fits (it answered NONE) or answered outside the list. Widen the labels.                                                       |
| A column of NULLs on the first try, answers on the second | Only possible if a pass was interrupted; run it again — the answers are cached.                                                                             |
| "did not answer within 90 s"                              | One model call timed out. The statement fails; cached answers so far are kept.                                                                              |
| More AI calls than rows came back                         | The engine evaluated the function for rows a later ORDER BY or LIMIT then discarded. Limit first, in a subquery, and call the function in the outer SELECT. |

See also [Lakehouse](./LAKEHOUSE.md), [AI gateway](./AI_GATEWAY.md) and
[Scale and limits](./SCALE_AND_LIMITS.md).
