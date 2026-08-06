import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — AgentSwarms" },
      {
        name: "description",
        content:
          "How AgentSwarms handles data. It's source-available and self-hosted, so your data stays on your own infrastructure — the maintainers never receive it. The project website collects only what's needed to reply to you.",
      },
      { property: "og:title", content: "Privacy Policy — AgentSwarms" },
      { property: "og:url", content: "https://agentswarms.fyi/privacy" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Privacy Policy — AgentSwarms" },
      {
        name: "twitter:description",
        content:
          "Open-source and self-hosted: your data stays on your own infrastructure and never reaches the maintainers.",
      },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1776452942019-Captsvvsvsure.webp",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1776452942019-Captsvvsvsure.webp",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/privacy" }],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
          <ShieldCheck className="h-3.5 w-3.5" /> Privacy
        </div>
        <h1 className="text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: July 2026</p>

        <div className="prose prose-invert mt-10 max-w-none space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-lg font-semibold text-foreground">
              Open source &amp; self-hosted — the short version
            </h2>
            <p>
              AgentSwarms is <strong className="text-foreground">source-available software</strong>{" "}
              (Elastic License 2.0 licensed) that you run on{" "}
              <strong className="text-foreground">your own infrastructure</strong>. When you deploy
              it, everything it stores — your account, agents, swarms, knowledge bases, chats,
              dashboards, execution traces and provider keys — lives in{" "}
              <strong className="text-foreground">your own database and file storage</strong> and is
              processed with{" "}
              <strong className="text-foreground">your own model-provider keys</strong>. The
              AgentSwarms maintainers do not host that data, cannot see it, and never receive it.
            </p>
            <p className="mt-2">
              This policy therefore covers two separate things: (1) this public project website,{" "}
              <Link to="/" className="text-primary hover:underline">
                agentswarms.fyi
              </Link>
              , which the maintainers operate; and (2) how the software handles data when{" "}
              <em>you</em> self-host it. It is not legal advice — if you deploy AgentSwarms for
              other people, you become the data controller for those users and should publish your
              own privacy notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">
              1. Data the project website collects
            </h2>
            <p>The marketing and documentation site at agentswarms.fyi collects very little:</p>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Contact form:</strong> if you write to us via{" "}
                <Link to="/contact" className="text-primary hover:underline">
                  /contact
                </Link>
                , we store your name, email, and message so we can reply.
              </li>
              <li>
                <strong className="text-foreground">Optional analytics:</strong> none by default. A
                deployment's operator can configure their own analytics ID, in which case anonymous,
                aggregate page analytics load <strong className="text-foreground">only</strong>{" "}
                after you click "Accept all" in the cookie banner. With no ID configured there is no
                banner and no analytics at all; decline, and nothing loads either way.
              </li>
              <li>
                <strong className="text-foreground">Essential cookies:</strong> only what's needed
                to remember your theme and, if you sign in to a hosted demo, keep that session.
              </li>
            </ul>
            <p className="mt-2">
              We do not sell data, run advertising, or use cross-site tracking.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">
              2. Data your self-hosted instance stores
            </h2>
            <p>
              When you run your own AgentSwarms instance, it stores the following{" "}
              <strong className="text-foreground">in your database</strong>, under your control —
              never transmitted to the maintainers:
            </p>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Account info:</strong> email, display name,
                avatar, role, organization and bio (only fields a user provides).
              </li>
              <li>
                <strong className="text-foreground">Authentication:</strong> hashed passwords or
                OAuth/SSO identifiers and the session tokens that keep users signed in — handled by
                your own Supabase project.
              </li>
              <li>
                <strong className="text-foreground">Project data:</strong> agents, swarm graphs,
                knowledge bases, prompts, skills, chats, dashboards, datasets and uploaded files,
                protected by row-level security so each user only sees their own rows (plus anything
                an admin explicitly shares).
              </li>
              <li>
                <strong className="text-foreground">Usage &amp; traces:</strong> model-call traces
                (provider, tokens, latency, cost) and audit events, so operators and users can
                monitor their own usage.
              </li>
              <li>
                <strong className="text-foreground">Provider credentials:</strong> third-party API
                keys are encrypted at rest and write-only — never returned to the browser after
                saving.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">3. Third-party AI providers</h2>
            <p>
              When an agent or dashboard runs, prompts and data are sent{" "}
              <strong className="text-foreground">directly from your instance</strong> to the AI
              provider you configured (e.g. OpenRouter, OpenAI, Anthropic, Google, or a self-hosted
              model) using your keys. Those providers' policies apply to that traffic. Prompts are
              never routed through, or logged by, the AgentSwarms maintainers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">4. Retention &amp; deletion</h2>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Self-hosted data:</strong> retention is up to
                you, the operator. Execution traces and audit logs auto-purge on a configurable
                schedule (30 days by default), and deleting a user account cascades to remove all of
                that user's linked records immediately via the database.
              </li>
              <li>
                <strong className="text-foreground">Website contact submissions:</strong> kept only
                as long as needed to handle your request, then deleted.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">5. Security</h2>
            <p>
              The software enforces <strong className="text-foreground">row-level security</strong>{" "}
              at the database layer, encrypts stored provider credentials, and uses TLS for API
              traffic. Where and how securely your instance is hosted — the region, the database,
              the backup policy — is determined by <strong className="text-foreground">your</strong>{" "}
              infrastructure choices, not the maintainers'.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">6. Your rights</h2>
            <p>
              Applicable data-protection laws (such as the{" "}
              <strong className="text-foreground">GDPR</strong> and the{" "}
              <strong className="text-foreground">UAE PDPL</strong>) give people the right to
              access, correct, port, restrict, or delete their personal data and to withdraw
              consent. For data held by a <em>self-hosted</em> instance, exercise those rights with
              that instance's operator — most are available directly from{" "}
              <Link to="/account" className="text-primary hover:underline">
                account settings
              </Link>
              , and account deletion is permanent and immediate. For the limited data the project
              website holds, contact us below.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">7. Contact</h2>
            <p>
              Questions about this policy or the project website's data? Use the{" "}
              <Link to="/contact" className="text-primary hover:underline">
                contact form
              </Link>{" "}
              and we'll respond within 1–2 business days. For data on a specific self-hosted
              deployment, contact whoever operates that instance.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
