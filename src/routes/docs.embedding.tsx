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
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/embedding")({
  head: () => ({
    meta: [
      { title: "Web embedding — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Put an agent, swarm or dashboard on your own site: embed keys, domain allow-lists, what anonymous visitors can reach, and transcript retention.",
      },
      { property: "og:title", content: "Web embedding — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Embed an agent on your website, safely.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/embedding" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/embedding" }],
  }),
  component: EmbeddingPage,
});

function EmbeddingPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Integrate & ship"
        title="Web embedding"
        description="Publish an agent, a swarm or a dashboard to your own site — where the visitors are anonymous, which changes what you must think about."
      />

      <P>
        Open <strong>Configure → Web Embedding</strong>. You create an <strong>embed key</strong>{" "}
        for one agent, swarm or dashboard, restrict it to the domains you control, and paste a
        snippet into your page.
      </P>

      <H2 id="setup">Setting one up</H2>
      <Steps
        items={[
          {
            title: "Pick what to expose",
            body: "One agent, one swarm, or one published dashboard per key. Separate keys for separate placements — they can be revoked independently.",
          },
          {
            title: "Restrict the domains",
            body: (
              <>
                List exactly the origins allowed to load it — <C>www.example.com</C>,{" "}
                <C>docs.example.com</C>. Never leave this open on a key with real data behind it.
              </>
            ),
          },
          {
            title: "Set an expiry",
            body: "Keys can carry an expiry date and be revoked or rotated later. A campaign key should outlive the campaign by days, not years.",
          },
          {
            title: "Copy the snippet",
            body: "An iframe or script tag. Paste it where the widget should appear.",
          },
        ]}
      />
      <Code lang="html">{`<iframe
  src="https://your-instance.example.com/embed/agent/emk_xxxxxxxxxxxxxxxx"
  style="width:100%;height:600px;border:0"
  title="Support assistant"
></iframe>`}</Code>
      <P>
        Keys are prefixed <C>emk_</C>. The URL path segment matches the resource type:{" "}
        <C>/embed/agent/&lt;key&gt;</C>, <C>/embed/swarm/&lt;key&gt;</C> or{" "}
        <C>/embed/bi/&lt;key&gt;</C>.
      </P>

      <H3 id="key-fields">Every field on an embed key</H3>
      <Table
        headers={["Field", "Default", "Notes"]}
        rows={[
          ["Name", "—", "1–80 characters. Your label; not shown to visitors."],
          [
            <C key="a">resource_type</C>,
            "—",
            <>
              One of <C key="x">agent</C>, <C key="y">swarm</C>, <C key="z">bi_dashboard</C>. Fixed
              at creation.
            </>,
          ],
          [
            <C key="b">allowed_domains</C>,
            "empty",
            "Origins permitted to load it. EMPTY MEANS NO DOMAIN RESTRICTION — set this.",
          ],
          [
            <C key="c">allow_ai</C>,
            "false",
            "For dashboard embeds: whether viewers may use the Ask-AI follow-up. Off by default because each question is a model call billed to you.",
          ],
          [
            <C key="d">is_active</C>,
            "true",
            "Turn off to disable the placement without deleting the key.",
          ],
          [
            <C key="e">transcript_retention_days</C>,
            "30",
            "1–3650. How long embed conversations are kept before the scheduled purge.",
          ],
          [<C key="f">expires_at</C>, "null", "Optional expiry."],
          [
            <C key="g">use_count</C>,
            "0",
            "Requests served — read-only, useful for spotting an abandoned placement.",
          ],
          [<C key="h">last_used_at</C>, "null", "Read-only."],
        ]}
      />

      <H2 id="what-visitors-get">What an anonymous visitor can reach</H2>
      <P>This is the part worth being precise about.</P>
      <Table
        headers={["Aspect", "Behaviour"]}
        rows={[
          ["Identity", "None. There is no sign-in; every visitor is anonymous."],
          [
            "Data access",
            "The visitor has none of their own. The agent runs against the OWNER's knowledge and data, explicitly scoped to that owner.",
          ],
          ["Model cost", "Billed to the key owner's workspace, under the owner's provider keys."],
          [
            "Tools",
            "Only what the underlying agent has enabled — an embed does not add capability.",
          ],
          [
            "Guardrails",
            "The agent's guardrails apply, including PII handling on input and output.",
          ],
          [
            "Which version runs",
            "For an embedded SWARM, the published snapshot — not your working canvas. Creating the embed key publishes the current graph, and later edits stay private until you press Publish in the Deploy dialog.",
          ],
        ]}
      />
      <P>
        That last row is the one people are surprised by, and it is deliberate: an embed sits in
        someone else&rsquo;s page, so a half-finished edit reaching it the moment you press Save
        would be the worst version of that behaviour. See{" "}
        <DocLink to="/docs/api">API &amp; webhooks</DocLink> for the publish states. Embeds created
        before publishing existed keep serving the live canvas until you publish once.
      </P>
      <Callout kind="warn" title="An embed is a public surface">
        Anything the agent can read, a visitor can ask it to reveal — including by writing a prompt
        that tries to talk it out of its instructions. Before publishing, ask: if a stranger asked
        this agent for everything it knows, what would come back? Attach only the collections and
        tables the public may see, and enable only the tools they may trigger.
      </Callout>

      <H2 id="security">How access is enforced</H2>
      <FieldList
        items={[
          {
            name: "Domain allow-list",
            body: "Requests carry the browser-set Origin header, which page scripts cannot forge, and are rejected when it isn't on your list. This stops your key being lifted and used on someone else's site — but it is a browser-level control, not authentication: a non-browser client can send any header it likes.",
          },
          {
            name: "Key lifecycle",
            body: "Keys record when they were last used and from which IP, can expire, and can be revoked or rotated. Rotation keeps the link between old and new so you can see what replaced what.",
          },
          {
            name: "Rate and concurrency limits",
            body: "Per-key limits blunt scraping and runaway loops.",
          },
          {
            name: "Budget caps",
            body: (
              <>
                A key can carry its own spend cap — see{" "}
                <DocLink to="/docs/budgets">Budgets</DocLink>. On a public endpoint this is the
                difference between a bad day and a bad invoice.
              </>
            ),
          },
        ]}
      />

      <H2 id="transcripts">Transcripts and retention</H2>
      <P>
        Embed conversations are recorded so you can see what people asked and how the agent
        answered. Each key has a <strong>transcript retention</strong> window (30 days by default,
        1–3650); a scheduled purge deletes older transcripts.
      </P>
      <P>
        Set this deliberately. Visitors may type personal information into a public chat box, and
        the shortest window that still serves you is the right one. Redaction guardrails can strip
        recognised personal data before it is stored or sent to a provider — see{" "}
        <DocLink to="/docs/guardrails">Guardrails &amp; PII</DocLink>.
      </P>

      <H2 id="dashboards">Embedded dashboards</H2>
      <P>
        A published <DocLink to="/docs/bi">dashboard</DocLink> can be embedded the same way. Widgets
        are sanitised on the way out so the underlying queries and connection details aren't exposed
        — but every number on the page is visible to whoever loads it.
      </P>
      <H3 id="visual-answers">Visual answers in embeds</H3>
      <P>
        If the agent has <strong>Visual BI answers</strong> enabled, embedded chats can return a
        chart alongside the text. Because the visitor has no data access, the chart is generated
        server-side using the owner's data with the owner enforced as the tenant boundary.
      </P>

      <H2 id="limits">What one visitor can consume</H2>
      <P>
        Worth knowing before you publish, because these are the numbers standing between a curious
        visitor — or a bot that finds the widget — and your provider bill. They are enforced
        server-side and counted in Postgres, so they hold across every app instance rather than per
        process.
      </P>
      <Table
        headers={["Limit", "Value", "Scope"]}
        rows={[
          ["Chat requests", "30 per minute → 429", "Per embed key"],
          ["Dashboard “Ask AI” requests", "10 per minute → 429", "Per embed key"],
          ["Resolve (widget load)", "60 per minute", "Per embed key"],
          ["Messages in one conversation", "60", "Per request"],
          ["Conversation size", "200,000 characters", "Per request"],
          [
            "Spend",
            <>
              Your cap → 402, when <C key="e">ENFORCE_BUDGET_CAP</C> is on
            </>,
            "Per embed key, and per user",
          ],
        ]}
      />
      <Callout kind="warn" title="Rate limits bound the pace, not the total">
        Thirty chat requests a minute is roughly 43,000 a day if something hammers it continuously.
        The rate limit stops a burst; only a{" "}
        <DocLink to="/docs/budgets">budget cap on the key</DocLink> stops the month. Set both — and
        set the cap before the embed is reachable, not after the first surprise.
      </Callout>
      <Callout kind="info" title="A swarm embed orchestrates in the visitor's browser">
        The graph runs client-side, but each node's call carries only the node's <em>id</em> — the
        server re-reads that node's real provider, model, prompt and tools from your stored swarm. A
        visitor cannot select a more expensive model, change the prompt, or reach a node you did not
        publish. Swarms containing a human-approval step are refused for embedding outright, since
        no anonymous visitor can ever release the gate.
      </Callout>

      <H2 id="checklist">Pre-publish checklist</H2>
      <UL>
        <li>Domains restricted to sites you control.</li>
        <li>Only public-safe knowledge collections and tables attached to the agent.</li>
        <li>Tools limited to what a stranger may trigger.</li>
        <li>Guardrails on, with PII redaction if visitors might type personal details.</li>
        <li>A budget cap on the key.</li>
        <li>A transcript retention window you can justify.</li>
        <li>
          Tested by asking the agent, in the embed, to reveal its instructions and everything it
          knows.
        </li>
      </UL>

      <NextPrev current="/docs/embedding" />
    </>
  );
}
