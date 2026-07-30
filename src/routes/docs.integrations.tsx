import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  DocLink,
  DocsHeader,
  H2,
  NextPrev,
  Note,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/integrations")({
  head: () => ({
    meta: [
      { title: "Integrations — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The AgentSwarms Integration Hub: bring-your-own-key model providers, an OpenAI-compatible LLM gateway option, n8n workflows, and MCP servers.",
      },
      { property: "og:title", content: "Integrations — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "BYOK model providers, an LLM gateway option, n8n workflows, and MCP servers.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/integrations" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Integrations — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content: "BYOK model providers, an LLM gateway option, n8n workflows, and MCP servers.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/integrations" }],
  }),
  component: IntegrationsDoc,
});

function IntegrationsDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Platform"
        title="Integrations"
        description="The Integration Hub at /integrations connects AgentSwarms to outside model providers and automation; /mcp connects it to tool servers. Keys are stored server-side and used only by the runtime — they are never sent back to the browser."
      />

      <H2 id="builtin">The default provider first</H2>
      <P>
        If the operator running this instance has configured a shared OpenRouter key, you don't need
        any integration to start — every account can use it with no setup. Connecting your own
        provider key routes calls to your own account/billing instead, and unlocks providers the
        shared key doesn't cover.
      </P>

      <H2 id="providers">LLM providers (bring your own key)</H2>
      <P>
        The <em>LLM Providers</em> tab is a set of key forms, one per provider, each with the fields
        that provider actually needs:
      </P>
      <UL>
        <li>
          <strong>Direct API keys</strong> — OpenAI (with optional org ID), Anthropic (with API
          version), Google Gemini, Grok (xAI), Groq, OpenRouter, NVIDIA, Qwen (DashScope). Most
          accept an optional custom base URL.
        </li>
        <li>
          <strong>Cloud platforms</strong> — AWS Bedrock, Google Vertex AI, Azure OpenAI (endpoint +
          deployment), and OCI Generative AI, with their platform-specific credential fields.
        </li>
        <li>
          <strong>Self-hosted</strong> — custom Ollama endpoints and OpenAI-compatible vLLM servers.
        </li>
      </UL>
      <P>
        Once connected, a provider becomes selectable in the{" "}
        <DocLink to="/docs/agents">Agent Builder</DocLink> and in swarm node inspectors. Some
        providers' models don't support tool calling — the builder warns you when an agent with
        tools is pointed at one.
      </P>

      <H2 id="gateway">LLM Gateway</H2>
      <P>
        The <em>LLM Gateway</em> tab points the platform at your own OpenAI-compatible gateway
        (LiteLLM and similar): base URL, key, and two routing modes. <strong>Per-agent</strong>:
        agents that enable &ldquo;Route through gateway&rdquo; in their tool settings use it, and
        everything else talks to providers directly. <strong>Route all</strong>: every LLM call on
        the account — chat, swarms, BI answers, embeds, skill generation, notebooks, model listings,
        embeddings — goes through the gateway, which is the one-gateway-one-bill enterprise pattern
        for real. Enabling either mode runs a live validation against the gateway first (auth
        failures block activation; a gateway that doesn&apos;t expose <code>/models</code> is
        tolerated).
      </P>

      <H2 id="n8n">n8n workflows</H2>
      <P>
        The <em>n8n Workflows</em> tab connects an n8n instance by webhook URL and token, letting
        agents trigger your automations as a tool. The same pattern extends to the other automation
        platforms configurable per-agent in the Agent Builder (Activepieces, Node-RED, Windmill,
        Temporal, Airflow, Zapier, Make, or a plain webhook).
      </P>

      <H2 id="mcp">MCP servers</H2>
      <P>
        <DocLink to="/mcp">/mcp</DocLink> attaches Model Context Protocol servers to your workspace.
        On connect, the platform probes the server and discovers the tools it exposes; agents can
        then be granted access to specific servers from the Agent Builder's tool section.
      </P>

      <Note>
        Treat every key you connect as spend authorization: pair bring-your-own-key providers with
        the caps at <DocLink to="/docs/account">/budgets</DocLink>, and per-agent limits in the{" "}
        <DocLink to="/docs/agents">guardrails section</DocLink>.
      </Note>

      <H2 id="categories">What can be connected</H2>
      <Table
        headers={["Category", "Connects", "Documented in"]}
        rows={[
          [
            "Model providers",
            "14 providers — OpenAI, Anthropic, Gemini, Vertex, Bedrock, Azure OpenAI, OCI, Grok, Qwen, Groq, NVIDIA, OpenRouter, Ollama, vLLM",
            <DocLink key="a" to="/docs/models">
              Models &amp; providers
            </DocLink>,
          ],
          [
            "Data sources",
            "10 warehouse/database connectors plus object stores and lakehouse catalogs",
            <DocLink key="b" to="/docs/data">
              Data Catalog &amp; SQL
            </DocLink>,
          ],
          [
            "Web search",
            "Firecrawl (built in), Brave, Tavily, SerpAPI; ScrapingBee for page fetching",
            <DocLink key="c" to="/docs/agents">
              Agent Builder → Tools
            </DocLink>,
          ],
          [
            "Automation",
            "n8n workflows, triggered by an agent tool",
            <DocLink key="d" to="/docs/agents">
              Agent Builder → Tools
            </DocLink>,
          ],
          [
            "MCP servers",
            "Any Streamable HTTP MCP endpoint",
            <DocLink key="e" to="/docs/mcp">
              MCP servers
            </DocLink>,
          ],
        ]}
      />

      <H2 id="credentials">Credential handling</H2>
      <UL>
        <li>
          Every secret is <strong>encrypted at rest</strong> and never returned to the browser after
          saving.
        </li>
        <li>
          Prefer a <DocLink to="/docs/secrets">Secrets</DocLink> reference over pasting a value, so
          rotation is one edit rather than a hunt through every connection.
        </li>
        <li>
          <strong>Test connection</strong> stores its result and error on the connection, so you can
          see when something started failing rather than discovering it through a broken dashboard.
        </li>
        <li>
          <strong>Scheduled health checks</strong> re-run the same live tests every 6 hours (set{" "}
          <code>INTEGRATION_HEALTH_HOURS</code> to change, <code>0</code> to disable). A key revoked
          upstream shows as a &ldquo;failing health checks&rdquo; badge, sends an in-app
          notification, and lands in the audit trail — before an agent run trips over it. Health
          results never auto-disable a connection.
        </li>
        <li>
          Connecting, changing, or deleting any credential is recorded in the{" "}
          <DocLink to="/docs/observability">audit trail</DocLink> — names, URLs and whether a secret
          was rotated; never the secret itself.
        </li>
        <li>
          <strong>Disconnect</strong> asks for confirmation and tells you what depends on the
          connection first.
        </li>
      </UL>
      <Callout kind="warn" title="Outbound requests are guarded">
        Connector endpoints resolving to private, loopback or link-local addresses are refused
        unless the deployment explicitly allows them. A database on a private network must be
        reachable from wherever the app runs — see{" "}
        <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink>.
      </Callout>

      <NextPrev current="/docs/integrations" />
    </>
  );
}
