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
          [
            "Settings",
            "Public-signup toggle, the default model-access policy (allow vs deny), trace retention, and the current superadmin list",
          ],
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
        Control which models a person may run. What "no rules" means is an instance choice —{" "}
        <strong>Settings → Default model access</strong>:
      </P>
      <Table
        headers={["Situation", "Allow by default (the default)", "Deny by default"]}
        rows={[
          [
            "User has no rules, and no group with rules",
            "Unrestricted — every model available",
            "No models at all, until a rule allow-lists them",
          ],
          [
            "Rules apply (their own or a group's)",
            "Allowed = the union of those rules",
            "Allowed = the union of those rules (identical)",
          ],
          [
            "Superadmin",
            "Rules apply to them like anyone else",
            "Bypasses entirely — the lock's administrator can't be locked out",
          ],
          [
            <>
              Rule is <C key="p">openai</C> + <C key="m">*</C>
            </>,
            "Every model from that provider",
            "Every model from that provider",
          ],
          [
            <>
              Rule is <C key="p2">openrouter</C> + <C key="m2">openai/*</C>
            </>,
            "Prefix match — those models only",
            "Prefix match — those models only",
          ],
        ]}
      />
      <Callout kind="info" title="Flipping to deny is safe to stage">
        The toggle changes nothing for anyone who already has rules, and superadmins are never
        affected — so the sensible order is: write the allow-lists under this tab, spot-check a
        non-admin account, then flip. Users denied by the default get a clear "not permitted by the
        workspace's policy" error, not a hang.
      </Callout>
      <Callout kind="why">
        Union, not intersection. Someone in two groups gets what either allows — because groups are
        additive grants of capability, and an intersection would mean adding a group could take
        access away, which nobody expects.
      </Callout>
      <P>
        Enforcement is server-side at the point every chat request is dispatched, so it covers the
        playground, saved agents, swarm nodes, API runs — and <strong>public embeds</strong>, which
        execute their owner's stored model for anonymous visitors and are checked against the
        owner's effective rules on every request. Pickers also filter to allowed models, but that's
        convenience — the check that matters happens on the request. Disallowed models return a
        clear error rather than failing obscurely.
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

      <H3 id="row-column-security">Narrowing a grant: row filters and column masks</H3>
      <P>
        Sharing a dataset or dashboard does not have to mean sharing all of it. Two optional
        restrictions can be attached to a grant on a <strong>SQL data table</strong> or a{" "}
        <strong>BI dashboard</strong> — the two types that serve rows. Neither applies to the other
        eight, and the platform refuses to save them there.
      </P>
      <Table
        headers={["Restriction", "Shape", "Effect on the grantee"]}
        rows={[
          [
            "Row filter",
            <>a column and a list of values</>,
            "They see only rows where that column matches one of those values",
          ],
          [
            "Column mask",
            "a list of column names",
            "Those columns are removed server-side — from the column list and from every row",
          ],
        ]}
      />
      <P>
        A regional lead granted the sales table with a row filter of <C>region ∈ (EMEA)</C> and a
        column mask of <C>salary</C> can query the table freely, see only EMEA rows, and never
        receive the salary column in any answer.
      </P>
      <P>
        Both are applied on the server, before the data leaves it — on stored dashboard snapshots,
        on live warehouse queries, and on the rows an agent's SQL tool reads. There is no path that
        applies one and not the others.
      </P>

      <Callout kind="info" title="Grants add up — they never subtract">
        Holding two grants can only ever give you <em>more</em>, never less. Two row filters union:
        a person granted EMEA by one team and APAC by another sees both. A grant carrying{" "}
        <strong>no</strong> row filter admits every row, and a grant carrying <strong>no</strong>{" "}
        column mask hides nothing — so an unrestricted grant makes the restricted ones moot. If you
        need someone narrowed, narrow <em>every</em> grant that reaches them. One deliberate
        exception: documents synced from a connected service can carry a{" "}
        <DocLink to="/docs/knowledge">per-source access scope</DocLink> — "Only me" or "Match source
        permissions" — which filters retrieval <em>inside</em> a granted knowledge base. That
        restriction belongs to the source's owner, not to the grant.
      </Callout>
      <Callout kind="warn" title="A masked column is also unfilterable">
        Hiding a column is not enough on its own: if a viewer could still <em>filter</em> on it,
        they could recover the values by narrowing the range and watching which rows come back.
        Filters naming a masked column are therefore dropped before the query runs, and the response
        says which ones were dropped rather than silently ignoring them.
      </Callout>
      <Callout kind="why" title="A restriction that cannot be checked returns nothing">
        If a result does not carry the filter's column, the filter cannot be evaluated against it —
        and an unevaluated filter counts as unsatisfied, so those rows are withheld. Skipping it
        instead would <em>widen</em> access, which is the opposite of what the person setting it
        asked for.
      </Callout>
      <Callout kind="warn" title="Aggregated widgets go empty for a filtered grantee">
        This is the case you will actually meet. A widget reading{" "}
        <C>SELECT product, sum(revenue) FROM sales GROUP BY product</C> has no <C>region</C> in its
        output, so a grantee filtered to <C>region ∈ (EMEA)</C> sees an empty widget rather than a
        global total that ignores their filter. The fix is to project the filter column — group by{" "}
        <C>region, product</C> — so the rows can be vetted. An empty widget is the restriction
        working, not a broken query.
      </Callout>

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
