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

export const Route = createFileRoute("/docs/iam")({
  head: () => ({
    meta: [
      { title: "Access control — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Users, groups, superadmins, model rules and resource sharing — plus invite-only signup and SSO.",
      },
      { property: "og:title", content: "Access control — AgentSwarms Documentation" },
      { property: "og:description", content: "Who can use what, enforced in the database." },
      { property: "og:url", content: "https://agentswarms.fyi/docs/iam" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/iam" }],
  }),
  component: IamPage,
});

function IamPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Govern & operate"
        title="Access control"
        description="Provision people, put them in groups, control which models they may run, and share data read-only — enforced in the database, not just hidden in the interface."
      />

      <P>
        Open <strong>Admin → IAM</strong> (superadmins only). Everything here is enforced by
        row-level security in the database, which is the reason it holds: an agent, an API call and
        the UI all hit the same rules, so there is no path that quietly bypasses them.
      </P>

      <H2 id="roles">Roles</H2>
      <P>
        There are two: <strong>superadmin</strong> and everyone else. The account named by{" "}
        <C>ADMIN_EMAIL</C> is the permanent bootstrap superadmin — it keeps the role even if its row
        is deleted, so you cannot lock yourself out. Superadmins can promote and demote others.
      </P>
      <Callout kind="info">
        Guardrails you'd expect are enforced: you can't demote, ban or delete the last superadmin,
        and you can't ban or delete yourself.
      </Callout>

      <H2 id="users">Users</H2>
      <P>Two ways to add someone:</P>
      <UL>
        <li>
          <strong>Email invitation</strong> — they set their own password. Preferred; no credential
          ever passes through you.
        </li>
        <li>
          <strong>Manual with a temporary password</strong> — for when email delivery isn't
          configured or you're provisioning in bulk. Have them change it.
        </li>
      </UL>
      <P>
        Users can be banned (blocks sign-in, preserves their content) or deleted. Ban first when
        someone leaves — deletion is not reversible.
      </P>

      <H2 id="groups">Groups</H2>
      <P>
        A named set of users. Model rules and resource grants attach to groups, so onboarding
        becomes "add to Engineering" rather than a dozen individual grants — and offboarding becomes
        one removal.
      </P>

      <H2 id="model-rules">Model rules</H2>
      <P>
        Control which models a person may run. The semantics are <strong>default-allow</strong>:
      </P>
      <Table
        headers={["Situation", "Result"]}
        rows={[
          ["User has no rules, and no group with rules", "Unrestricted — every model available"],
          ["Rules apply (their own or a group's)", "Allowed = the union of those rules"],
          [
            <>
              Rule is <C key="p">openai</C> + <C key="m">*</C>
            </>,
            "Every model from that provider",
          ],
          [
            <>
              Rule is <C key="p2">openrouter</C> + <C key="m2">openai/*</C>
            </>,
            "Prefix match — those models only",
          ],
        ]}
      />
      <Callout kind="why">
        Union, not intersection. Someone in two groups gets what either allows — because groups are
        additive grants of capability, and an intersection would mean adding a group could take
        access away, which nobody expects.
      </Callout>
      <P>
        Enforcement is server-side at the point every chat request is dispatched, so it covers the
        playground, saved agents, swarm nodes and API runs alike. Pickers also filter to allowed
        models, but that's convenience — the check that matters happens on the request. Disallowed
        models return a clear error rather than failing obscurely.
      </P>

      <H2 id="sharing">Resource sharing</H2>
      <P>
        Grant a user or group <strong>read-only</strong> access to a knowledge base, data table,
        dashboard or secret owned by someone else. Recipients see a <em>Shared</em> badge; edit and
        delete controls are hidden and writes are blocked by the database regardless.
      </P>
      <P>
        Because grants are enforced in row-level security, agent tools inherit them automatically —
        a shared table becomes queryable by that user's agents with no extra wiring.
      </P>

      <H2 id="signup">Signup policy and SSO</H2>
      <FieldList
        items={[
          {
            name: "Invite-only",
            body: "Turn off public signup and the database itself rejects new accounts that weren't invited or admin-created. Enforced at the trigger, so it also covers OAuth signups.",
          },
          {
            name: "SSO",
            body: "Connect a SAML identity provider so people sign in with your corporate directory. Can be made the enforced path.",
          },
        ]}
      />

      <H3 id="rollout">A sensible rollout</H3>
      <UL>
        <li>
          Sign in as <C>ADMIN_EMAIL</C> and confirm you have the IAM page.
        </li>
        <li>Create groups that mirror how people actually work, not the org chart.</li>
        <li>Turn off public signup before sharing the URL.</li>
        <li>Set model rules on groups — start permissive, tighten with evidence from Analytics.</li>
        <li>Share the data collections teams need read access to, rather than duplicating them.</li>
        <li>
          Pair rules with <DocLink to="/docs/budgets">budget caps</DocLink>: rules decide{" "}
          <em>what</em>, budgets decide <em>how much</em>.
        </li>
      </UL>

      <NextPrev current="/docs/iam" />
    </>
  );
}
