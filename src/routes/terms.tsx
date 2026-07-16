import { createFileRoute, Link } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Use — AgentSwarms" },
      {
        name: "description",
        content:
          "The terms that govern your use of AgentSwarms — the hands-on learning playground for Agentic AI.",
      },
      { property: "og:title", content: "Terms of Use — AgentSwarms" },
      {
        property: "og:description",
        content: "The terms that govern your use of AgentSwarms.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/terms" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Terms of Use — AgentSwarms" },
      { name: "twitter:description", content: "The terms that govern your use of AgentSwarms." },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/terms" }],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
          <ScrollText className="h-3.5 w-3.5" /> Legal
        </div>
        <h1 className="text-4xl font-bold tracking-tight">Terms of Use</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: June 2026</p>

        <div className="prose prose-invert mt-10 max-w-none space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-lg font-semibold text-foreground">1. Acceptance of terms</h2>
            <p>
              By creating an account or otherwise accessing AgentSwarms (the "Service"), you agree
              to be bound by these Terms of Use ("Terms"). If you do not agree, do not use the
              Service. These Terms form a binding agreement between you and AgentSwarms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">2. What AgentSwarms is</h2>
            <p>
              AgentSwarms is an educational, hands-on playground for learning to design, build,
              evaluate, and operate Agentic AI systems. It includes notebooks, agent and swarm
              builders, evaluation labs, traces, and related tooling.{" "}
              <strong className="text-foreground">
                The Service is hosted in the European Union
              </strong>{" "}
              — application servers, the primary database, file storage, and backups are located in
              EU data centres, and our infrastructure providers operate under SOC 2 Type II, ISO/IEC
              27001, and GDPR compliance frameworks. The Service is provided for learning and
              experimentation — it is not a production runtime, not a regulated decision system, and
              not a substitute for professional advice in any domain (medical, legal, financial,
              safety-critical, etc.).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">3. Your account</h2>
            <p>
              You are responsible for maintaining the security of your account credentials and for
              all activity under your account. You must be at least 13 years old (or the minimum age
              required in your jurisdiction) to use the Service. You agree to provide accurate
              information and to keep it up to date.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">4. Acceptable use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                Use the Service to build or operate systems that violate any law or third-party
                rights.
              </li>
              <li>Attempt to bypass quotas, authentication, billing, or rate limits.</li>
              <li>
                Use the platform's LLM, embedding, or image endpoints to generate disallowed content
                — including CSAM, content that facilitates real-world violence, non-consensual
                sexual content, targeted harassment, or instructions to create weapons of mass harm.
              </li>
              <li>
                Use AgentSwarms to scrape, mirror, or compete directly with the AgentSwarms
                platform, or to train a substantially similar competing service.
              </li>
              <li>
                Upload malware, intentionally exfiltrate other users' data, or probe the platform
                for vulnerabilities outside a coordinated disclosure.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">5. Your content</h2>
            <p>
              You retain ownership of agents, swarms, prompts, notebooks, knowledge sources, and
              other content you create ("Your Content"). You grant AgentSwarms a limited license to
              host, process, and display Your Content solely to operate the Service for you.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">6. AI outputs</h2>
            <p>
              Outputs from LLMs, agents, and swarms run on AgentSwarms can be inaccurate,
              incomplete, biased, or offensive. You are solely responsible for reviewing outputs
              before relying on them or sharing them. Do not use AI outputs to make consequential
              decisions about a real person without qualified human review.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">7. Third-party services</h2>
            <p>
              The Service integrates third-party providers (model providers, OAuth providers, email
              providers, infrastructure providers). Your use of those providers through AgentSwarms
              is also subject to their terms. We are not responsible for outages, changes, or
              content originating from third-party services.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">8. Plans, billing, and limits</h2>
            <p>
              Some features are offered under usage limits, free tiers, or paid plans. We may change
              pricing, quotas, or feature availability with reasonable notice. Free credits and
              trial limits may be revoked if abused.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">9. Termination</h2>
            <p>
              You can stop using the Service at any time and delete your account from the Account
              settings. We may suspend or terminate access to the Service if you violate these
              Terms, abuse the platform, or expose us or other users to material risk.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">10. Disclaimers</h2>
            <p>
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
              WHETHER EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR
              PURPOSE, AND NON-INFRINGEMENT. We do not warrant that the Service will be
              uninterrupted, secure, or error-free, or that AI outputs will be accurate.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">11. Limitation of liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, AGENTSWARMS WILL NOT BE LIABLE FOR ANY
              INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
              PROFITS, REVENUE, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE. Our
              aggregate liability for any claim arising out of the Service will not exceed the
              greater of (a) the amount you paid us in the 12 months preceding the claim, or (b) USD
              50.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">12. Changes to these terms</h2>
            <p>
              We may update these Terms from time to time. Material changes will be highlighted on
              the site or sent by email. Continued use of the Service after changes become effective
              constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">13. Contact</h2>
            <p>
              Questions about these Terms? Email{" "}
              <a className="text-foreground underline" href="mailto:hello@agentswarms.fyi">
                hello@agentswarms.fyi
              </a>{" "}
              or visit our{" "}
              <Link to="/contact" className="text-foreground underline">
                contact page
              </Link>
              . See also our{" "}
              <Link to="/privacy" className="text-foreground underline">
                Privacy Policy
              </Link>
              .
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
