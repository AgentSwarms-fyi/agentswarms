import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/api")({
  head: () => ({
    meta: [
      { title: "API & webhooks — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Run swarms from your own systems: API keys and scopes, idempotency, rate limits, and signed webhook callbacks.",
      },
      { property: "og:title", content: "API & webhooks — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Trigger runs from your systems and get signed callbacks.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/api" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/api" }],
  }),
  component: ApiPage,
});

function ApiPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Integrate & ship"
        title="API & webhooks"
        description="Run a swarm from your own code, safely enough to put in a production path: scoped keys, idempotent retries and signed callbacks."
      />

      <H2 id="keys">API keys</H2>
      <P>
        Create a key against a swarm from its page. The secret is shown <strong>once</strong> — it
        is stored hashed and cannot be recovered, only rotated.
      </P>
      <FieldList
        items={[
          {
            name: "Scopes",
            body: "What the key may do — start runs, read results. Issue the narrowest scope that works.",
          },
          {
            name: "Expiry",
            body: "An optional expiry date. A key for a specific integration should have one.",
          },
          {
            name: "Rotation",
            body: "Issue a replacement while the old key still works, cut over, then revoke. The new key records what it replaced.",
          },
          {
            name: "Last used",
            body: "Timestamp and source IP, so an unused key is obvious and a stolen one is traceable.",
          },
          {
            name: "Revocation",
            body: "Immediate. A revoked key fails closed on the next request.",
          },
        ]}
      />

      <H2 id="run">Starting a run</H2>
      <Code lang="bash">{`curl -X POST https://your-instance.example.com/api/swarm/run \\
  -H "Authorization: Bearer $AGENTSWARMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-48213-summary" \\
  -d '{
        "input": "Summarise ticket 48213 and suggest a reply",
        "callback_url": "https://api.example.com/hooks/agentswarms"
      }'`}</Code>
      <P>
        Without a callback the request returns the result when the run finishes. With one, it
        returns quickly and the result is delivered to your endpoint — the right shape for anything
        that takes longer than a request should.
      </P>

      <H2 id="idempotency">Idempotency</H2>
      <P>
        Send an <C>Idempotency-Key</C> and a retry with the same key returns the original result
        instead of running the swarm a second time.
      </P>
      <Callout kind="why">
        Networks fail after the server has done the work. Without idempotency, your retry logic and
        the platform's willingness to run mean one customer event can trigger three model runs —
        three times the cost, and three conflicting outputs. Derive the key from the thing you're
        processing (<C>order-48213-summary</C>), not from a random value per attempt.
      </Callout>
      <P>
        Replaying the same key with a <em>different</em> body is treated as a client bug and
        rejected loudly, rather than silently returning a result that doesn't match what you sent.
        Records are kept for a bounded window and then purged.
      </P>

      <H2 id="limits">Limits</H2>
      <Table
        headers={["Limit", "Purpose"]}
        rows={[
          ["Rate limit", "Requests per key per interval."],
          ["Concurrency", "Simultaneous runs per key — the one that protects your provider quota."],
          ["Run timeout", "A ceiling on wall-clock time, so a looping graph cannot run forever."],
          [
            "Budget cap",
            <>
              Spend ceiling per key — see{" "}
              <DocLink key="b" to="/docs/budgets">
                Budgets
              </DocLink>
              .
            </>,
          ],
        ]}
      />
      <Callout kind="info">
        Rate and concurrency limits are enforced per application process. If you run several
        instances behind a load balancer, the effective limit is multiplied by the instance count —
        size accordingly, and use budget caps for the hard ceiling.
      </Callout>

      <H2 id="webhooks">Webhook callbacks</H2>
      <P>
        Set a <C>callback_url</C> on the key or per run. When the run finishes, the result is POSTed
        to it.
      </P>
      <H3 id="verify">Verifying the signature</H3>
      <P>
        Each delivery carries a timestamp and an HMAC-SHA256 signature over{" "}
        <C>{"<timestamp>.<body>"}</C>, computed with the key's webhook secret. Verify it before
        trusting the payload — an unverified webhook endpoint is an open door.
      </P>
      <Code lang="javascript">{`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, timestamp, signature, secret) {
  // Reject old timestamps first — this is what stops a captured
  // delivery being replayed at you later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(\`\${timestamp}.\${rawBody}\`)
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Constant-time: a plain === leaks the answer through timing.
  return a.length === b.length && timingSafeEqual(a, b);
}`}</Code>
      <UL>
        <li>
          Sign over the <strong>raw</strong> body, before any JSON parsing — re-serialising changes
          the bytes and the signature won't match.
        </li>
        <li>Respond 2xx quickly and do the work asynchronously; slow endpoints get retried.</li>
        <li>Make your handler idempotent — a retry may deliver the same result twice.</li>
      </UL>

      <H2 id="outbound">Outbound safety</H2>
      <P>
        Callback URLs are checked before delivery: private, loopback and link-local addresses —
        including cloud metadata endpoints — are refused. The same guard covers every outbound
        request the platform makes on your behalf, including <C>web_browse</C> and MCP endpoints, so
        a URL chosen by a model cannot be used to reach inside your network.
      </P>

      <H2 id="observability">Seeing what happened</H2>
      <P>
        Every API-triggered run produces a full trace, attributed to the key that started it —
        visible in <DocLink to="/docs/debugging">Traces</DocLink>, with cost attributed in{" "}
        <DocLink to="/docs/analytics">Analytics</DocLink>. When an integration misbehaves, start
        there rather than in your own logs.
      </P>

      <NextPrev current="/docs/api" />
    </>
  );
}
