import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  Note,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/playground")({
  head: () => ({
    meta: [
      { title: "Chat Playground — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The AgentSwarms playground: chat with your agents, attach images and documents, watch citations and memory recall, and inspect the trace behind every message.",
      },
      { property: "og:title", content: "Chat Playground — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Chat with your agents, attach files, and inspect the trace behind every message.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/playground" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Chat Playground — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content: "Chat with your agents, attach files, and inspect the trace behind every message.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/playground" }],
  }),
  component: PlaygroundDoc,
});

function PlaygroundDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Run & observe"
        title="Chat Playground"
        description="The playground at /playground is where you talk to agents directly. It looks like a chat app; the difference is that every message produces a trace you can inspect, and the agent runs with its full saved configuration — same tools, same guardrails, same memory as anywhere else on the platform."
      />

      <H2 id="chatting">Chatting with an agent</H2>
      <P>
        Pick an agent from the selector and the conversation runs against its saved configuration:
        provider, model, system prompt, knowledge bases, skills, tools, guardrails, and memory.
        Conversations are persisted, so you can leave and pick a thread back up later.
      </P>
      <UL>
        <li>
          <strong>Attachments</strong> — drop images (sent to vision-capable models as image input)
          or documents (parsed and added to the conversation context) directly into a message.
        </li>
        <li>
          <strong>Citations</strong> — when the agent answers from a knowledge base, the message
          carries the source chunks it used, so grounded answers are visibly grounded.
        </li>
        <li>
          <strong>Memory chip</strong> — when long-term memory is enabled, each reply shows how many
          memory items were recalled (with a preview), so you can see exactly what the agent
          "remembered" rather than guessing.
        </li>
        <li>
          <strong>Fallback override</strong> — if the primary model fails, the playground offers a
          fallback model picker; your choice sticks for the rest of the session and is shown
          explicitly.
        </li>
      </UL>

      <H2 id="traces">The trace behind every message</H2>
      <P>
        Every response carries a trace ID, and the inspector panel opens the full execution record
        for any message: the resolved prompt, tool calls with their arguments and results, tokens,
        cost, and latency. This is the playground's real purpose — the fastest loop from "I changed
        something in my agent" to "I can see exactly what that change did". The same traces are
        queryable later from <DocLink to="/docs/debugging">Logs &amp; traces</DocLink>.
      </P>

      <H2 id="skill-samples">Skill-sample agents</H2>
      <P>
        The first time you open the playground, a small set of sample agents built around{" "}
        <DocLink to="/docs/skills">skills</DocLink> is seeded into your workspace, with a short tour
        overlay that demonstrates how attached skills change an agent's behaviour. They are ordinary
        agents in your library afterwards — edit or delete them freely.
      </P>

      <Note>
        Treat the playground as your default debugging surface: reproduce the problem in a chat,
        open the trace for the bad message, and read what the model actually saw and decided. Most
        "the agent is broken" reports dissolve at that step.
      </Note>

      <H2 id="composer">Composer controls — every button</H2>
      <Table
        headers={["Control", "What it does"]}
        rows={[
          [
            "Attach",
            "Attach images or documents to the turn. Text is extracted and included in the prompt; a summary is saved with the message so the history stays readable.",
          ],
          [
            "Visual BI",
            <>
              Generate charts from your connected tables alongside the text answer. Seeded from the
              agent's <C key="b">tools.biVisuals</C> setting and toggleable per session. Ask for
              more than one — &ldquo;show me 3 charts of sales&rdquo;, &ldquo;a couple of
              visuals&rdquo;, &ldquo;charts for revenue, cost and headcount&rdquo; — and the
              question is split into one analytical question per visual (up to 4). A plain request
              still produces one chart and costs exactly what it did before.
            </>,
          ],
          ["PPT / Word / Excel", "Generate a real, editable Office file from a prompt. See below."],
          [
            "Sample / Full data",
            "How much data is pulled in — applies to Excel generation and the Visual BI row snapshot.",
          ],
          [
            "Model override",
            "Swap the model for this session only. The fastest A/B test on the platform.",
          ],
          ["Stop generating", "Cancels the in-flight turn."],
          ["Regenerate", "Re-runs the last turn."],
          ["Edit & resend", "Rewrite your message and rerun from that point."],
          [
            "Inspector",
            "Live thinking, tool calls, and the full request/response for the last turn.",
          ],
        ]}
      />

      <H2 id="sources">Sources under an answer</H2>
      <P>
        Every answer lists what it actually drew on, grouped by kind — web links, knowledge base
        documents, the tables a query read, an MCP tool, or any other tool. Several kinds appear
        together when the answer genuinely used several.
      </P>
      <Callout kind="why">
        Knowledge base documents are retrieved <em>before</em> the model runs, so their presence
        proves nothing about whether the answer used them. They are listed only when the answer
        cites them by number, or when nothing else grounded it — which is why a web-search answer
        shows links rather than a tail of unrelated documents. Reading this panel is the fastest
        honesty check available: ask a data question and if the sources show a document rather than
        a table, the agent answered from prose it half-remembered instead of counting.
      </Callout>

      <H2 id="docgen">Generating documents</H2>
      <Table
        headers={["Phase", "What is happening"]}
        rows={[
          [
            "gathering",
            "Collecting knowledge excerpts, table schemas and samples, the recent conversation, and — if the prompt points at the internet — live web research.",
          ],
          ["planning", "An LLM produces a typed plan for the document."],
          ["building", "The plan is filled with real numbers and rendered into a file."],
        ]}
      />
      <H3 id="docgen-modes">Browser vs Deep</H3>
      <Table
        headers={["", "Browser · fast", "Deep · slow"]}
        rows={[
          ["Renders", "In your browser", "Server-side, native Office toolchains"],
          ["Deck size", "16–22 slides", "24–30 slides"],
          ["Diagram variety", "≥8 kinds", "All 14 kinds, none more than twice"],
          ["Extras", "—", "Contents page; render-verify pass"],
          [
            "Needs",
            "Nothing",
            <>
              The docgen service running — see{" "}
              <DocLink key="s" to="/docs/self-hosting">
                Install &amp; deploy
              </DocLink>
            </>,
          ],
        ]}
      />
      <Callout kind="warn" title="Deep greys out when it cannot run">
        If the renderer is unreachable, Deep would silently fall back to the browser build and
        produce a file identical to Fast. The composer probes for the service and disables Deep with
        the reason instead, so "Deep did nothing" is visible up front rather than after a
        generation.
      </Callout>
      <P>
        The finished file appears as a preview card with a thumbnail and a Download button, and is
        stored in a private bucket so Download still works after a reload — until the agent's chat
        retention window purges it.
      </P>

      <NextPrev current="/docs/playground" />
    </>
  );
}
