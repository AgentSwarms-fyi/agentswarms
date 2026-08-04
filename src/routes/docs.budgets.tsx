import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/budgets")({
  head: () => ({
    meta: [
      { title: "Budgets & cost — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Cap spend per user, group, embed key or API key; understand what drives cost; and set retention for chats, transcripts and traces.",
      },
      { property: "og:title", content: "Budgets & cost — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Control what agents cost, and how long data is kept.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/budgets" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/budgets" }],
  }),
  component: BudgetsPage,
});

function BudgetsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Govern & operate"
        title="Budgets & cost"
        description="Agents spend money on every turn, and a looping graph or a public embed can spend a lot of it quickly. Caps are the control that turns a bad day into a stopped run."
      />

      <H2 id="what-costs">What actually costs money</H2>
      <P>
        Model calls, billed per token in and out. Everything else is rounding. The things that make
        it add up faster than people expect:
      </P>
      <Table
        headers={["Driver", "Why it costs"]}
        rows={[
          [
            "Retrieved context",
            "Every retrieved chunk is input tokens on every turn that carries it.",
          ],
          [
            "Conversation history",
            "A long chat resends its history each turn — cost grows with the conversation.",
          ],
          [
            "Tool loops",
            "Each tool round trip is another full model call with the transcript so far.",
          ],
          ["Swarm fan-out", "Parallel branches multiply calls; a loop node multiplies them again."],
          [
            "Deep document generation",
            "A large deck is a big plan plus a render-verify vision pass.",
          ],
          [
            "Public embeds",
            "Unbounded strangers, at your expense — the case that most needs a cap.",
          ],
        ]}
      />

      <H2 id="caps">Setting caps</H2>
      <P>There are two separate mechanisms, and it is worth knowing which one you are setting.</P>

      <H3 id="cap-user">Per-user cap</H3>
      <Table
        headers={["Property", "Value"]}
        rows={[
          ["Stored in", <C key="a">budget_settings.monthly_cap_usd</C>],
          ["Scope", "One person's own spend, across everything they do"],
          ["Period", "Calendar month"],
          ["Default", "A very high number — effectively unlimited until you set it"],
        ]}
      />

      <H3 id="cap-scoped">Scoped caps</H3>
      <P>
        Set in <strong>Observe → Budgets</strong>, and per group in{" "}
        <strong>Admin → IAM → Budgets</strong>. Three scopes exist, enforced by a database
        constraint:
      </P>
      <Table
        headers={["scope_type", "Applies to", "Why you would set it"]}
        rows={[
          [
            <C key="a">group</C>,
            "Everyone in an IAM group, shared",
            "A team's combined monthly ceiling",
          ],
          [
            <C key="b">embed_key</C>,
            "One public embed placement",
            "The most important one to set — unbounded strangers, at your expense",
          ],
          [
            <C key="c">swarm_api_key</C>,
            "One integration",
            "Bounds a retry storm in someone else's code",
          ],
        ]}
      />
      <Table
        headers={["Field", "Type", "Notes"]}
        rows={[
          [
            <C key="a">monthly_cap_usd</C>,
            "numeric(10,2)",
            "Must be greater than zero. A calendar-month ceiling in USD.",
          ],
          [
            <C key="b">is_active</C>,
            "boolean, default true",
            "Turn a cap off without deleting it.",
          ],
        ]}
      />
      <Callout kind="info">
        Where several caps apply, the <strong>most restrictive wins</strong>. A user with a $50
        personal cap who belongs to a group capped at $20 is limited to $20.
      </Callout>

      <H3 id="enforcement">Enforcement is opt-in</H3>
      <P>
        Caps only <em>block</em> when <C>ENFORCE_BUDGET_CAP</C> is set on the deployment (accepted
        values: <C>1</C>, <C>true</C>, <C>yes</C>). Without it they still track and alert, but every
        call proceeds.
      </P>
      <Callout kind="why">
        The default is off because <C>monthly_cap_usd</C> ships at a very high value that nobody
        chose. Enforcing it on upgrade would have started refusing model calls on instances whose
        cap was never meant to bite. Turn it on deliberately once your caps reflect reality — and do
        turn it on before exposing a public embed.
      </Callout>
      <Callout kind="warn" title="The check fails open — unless you say otherwise">
        Cap evaluation happens before a call is dispatched. If the spend <em>lookup itself</em>{" "}
        errors, work continues by default rather than the platform bricking itself over an
        accounting question — enforcement is a cost control, not a security boundary, and an outage
        in it should not take down your agents.
        <br />
        <br />
        Set <C>BUDGET_FAIL_CLOSED=true</C> to invert that and have an unknown figure refuse the call
        instead. Either way the failure is logged; the difference is whether an unreadable number is
        treated as "probably fine" or "not proven safe". Public embeds are the usual reason to
        choose the second.
      </Callout>
      <Callout kind="info" title="Unknown is not zero">
        A failed lookup is recorded as <em>unknown</em>, never as $0 spent. That distinction is the
        whole reason the setting above can exist: for a while both outcomes produced the same
        number, so a slow query silently read as "nothing spent yet" and every cap passed.
      </Callout>

      <H2 id="worked">Worked example: a support bot on a public site</H2>
      <P>
        The shape that costs people money unexpectedly — an embed anyone can use, spending your
        credits, with no login to rate-limit against. Here is the whole configuration, in the order
        it wants doing.
      </P>
      <Steps
        items={[
          {
            title: "Turn enforcement on before the embed is public",
            body: (
              <>
                Set <C>ENFORCE_BUDGET_CAP=true</C> and <C>BUDGET_FAIL_CLOSED=true</C> on the
                deployment, then restart. Without the first, caps only alert. Without the second, a
                spend query that times out reads as "not proven over" and the call proceeds.
              </>
            ),
          },
          {
            title: "Give yourself a personal ceiling",
            body: (
              <>
                <strong>Observe → Budgets</strong>, set <C>monthly_cap_usd</C> to a figure you would
                genuinely be unhappy to exceed. This is the backstop, not the control — everything
                you own counts against it, including your own testing.
              </>
            ),
          },
          {
            title: "Cap the embed key itself",
            body: (
              <>
                This is the one that matters. A scoped cap on the <C>embed_key</C> bounds what that
                one placement can spend, whoever is using it — so a leaked key, or a bot that
                discovers the widget, drains a number you chose rather than your whole allowance.
                Start low; you can raise it once you have a week of real traffic.
              </>
            ),
          },
          {
            title: "Set alert thresholds below the cap",
            body: (
              <>
                Thresholds fire once each per calendar month, at the highest one crossed, so a busy
                afternoon does not produce a stream of mail. Pick values that leave you time to act
                — 50 and 80 give you warning; 95 mostly tells you it already happened.
              </>
            ),
          },
          {
            title: "Check the attribution after a day of traffic",
            body: (
              <>
                In <DocLink to="/docs/analytics">Analytics</DocLink>, confirm the embed's calls are
                landing against the key and not just against you. If they are not scoped, the
                per-key cap has nothing to measure and only the personal cap is holding.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="A cap is a ceiling, not a brake">
        Enforcement is checked before a call is dispatched, and month-to-date spend is cached
        briefly, so the last few calls before a cap engages can carry you slightly past it. Size the
        cap as "the most I am willing to lose", not "the exact amount I will be billed", and pair it
        with rate limits — see <DocLink to="/docs/embedding">Embedding</DocLink>.
      </Callout>

      <H2 id="how-cost-is-computed">How a number becomes a cost</H2>
      <P>
        Every figure on this page is an <strong>estimate the platform computes</strong>, not an
        invoice line from your provider. Knowing the two places it can drift keeps you from
        reconciling the wrong thing at month end.
      </P>

      <H3 id="cost-tokens">Tokens: measured, or approximated</H3>
      <P>
        When a provider returns a <C>usage</C> block, those counts are used verbatim. When it does
        not — some streaming responses, some gateways — the text is approximated at roughly one
        token per 3.8 characters, and the trace is marked <C>tokens_estimated</C> so you can tell
        the two apart in <DocLink to="/docs/analytics">Analytics</DocLink>.
      </P>

      <H3 id="cost-price">Price: resolved per provider, per model</H3>
      <P>
        The same model does not cost the same everywhere — a gateway adds a margin, a cloud has its
        own rate card — so price is looked up by <em>provider and model together</em>, in this
        order:
      </P>
      <Table
        headers={["Layer", "Where it comes from", "Why it wins"]}
        rows={[
          [
            "Operator override",
            "Set by an admin",
            "Committed-use and enterprise-agreement rates are not list price, and no public source knows yours",
          ],
          [
            "Synced catalog",
            "Public price data vendored into the repo",
            "Broad coverage, reviewed in version control rather than fetched at runtime",
          ],
          ["Bundled table", "Ships with the app", "Keeps an air-gapped install pricing its calls"],
          [
            "Self-hosted",
            "Ollama, vLLM",
            "Runs on hardware you already pay for — a known zero, not an unknown one",
          ],
        ]}
      />
      <Callout kind="warn" title="A model nobody has priced counts as $0">
        If none of those layers knows a model, the call is recorded with real tokens and a cost of
        zero, and the trace is flagged <C>pricing_missing</C>. It still appears in your usage; it
        contributes nothing to a cap. Filter for that flag before trusting a monthly total, and add
        an override for anything that shows up.
      </Callout>
      <Callout kind="info">
        Historical rows keep the price that applied when they were written. A vendor changing their
        rate does not silently rewrite last quarter's spend — which is what you want for an audit,
        and what to remember when a figure disagrees with today's price sheet.
      </Callout>

      <H2 id="reduce">Reducing spend</H2>
      <UL>
        <li>
          <strong>Use smaller models for mechanical steps.</strong> Routing, classification and
          extraction rarely need a frontier model — and in a swarm, each node picks its own.
        </li>
        <li>
          <strong>Retrieve less.</strong> Fewer, better chunks beat many mediocre ones on both cost
          and accuracy.
        </li>
        <li>
          <strong>Shorten conversations.</strong> Memory summarisation exists so a long chat doesn't
          resend everything forever.
        </li>
        <li>
          <strong>Cap loop iterations</strong> in swarms. An unbounded loop is the classic runaway.
        </li>
        <li>
          <strong>Import rather than direct-query</strong> for dashboards many people open.
        </li>
        <li>
          <strong>Check Analytics for the top spender.</strong> It is usually one agent or one
          integration, not a broad increase.
        </li>
      </UL>

      <H2 id="retention">Retention</H2>
      <P>
        Cost isn't the only thing worth bounding. Three retention windows are configurable, and each
        is enforced by a scheduled purge:
      </P>
      <Table
        headers={["Data", "Where to set it", "Default"]}
        rows={[
          [
            "Chat history and generated documents",
            <>
              Agent Builder → Memory (
              <DocLink key="c" to="/docs/agents">
                per agent
              </DocLink>
              )
            </>,
            "7 days (minimum 7; can be increased)",
          ],
          [
            "Embed transcripts",
            <DocLink key="e" to="/docs/embedding">
              Per embed key
            </DocLink>,
            "30 days",
          ],
          ["Audit events", "Retained long-term, with export", "365 days"],
        ]}
      />
      <P>
        When chat history is purged, the generated documents stored with it are deleted from storage
        too — the file doesn't outlive the conversation that produced it.
      </P>
      <Callout kind="info">
        Retention is a privacy control as much as a storage one. The shortest window that still
        serves your purpose is the right answer, particularly for public embeds where strangers type
        personal details into a chat box.
      </Callout>

      <H3 id="alerts">Alerts</H3>
      <P>
        A budget warns before it stops anything — a hard stop at 100% with no warning is how a team
        finds out by being blocked. Thresholds default to <strong>50%, 75% and 90%</strong>, and
        each one emails once per month: the check runs after every model call, so "notify on
        crossing" has to mean once. Crossing 100% sends its own message, tracked separately so a 90%
        warning cannot suppress it.
      </P>
      <Table
        headers={["Scope", "Who is emailed", "Default"]}
        rows={[
          [
            "Personal cap",
            "The person whose budget it is",
            <>
              On — see <strong key="a">Observe → Budgets</strong>
            </>,
          ],
          [
            "Group cap",
            "Superadmins — the people who can raise it",
            <>
              <strong key="b">Off</strong> — enable per group under Admin → IAM → Budgets
            </>,
          ],
        ]}
      />
      <Callout kind="why" title="A team alert goes to admins, not to the team">
        Only a superadmin can raise a group cap, so they are the people who can act on the warning.
        Mailing every member would also publish the team's total spend to the whole team, which is a
        disclosure decision nobody made when they set a budget. If you want members notified, that
        should be a deliberate choice rather than a side effect of capping them.
      </Callout>
      <Callout kind="info" title="Alerting and enforcing are separate switches">
        A group can be warned without being blocked, and blocked without being warned. That is what
        makes it safe to introduce a cap: turn alerts on first, watch a month of real spend against
        the number you guessed, and enable enforcement once you know the guess was right.
      </Callout>

      <H3 id="attribution">Attribution</H3>
      <P>
        Every model call is recorded with the user, agent and credential that caused it, so spend
        can be traced to a person, a swarm, an embed key or an API key. See{" "}
        <DocLink to="/docs/analytics">Analytics &amp; audit</DocLink>.
      </P>

      <NextPrev current="/docs/budgets" />
    </>
  );
}
