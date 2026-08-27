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
  Steps,
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
        eyebrow="Integrate & ship"
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
        The <em>LLM Gateway</em> tab points the platform at your own OpenAI-compatible gateway —
        LiteLLM and similar. You give it a base URL and a key, and choose one of two routing modes.
      </P>
      <Table
        headers={["Mode", "What routes through it", "Use it for"]}
        rows={[
          [
            <strong key="a">Per-agent</strong>,
            <>
              Only agents that switch on <em key="b">Route through gateway</em> in their tool
              settings. Everything else talks to providers directly.
            </>,
            "Trying the gateway on one workload before committing to it.",
          ],
          [
            <strong key="c">Route all</strong>,
            "Every LLM call on the account: chat, swarms, BI answers, embeds, skill generation, notebooks, model listings and embeddings.",
            "The one-gateway-one-bill pattern — central rate limits, central spend, one audit trail.",
          ],
        ]}
      />
      <P>
        Enabling either mode validates against the gateway first, so a wrong key fails at
        configuration time rather than on someone's next question. An auth failure blocks
        activation; a gateway that does not expose <C>/models</C> is tolerated, since not all of
        them do.
      </P>
      <Callout kind="warn" title="Route all is routing, not an egress boundary">
        If the gateway integration cannot be read at call time — a database blip, a config that
        failed to resolve — the call goes <strong>direct to the provider</strong> rather than
        failing. That is deliberate: a transient lookup problem taking down every model call on the
        instance would be worse. But it means <em>route all</em> is not something to rely on as the
        control that guarantees no traffic ever reaches a provider directly. If you need that
        guarantee, enforce it at the network, and use this for billing and observability.
      </Callout>

      <H2 id="shared">Shared credentials (teams)</H2>
      <P>
        A superadmin can grant one user&apos;s LLM credential to other users or groups under{" "}
        <DocLink to="/admin/iam">Admin → IAM</DocLink> (resource types &ldquo;LLM key&rdquo; and
        &ldquo;LLM credential&rdquo;) — the enterprise pattern of one provisioned Bedrock or OpenAI
        credential for a whole team.
      </P>

      <H3 id="resolution">Which key actually pays</H3>
      <P>
        Worth knowing precisely, because it decides which account gets the bill. The first match
        wins:
      </P>
      <Steps
        items={[
          {
            title: "The caller's own connection",
            body: "If you have connected that provider yourself, your key is used — always. A grant never displaces your own credential.",
          },
          {
            title: "A credential granted to you",
            body: "Resolved server-side at call time and shown as “Shared with you” on the Integrations page. You can use it; you can never read it.",
          },
          {
            title: "The operator's environment default",
            body: "The shared key the instance was configured with, if there is one. This is what makes a brand-new account work before anything is connected.",
          },
        ]}
      />
      <Callout kind="info" title="Sharing a key does not share anything else">
        A grantee&apos;s calls still run under their <em>own</em>{" "}
        <DocLink to="/docs/iam">model rules</DocLink>, their own{" "}
        <DocLink to="/docs/budgets">budget caps</DocLink>, and their own traces. What changes is
        whose provider account the tokens are billed to — so the spend lands on the credential owner
        while the governance stays with the caller. Cap the credential itself if you need to bound
        what a shared key can cost.
      </Callout>

      <H2 id="websearch">Web search &amp; browsing</H2>
      <P>
        The <strong>Web Search</strong> tab holds one workspace-wide Firecrawl key, which powers the{" "}
        <C>web_search</C> and <C>web_browse</C> tools for every agent that has them enabled.
      </P>
      <Callout kind="info" title="It works with no key at all">
        <C>web_browse</C> falls back to a <strong>built-in fetcher</strong>: it requests the page,
        strips navigation, headers, footers and cookie banners, and converts what is left to
        markdown — tables included. It does <strong>not</strong> run JavaScript, so a
        server-rendered page (documentation, a blog post, a licence, a GitHub README) reads cleanly
        while a client-rendered app returns its empty shell. When that happens the result is flagged
        as thin and says so, rather than handing the model nothing and calling it an answer. Adding
        a URL as a knowledge-base source uses the same fetcher.
        <br />
        <br />
        <C>web_search</C> falls back to DuckDuckGo's Instant Answer API. That is a category
        difference rather than a quality one: it returns encyclopedia-style entries for recognised
        entities and has no ranked web results at all, so ordinary queries come back empty however
        they are phrased. A key is what turns it into real search.
      </Callout>
      <P>The same setting can come from three places, in this order:</P>
      <Table
        headers={["Source", "Scope", "Wins over"]}
        rows={[
          [<>A per-agent key in the agent editor</>, "That one agent", "Everything below"],
          [<C key="e">FIRECRAWL_API_KEY</C>, "The deployment", "The workspace default"],
          ["This tab", "Workspace default", "Nothing — it is the fallback"],
        ]}
      />
      <P>
        Keys are stored encrypted and never shown again; leaving the field blank keeps the saved key
        rather than clearing it. Saving validates the key first, so a wrong paste fails here instead
        of silently degrading every agent's search to DuckDuckGo.
      </P>
      <P>
        Agents can also use Brave, SerpAPI, Tavily or ScrapingBee instead — those are chosen
        per-agent on the Tools tab, not here. See{" "}
        <DocLink to="/docs/agents" hash="tools">
          the tool reference
        </DocLink>
        .
      </P>

      <H2 id="slack">Ask an AI Analyst from Slack</H2>
      <P>
        The <strong>Slack</strong> tab authorises Slack workspaces to run one of your{" "}
        <DocLink to="/docs/bi" hash="ai-analyst">
          AI Analysts
        </DocLink>{" "}
        with a slash command. Someone types <C>/ask</C> in a channel, the analyst answers there, and
        the message links back here.
      </P>
      <Callout kind="why">
        The answer posted to Slack is a <strong>summary</strong>. The rows, the generated SQL and
        the lineage stay in the app. A channel is a wide audience with no per-viewer permissions, so
        publishing internal table and column names into it is not a thing you can take back — the
        link is there for anyone who needs the detail and is allowed to see it.
      </Callout>
      <P>
        This tab sits beside <strong>Notifications</strong> because both are Slack-shaped, but they
        point in opposite directions: notifications <em>post out</em> to a webhook you supply, while
        this <em>accepts calls in</em>. That difference is what makes the signing secret mandatory.
      </P>
      <Steps
        items={[
          {
            title: "Copy the request URL",
            body: (
              <>
                Shown at the top of the tab — <C>/api/slack/command</C> on your deployment. Slack
                has to reach it over the public internet.
              </>
            ),
          },
          {
            title: "Create the slash command in Slack",
            body: (
              <>
                In your Slack app: <strong>Slash Commands → Create New Command</strong>. Name it{" "}
                <C>/ask</C> and paste the request URL.
              </>
            ),
          },
          {
            title: "Copy the signing secret",
            body: (
              <>
                <strong>Basic Information → Signing Secret</strong>. Paste it here when you add the
                workspace. It is written once and never read back.
              </>
            ),
          },
          {
            title: "Add the workspace here",
            body: (
              <>
                Workspace ID (like <C>T01AB2CD3EF</C>), an optional name, and the analyst that
                answers. A bot token is <strong>not</strong> needed for slash commands — replies go
                back through Slack's own response URL.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="Configured and working are different things">
        The tab shows those as two separate states on purpose. <strong>Configured</strong> only
        means a form was filled in. <strong>Receiving commands</strong> is backed by a timestamp
        only Slack can set, so it is the one that proves the round trip works. If a row stays
        configured but never receives anything, the usual causes are that the deployment is on{" "}
        <C>localhost</C> and unreachable from Slack, a typo in the request URL, or a Slack app that
        was never reinstalled after the command was added.
      </Callout>
      <P>
        The endpoint is public because Slack has to reach it, so the signing secret is the only
        thing separating a real slash command from anyone who learned the URL. Deleting a workspace
        stops <C>/ask</C> working there immediately.
      </P>

      <H2 id="notifications">Notification channels</H2>
      <P>
        The <em>Notifications</em> tab connects Slack, Microsoft Teams, Discord, or any custom
        webhook. Connected channels receive system alerts (failing credential health checks,
        scheduled-refresh errors, BI data alerts) alongside the in-app notification bell, and power
        the <code>send_notification</code> agent tool (enable it per agent under Agent Builder →
        Tools → Automation). Saving posts a visible test message first; webhook URLs are capability
        URLs, so they are encrypted at rest and never shown again.
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
        Treat every key you connect as spend authorization: pair bring-your-own-key providers with{" "}
        <DocLink to="/docs/budgets">budget caps</DocLink>, and per-agent limits in the{" "}
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
            "22 database/warehouse connectors queried in place, 5 apps synced into datasets, plus object stores and lakehouse catalogs",
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
            "Notifications",
            "Slack, Microsoft Teams, Discord, custom webhooks — system alerts + the send_notification agent tool",
            <DocLink key="f" to="/docs/agents">
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

      <Note>
        SaaS tools (Google Drive, Jira, GitHub, CRMs…) connect through{" "}
        <DocLink to="/docs/mcp">MCP servers</DocLink> or n8n workflows — that is the deliberate
        strategy, not a gap in the catalog. Native per-provider OAuth connectors would require every
        operator to register their own OAuth apps with each vendor, so they are not shipped in the
        self-hosted build.
      </Note>

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
          <DocLink to="/docs/analytics#audit-timeline">audit trail</DocLink> — names, URLs and
          whether a secret was rotated; never the secret itself.
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
