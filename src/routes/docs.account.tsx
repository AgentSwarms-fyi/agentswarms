import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, FieldList, H2, NextPrev, Note, P } from "@/components/docs/DocsShell";

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
        Spend controls live at <DocLink to="/docs/analytics">/budgets</DocLink> (linked from the
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

      <NextPrev current="/docs/account" />
    </>
  );
}
