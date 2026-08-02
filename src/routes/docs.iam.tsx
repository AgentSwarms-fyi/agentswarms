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
  Steps,
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

      <H2 id="tabs">The six tabs</H2>
      <Table
        headers={["Tab", "What you do there"]}
        rows={[
          [
            "Users",
            "Invite, create, ban, delete; grant/revoke superadmin; manage group membership",
          ],
          ["Groups", "Create, rename, delete groups and manage members"],
          ["Access", "Model rules and resource grants"],
          [
            "Budgets",
            <>
              Per-group spend caps — see{" "}
              <DocLink key="b" to="/docs/budgets">
                Budgets
              </DocLink>
            </>,
          ],
          ["Settings", "Public-signup toggle and the current superadmin list"],
          ["SSO", "SAML identity provider configuration"],
        ]}
      />

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
        Grant a user or group <strong>read-only</strong> access to a resource owned by someone else,
        under <strong>Admin → IAM → Access</strong>. Ten resource types are grantable, enforced by a
        database constraint:
      </P>
      <Table
        headers={["Type", "What the grantee gets"]}
        rows={[
          ["📚 Knowledge base", "Their agents can search it"],
          ["🗄 SQL data table", "Queryable, subject to row filters and column masks"],
          ["🔑 Secret", "Usable by reference; the value is never shown"],
          ["📊 BI dashboard", "Viewable, subject to row filters and column masks"],
          ["🧮 Semantic model", "Its metrics and dimensions become askable"],
          ["🗂 Data catalog source", "Its crawled tables and profiles become browsable"],
          ["🤖 LLM key / ☁️ LLM credential", "Calls bill to the owner's key"],
          ["🏢 Database / warehouse connection", "Queryable — see below"],
          ["🔌 App source", "Syncable — see below"],
        ]}
      />
      <P>
        Recipients see a <em>Shared</em> badge; edit and delete controls are hidden and writes are
        blocked by the database regardless.
      </P>
      <P>
        Because most grants are enforced in row-level security, agent tools inherit them
        automatically — a shared table becomes queryable by that user's agents with no extra wiring.
      </P>

      <H3 id="shared-connections">Shared connections run as their owner</H3>
      <P>
        Connections are the exception to the row-level rule, because those rows carry an encrypted{" "}
        <strong>credential</strong>. There is deliberately <strong>no</strong> row-level policy
        granting a recipient access to them — that would let a grantee fetch the ciphertext straight
        from the API with their own token. Instead the grant is resolved server-side and the row is
        loaded with the service role, so a grantee gains the <em>use</em> of a connection without
        ever receiving it. <C>{"{{secret:NAME}}"}</C> references resolve as the owner too, never
        against the grantee's own vault.
      </P>
      <P>
        A shared <strong>app source</strong> syncs as its owner, into the owner's datasets — so a
        grantee re-running a stale sync refreshes the real datasets rather than building a parallel
        copy under their own account. Sharing the source lets someone keep it healthy; to let them
        read the resulting data, share those datasets too. Grants are resolved fresh on every call,
        including scheduled runs, so revoking one takes effect on the next use.{" "}
        <DocLink to="/docs/data#sharing">Full details in Data sources</DocLink>.
      </P>
      <P>
        BI dashboard grants can additionally carry a <strong>row filter</strong> (the grantee only
        sees rows where a column matches allowed values) and <strong>hidden columns</strong>{" "}
        (removed from every result). Both are enforced server-side: a restricted grantee's data is
        filtered and masked before it leaves the server, on stored snapshots and live queries alike.
        Union semantics apply — one unrestricted grant makes the dashboard fully visible, and a
        column is hidden only when every applicable grant hides it.
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

      <H3 id="worked">Worked example — onboarding an analytics team</H3>
      <Steps
        items={[
          {
            title: "Groups → New group",
            body: (
              <>
                Name it <C>analytics</C>. Groups are how you avoid granting things person by person.
              </>
            ),
          },
          {
            title: "Users → Add user → Invite by email",
            body: "They set their own password, so no credential passes through you. Repeat for the team, then add each to analytics from their row.",
          },
          {
            title: "Access → Model rules → principal: group analytics",
            body: (
              <>
                Add <C>openai</C> + <C>gpt-4o-mini</C> and <C>openai</C> + <C>gpt-4o</C>. The team
                is now restricted to those two; everyone outside the group is still unrestricted
                unless a rule applies to them.
              </>
            ),
          },
          {
            title: "Access → Resource grants",
            body: (
              <>
                Grant <C>analytics</C> read access to the <C>revenue</C> data table and the{" "}
                <C>Finance policies</C> knowledge base. Their agents can now query both with no
                further wiring.
              </>
            ),
          },
          {
            title: "Budgets → new cap, scope group analytics",
            body: "Set a monthly USD ceiling before handing out access, not after the first surprise.",
          },
          {
            title: "Settings → turn OFF public signup",
            body: "Do this before you share the URL. Invitations and admin-created users keep working.",
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
