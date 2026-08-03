import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/quickstart")({
  head: () => ({
    meta: [
      { title: "Quickstart — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Build your first agent, give it data and tools, run it, and read the trace — a guided first thirty minutes on AgentSwarms.",
      },
      { property: "og:title", content: "Quickstart — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Your first agent, its data, its tools, and how to read what it did.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/quickstart" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/quickstart" }],
  }),
  component: QuickstartPage,
});

function QuickstartPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Quickstart"
        description="Thirty minutes, five steps. At the end you'll have an agent that answers from your own documents and data, and you'll know how to check whether its answer was honest."
      />

      <P>
        Do this with the app open in a second tab. Every step points at a real screen, and the
        fastest way to learn the platform is to click through it once end to end rather than read
        about it.
      </P>

      <H2 id="step-0">Before you start: one model provider</H2>
      <P>
        Nothing below runs without a model to run it on, and a fresh instance ships with none
        configured. Pick whichever applies to you:
      </P>
      <Table
        headers={["If you are", "Do this", "Where"]}
        rows={[
          [
            "Self-hosting",
            <>
              Set <C key="a">OPENROUTER_API_KEY</C> in your environment file and restart. One key
              reaches most models, which is why it is the quickest start.
            </>,
            <DocLink key="b" to="/docs/self-hosting">
              Install &amp; deploy
            </DocLink>,
          ],
          [
            "Using an instance someone else runs",
            "Connect your own provider credentials, or use the operator's shared key if they left one configured.",
            <>
              <strong key="c">Integrations</strong> —{" "}
              <DocLink key="d" to="/docs/models">
                Models &amp; providers
              </DocLink>
            </>,
          ],
        ]}
      />
      <Callout kind="info" title="How to tell it worked">
        Open <strong>Build → Agent Chat</strong> and look at the model picker. If it lists models,
        you are ready. If it is empty or every send returns a provider error, the key is missing or
        wrong — fix that first, because every symptom below will otherwise look like something else.
      </Callout>

      <H2 id="step-1">1. Talk to something that already works</H2>
      <P>
        Before building anything, run a finished example so you know what "working" looks like. Open{" "}
        <strong>Build → Agent Swarms</strong> and start from the <strong>Support Copilot</strong>{" "}
        template. It is the clearest one to learn from because it contains, already wired, most of
        what the rest of these docs describe:
      </P>
      <UL>
        <li>
          a <strong>router</strong> that classifies each request and sends it down one of three
          paths,
        </li>
        <li>
          <strong>knowledge-base retrieval</strong> with reranking and a citation check,
        </li>
        <li>
          an <strong>LLM judge</strong> that scores the draft answer for faithfulness,
        </li>
        <li>
          and a <strong>human approval</strong> gate that anything low-confidence or sensitive stops
          at.
        </li>
      </UL>
      <P>
        It needs no setup: its retrieval node points at <em>Sample · Notebook RAG Lab</em>, a
        read-only knowledge base bundled with the platform and readable by every user. So the
        template answers real questions on a brand-new instance.
      </P>
      <P>Run it with the question it ships with, which that sample base genuinely covers:</P>
      <Code lang="text">{`How does retrieval-augmented generation reduce hallucinations,
and when should I use it instead of fine-tuning?`}</Code>
      <P>
        Then ask something the sample base plainly does not contain —{" "}
        <em>"what is our refund window?"</em> — and watch what it does with a question it cannot
        answer. That contrast is the whole subject of this platform: the first answer should carry
        citations, and the second should be a refusal rather than an invention.
      </P>

      <H2 id="step-2">2. Give the platform something to work with</H2>
      <P>
        An agent with no data is a chatbot. Two places give it substance, and they are not
        interchangeable:
      </P>
      <UL>
        <li>
          <strong>
            <DocLink to="/docs/knowledge">Knowledge Base</DocLink>
          </strong>{" "}
          — prose. Contracts, policies, manuals, scraped pages. Retrieved by meaning, quoted back
          with citations. Use it for questions like <em>"what is our refund window?"</em>
        </li>
        <li>
          <strong>
            <DocLink to="/docs/data">Data Catalog</DocLink>
          </strong>{" "}
          — rows and columns. CSVs, spreadsheets, warehouse tables. Queried with SQL and counted
          exactly. Use it for <em>"how many refunds did we issue in March?"</em>
        </li>
      </UL>
      <Callout kind="why">
        A language model cannot count reliably. Ask it to total a column from a document and it will
        produce a confident, wrong number. Anything that must be <em>arithmetically</em> correct
        belongs in a table where SQL does the counting; anything that must be{" "}
        <em>faithfully quoted</em> belongs in the knowledge base. Choosing the wrong one is the most
        common cause of a plausible-but-false answer.
      </Callout>
      <P>Upload one small file to each. A ten-row CSV and a two-page PDF are enough to learn on.</P>
      <P>
        If you have nothing to hand, save this as <C>refunds.csv</C> and upload it under{" "}
        <strong>Data → Data Catalog</strong>. It is deliberately small enough to check the agent's
        arithmetic by eye:
      </P>
      <Code lang="csv">{`order_id,customer,region,refund_usd,refunded_on
1001,Acme,EMEA,120.00,2026-03-02
1002,Globex,AMER,45.50,2026-03-05
1003,Initech,EMEA,310.25,2026-03-11
1004,Umbrella,APAC,80.00,2026-03-14
1005,Acme,EMEA,15.75,2026-03-19
1006,Hooli,AMER,220.00,2026-04-02
1007,Globex,AMER,60.00,2026-04-08`}</Code>
      <Callout kind="info" title="The check that teaches the most">
        March refunds total <strong>571.50</strong> across five rows. Ask the agent for that number
        once the table is attached. A correct answer with the table in its sources means the wiring
        works; a confident number with a <em>document</em> in its sources means it guessed, and you
        have just seen the failure mode this page is about.
      </Callout>

      <H2 id="step-3">3. Build the agent</H2>
      <P>
        Open <strong>Build → Agent Builder</strong> and create one. Fill in these fields and skip
        the rest for now:
      </P>
      <Steps
        items={[
          {
            title: "Name and system prompt",
            body: (
              <>
                Say who the agent is and what it must refuse. Be blunt:{" "}
                <em>
                  "You answer questions about our returns policy using only the provided sources. If
                  the sources don't cover it, say so."
                </em>{" "}
                A vague prompt is the second most common cause of a bad agent.
              </>
            ),
          },
          {
            title: "Model",
            body: (
              <>
                Pick any model your workspace allows. Start with a small, fast one — you are testing
                whether your <em>wiring</em> is right, not whether the model is clever. See{" "}
                <DocLink to="/docs/models">Models &amp; providers</DocLink>.
              </>
            ),
          },
          {
            title: "Knowledge base",
            body: "Attach the collection you just created. The agent can now retrieve from it.",
          },
          {
            title: "Tools",
            body: (
              <>
                Enable <C>sql_query</C> so it can read your table, and <C>web_search</C> if it
                should be allowed to look things up online. Enable only what this agent genuinely
                needs — see the note below.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="Don't switch on every tool">
        Each enabled tool is another option the model has to choose between on every turn. Give an
        agent eight tools and it will sometimes reach for the wrong one — running SQL against a
        table that can't answer the question instead of searching the web. Enable the two or three
        that match the agent's job.
      </Callout>
      <P>
        A system prompt worth starting from. It is blunt about the two things that matter most —
        which source answers which kind of question, and what to do when neither does:
      </P>
      <Code lang="text">{`You answer questions about our returns and refunds using only the
sources available to you.

- For anything about policy or wording, search the knowledge base and
  quote it. Do not paraphrase a policy from memory.
- For anything involving a count, a total or a date range, query the
  refunds table with SQL. Never estimate a number from prose.
- If the sources do not cover the question, say so plainly and stop.
  Do not fill the gap with general knowledge.

Always state which source you used.`}</Code>
      <Callout kind="why">
        The last two rules are doing the real work. A model's default behaviour when retrieval comes
        back empty is to answer anyway from what it absorbed in training — fluently, and with no
        signal that anything is different about this answer. Telling it explicitly to stop is what
        turns silence into a visible refusal you can act on.
      </Callout>

      <H2 id="step-4">4. Run it and read the sources</H2>
      <P>
        Open <strong>Build → Agent Chat</strong>, select your agent, and ask it something real.
      </P>
      <P>
        Under the answer you'll see <strong>Sources</strong>, grouped by where the information came
        from — web links, knowledge base documents, the tables a query read, or an MCP tool. This is
        the fastest honesty check available: if you asked a data question and the sources show a
        document rather than a table, the agent answered from prose it half-remembered instead of
        counting.
      </P>
      <H3 id="generate-a-document">Generate a document</H3>
      <P>
        The <strong>PPT</strong>, <strong>Word</strong> and <strong>Excel</strong> buttons under the
        composer turn a prompt plus your connected data into a real, editable Office file — a
        workbook with live formulas, a deck with native charts. Try{" "}
        <em>"build a one-page summary of the table as a deck"</em>. Details in{" "}
        <DocLink to="/docs/playground">Agent Chat</DocLink>.
      </P>

      <H2 id="step-5">5. Read the trace</H2>
      <P>
        Open <strong>Traces &amp; Logs</strong> and find the run you just made. The trace shows what
        actually happened, not what the agent claims happened: the fully resolved system prompt,
        every tool call with its arguments and result, tokens in and out, latency and cost.
      </P>
      <P>
        When an agent misbehaves, the answer is almost always visible here — a tool that returned an
        error the model then papered over, a retrieval that came back empty, a prompt that didn't
        contain what you assumed it did. Reading traces is the single most useful habit this
        platform teaches. See <DocLink to="/docs/debugging">Logs &amp; traces</DocLink>.
      </P>

      <H2 id="first-run-problems">If the first run doesn't work</H2>
      <P>Four failures account for most of them, and each looks like something else:</P>
      <Table
        headers={["What you see", "Usually", "Fix"]}
        rows={[
          [
            "Every message fails, or the model picker is empty",
            "No provider configured, or a key that was rejected",
            <>
              Step 0 above — check <C key="a">OPENROUTER_API_KEY</C> or your own credentials under{" "}
              <strong key="b">Integrations</strong>
            </>,
          ],
          [
            "It answers, but with no sources",
            "Nothing is attached, or nothing matched",
            "Confirm the collection is attached to THIS agent, and that its documents finished processing",
          ],
          [
            "It answers a data question from a document",
            <>
              <C key="c">sql_query</C> is off, or the table is not attached
            </>,
            "Enable the tool and attach the table; the sources under the answer tell you which happened",
          ],
          [
            "A model you expected is missing",
            "A model rule limits this user or group",
            <>
              <DocLink key="d" to="/docs/iam">
                Access control
              </DocLink>{" "}
              → Access → model rules
            </>,
          ],
        ]}
      />
      <Callout kind="info" title="Read the trace before changing anything">
        It is tempting to start rewriting the prompt. Open the run in{" "}
        <strong>Traces &amp; Logs</strong> first: it shows whether retrieval returned nothing,
        whether a tool errored, and what the prompt actually contained. Most "the prompt is wrong"
        theories die there in about ten seconds.
      </Callout>

      <H2 id="where-next">Where to go next</H2>
      <UL>
        <li>
          Understand the vocabulary properly — <DocLink to="/docs/concepts">Core concepts</DocLink>.
        </li>
        <li>
          Chain several agents together — <DocLink to="/docs/swarms">Swarm Canvas</DocLink>.
        </li>
        <li>
          Put the agent on your own website — <DocLink to="/docs/embedding">Web embedding</DocLink>.
        </li>
        <li>
          Stop it leaking things it shouldn't —{" "}
          <DocLink to="/docs/guardrails">Guardrails &amp; PII</DocLink>.
        </li>
      </UL>

      <NextPrev current="/docs/quickstart" />
    </>
  );
}
