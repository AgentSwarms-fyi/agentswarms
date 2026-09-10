import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";
import { AI_SQL_FUNCTIONS, AI_SQL_FUNCTION_DOCS } from "@/utils/aiSql/core";

export const Route = createFileRoute("/docs/ai-sql")({
  head: () => ({
    meta: [
      { title: "AI in SQL — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "ai_classify, ai_extract, ai_sentiment, ai_summarize, ai_translate, ai_filter and ai_complete as scalar functions in lakehouse SQL: every call through the model channel with IAM, budget, trace and cost, answers cached per user and model, a per-statement call cap.",
      },
      { property: "og:title", content: "AI in SQL — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Classify, extract, judge and summarize inside a SELECT, governed like every other model call.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ai-sql" },
    ],
  }),
  component: Page,
});

function Page() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="AI in SQL"
        description="Seven scalar functions answered by a model, callable wherever a lower() is: classify, extract fields, judge sentiment, summarize, translate, filter by a condition a formula cannot express, or ask anything. Every call is governed like every other model call."
      />

      <H2 id="what">What it is</H2>
      <P>
        A warehouse question often ends in a judgement no expression makes: which of three zones a
        free-text region belongs to, whether a name is a company, what a comment's mood is. The
        functions below answer those inside the statement, so the answer lands in a column, a GROUP
        BY or a WHERE like any other value. Find them under Data & BI → Lakehouse → Query, behind
        the <strong>AI functions</strong> button beside the editor; each entry there puts a runnable
        example in the editor.
      </P>

      <H2 id="functions">The functions</H2>
      <Table
        headers={["Function", "Returns", "What it does"]}
        rows={AI_SQL_FUNCTIONS.map((fn) => [
          <C key="s">{AI_SQL_FUNCTION_DOCS[fn].signature}</C>,
          AI_SQL_FUNCTION_DOCS[fn].returns,
          AI_SQL_FUNCTION_DOCS[fn].description,
        ])}
      />
      <P>
        The model is always the optional last argument, written <C>provider/model</C> (
        <C>openrouter/openai/gpt-4o-mini</C>, <C>openai/gpt-4o</C>); leave it out and the instance
        default applies. Arguments may be any type — a number, a date, a decimal reads as its
        natural text. A NULL in any argument gives NULL without a call, the way every scalar
        function behaves.
      </P>
      <Code>{`-- Group free-text regions into three zones
SELECT region, ai_classify(region, 'americas, emea, apac') AS zone, count(*)
FROM analytics.revenue_facts
GROUP BY 1, 2;

-- Keep only the rows a model judges to be companies
SELECT customer_name FROM analytics.revenue_facts
WHERE ai_filter(customer_name, 'looks like a company, not a person') LIMIT 10;

-- Enrich a table once, then query the enrichment forever
CREATE TABLE analytics.revenue_facts_zoned AS
SELECT *, ai_classify(region, 'americas, emea, apac') AS zone FROM analytics.revenue_facts;`}</Code>
      <Callout kind="info" title="Typed cells are the point">
        <C>ai_classify</C> returns a label verbatim or NULL, never a sentence; <C>ai_sentiment</C>{" "}
        is one of four words; <C>ai_extract</C> is a JSON object with exactly the fields you named;{" "}
        <C>ai_filter</C> is true or false. An answer that does not fit the contract becomes NULL —
        visible and countable, where a stray sentence would poison a GROUP BY.
      </Callout>

      <H2 id="passes">How a statement runs</H2>
      <P>
        A DuckDB scalar function is synchronous and a model call is not, so the engine runs the
        statement in passes. The first pass evaluates every <C>ai_*</C> call against the session's
        answers; a call it cannot answer returns NULL and is written down. The misses are then
        answered — the durable cache first, then the model, several calls in flight at once — and
        the statement runs again, now answered. Two passes cover any statement whose AI calls do not
        feed each other; a nested <C>ai_summarize(ai_translate(...))</C> takes one more.
      </P>
      <P>
        Answers are cached per user and per model for the cache's lifetime (30 days by default), so
        the same call costs once: re-running a query, or a dashboard built on it, is free, and a
        user never reads an answer they could not have asked for themselves. Distinct inputs are
        what cost — a column with five distinct values on a million rows is five calls. The result
        line under the editor shows what a statement cost (<C>12 AI calls · 40 cached</C>), with the
        models and the reported cost in the tooltip.
      </P>

      <H2 id="prep">In Data Prep</H2>
      <P>
        The same functions are a step in Data & BI → BI Workspace → Data preparation: add an{" "}
        <strong>AI column</strong>, pick what the model does, the column it reads (or, for a free
        prompt, write the prompt with <C>{"{column}"}</C> placeholders), name the output and
        optionally the model. The step compiles to the matching <C>ai_*</C> call, so it runs
        wherever the flow runs on a DuckDB engine — the lakehouse, or the local engine for uploaded
        datasets — with the same cache, cap and governance. A warehouse flow cannot push an AI
        column down to the warehouse; the flow runs that step locally and the pushdown panel says
        so. Incremental refresh keeps working, since the step keeps one output row per input row.
        See <DocLink to="/docs/data-prep">Data preparation</DocLink>.
      </P>

      <H2 id="governance">Cost, limits and governance</H2>
      <UL>
        <li>
          <strong>Per-statement cap.</strong> A statement may make at most{" "}
          <em>AI calls per statement</em> model calls (200 by default, under Admin → Developer
          runtime → AI in SQL, or <C>AI_SQL_MAX_CALLS_PER_STATEMENT</C>). A statement that would
          exceed it fails before any call is made, and the message says how many it needed.
        </li>
        <li>
          <strong>Default model</strong> and <strong>answer cache (days)</strong> live beside it (
          <C>AI_SQL_DEFAULT_MODEL</C>, <C>AI_SQL_CACHE_TTL_DAYS</C>). None of them is capped by the
          application.
        </li>
        <li>
          <strong>IAM.</strong> A model the caller's role may not use is refused per call, exactly
          as in Agent Chat; the statement fails with the model named.
        </li>
        <li>
          <strong>Budget.</strong> Every call is a chat turn on the internal channel, so a budget
          that would be exceeded refuses it and the statement fails with the budget's message.
        </li>
        <li>
          <strong>Audit and traces.</strong> Each model call leaves an execution trace under the
          agent name <em>AI SQL</em>, with tokens and cost; each statement that made or reused calls
          leaves one <C>lakehouse.ai_functions</C> audit event with the functions, models, calls,
          cached answers and cost. The lakehouse read itself is audited as every read is.
        </li>
        <li>
          <strong>The SQL drafter</strong> (Draft SQL, the AI Analyst) knows the functions and
          reaches for them only when a question needs a judgement a formula cannot make, adding a
          LIMIT unless you asked for every row.
        </li>
      </UL>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["You see", "What it means"]}
        rows={[
          [
            '"This statement needs N AI calls; the limit is M"',
            "More distinct inputs than the cap. Add a WHERE or a LIMIT, or raise the limit under Admin → Developer runtime.",
          ],
          [
            '"Unknown model …"',
            "The last argument looked like a model but named no provider. Write provider/model, or drop it for the default.",
          ],
          [
            '"The model … is not allowed for your role"',
            "An IAM model rule excludes it. Pick another model or ask an administrator.",
          ],
          [
            "ai_classify returns NULL for a row",
            "The model found no label that fits (it answered NONE) or answered outside the list. Widen the labels.",
          ],
          [
            "More AI calls than rows came back",
            "The engine evaluated the function for rows a later ORDER BY or LIMIT then discarded. Limit first, in a subquery, and call the function in the outer SELECT.",
          ],
          [
            '"did not answer within 90 s"',
            "One model call timed out. The statement fails; cached answers so far are kept.",
          ],
        ]}
      />
      <P>
        See also <DocLink to="/docs/lakehouse">Lakehouse</DocLink> and{" "}
        <DocLink to="/docs/gateway">AI Gateway</DocLink>.
      </P>
      <NextPrev current="/docs/ai-sql" />
    </>
  );
}
