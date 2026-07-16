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
          "How AgentSwarms collects, uses, and protects your data. Built privacy-first with row-level security on every user record.",
      },
      { property: "og:title", content: "Privacy Policy — AgentSwarms" },
      { property: "og:url", content: "https://agentswarms.fyi/privacy" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Privacy Policy — AgentSwarms" },
      {
        name: "twitter:description",
        content: "How AgentSwarms collects, uses, and protects your data.",
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
        <p className="mt-2 text-sm text-muted-foreground">Last updated: June 2026</p>

        <div className="prose prose-invert mt-10 max-w-none space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-lg font-semibold text-foreground">Who we are</h2>
            <p>
              AgentSwarms ("we", "us") is an educational platform for Agentic AI. This policy
              explains what data we collect when you use{" "}
              <Link to="/" className="text-primary hover:underline">
                agentswarms.fyi
              </Link>
              , how we use it, and how you can control it.
            </p>
            <p className="mt-2">
              We adhere to the{" "}
              <strong className="text-foreground">
                UAE Personal Data Protection Law (PDPL) — Federal Decree-Law No. 45 of 2021
              </strong>
              . You have the right to access, correct, port, restrict, or permanently delete your
              personal data, and to withdraw consent at any time.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">What we collect</h2>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Account info:</strong> email address, display
                name, first/last name, avatar, role, designation, organization, and bio (only fields
                you provide).
              </li>
              <li>
                <strong className="text-foreground">Authentication data:</strong> hashed password or
                Google/Apple OAuth identifier, plus the session tokens needed to keep you signed in.
              </li>
              <li>
                <strong className="text-foreground">Project data:</strong> agents, swarm node
                graphs, knowledge bases, prompts, skills, chats, and any files you upload. Visible
                only to you.
              </li>
              <li>
                <strong className="text-foreground">Usage data:</strong> traces of model calls
                (provider, tokens, latency, cost), gateway usage counters, and aggregated page
                analytics — used so you can monitor your own usage and so we can understand product
                use.
              </li>
              <li>
                <strong className="text-foreground">Contact form:</strong> if you write to us via
                /contact, we store your name, email, and message so we can reply.
              </li>
              <li>
                <strong className="text-foreground">Provider credentials:</strong> third-party API
                keys you choose to save are encrypted at rest.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Why we collect it (purposes)</h2>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Provide the service:</strong> save your session
                state, persist your agents/swarms/knowledge bases between visits, and route model
                calls.
              </li>
              <li>
                <strong className="text-foreground">Account &amp; security:</strong> authenticate
                sign-ins, send password-reset and email-change confirmations, prevent abuse.
              </li>
              <li>
                <strong className="text-foreground">Transactional email:</strong> welcome message,
                contact-form replies, certificate delivery, budget alerts you opt into.
              </li>
              <li>
                <strong className="text-foreground">Product updates:</strong> occasional updates
                about new features (you can unsubscribe from any non-essential email at any time).
              </li>
              <li>
                <strong className="text-foreground">Product improvement:</strong> anonymous
                aggregate analytics — only after you opt in via the cookie banner.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Cookies &amp; tracking</h2>
            <p>
              AgentSwarms uses only the{" "}
              <strong className="text-foreground">strictly essential cookies</strong> required to
              keep you signed in (Supabase auth tokens) and to remember your theme. We do{" "}
              <strong className="text-foreground">not</strong> place any advertising or cross-site
              tracking cookies.
            </p>
            <p className="mt-2">
              Optional analytics (Google Analytics / Google Tag Manager) only load{" "}
              <strong className="text-foreground">after you click "Accept all"</strong> in our
              cookie banner. If you decline, no analytics scripts are loaded and no analytics
              cookies are set. You can clear your choice from your browser's site data at any time
              to be re-prompted.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">
              How long we keep your data (retention)
            </h2>
            <ul className="ml-5 list-disc space-y-2">
              <li>
                <strong className="text-foreground">Account &amp; project data:</strong> retained
                for as long as your account exists. When you delete your account from{" "}
                <Link to="/account" className="text-primary hover:underline">
                  account settings
                </Link>
                , all linked records (profile, agents, swarms, knowledge bases, chats, traces,
                credentials) are permanently removed immediately via database cascade.
              </li>
              <li>
                <strong className="text-foreground">
                  Execution traces &amp; observability data:
                </strong>{" "}
                automatically purged after <strong className="text-foreground">30 days</strong>.
              </li>
              <li>
                <strong className="text-foreground">Contact form submissions:</strong> kept for up
                to <strong className="text-foreground">24 months</strong> for support follow-ups,
                then deleted.
              </li>
              <li>
                <strong className="text-foreground">Email suppression list:</strong> kept
                indefinitely so we honour unsubscribes and bounces.
              </li>
              <li>
                <strong className="text-foreground">Backups:</strong> rolling encrypted backups are
                retained for up to <strong className="text-foreground">30 days</strong> and then
                overwritten.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">
              Security &amp; hosting location
            </h2>
            <p>
              <strong className="text-foreground">
                AgentSwarms is hosted in the European Union.
              </strong>{" "}
              Application servers, the primary database, file storage, and encrypted backups are all
              located in EU data centres, so your personal data stays within the EU/EEA at rest. All
              user data is protected by row-level security at the database layer — meaning queries
              can only return rows the requesting user owns. Provider API keys you enter are
              encrypted at rest. We use industry-standard TLS for all traffic, and our
              infrastructure providers operate under{" "}
              <strong className="text-foreground">SOC 2 Type II</strong>,{" "}
              <strong className="text-foreground">ISO/IEC 27001</strong>, and{" "}
              <strong className="text-foreground">GDPR</strong> compliance frameworks.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Third-party AI providers</h2>
            <p>
              When you run an agent, your prompts are sent to the AI provider you've selected (e.g.
              OpenAI, Anthropic, Google). Their policies apply to that data. We never log raw prompt
              content beyond what's shown in your own trace inspector.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Your rights under UAE PDPL</h2>
            <p>
              You may request access, correction, transfer, restriction, or deletion of your
              personal data, and withdraw consent at any time. Most rights can be exercised directly
              from{" "}
              <Link to="/account" className="text-primary hover:underline">
                your account settings
              </Link>
              ; for anything else, contact us below. Account deletion is permanent and immediate.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">Contact</h2>
            <p>
              Questions about this policy or a PDPL data request? Use the{" "}
              <Link to="/contact" className="text-primary hover:underline">
                contact form
              </Link>{" "}
              and we'll respond within 1–2 business days.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
