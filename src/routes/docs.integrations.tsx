import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

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
        (LiteLLM and similar): base URL, key, and a toggle to route traffic through it. This is the
        enterprise pattern — one gateway, one bill, one place to enforce policy — practiced on a
        learning platform.
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

      <NextPrev current="/docs/integrations" />
    </>
  );
}
