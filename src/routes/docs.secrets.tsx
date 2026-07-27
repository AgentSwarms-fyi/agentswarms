import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  P,
  Steps,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/secrets")({
  head: () => ({
    meta: [
      { title: "Secrets — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Store credentials once, reference them everywhere, rotate them in one place — and keep them out of prompts and connector forms.",
      },
      { property: "og:title", content: "Secrets — AgentSwarms Documentation" },
      { property: "og:description", content: "One place for credentials, referenced everywhere." },
      { property: "og:url", content: "https://agentswarms.fyi/docs/secrets" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/secrets" }],
  }),
  component: SecretsPage,
});

function SecretsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Integrate & ship"
        title="Secrets"
        description="A vault for the credentials the platform uses on your behalf. Store once, reference by name, rotate in one place."
      />

      <P>
        Open <strong>Configure → Secrets</strong>. Anywhere a credential is needed — a warehouse
        connection, a provider key, an MCP token — you can reference a secret instead of typing the
        value in.
      </P>

      <Callout kind="why">
        The problem isn't storing a key; it's the <em>copies</em>. Paste a warehouse password into
        four connectors and rotation means finding all four, one of which someone set up last year
        and forgot. A reference means the value exists once and every consumer follows it.
      </Callout>

      <H2 id="using">Creating and referencing</H2>
      <Steps
        items={[
          {
            title: "Create the secret",
            body: (
              <>
                Give it a clear name — <C>snowflake_analytics_ro</C> beats <C>key2</C>. Values are
                encrypted at rest with authenticated encryption and are never returned to the
                browser after saving.
              </>
            ),
          },
          {
            title: "Reference it",
            body: "In a connector or provider form, choose the secret instead of pasting a value. The reference is stored, not the credential.",
          },
          {
            title: "Rotate in place",
            body: "Update the value here and every consumer picks it up on its next call. No redeploy, no hunting.",
          },
        ]}
      />

      <H2 id="where">Where secrets can be used</H2>
      <UL>
        <li>
          <DocLink to="/docs/data">Warehouse and database connections</DocLink> — passwords, service
          accounts, key files.
        </li>
        <li>
          <DocLink to="/docs/models">Model provider credentials</DocLink> — API keys, AWS/GCP/Azure
          credentials.
        </li>
        <li>
          <DocLink to="/docs/mcp">MCP server tokens</DocLink>.
        </li>
        <li>Integration credentials — search providers, automation tools, object stores.</li>
      </UL>

      <H2 id="access">Access</H2>
      <P>
        Secrets are private to their owner. An administrator can grant a user or group access from{" "}
        <DocLink to="/docs/iam">Access control</DocLink>, which lets a colleague <em>use</em> a
        secret in a connector without ever seeing its value.
      </P>
      <Callout kind="info">
        Granting access to a secret grants the ability to use it, which is effectively access to
        whatever it unlocks. Grant to groups rather than individuals so leavers are handled by group
        membership rather than an audit of every grant.
      </Callout>

      <H2 id="hygiene">Hygiene</H2>
      <FieldList
        items={[
          {
            name: "Least privilege at the source",
            body: "Create a read-only warehouse user for analytics rather than storing an admin credential. The vault protects the value; it can't reduce what the credential can do.",
          },
          {
            name: "One secret per system per purpose",
            body: "Separate credentials for separate uses means revoking one doesn't break the others, and the audit trail tells you which integration did what.",
          },
          {
            name: "Rotate on a schedule and on departure",
            body: "Anything a leaver could have seen should be rotated, whether or not you think they copied it.",
          },
          {
            name: "Never put credentials in prompts",
            body: "A system prompt is sent to a model provider and shown in traces. Credentials belong here, referenced by the platform, not in text the model can read back to someone.",
          },
        ]}
      />

      <H2 id="at-rest">How they're protected</H2>
      <P>
        Values are encrypted before storage using a workspace encryption key held in the
        environment, not in the database — so a database dump alone doesn't yield credentials. On a
        self-hosted deployment that key is <C>PROVIDER_CREDS_SECRET</C>; back it up somewhere you
        can recover it from, because losing it makes every stored secret unreadable. See{" "}
        <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink>.
      </P>

      <NextPrev current="/docs/secrets" />
    </>
  );
}
