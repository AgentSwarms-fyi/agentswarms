import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  Table,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/account")({
  head: () => ({
    meta: [
      { title: "Account — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Your AgentSwarms account: public profile, password and email changes, sign-out, account deletion, and spend budgets.",
      },
      { property: "og:title", content: "Account — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Your AgentSwarms account: public profile, password and email changes, sign-out, account deletion, and spend budgets.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/account" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Account — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "Your AgentSwarms account: public profile, password and email changes, sign-out, account deletion, and spend budgets.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/account" }],
  }),
  component: AccountDoc,
});

function AccountDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Account"
        description="Account Settings at /account covers your identity and credentials. Spend controls live separately at /budgets."
      />

      <H2 id="settings">Account settings</H2>
      <FieldList
        items={[
          {
            name: "Public Profile",
            body: (
              <>
                Display name, avatar, bio, role, designation, and organization. This is what appears
                on your certification certificate if you earn one — it is not shown anywhere else.
              </>
            ),
          },
          {
            name: "Account",
            body: "Your current sign-in email and provider, read-only.",
          },
          {
            name: "Change Password",
            body: "Set a new password. You stay signed in on the current device.",
          },
          {
            name: "Change Email",
            body: "Enter a new address; the change takes effect after you click the confirmation link sent to it.",
          },
          {
            name: "Session",
            body: "Sign out of AgentSwarms on this device.",
          },
          {
            name: "Delete Account",
            body: "Permanently deletes your account and all associated data — agents, swarms, knowledge bases, runs. Requires explicit confirmation and cannot be undone.",
          },
        ]}
      />

      <H2 id="budgets">Budgets</H2>
      <P>
        Spend controls live at <DocLink to="/docs/budgets">Budgets</DocLink> (linked from the
        sidebar), not on the account page:
      </P>
      <FieldList
        items={[
          {
            name: "Monthly Hard Cap",
            body: "A workspace-wide dollar cap. Agents refuse new requests once month-to-date spend reaches it. The card shows current spend against the cap.",
          },
          {
            name: "Spend Alerts",
            body: "Notifications before you hit the cap, so the hard stop is never a surprise.",
          },
          {
            name: "Agent-Specific Limits",
            body: "Per-agent daily caps, with an optional auto-disable when an agent hits its limit.",
          },
        ]}
      />
      <Note>
        Budget settings save automatically as you change them. Per-agent budget caps can also be set
        inside the <DocLink to="/docs/agents">Agent Builder</DocLink>'s guardrails section.
      </Note>

      <H2 id="what-is-yours">What belongs to your account</H2>
      <Table
        headers={["Owned by you", "Shared with you"]}
        rows={[
          [
            "Agents, swarms, knowledge collections, data tables, prepared tables, dashboards, secrets, notebooks, API and embed keys",
            "Anything an administrator granted you read-only access to — shown with a Shared badge",
          ],
        ]}
      />
      <P>
        Shared resources cannot be edited or deleted by the recipient; the controls are hidden and
        writes are blocked by the database regardless. Grants are managed in{" "}
        <DocLink to="/docs/iam">Access control</DocLink>.
      </P>

      <H2 id="deletion">Deletion and departure</H2>
      <Callout kind="warn">
        Deleting a user cascades to the content they own. If someone leaves and their agents,
        collections or dashboards matter, transfer or duplicate them first — or <strong>ban</strong>{" "}
        the account instead, which blocks sign-in while preserving everything.
      </Callout>
      <P>Ban is almost always the right first move when someone leaves:</P>
      <Table
        headers={["", "Ban", "Delete"]}
        rows={[
          ["Can sign in", "No", "No"],
          ["Their agents, collections, dashboards", "Kept", "Deleted with them"],
          ["Grants they held", "Inert while banned", "Removed"],
          ["Reversible", "Yes — unban", "No"],
        ]}
      />
      <Callout kind="info" title="The audit trail outlives the account">
        Deletion does not erase the record of what the person did. Audit events keep their
        attribution: the link to the account is cleared, and the email captured at the time of the
        action remains on the row — so a leaver cannot be used to launder the history of an action,
        and a compliance question about a departed employee is still answerable. Everything else
        they owned is genuinely gone.
      </Callout>
      <P>
        Retention for that trail is set separately — see{" "}
        <DocLink to="/docs/analytics#retention">Analytics</DocLink>.
      </P>

      <NextPrev current="/docs/account" />
    </>
  );
}
