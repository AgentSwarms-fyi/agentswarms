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
      <P>
        Budgets are set in <strong>Observe → Budgets</strong>, and per group in{" "}
        <strong>Admin → IAM → Budgets</strong>. A cap can attach to:
      </P>
      <FieldList
        items={[
          { name: "A user", body: "One person's total spend over the period." },
          { name: "A group", body: "Everyone in an IAM group, shared." },
          {
            name: "An embed key",
            body: "A public placement. The single most important one to set.",
          },
          { name: "A swarm API key", body: "One integration's ceiling." },
        ]}
      />
      <P>
        Where several caps apply, the <strong>most restrictive wins</strong>. A user with a $50 cap
        in a group capped at $20 is limited to $20.
      </P>
      <Callout kind="why">
        Caps are evaluated before a call is dispatched and the check <em>fails open</em> — if the
        budget service itself errors, work continues rather than the platform bricking itself over
        an accounting question. That's a deliberate trade: enforcement is a cost control, not a
        security boundary, and an outage in it shouldn't take down your agents.
      </Callout>
      <P>
        Hard enforcement is opt-in via <C>ENFORCE_BUDGET_CAP</C> on a self-hosted deployment.
        Without it, caps still track and alert but do not block — which is the right default for a
        team instance and the wrong one for a public embed.
      </P>

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
        A budget can notify at a threshold before it stops anything — a warning at 80% is more
        useful than a hard stop at 100% with no warning. Notifications appear in-app and by email
        where email is configured.
      </P>

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
