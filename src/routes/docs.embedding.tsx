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
        Open <strong>Integrations → Web Embedding</strong>. You create an <strong>embed key</strong>{" "}
        for one agent, swarm or dashboard, restrict it to the domains you control, and paste a
        snippet into your page.
      </P>

      <H2 id="setup">Setting one up</H2>
      <Steps
        items={[
          {
            title: "Pick what to expose",
            body: "One agent, one swarm, one published dashboard or one AI Analyst per key. Separate keys for separate placements — they can be revoked independently.",
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
            body: "The dialog has two tabs: an iframe tag to paste where the widget should appear, or React SDK code if you would rather render it yourself.",
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
        <C>/embed/agent/&lt;key&gt;</C>, <C>/embed/swarm/&lt;key&gt;</C>,{" "}
        <C>/embed/bi/&lt;key&gt;</C> or <C>/embed/analyst/&lt;key&gt;</C>.
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

      <H2 id="react-sdk">Two ways to embed: iframe or React SDK</H2>
      <P>
        The snippet dialog offers both, on the same key. An iframe is a sealed box you drop on a
        page; the SDK is a library your React app calls, so the conversation renders with your own
        components. They reach the identical endpoints, so a key's domain allow-list, expiry, budget
        cap, guardrails and rate limits apply the same either way.
      </P>
      <Table
        headers={["", "iframe", "React SDK"]}
        rows={[
          [
            "Setup",
            "Paste one tag. No build step.",
            "npm install, then render a component or call a hook.",
          ],
          [
            "Look and feel",
            "Our styling, inside a fixed frame.",
            "Entirely yours — your bubbles, markdown renderer and theme.",
          ],
          [
            "Control",
            "Sealed. The host page cannot read the conversation.",
            "Full: send from anywhere in your app, intercept every streamed event, seed the history.",
          ],
          [
            "Layout",
            "Fixed height, own scroll area.",
            "A normal element in your layout and router.",
          ],
          [
            "Works for",
            "Agents, swarms, dashboards and the AI Analyst.",
            "Agents, swarms and the AI Analyst. Dashboards stay iframe-only.",
          ],
        ]}
      />
      <Callout kind="info" title="Dashboards are iframe-only, on purpose">
        A BI dashboard is a whole rendered surface — filters, drill-downs, cross-filtering and chart
        interactions — not a stream of messages. There is no useful way to hand that to a host app
        as data, so the SDK does not pretend to. The React SDK tab is disabled for dashboard keys.
      </Callout>

      <H3 id="sdk-install">Installing</H3>
      <P>
        The package lives in the repository at <C>sdk/react</C> and is not published to npm yet, so
        install it from the folder:
      </P>
      <Code lang="bash">{`npm install ./sdk/react`}</Code>
      <P>
        Add the host app's domain to the key's allowed domains before you start — the server checks
        the browser's <C>Origin</C> header on every call, exactly as it does for an iframe.
      </P>

      <H3 id="sdk-drop-in">The drop-in component</H3>
      <P>
        <C>&lt;AgentChat&gt;</C> is the batteries-included path: a working chat with input,
        streaming replies and a stop button, themed through CSS variables so it inherits your
        palette without a stylesheet import.
      </P>
      <Code lang="tsx">{`import { AgentChat } from "@agentswarms/react";

export function SupportWidget() {
  return (
    <AgentChat
      baseUrl="https://your-instance.example.com"
      embedKey="emk_xxxxxxxxxxxxxxxx"
      title="Support"
      style={{ "--as-accent": "#7c3aed", height: 560 } as React.CSSProperties}
    />
  );
}`}</Code>
      <P>
        Themeable variables: <C>--as-bg</C>, <C>--as-fg</C>, <C>--as-muted</C>, <C>--as-border</C>,{" "}
        <C>--as-accent</C>, <C>--as-accent-fg</C>, <C>--as-bubble</C> and <C>--as-radius</C>.
      </P>

      <H3 id="sdk-hooks">The headless hooks</H3>
      <P>
        When the component's layout is not what you want, take the state and render it yourself.{" "}
        <C>useAgentChat</C> owns the streaming, cancellation and history; everything visual is
        yours.
      </P>
      <Code lang="tsx">{`import { useAgentChat } from "@agentswarms/react";

const { messages, send, stop, isStreaming, citations, widget, error } = useAgentChat({
  baseUrl: "https://your-instance.example.com",
  embedKey: "emk_xxxxxxxxxxxxxxxx",
  // nodeId: "…",            // swarm embeds: address one node
  // initialMessages: [...], // seed a welcome message
  // onEvent: (e) => {},     // every typed stream event, if you want the raw feed
});`}</Code>
      <Table
        headers={["Returned", "What it holds"]}
        rows={[
          ["messages", "The conversation. The last assistant message grows as the answer streams."],
          ["isStreaming", "True while a reply is arriving. Use it to disable the input."],
          ["citations", "Knowledge-base sources for the current answer, when the agent used any."],
          ["widget", "A Visual BI chart spec, when the agent produced one."],
          ["error", "Hard failures only — see the callout below."],
          ["send / stop / reset", "Send a message, abort the stream, clear the conversation."],
        ]}
      />
      <Callout kind="why">
        A guardrail refusal or an exhausted budget is <strong>not</strong> an <C>error</C> — it
        arrives as an ordinary assistant message, because that is what the visitor should see, and
        it is what the iframe shows too. <C>error</C> is reserved for the cases where nothing was
        said at all: a revoked or expired key, an origin that is not allow-listed, a rate limit, or
        the network. Rendering refusals as errors is the usual way an SDK integration ends up
        looking broken when it is working correctly.
      </Callout>
      <P>
        The AI Analyst has its own hook, because it streams whole reasoning turns rather than text:{" "}
        <C>activeTurn</C> fills in live as the analyst states its approach and works through each
        step, and every finished turn is appended to <C>turns</C>. Follow-up questions carry the
        prior turns automatically.
      </P>
      <Code lang="tsx">{`import { useAgentAnalyst } from "@agentswarms/react";

const { turns, activeTurn, ask, isRunning, error } = useAgentAnalyst({
  baseUrl: "https://your-instance.example.com",
  embedKey: "emk_xxxxxxxxxxxxxxxx", // a key whose resource is an AI Analyst
});

// ask("What drove revenue last quarter?")`}</Code>
      <Callout kind="info" title="Not a React app?">
        The wire format is plain Server-Sent Events over <C>POST</C>, and the parser is exported
        framework-free as <C>createSseParser</C>, <C>mapChatFrame</C> and <C>mapAnalystFrame</C> —
        enough to build the same integration in Vue, Svelte or no framework at all.
      </Callout>

      <H3 id="sdk-key-safety">The embed key is still public</H3>
      <P>
        Nothing changes about the trust model. The key ships in your JavaScript bundle exactly as it
        ships in iframe markup, and it is meant to: it is a site key, not a secret. Every control
        that matters runs on the server, so a reader who copies the key out of your bundle can only
        do what your allow-listed domain could already do — and disabling the key in{" "}
        <strong>Integrations → Web Embedding</strong> cuts off SDK apps as instantly as iframes.
      </P>

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
      <H3 id="signed-viewers">Signed viewers — one dashboard, many customers</H3>
      <P>
        That last sentence is the problem when you are embedding analytics <em>inside a product</em>
        : every customer loading the page sees the same rows. Issuing one key each does not help —
        the keys are equally public, so any customer can use any other customer's.
      </P>
      <P>
        Turn on <strong>Signed viewers</strong> (the shield button on a dashboard embed) and name
        the attributes your data is scoped by — <C>tenant</C>, <C>region</C>. You get a signing
        secret, shown <strong>once</strong>, and a ready-made Node snippet. Your backend mints a
        short-lived token naming the viewer and puts it in the iframe URL as <C>?vt=…</C>. We verify
        the signature and turn those attributes into row filters. The browser can read the token; it
        cannot forge one.
      </P>
      <UL>
        <li>
          No token, an expired one, a forged one, or one missing a named attribute is a{" "}
          <strong>refusal that says which</strong> — never the owner's unfiltered view.
        </li>
        <li>
          An expiry is required and capped at 12 hours. A viewer token that never expires is a
          permanent grant sitting in someone's browser history.
        </li>
        <li>
          Attributes <strong>intersect</strong>: <C>tenant</C> and <C>region</C> means this tenant{" "}
          <em>in</em> this region. (IAM grants union — that is a different question.)
        </li>
        <li>The embedded Ask-AI analyst reads the same scoped rows, not the owner's.</li>
      </UL>
      <Callout kind="warn" title="Widgets that can't be scoped are withheld, and say so">
        An embed renders stored results. If a widget projects your scope column, its rows can be
        filtered and the number is right. If it aggregated that column away —{" "}
        <C>sum(revenue) by month</C> — the total already contains every customer and no filter over
        those rows can recover one customer's share. Those widgets are <strong>withheld</strong>{" "}
        with that reason in place of the chart, because showing them unfiltered leaks and blanking
        them reads as "no data". Add the column to the widget's query to bring it back. Scoped
        viewers also see a banner naming the scope, so a subset is never mistaken for a total.
      </Callout>

      <H3 id="visual-answers">Visual answers in embeds</H3>
      <P>
        If the agent has <strong>Visual BI answers</strong> enabled, embedded chats can return a
        chart alongside the text. Because the visitor has no data access, the chart is generated
        server-side using the owner's data with the owner enforced as the tenant boundary.
      </P>

      <H2 id="analyst">Embedding the AI Analyst</H2>
      <P>
        The fourth embed type puts the <DocLink to="/docs/bi">AI Analyst</DocLink> chat itself on
        your site. Visitors ask their own questions and see the stated approach, each step's result
        and chart, the findings and what to ask next — the same reasoning loop the signed-in screen
        runs.
      </P>
      <P>
        It runs <strong>server-side as the analyst's owner</strong>, because an anonymous visitor
        has no datasets, no credentials and no query engine. That makes the{" "}
        <strong>analyst's data scope the access boundary</strong>: scoped to two datasets, it can
        read those two and nothing else. Scope it to what you would be comfortable publishing. Your
        IAM model rules and semantic row filters still apply, since the compile happens under your
        id.
      </P>
      <Callout kind="warn" title="This is the most exposed embed type">
        A dashboard embed serves numbers you already computed and looked at. An analyst embed
        accepts a <em>question</em> and writes fresh SQL against whatever it is scoped to. Visitors
        never receive the generated SQL — it is stripped server-side, not merely left unrendered,
        because it names your tables and columns — and they get none of the owner tools (edit and
        re-run, pin to dashboard, verify, what-if). But the questions are theirs, so the scope is
        the control.
      </Callout>
      <UL>
        <li>
          <strong>Cost:</strong> several model calls per question, billed to you. Analyst turns are
          rate-limited to <strong>5 per minute per key</strong> (a dashboard question gets 10), and
          spend is metered to the embed key so it shows up per-embed in Analytics.
        </li>
        <li>
          <strong>Latency, and what the visitor sees:</strong> a turn plans, queries, self-checks
          and synthesises — ~37–95s on the bundled HR sample. It <strong>streams</strong>, so the
          named stage and the stated approach land at about 6s and the trace fills in from there,
          rather than a spinner that is indistinguishable from a hang.
        </li>
        <li>
          <strong>Signed viewers do not apply.</strong> They filter stored results; an analyst
          writes new SQL each time, so a filter could cover the governed steps and not the rest —
          partial enforcement is a badge that vouches for less than it looks like.
        </li>
      </UL>

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
          For a dashboard your customers each load: <strong>signed viewers</strong> on, with the
          scope attributes named — and check which widgets came back withheld before you ship.
        </li>
        <li>
          Tested by asking the agent, in the embed, to reveal its instructions and everything it
          knows.
        </li>
      </UL>

      <NextPrev current="/docs/embedding" />
    </>
  );
}
