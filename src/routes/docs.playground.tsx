import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

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

      <NextPrev current="/docs/playground" />
    </>
  );
}
