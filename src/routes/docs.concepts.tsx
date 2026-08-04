import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Diagram,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/concepts")({
  head: () => ({
    meta: [
      { title: "Core concepts — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Agents, tools, retrieval, swarms, guardrails, traces and BYOK — what each term actually means and when to reach for it.",
      },
      { property: "og:title", content: "Core concepts — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The vocabulary of agentic AI, explained in terms of what the machine really does.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/concepts" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/concepts" }],
  }),
  component: ConceptsPage,
});

function ConceptsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Core concepts"
        description="The words this platform uses, and what each one corresponds to mechanically. Worth twenty minutes — most agent problems are really a misunderstanding of one of these."
      />

      <H2 id="model">The model, and what it can't do</H2>
      <P>
        A language model is a function from text to text. It has no memory between calls, no access
        to your files, and no ability to act on the world. Everything else on this platform exists
        to work around one of those three limits.
      </P>
      <P>
        It also has no notion of truth — only of plausibility. A model asked for a total it cannot
        compute will return a number that <em>looks</em> like a total. This is not a bug that better
        prompting fixes; it is what the machine is. The reliable move is to never ask it for facts
        it would have to invent, and instead hand it facts retrieved by something deterministic.
      </P>

      <H2 id="agent">Agent</H2>
      <P>
        An <strong>agent</strong> is a saved configuration: a system prompt, a model, a set of
        permitted tools, optional knowledge and data, memory settings and guardrails. It is not a
        running process. Each time you chat with it, the platform assembles those pieces into a
        request.
      </P>
      <Diagram caption="What one agent turn actually is.">{`your message
      │
      ▼
┌──────────────────────────────────────────┐
│ system prompt + retrieved context        │
│ + conversation history + tool definitions│
└──────────────────────────────────────────┘
      │
      ▼  model decides: answer, or call a tool
      │
      ├─ tool call ──▶ platform runs it ──▶ result appended ──┐
      │                                                        │
      │◀───────────────────────────────────────────────────────┘
      ▼  (loop until the model stops asking for tools)
   final answer + sources`}</Diagram>
      <P>
        The loop is the important part. The model doesn't "use" a tool; it emits a request to use
        one, the platform executes it, and the result is fed back as more text. An agent that seems
        to ignore its tools is usually one whose prompt or tool descriptions didn't make the choice
        obvious.
      </P>

      <H2 id="tools">Tools</H2>
      <P>
        A <strong>tool</strong> is a function the model may ask for by name, with a description and
        a typed argument schema. The description is not documentation — it is the entire basis on
        which the model decides whether to call it. Tools available here:
      </P>
      <Table
        headers={["Tool", "What it does", "Reach for it when"]}
        rows={[
          [
            <C key="a">kb_search</C>,
            "Semantic search over your knowledge base",
            "The answer is written down in prose somewhere",
          ],
          [
            <C key="b">sql_query</C>,
            "Read-only SQL over connected tables",
            "The answer requires counting, filtering or aggregating",
          ],
          [
            <C key="c">metric_query</C>,
            "Governed metrics from the semantic layer",
            "The number has an agreed definition you must not re-derive",
          ],
          [
            <C key="d">web_search</C>,
            "Live search via Firecrawl, Brave, Tavily or SerpAPI",
            "The answer is outside your data and changes over time",
          ],
          [
            <C key="e">web_browse</C>,
            "Fetch and read one page",
            "You have a specific URL worth reading in full",
          ],
          [
            <C key="f">mcp_call_tool</C>,
            "Call a tool on a connected MCP server",
            "Another system owns the capability",
          ],
          [
            <C key="g">calculator</C>,
            "Arithmetic",
            "Any arithmetic at all — never let the model do it in its head",
          ],
        ]}
      />
      <Callout kind="why">
        Tool choice degrades as you add tools. With three tools the model picks well; with ten it
        starts pattern-matching on surface wording and reaching for whichever description sounds
        richest. The platform mitigates this by injecting explicit routing rules into the prompt,
        but the real fix is giving each agent a narrow job and only the tools for it.
      </Callout>

      <H2 id="retrieval">Retrieval, or "RAG"</H2>
      <P>
        Retrieval-augmented generation means: before asking the model anything, go and find the
        relevant text, paste it into the prompt, and instruct the model to answer only from it.
      </P>
      <P>Mechanically, on this platform:</P>
      <UL>
        <li>
          Your document is split into <strong>chunks</strong> of a few hundred words.
        </li>
        <li>
          Each chunk is turned into an <strong>embedding</strong> — a list of numbers positioning it
          in meaning-space, so "refund window" lands near "return period" without sharing a word.
        </li>
        <li>
          Your question is embedded the same way, and the nearest chunks are pulled back and put in
          the prompt with numbered citations.
        </li>
      </UL>
      <P>
        This is why retrieval fails in two characteristic ways. If the chunk containing the answer
        never got retrieved, the model answers from general knowledge and sounds fine. If your
        question phrases something very differently from the source, the nearest chunks are the
        wrong ones. Both are visible in <DocLink to="/docs/debugging">the trace</DocLink> — check
        what was retrieved before blaming the model.
      </P>
      <Callout kind="info">
        Retrieved documents are <em>candidates</em>, not proof. On this platform a knowledge base
        source is only listed under an answer when the answer actually cites it, or when nothing
        else grounded the answer — so a web-search answer no longer drags unrelated documents along
        behind it.
      </Callout>

      <H2 id="swarm">Swarm</H2>
      <P>
        A <strong>swarm</strong> is a graph of nodes: agents, routers that branch on a condition,
        loops, parallel fan-outs, human approval gates, code functions and tool nodes. Output flows
        along the edges.
      </P>
      <P>Split one agent into several when — and only when — one of these is true:</P>
      <UL>
        <li>
          <strong>The jobs need different tools.</strong> A researcher that browses the web and a
          writer that never should are cleanly separate.
        </li>
        <li>
          <strong>A step must be checked before it continues.</strong> Put an approval node in the
          path.
        </li>
        <li>
          <strong>Work can happen in parallel.</strong> Three independent analyses fan out and join.
        </li>
      </UL>
      <P>
        Otherwise prefer one good agent. Every hop is a place for context to be lost in
        summarisation, and a multi-agent graph is markedly harder to debug than a single prompt. See{" "}
        <DocLink to="/docs/swarms">Swarm Canvas</DocLink>.
      </P>

      <H2 id="memory">Memory</H2>
      <P>Three different things get called memory. They behave differently:</P>
      <Table
        headers={["Kind", "Lifetime", "What it is"]}
        rows={[
          [
            "Context window",
            "One request",
            "The transcript sent with this call. Finite; the oldest turns fall out first.",
          ],
          [
            "Short-term (STM)",
            "One conversation",
            "A rolling summary of earlier turns, so a long chat survives the window.",
          ],
          [
            "Long-term (LTM)",
            "Across conversations",
            "Durable facts the agent chose to remember, recalled by relevance to the current message.",
          ],
        ]}
      />
      <P>
        Long-term memory is opt-in per agent and is stored as ordinary rows you can inspect and
        delete. Chat history has its own retention window — see{" "}
        <DocLink to="/docs/budgets">retention</DocLink>.
      </P>

      <H2 id="guardrails">Guardrails</H2>
      <P>
        Guardrails run <em>outside</em> the model, on the way in and on the way out — which is why
        they hold when a prompt is manipulated into ignoring its instructions. They can block
        topics, require citations, and detect or redact personal data before it reaches a provider.
        See <DocLink to="/docs/guardrails">Guardrails &amp; PII</DocLink>.
      </P>

      <H2 id="byok">BYOK — whose key pays</H2>
      <P>
        <strong>Bring your own key.</strong> You connect your own provider credentials (OpenAI,
        Anthropic, Bedrock, Vertex, Azure, and others) and calls are billed to your account, at your
        rates, under your data agreement with that provider. The operator's shared key is only a
        zero-config fallback so a new workspace works before anything is connected.
      </P>
      <P>
        This is a governance property, not a billing detail: prompts and documents travel to a
        provider you chose and hold the contract with. Which models a user may reach is controlled
        separately in <DocLink to="/docs/iam">access control</DocLink>.
      </P>

      <H2 id="traces">Traces</H2>
      <P>
        Every model and tool call is recorded: the resolved prompt, arguments, results, tokens,
        latency and cost. Traces are the ground truth for what an agent did — an agent's own account
        of its reasoning is generated text and can be wrong. Debugging here means reading the trace
        first and forming a theory second.
      </P>

      <H2 id="choosing">Which one do I actually want?</H2>
      <P>
        The concepts above overlap enough that the common question is not "what is retrieval" but
        "is this a retrieval problem or a data problem". This is the mapping that resolves most of
        them:
      </P>
      <Table
        headers={["What you want", "Reach for", "Not"]}
        rows={[
          [
            "Answers quoted faithfully from documents",
            <>
              A{" "}
              <DocLink key="a" to="/docs/knowledge">
                knowledge base
              </DocLink>
            </>,
            "A long system prompt containing the documents — it costs the same tokens every turn and still cannot cite",
          ],
          [
            "A number that has to be arithmetically right",
            <>
              A table and <C key="b">sql_query</C> —{" "}
              <DocLink key="c" to="/docs/data">
                Data Catalog
              </DocLink>
            </>,
            "Retrieval. A model reading a figure out of prose is guessing, confidently",
          ],
          [
            "A definition everyone must compute the same way",
            <>
              A{" "}
              <DocLink key="d" to="/docs/semantics">
                semantic metric
              </DocLink>
            </>,
            "Repeating the SQL in each dashboard, where the four copies drift",
          ],
          [
            "A reusable transformation of your own data",
            <>
              A{" "}
              <DocLink key="e" to="/docs/data-prep">
                prepared table
              </DocLink>
            </>,
            "A calculated field in each chart that needs it",
          ],
          [
            "Steps that must happen in a fixed order, with a human check",
            <>
              A{" "}
              <DocLink key="f" to="/docs/swarms">
                swarm
              </DocLink>{" "}
              with an approval node
            </>,
            "One agent and a prompt telling it to ask first — a prompt is guidance, a gate is a gate",
          ],
          [
            "The agent to remember something between conversations",
            <>
              Long-term{" "}
              <DocLink key="g" to="/docs/agents">
                memory
              </DocLink>
              , opt-in per agent
            </>,
            "A larger context window, which forgets everything the moment the conversation ends",
          ],
          [
            "Something it must never say or leak",
            <>
              A{" "}
              <DocLink key="h" to="/docs/guardrails">
                guardrail
              </DocLink>
              , which runs outside the model
            </>,
            "An instruction in the system prompt, which is exactly what a manipulated prompt talks it out of",
          ],
          [
            "To stop one team spending the whole budget",
            <>
              A{" "}
              <DocLink key="i" to="/docs/budgets">
                cap
              </DocLink>{" "}
              on the group or credential
            </>,
            "Watching the analytics page and intervening — by then it is spent",
          ],
        ]}
      />
      <Callout kind="why">
        Nearly every "the model isn't good enough" report is one of these choices made the other
        way. A bigger model does not make prose arithmetically correct, does not make a prompt into
        an enforced gate, and does not remember anything after the conversation ends.
      </Callout>

      <H3 id="glossary">Quick glossary</H3>
      <Table
        headers={["Term", "Meaning"]}
        rows={[
          ["Token", "A chunk of text (~¾ of a word) — the unit models are billed and limited in."],
          [
            "Temperature",
            "Randomness. Low for extraction and classification, higher for drafting.",
          ],
          ["System prompt", "Standing instructions prepended to every turn."],
          ["Embedding", "A numeric position in meaning-space, used to find related text."],
          ["Chunk", "One retrievable slice of a document."],
          ["Context window", "The maximum text a model can consider at once."],
          ["MCP", "Model Context Protocol — a standard way to expose tools to any agent."],
          [
            "Idempotency key",
            "A client-supplied id that makes a retried API run execute only once.",
          ],
        ]}
      />

      <NextPrev current="/docs/concepts" />
    </>
  );
}
