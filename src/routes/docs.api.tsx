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

export const Route = createFileRoute("/docs/api")({
  head: () => ({
    meta: [
      { title: "API & webhooks — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The POST /api/swarm/run contract: request and response bodies, every status code, idempotency semantics, scopes, and verifying signed webhook callbacks.",
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
        description="One endpoint runs a swarm from your own code: POST /api/swarm/run. Scoped keys, idempotent retries, and signed callbacks for anything slower than a request."
      />

      {/* ── KEYS ── */}
      <H2 id="keys">API keys</H2>
      <P>
        Create one from the swarm's <strong>Deploy</strong> dialog. Keys look like <C>sk_swarm_…</C>{" "}
        and the secret is shown <strong>once</strong> — it is stored hashed and cannot be recovered,
        only rotated.
      </P>
      <Table
        headers={["Property", "Values", "Notes"]}
        rows={[
          [
            <C key="a">scopes</C>,
            <>
              <C key="r">run</C>, <C key="rr">read_runs</C>
            </>,
            <>
              Defaults to <C key="d">['run']</C>. A database constraint rejects any other value, so
              a typo fails at write time rather than silently granting nothing.
            </>,
          ],
          [
            <C key="b">expires_at</C>,
            "timestamp / null",
            "Optional expiry. Set one on keys for a specific integration.",
          ],
          [
            <C key="c">revoked_at</C>,
            "timestamp / null",
            "Revocation is immediate — the next request fails closed.",
          ],
          [
            <C key="d">rotated_from</C>,
            "key id",
            "Set on a replacement key, so you can see what superseded what.",
          ],
          [
            <C key="e">last_used_ip</C>,
            "text",
            "Source IP of the last request — an unused key is obvious, a stolen one traceable.",
          ],
          [
            <C key="f">reject_approvals</C>,
            "boolean",
            "When set, runs that hit an approval node fail rather than hanging waiting for a human who isn't watching.",
          ],
          [<C key="g">webhook_secret</C>, "text", "Used to sign callbacks — see below."],
          [
            <C key="h">callback_url</C>,
            "url",
            "Default callback for this key; can be overridden per request.",
          ],
        ]}
      />

      {/* ── PUBLISHING ── */}
      <H2 id="publishing">Which version your key runs</H2>
      <P>
        The canvas edits a <strong>draft</strong>. API keys and schedules run the{" "}
        <strong>published</strong> snapshot, so saving a half-finished edit cannot change what your
        integration receives. Creating a swarm's first key or schedule publishes the current graph
        automatically — a new deployment is never pointed at nothing.
      </P>
      <P>
        After that, rolling out a change is deliberate: edit and save on the canvas, then press{" "}
        <strong>Publish</strong> in the Deploy dialog. Until you do, the dialog shows{" "}
        <strong>Draft ahead</strong> and deployed callers keep getting the previous version.
        Publishing pins whatever is <em>saved</em>, so save before you publish — the dialog says so
        if the canvas has unsaved edits.
      </P>
      <Table
        headers={["State", "What deployed runs execute"]}
        rows={[
          ["Published", "The pinned snapshot, which currently matches the canvas."],
          [
            "Draft ahead",
            "The pinned snapshot. Your canvas changes are NOT live until you publish.",
          ],
          [
            "Serving the live canvas",
            "The draft itself — every save is immediately live. Only happens on swarms deployed before publishing existed, or if you press Unpin.",
          ],
        ]}
      />
      <P>
        <strong>Unpin</strong> is available if you want the old behaviour, where saves reach
        production immediately. Sub-swarms follow the same rule: an Execute Swarm node inside a
        headless run executes the child's published graph, not its draft.
      </P>

      {/* ── REQUEST ── */}
      <H2 id="request">POST /api/swarm/run</H2>
      <H3 id="req-headers">Headers</H3>
      <Table
        headers={["Header", "Required", "Notes"]}
        rows={[
          [<C key="a">Authorization: Bearer sk_swarm_…</C>, "Yes", "—"],
          [<C key="b">Content-Type: application/json</C>, "Yes", "—"],
          [
            <C key="c">Idempotency-Key</C>,
            "No",
            "Client-chosen. Makes a retry return the original result instead of re-running.",
          ],
        ]}
      />

      <H3 id="req-body">Request body</H3>
      <Table
        headers={["Field", "Type", "Purpose"]}
        rows={[
          [<C key="a">input</C>, "string", "The free-text input for the swarm's input node."],
          [
            <C key="b">inputs</C>,
            "object",
            "For a swarm whose input node declares a typed form: one key per field name.",
          ],
          [
            <C key="c">history</C>,
            "{role, content}[]",
            <>
              Prior turns (<C key="u">user</C> / <C key="v">assistant</C>). This is what turns a
              swarm into a multi-turn chatbot.
            </>,
          ],
          [
            <C key="d">async</C>,
            "boolean",
            "true returns immediately and delivers the result to the callback.",
          ],
          [
            <C key="e">callback_url</C>,
            "url",
            "Overrides the key's default callback for this run.",
          ],
        ]}
      />

      <H3 id="req-sync">Synchronous run</H3>
      <Code lang="bash">{`curl -X POST https://your-instance.example.com/api/swarm/run \\
  -H "Authorization: Bearer $AGENTSWARMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-48213-summary" \\
  -d '{
        "input": "Summarise ticket 48213 and suggest a reply",
        "inputs": { "priority": "high" }
      }'`}</Code>
      <Code lang="200 response">{`{
  "output": "The customer reports a faulty hinge …",
  "runId": "5f1c0f0e-…"
}`}</Code>

      <H3 id="req-async">Asynchronous run</H3>
      <Code lang="bash">{`curl -X POST https://your-instance.example.com/api/swarm/run \\
  -H "Authorization: Bearer $AGENTSWARMS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "input": "Produce the weekly summary",
        "async": true,
        "callback_url": "https://api.example.com/hooks/agentswarms"
      }'`}</Code>
      <Code lang="202 response">{`{
  "accepted": true,
  "callback_url": "https://api.example.com/hooks/agentswarms"
}`}</Code>
      <P>
        Use async for anything that takes longer than a request should — a long graph, an approval
        gate, a large document.
      </P>

      {/* ── STATUS CODES ── */}
      <H2 id="status">Status codes</H2>
      <Table
        headers={["Code", "Meaning", "What to do"]}
        rows={[
          ["200", "Run finished (sync)", "Read output and runId."],
          ["202", "Accepted (async)", "Wait for the callback."],
          [
            "401",
            "Missing, invalid, disabled or expired key",
            "Check the key; do not retry blindly.",
          ],
          [
            "402",
            "Budget cap exceeded",
            <>
              Spend ceiling hit — see{" "}
              <DocLink key="b" to="/docs/budgets">
                Budgets
              </DocLink>
              .
            </>,
          ],
          ["404", "Swarm not found", "The key's swarm was deleted."],
          [
            "409",
            "A run with this Idempotency-Key is still in progress",
            "Back off and retry; do not start a second run.",
          ],
          [
            "422",
            "Idempotency-Key reused with a different body",
            "A client bug — either reuse the exact body or use a new key.",
          ],
          ["429", "Rate limit exceeded", "Slow down and retry."],
        ]}
      />

      {/* ── IDEMPOTENCY ── */}
      <H2 id="idempotency">Idempotency</H2>
      <P>
        Send an <C>Idempotency-Key</C> and a retry with the same key returns the original result
        instead of running the swarm again.
      </P>
      <Callout kind="why">
        Networks fail after the server has already done the work. Without idempotency, your retry
        logic plus the platform's willingness to run means one customer event can trigger three
        model runs — three times the cost and three conflicting outputs. Derive the key from the
        thing you are processing (<C>order-48213-summary</C>), never from a random value per
        attempt, or every retry is a fresh run.
      </Callout>
      <Table
        headers={["Situation", "Result"]}
        rows={[
          ["Same key, same body, first call finished", "200 with the original stored response"],
          ["Same key, same body, first call still running", "409 — do not start a second run"],
          [
            "Same key, DIFFERENT body",
            "422 — rejected loudly rather than returning a mismatched result",
          ],
        ]}
      />
      <P>Idempotency records are kept for a bounded window and then purged.</P>

      {/* ── LIMITS ── */}
      <H2 id="limits">Limits</H2>
      <Table
        headers={["Limit", "Purpose"]}
        rows={[
          ["Rate limit", "Requests per key per interval → 429."],
          ["Concurrency", "Simultaneous runs per key — the one protecting your provider quota."],
          ["Run timeout", "Wall-clock ceiling, so a looping graph cannot run forever."],
          [
            "Budget cap",
            <>
              Spend ceiling per key → 402. See{" "}
              <DocLink key="b" to="/docs/budgets">
                Budgets
              </DocLink>
              .
            </>,
          ],
        ]}
      />
      <Callout kind="info" title="These limits hold across every instance">
        Rate limits and concurrency slots are counted in Postgres, not in each app process, so the
        number configured is the number enforced however many instances sit behind your load
        balancer. If the database is briefly unreachable an instance falls back to counting locally
        and logs that it has — the limit weakens for that moment rather than disappearing.
      </Callout>

      {/* ── WEBHOOKS ── */}
      <H2 id="webhooks">Webhook callbacks</H2>
      <P>Each delivery carries these headers:</P>
      <Table
        headers={["Header", "Value"]}
        rows={[
          [<C key="a">X-AgentSwarms-Event</C>, <C key="v">swarm.run.completed</C>],
          [<C key="b">X-AgentSwarms-Timestamp</C>, "Unix seconds, included in the signed material"],
          [
            <C key="c">X-AgentSwarms-Signature</C>,
            <>
              <C key="v">sha256=&lt;hex&gt;</C> — HMAC-SHA256 over{" "}
              <C key="m">{"<timestamp>.<body>"}</C> using the key's webhook secret
            </>,
          ],
        ]}
      />
      <P>Delivery is retried up to 3 times, with a 15-second timeout per attempt.</P>

      <H3 id="verify">Verifying the signature</H3>
      <Code lang="javascript">{`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, headers, secret) {
  const ts  = headers["x-agentswarms-timestamp"];
  const sig = headers["x-agentswarms-signature"]; // "sha256=<hex>"

  // Reject old timestamps FIRST — this is what stops a captured
  // delivery being replayed at you weeks later.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected =
    "sha256=" + createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig ?? "");
  // Constant-time: a plain === leaks the answer through timing.
  return a.length === b.length && timingSafeEqual(a, b);
}`}</Code>
      <UL>
        <li>
          Sign over the <strong>raw</strong> body, before any JSON parsing — re-serialising changes
          the bytes and the signature will not match.
        </li>
        <li>Respond 2xx quickly and do the work asynchronously; slow endpoints get retried.</li>
        <li>Make your handler idempotent — a retry may deliver the same result twice.</li>
      </UL>

      {/* ── SAFETY ── */}
      <H2 id="outbound">Outbound safety</H2>
      <P>
        Callback URLs are checked before delivery: private, loopback and link-local addresses —
        including cloud metadata endpoints — are refused. The same guard covers every outbound
        request the platform makes on your behalf, including <C>web_browse</C>, swarm HTTP nodes and
        MCP endpoints, so a URL chosen by a model cannot be used to reach inside your network.
      </P>

      <H2 id="approvals">Runs that hit an approval node</H2>
      <P>
        A swarm with an <DocLink to="/docs/swarms">approval node</DocLink> will wait for a human.
        For an unattended integration that is a hang, so set <C>reject_approvals</C> on the key and
        such runs fail fast instead. Approvals fail closed either way — a run never proceeds past a
        gate on a timeout.
      </P>

      <H2 id="observability">Seeing what happened</H2>
      <P>
        Every API-triggered run produces a full trace attributed to the key that started it, visible
        in <DocLink to="/docs/debugging">Traces</DocLink>, with cost attributed in{" "}
        <DocLink to="/docs/analytics">Analytics</DocLink>. When an integration misbehaves, start
        there rather than in your own logs — the trace shows the resolved prompt and every tool
        call.
      </P>

      <H2 id="notebooks">Calling a notebook instead of a swarm</H2>
      <P>
        Notebooks in the <DocLink to="/docs/notebooks">Developer workspace</DocLink> can be
        published the same way: click <strong>Publish</strong> on a notebook to mint an <C>nbk_…</C>{" "}
        key, then <C>POST /api/notebook/run</C> with <C>{`{"inputs": {…}}`}</C>. The request body
        reaches the notebook's entrypoint function and its return value comes back as the response;
        long runs hand back a <C>runId</C> to poll at <C>/api/notebook/run/status</C>. Use it when
        the logic is Python that already works in a notebook and does not need to become a swarm
        first.
      </P>

      <NextPrev current="/docs/api" />
    </>
  );
}
