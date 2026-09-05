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
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/gateway")({
  head: () => ({
    meta: [
      { title: "AI Gateway — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "An OpenAI-compatible endpoint in front of your agents and connected models: per-key scopes, budgets, rate limits and a fallback chain, governed by the same IAM rules, traces and audit as the app.",
      },
      { property: "og:title", content: "AI Gateway — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Point any OpenAI SDK at your agents. Every call runs as you, governed like the app.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/gateway" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/gateway" }],
  }),
  component: GatewayDocsPage,
});

function GatewayDocsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Integrate & ship"
        title="AI Gateway"
        description="An OpenAI-compatible endpoint in front of your agents and connected models. Point any OpenAI SDK, IDE plugin, evaluation harness or other agent at /api/v1/ with a gateway key; every call runs as the key's owner, under that owner's model rules, budgets, traces and audit trail."
      />

      <H2 id="what">What it is</H2>
      <P>
        The platform already governs every model call it makes. Until now only callers that spoke
        its own request shape could reach an agent. A <strong>gateway key</strong> opens the OpenAI
        shape without opening anything else: it is minted by one user, reaches only that user&apos;s
        agents and the models that user may call, pays from that user&apos;s budgets, and is traced
        and audited under that user&apos;s name. This is the inbound half of the gateway; the
        outbound half — routing the platform&apos;s own traffic through LiteLLM, Portkey or Helicone
        — is the setting beside it on the same tab and is unchanged.
      </P>

      <H2 id="keys">Keys</H2>
      <P>
        Mint a key under <strong>Integrations → LLM Gateway → API access</strong>. The plaintext{" "}
        <C>gw_…</C> is shown once; the row keeps a hash and the first characters. Revoking is
        immediate and permanent, and every change to a key is audited by trigger.
      </P>
      <Table
        headers={["Setting", "What it does"]}
        rows={[
          [
            "Scopes",
            "agents lets the key call your saved agents (model = agent:<name or id>); models lets it call a connected model directly (model = <provider>/<model>).",
          ],
          [
            "Agents",
            "With the agents scope, an optional allow-list; none ticked means every agent you own.",
          ],
          [
            "Model patterns",
            "With the models scope, provider/model patterns the key may call (openrouter/*, anthropic/claude-*); empty means anything your IAM model rules allow.",
          ],
          [
            "Fallback chain",
            "Ordered provider/model entries tried when the requested model fails with a provider error, before the instance-wide chain.",
          ],
          ["Calls a minute", "A per-key rate limit; blank uses the instance default."],
          [
            "Monthly budget",
            "A ceiling in USD on what this key may spend, measured from the traces it makes.",
          ],
          ["Expires", "Optional; an expired key answers 401 the moment it lapses."],
        ]}
      />

      <H2 id="calling">Calling it</H2>
      <P>
        Base URL <C>https://&lt;your host&gt;/api/v1/</C>. <C>GET /models</C> lists what the key may
        name; <C>POST /chat/completions</C> runs one turn, streamed as server-sent events when{" "}
        <C>stream</C> is true.
      </P>
      <Code>{`curl https://<your host>/api/v1/chat/completions \\
  -H "Authorization: Bearer gw_..." \\
  -H "Content-Type: application/json" \\
  -d '{"model": "agent:Support triage", "stream": true,
       "messages": [{"role": "user", "content": "A customer reports a failed payment"}]}'`}</Code>
      <Code>{`from openai import OpenAI
client = OpenAI(base_url="https://<your host>/api/v1/", api_key="gw_...")
reply = client.chat.completions.create(
    model="openrouter/openai/gpt-4o-mini",
    messages=[{"role": "user", "content": "What is a lakehouse?"}],
)
print(reply.choices[0].message.content)`}</Code>
      <UL>
        <li>
          <strong>Taken from the request:</strong> <C>model</C>, <C>messages</C> (system and
          developer messages become the instruction; tool messages are dropped, because an agent
          runs its own tools), <C>stream</C>, <C>temperature</C>, <C>max_tokens</C>, and{" "}
          <C>stream_options.include_usage</C>. Client-supplied <C>tools</C> are ignored: an
          agent&apos;s tools are the ones its owner configured, and a bare model has none.
        </li>
        <li>
          <strong>Added to the reply:</strong> an <C>agentswarms</C> object with the trace id, the
          model fallen back from, citations, tool calls and any guardrail note; headers{" "}
          <C>X-Trace-Id</C>, <C>X-Gateway-Model</C> (the model that answered) and{" "}
          <C>X-Gateway-Fallback</C>.
        </li>
        <li>
          <strong>No memory between calls.</strong> The caller holds the conversation and replays
          it, the way the OpenAI API works; a key is not a person.
        </li>
      </UL>

      <H2 id="fallback">Fallback</H2>
      <P>
        When the requested model fails with a provider error — throttling, exhausted credits, a
        timeout, a 5xx — the gateway tries the key&apos;s chain, then the instance-wide chain, each
        entry once, and answers with the first that works. For an agent only the model changes; the
        prompt, tools and knowledge stay the agent&apos;s. A caller&apos;s own mistake is never
        retried, and a policy refusal of the model the caller asked for answers 403; a forbidden
        model that only appears in a chain is skipped. A fallback happens only before any token has
        reached the caller. Every switch is audited as <C>gateway.fallback</C>.
      </P>

      <H2 id="governance">Governance</H2>
      <UL>
        <li>
          <strong>Identity.</strong> The turn runs on the chat route&apos;s internal channel as the
          key&apos;s owner; data tools read what the owner may read.
        </li>
        <li>
          <strong>Model rules.</strong> IAM allow-lists apply to the model that answers, requested
          or fallen back to. See <DocLink to="/docs/iam">Access control</DocLink>.
        </li>
        <li>
          <strong>Budgets.</strong> The owner&apos;s personal and group budgets apply, and the
          key&apos;s own monthly ceiling on top; every trace made through the key carries the key as
          its cost scope, so the ceiling is measured. Over budget answers 429{" "}
          <C>insufficient_quota</C>.
        </li>
        <li>
          <strong>Audit.</strong> <C>gateway.chat</C> for every turn, <C>gateway.fallback</C> for
          every switch, <C>gateway.access.denied</C> for a revoked, expired, out-of-scope or
          throttled key with the caller&apos;s address; agent turns also audit <C>agent.chat</C>.
        </li>
        <li>
          <strong>Traces.</strong> Each turn is an execution trace under the owner with the
          agent&apos;s name, so Observability shows gateway traffic beside everything else.
        </li>
      </UL>
      <Callout title="Errors use the OpenAI shape">
        <C>{'{ "error": { "message", "type", "code" } }'}</C> with codes <C>invalid_api_key</C>{" "}
        (401), <C>insufficient_scope</C> and <C>model_not_allowed</C> (403), <C>model_not_found</C>{" "}
        (404), <C>rate_limit_exceeded</C> and <C>insufficient_quota</C> (429),{" "}
        <C>invalid_request_error</C> (400), <C>upstream_error</C> (502).
      </Callout>

      <H2 id="limits">Limits</H2>
      <Table
        headers={["Setting", "Default", "Where"]}
        rows={[
          [
            "AI_GATEWAY_RATE_LIMIT_PER_MIN",
            "60",
            "Calls a minute one key may make unless it sets its own; Admin → Developer runtime.",
          ],
          [
            "AI_GATEWAY_FALLBACK_MODELS",
            "none",
            "Comma-separated provider/model entries every call may fall back to, after the key's chain.",
          ],
          [
            "Fallback entries per key",
            "10",
            "Entries that do not parse as provider/model are dropped when saved, and said so.",
          ],
        ]}
      />

      <H2 id="how-this-compares">How this compares</H2>
      <P>
        LiteLLM and Portkey are gateways in front of model providers: keys, routing, fallbacks and
        spend for raw models. This endpoint is a gateway in front of your <strong>agents</strong> as
        well as your models, and it inherits the platform&apos;s governance instead of carrying its
        own copy. If you already run one of those gateways, keep it as the outbound route and put
        this endpoint in front of the agents.
      </P>

      <H3 id="troubleshooting">Troubleshooting</H3>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            "401 invalid_api_key",
            "Missing, malformed, revoked or expired key. Mint a new one under Integrations → LLM Gateway.",
          ],
          [
            "404 model_not_found",
            "model is neither agent:<name or id> nor <provider>/<model>, the agent is inactive, or two agents share the name — use agent:<id>.",
          ],
          [
            "403 insufficient_scope",
            "The key lacks the scope, or the agent is not on its allow-list.",
          ],
          [
            "403 model_not_allowed",
            "Your IAM model rules forbid the model, or the key's model patterns do.",
          ],
          ["429 insufficient_quota", "The owner's or the key's monthly budget is spent."],
          [
            "The reply came from a different model",
            "A fallback fired; X-Gateway-Model names it and the audit log has gateway.fallback with the reason.",
          ],
        ]}
      />

      <NextPrev current="/docs/gateway" />
    </>
  );
}
