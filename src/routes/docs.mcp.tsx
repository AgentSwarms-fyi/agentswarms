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
  Table,
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

      <H3 id="server-fields">Every field on a server</H3>
      <Table
        headers={["Field", "Values", "Notes"]}
        rows={[
          [
            "Name",
            "text",
            "How the agent refers to it — this exact string goes in server_name on a call, and in the agent allow-list.",
          ],
          [
            <C key="a">endpoint</C>,
            "https URL",
            "Streamable HTTP MCP endpoint. Must be reachable from where the app runs.",
          ],
          [<C key="b">description</C>, "text", "For humans browsing the list."],
          [
            <C key="c">auth_type</C>,
            <>
              <C key="n">none</C> | <C key="t">token</C>
            </>,
            "Bearer token or anonymous.",
          ],
          [
            <C key="d">auth_token</C>,
            "text",
            "Encrypted at rest, never returned to the browser after saving. Prefer a Secrets reference.",
          ],
          [<C key="e">status</C>, "connected / disconnected", "Read-only, set by the last test."],
          [
            <C key="f">tools_count</C>,
            "number",
            "Read-only — how many tools the server advertised. Zero after a successful connect is the signal described below.",
          ],
          [<C key="g">last_ping</C>, "timestamp", "Read-only."],
        ]}
      />
      <Callout kind="warn" title="The server Name is an identifier, not a label">
        An agent allow-lists servers by name, and <C>mcp_call_tool</C> takes <C>server_name</C>.
        Renaming a server after agents reference it breaks those references silently — the agent
        simply finds no server and reports it cannot do the thing.
      </Callout>

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

      <H2 id="build">Building your own MCP server</H2>
      <P>
        Everything above is about connecting to a server somebody else runs.{" "}
        <strong>Build → MCP Builder</strong> is the other direction: you write the server in Python
        with <a href="https://gofastmcp.com">FastMCP</a>, it runs on the same sandboxed kernel the{" "}
        <DocLink to="/docs/notebooks">Developer workspace</DocLink> uses, and it is reachable over
        Streamable HTTP at <C>/api/mcp/s/&lt;slug&gt;</C>.
      </P>

      <Callout kind="why">
        The alternative is standing a service up somewhere else and wiring it back in by URL — which
        means a second deployment, a second set of credentials, and a second place to reason about
        who may call what. Here the source, the sandbox, the keys and the audit trail are one thing.
      </Callout>

      <H3 id="build-contract">What the runner expects</H3>
      <P>
        A module-level FastMCP instance named <C>mcp</C> (<C>server</C> and <C>app</C> also work),
        with <C>@mcp.tool</C> functions. Do <strong>not</strong> call <C>mcp.run()</C> — the
        platform serves the object for you, and calling it yourself deadlocks startup.
      </P>
      <UL>
        <li>
          <strong>Type hints become the input schema</strong> and the docstring becomes the
          description the calling model reads. Both are worth writing carefully — they are how a
          model decides whether your tool is the right one.
        </li>
        <li>
          <strong>Extra packages</strong> go in the Deploy tab, one per line, and are installed at
          container start. <C>httpx</C>, <C>pydantic</C>, <C>pandas</C>, <C>numpy</C>,{" "}
          <C>langchain</C>, <C>llama_index</C> and the <C>agentswarms</C> helper are already there.
        </li>
        <li>
          <strong>Secrets</strong> are bound on the Deploy tab as{" "}
          <C>ENV_NAME={"{{secret:NAME}}"}</C> and read with <C>os.environ</C>. They are resolved
          only when the container starts and arrive over an authenticated call, so they never appear
          in the container environment, the database, or the logs.
        </li>
      </UL>

      <H3 id="build-lifecycle">Cold starts and keep-warm</H3>
      <P>
        By default a server scales to zero: no container exists until the first call, which pays a
        few seconds of start-up, and it stops again after its idle timeout. Turn on{" "}
        <strong>Keep warm</strong> for latency-sensitive servers — it holds a container permanently,
        which is why it is off by default.
      </P>

      <H3 id="build-access">Who can call it</H3>
      <Steps
        items={[
          {
            title: "Your agents (internal)",
            body: "Toggle it on under Access and the server is registered in your connected-servers list. Agents and swarms here can call it through the same mcp_call_tool path as any other server. Nothing is exposed to the internet.",
          },
          {
            title: "Anyone with a key (public)",
            body: "Expose publicly, then mint a key. External MCP clients call /api/mcp/s/<slug> with Authorization: Bearer mcps_… . Keys are stored hashed, can expire, can be limited to specific tools and source addresses, and are revoked rather than deleted so the usage trail survives.",
          },
        ]}
      />
      <P>
        While a server is not exposed publicly, its endpoint answers <C>404</C> to everything except
        your own agents — the same response an unknown slug gets, so probing cannot tell the
        difference.
      </P>

      <H3 id="build-security">How a built server is contained</H3>
      <UL>
        <li>
          <strong>Same sandbox as notebooks.</strong> Non-root, read-only root filesystem, all
          capabilities dropped, no-new-privileges, CPU/memory/PID limits, and no route off the box
          except the filtering egress proxy.
        </li>
        <li>
          <strong>No credential of yours reaches your code.</strong> The caller's Authorization
          header is consumed at the edge and never forwarded, and the sandbox holds only a
          short-lived capability token — never a provider key or your Supabase session.
        </li>
        <li>
          <strong>Sessions are translated.</strong> The <C>Mcp-Session-Id</C> a caller receives is
          ours, bound to the key that opened it; the server's own session id never leaves the
          platform.
        </li>
        <li>
          <strong>Only tool methods are forwarded.</strong> <C>initialize</C>, <C>tools/list</C>,{" "}
          <C>tools/call</C> and <C>ping</C>. Anything else is refused at the edge, so a future
          protocol method cannot become reachable because a dependency was upgraded.
        </li>
        <li>
          <strong>Tool changes need re-approval.</strong> A redeploy that changes any tool name,
          description or schema blocks calls until you review it — see below.
        </li>
      </UL>

      <Callout kind="warn" title="Why a changed tool description blocks calls">
        Tool descriptions are instructions the calling model reads. A server that is trusted and
        then quietly rewrites "look up an order" into something that also forwards the result
        elsewhere is a real attack, not a hypothetical one. So a deploy that moves the tool
        fingerprint parks the server until a human approves the new list.
      </Callout>

      <Callout kind="warn" title="Egress filtering is instance-wide">
        The allow-list that decides which hosts a sandbox may reach is a single shared proxy, so it
        applies to every server and every notebook on the instance — there is no per-server egress
        isolation. If your server needs a host, an administrator adds it under{" "}
        <strong>Admin → Developer runtime</strong>, and every other sandbox gains that host too.
      </Callout>

      <H3 id="build-troubleshooting">When a build won't start</H3>
      <FieldList
        items={[
          {
            name: "Deploy fails immediately",
            body: "Read the Logs tab — it is the container's stdout and stderr, with bound secret values scrubbed. A missing package and a syntax error both surface there.",
          },
          {
            name: "No MCP server found",
            body: "The runner could not find a module-level FastMCP instance. Name it `mcp`, and make sure it is created at import time rather than inside a function.",
          },
          {
            name: "Deploy hangs then times out",
            body: "Usually a call to mcp.run() in your own code. The platform serves the object; your file should only define it.",
          },
          {
            name: "A network call is refused",
            body: "The host is not on the instance egress allow-list. Add it under Admin → Developer runtime — the refusal comes from the proxy, not from the remote server.",
          },
        ]}
      />

      <H3 id="troubleshooting">Troubleshooting a connected server</H3>
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
