// Public security posture page.
//
// Written for the people who sign, not the people who deploy: an enterprise
// evaluation stalls on questions this page answers, and "read the source" is
// not an answer a procurement reviewer accepts.
//
// EVERY CLAIM HERE IS ONE THE CODE ACTUALLY MAKES. If a control is not
// implemented it is listed under "What we do not claim" rather than softened
// into something that reads like it exists. A security page that overstates is
// worse than none — it is the first thing a serious reviewer checks, and being
// caught out on one line discredits the rest.
import { createFileRoute } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const Route = createFileRoute("/security")({
  head: () => ({
    meta: [
      { title: "Security — AgentSwarms" },
      {
        name: "description",
        content:
          "How AgentSwarms handles credentials, tenant isolation, auditing and data residency. Self-hosted: your infrastructure, your keys, your data.",
      },
    ],
  }),
  component: SecurityPage,
});

type Item = { title: string; body: string };

const ARCHITECTURE: Item[] = [
  {
    title: "Self-hosted by default",
    body: "You run the container and you own the Supabase project. Application data, embeddings, traces and credentials live in your database, in the region you chose. There is no vendor-side copy and no call-home.",
  },
  {
    title: "Your model keys",
    body: "Model calls go directly from your deployment to the provider you configured, using your key. Prompts and completions are not proxied through us.",
  },
  {
    title: "Data residency follows your infrastructure",
    body: "Residency is whatever your Supabase region and your model provider's region are. Nothing else is involved.",
  },
];

const CREDENTIALS: Item[] = [
  {
    title: "Encrypted at rest, not just in the database",
    body: "Warehouse credentials, SaaS tokens, provider API keys, MCP tokens and integration secrets are AES-256-GCM encrypted in application code before they reach the database, keyed from PROVIDER_CREDS_SECRET. The database stores ciphertext and a per-record IV.",
  },
  {
    title: "Authenticated encryption",
    body: "GCM is authenticated: a tampered ciphertext fails to decrypt rather than returning altered data. A fresh random 96-bit IV is generated per encryption, so identical secrets do not produce identical ciphertext.",
  },
  {
    title: "Never returned to the browser",
    body: "Connection listings deliberately exclude the encrypted field entirely. Secrets are decrypted server-side, at the point of use, and are not sent to any client.",
  },
  {
    title: "Secret references",
    body: "Configuration can hold {{secret:NAME}} pointers resolved per-user at read time, so a shared configuration never embeds the secret itself.",
  },
];

const ISOLATION: Item[] = [
  {
    title: "Row-level security",
    body: "Tenant data is scoped by Postgres RLS policies on the owning user, enforced by the database rather than by application code.",
  },
  {
    title: "Explicit scoping where RLS cannot apply",
    body: "Background work — scheduled refreshes, syncs and swarm runs — executes with a service-role client, where RLS is off. Those paths pass an explicit owner filter, and the tool surface available to them is capped to a hard-coded allow-list of tools that honour it.",
  },
  {
    title: "Shared data is masked in SQL, not in the UI",
    body: "When a dataset is shared, row filters and column masks are applied by a SECURITY DEFINER database function. Masked columns are absent from the result, not hidden by the interface — so there is no view that returns them.",
  },
  {
    title: "Read-only by construction",
    body: "Every query path against a connected database is guarded to reject anything but SELECT/WITH/SHOW/DESCRIBE/EXPLAIN, and connectors are documented to use read-only credentials. Where the vendor supports it, read-only is also asserted at the server.",
  },
];

const GOVERNANCE: Item[] = [
  {
    title: "Tamper-evident audit trail",
    body: "Governed actions are written by database triggers into a hash-chained audit log — each row's hash covers the previous one, so a removed or edited entry breaks the chain. The chain can be verified independently of the database that produced it.",
  },
  {
    title: "Retention and archive",
    body: "Audit events have a configurable retention window with NDJSON archive export. Execution traces and swarm runs have their own retention setting, purged in bounded batches.",
  },
  {
    title: "IAM, groups and model rules",
    body: "Resources are shared through group grants with row filters and column masks. Which models an account may call is governed by allow-list rules.",
  },
  {
    title: "Budgets and full traces",
    body: "Every model call is recorded with user, model, token counts and cost. Monthly caps can be set per user and per group.",
  },
  {
    title: "SAML SSO",
    body: "Enterprise single sign-on is supported via your identity provider.",
  },
];

const NOT_CLAIMED: Item[] = [
  {
    title: "No third-party certification",
    body: "AgentSwarms is not SOC 2, ISO 27001 or HIPAA certified. Because you self-host, the certified boundary in your architecture is your own infrastructure and your Supabase project — the compliance posture of the deployment is yours to assert, and we do not claim it for you.",
  },
  {
    title: "No penetration-test report",
    body: "There is no third-party penetration test to share. The source is available for your own review, which for many buyers is a stronger position than a summary letter.",
  },
  {
    title: "Key management is yours",
    body: "PROVIDER_CREDS_SECRET is an environment variable you set. There is no managed KMS integration, and rotating it re-encrypts nothing automatically — plan a rotation as a deliberate operation.",
  },
];

function Section({ title, blurb, items }: { title: string; blurb?: string; items: Item[] }) {
  return (
    <section className="mt-14">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      {blurb && <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{blurb}</p>}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.title} className="rounded-xl bg-card p-5 ring-1 ring-border">
            <h3 className="text-sm font-semibold text-foreground">{i.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{i.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SecurityPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="mt-6 font-display text-4xl font-semibold tracking-tight text-foreground">
          Security
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-muted-foreground">
          AgentSwarms is self-hosted. The short version of our security model is that we are not in
          the path: your data stays in your Supabase project, your prompts go straight to the model
          provider you chose with the key you supplied, and there is no vendor-side copy of
          anything. What follows is what the software does about the parts you cannot see.
        </p>

        <Section
          title="Architecture"
          blurb="Where your data is, and who can reach it."
          items={ARCHITECTURE}
        />
        <Section
          title="Credential handling"
          blurb="What happens to the keys and tokens you paste in."
          items={CREDENTIALS}
        />
        <Section
          title="Tenant isolation"
          blurb="How one account's data is kept away from another's."
          items={ISOLATION}
        />
        <Section
          title="Governance and auditability"
          blurb="What you can prove after the fact."
          items={GOVERNANCE}
        />
        <Section
          title="What we do not claim"
          blurb="The gaps, stated plainly. A security page that overstates is worse than none — this section is here so your reviewer finds the limits from us rather than from a surprise."
          items={NOT_CLAIMED}
        />

        <section className="mt-14 rounded-xl bg-card p-6 ring-1 ring-border">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Reporting a vulnerability
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Please report suspected vulnerabilities privately rather than opening a public issue.
            Use GitHub&rsquo;s private security advisory on the repository, or the security contact
            in <span className="font-mono text-xs">SECURITY.md</span>. Tell us what you did, what
            you expected and what happened; a proof of concept helps. We will acknowledge, keep you
            updated while we investigate, and credit you when a fix ships unless you would rather we
            did not.
          </p>
        </section>

        <p className="mt-10 text-xs text-muted-foreground">
          Self-hosting means most of these controls are ones you operate rather than ones we run for
          you. Deployment guidance, including the environment variables referenced here, is in{" "}
          <span className="font-mono">docs/DEPLOYMENT.md</span>.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
