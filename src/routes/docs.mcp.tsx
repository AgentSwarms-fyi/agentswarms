import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/mcp")({
  head: () => ({
    meta: [
      { title: "MCP servers — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Connect Model Context Protocol servers so agents can call tools owned by other systems, with per-agent allow-lists.",
      },
      { property: "og:title", content: "MCP servers — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Give agents tools that live in other systems.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/mcp" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/mcp" }],
  }),
  component: McpPage,
});

function McpPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Integrate & ship"
        title="MCP servers"
        description="The Model Context Protocol is a standard way for a system to expose its tools to any agent. Connect one and its tools become available to yours."
      />

      <P>
        Open <strong>Configure → MCP Servers</strong>. Once a server is connected and allow-listed
        on an agent, the agent can discover its tools and call them.
      </P>

      <Callout kind="why">
        Before MCP, every integration was bespoke: someone wrote a wrapper per system, per platform.
        MCP inverts it — the system that owns a capability describes its own tools once, and any
        MCP-speaking agent can use them. The practical benefit is that the team owning the ticketing
        system owns its tool definitions, instead of you guessing at their API.
      </Callout>

      <H2 id="connect">Connecting a server</H2>
      <Steps
        items={[
          {
            title: "Add the endpoint",
            body: (
              <>
                An HTTP(S) URL speaking Streamable HTTP MCP. It must be reachable from wherever the
                app runs — a server on a private network won't be reachable from a hosted instance.
              </>
            ),
          },
          {
            title: "Set authentication",
            body: (
              <>
                Bearer token or none. Tokens are encrypted at rest; store them in{" "}
                <DocLink to="/docs/secrets">Secrets</DocLink> and reference them so rotation is one
                edit.
              </>
            ),
          },
          {
            title: "Test the connection",
            body: "The page lists the tools the server advertises. An empty list means it connected but exposes nothing — usually an auth scope problem.",
          },
          {
            title: "Allow-list it on an agent",
            body: (
              <>
                In the Agent Builder, enable <C>mcp_call_tool</C> and choose which servers this
                agent may reach. An agent with no allow-list entry cannot call any server.
              </>
            ),
          },
        ]}
      />

      <H2 id="how-agents-use">How an agent uses it</H2>
      <P>Three tools, used in sequence:</P>
      <FieldList
        items={[
          { name: "list_mcp_servers", body: "Which servers this agent may reach." },
          { name: "mcp_list_tools", body: "What one server offers, with argument schemas." },
          { name: "mcp_call_tool", body: "Invoke a named tool on a named server with arguments." },
        ]}
      />
      <P>
        Discovery calls are not treated as sources — only <C>mcp_call_tool</C> contributes to the{" "}
        <strong>Sources</strong> shown under an answer, where it appears as the remote tool name and
        the server it came from.
      </P>

      <H2 id="security">Security</H2>
      <UL>
        <li>
          <strong>Allow-lists are per agent.</strong> Connecting a server workspace-wide does not
          expose it to every agent; each one must be granted it explicitly.
        </li>
        <li>
          <strong>Outbound requests are guarded.</strong> Endpoints resolving to private or
          link-local addresses — including cloud metadata services — are refused, so a malicious or
          mistyped endpoint can't be used to reach inside your network.
        </li>
        <li>
          <strong>Tokens are encrypted at rest</strong> and never returned to the browser after
          saving.
        </li>
        <li>
          <strong>Calls are traced.</strong> Every invocation appears in the run trace with its
          arguments and result.
        </li>
      </UL>
      <Callout kind="warn" title="A remote tool can act">
        Unlike retrieval, an MCP tool may change something — file a ticket, send a message, update a
        record. An agent deciding to call it is a model decision. For anything consequential, put a
        human approval node in front of it in a <DocLink to="/docs/swarms">swarm</DocLink> rather
        than trusting the prompt to hold.
      </Callout>

      <H3 id="troubleshooting">Troubleshooting</H3>
      <FieldList
        items={[
          {
            name: "Connects but lists no tools",
            body: "Authenticated as a principal with no tool scope, or the server exposes tools only after an initialisation step it didn't complete.",
          },
          {
            name: "Agent never calls it",
            body: "Not allow-listed on that agent, or the tool descriptions are too vague for the model to match against the question. Descriptions come from the server — improve them there.",
          },
          {
            name: "Refused endpoint",
            body: "The URL resolves to a private address. Expose it on a reachable host, or run the app where it can see it.",
          },
          {
            name: "Times out",
            body: "Long-running remote tools exceed the call budget. Make the remote tool return quickly and poll, rather than blocking.",
          },
        ]}
      />

      <NextPrev current="/docs/mcp" />
    </>
  );
}
