import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
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

      <H2 id="step-1">1. Talk to something that already works</H2>
      <P>
        Before building anything, run a finished example so you know what "working" looks like. Open{" "}
        <strong>Build → Agent Swarms</strong> and pick a featured swarm —{" "}
        <em>Product Support Assistant</em> is the clearest one. It arrives with a knowledge base,
        tools and an approval gate already wired.
      </P>
      <P>
        Run it and ask a question its knowledge base actually covers. Then ask one it definitely
        doesn't, and watch what it does with a question it can't answer. That contrast is the whole
        subject of this platform.
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
