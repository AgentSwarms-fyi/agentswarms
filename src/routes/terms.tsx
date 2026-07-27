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
          "The terms for the AgentSwarms project website and any hosted demo. The software itself is source-available under the Elastic License 2.0 and self-hosted on your own infrastructure.",
      },
      { property: "og:title", content: "Terms of Use — AgentSwarms" },
      {
        property: "og:description",
        content:
          "AgentSwarms is source-available (Elastic License 2.0) and self-hosted. These terms cover the project website and hosted demo.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/terms" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Terms of Use — AgentSwarms" },
      {
        name: "twitter:description",
        content:
          "Source-available (Elastic License 2.0), self-hosted. Terms for the project website and hosted demo.",
      },
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
        <p className="mt-2 text-sm text-muted-foreground">Last updated: July 2026</p>

        <div className="prose prose-invert mt-10 max-w-none space-y-6 text-sm leading-relaxed text-muted-foreground">
          <section>
            <h2 className="text-lg font-semibold text-foreground">1. About these terms</h2>
            <p>
              AgentSwarms is{" "}
              <strong className="text-foreground">
                source-available software licensed under the Elastic License 2.0 (ELv2)
              </strong>
              . Your use of the <em>software itself</em> — running, modifying, and redistributing it
              — is governed by that license, which ships in the repository. These Terms of Use
              additionally govern your use of the public project website at agentswarms.fyi and any
              optional hosted demo the maintainers provide (together, the "Service"). If you don't
              agree, don't use the website or demo.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">2. What AgentSwarms is</h2>
            <p>
              AgentSwarms is a <strong className="text-foreground">self-hosted</strong> platform for
              building and running AI agents, multi-agent swarms and AI-native business intelligence
              — a visual builder, RAG, tools, MCP, dashboards, traces and budgets that you deploy on
              your own infrastructure with your own model-provider keys. It is provided for you to
              operate yourself; it is not a substitute for professional advice in any regulated
              domain (medical, legal, financial, safety-critical, etc.).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">
              3. The Elastic License 2.0 &amp; your deployment
            </h2>
            <p>
              Under ELv2 you may use, copy, modify and redistribute the software, including
              internally and commercially, provided you keep the licensing and copyright notices
              intact. ELv2 adds two limits that a permissive licence does not: you may not provide
              the software to third parties as a hosted or managed service, and you may not
              circumvent its licence-key functionality. A separate commercial licence is available
              from the author for uses ELv2 does not permit. The software is provided "as is",
              without warranty of any kind. You are{" "}
              <strong className="text-foreground">
                solely responsible for your own deployment
              </strong>
              : its security, availability, costs (including model-provider usage), data, and
              compliance with the laws that apply to you and your users. If you host AgentSwarms for
              others, you are their operator and data controller. The{" "}
              <strong className="text-foreground">AgentSwarms name and logo are trademarks</strong>{" "}
              and are not licensed under ELv2 — don't use them to imply endorsement or to pass off a
              modified version as official.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">
              4. Acceptable use (website &amp; hosted demo)
            </h2>
            <p>When using the project website or a hosted demo, you agree not to:</p>
            <ul className="ml-5 list-disc space-y-1">
              <li>Break any law or infringe third-party rights.</li>
              <li>
                Attempt to bypass authentication or rate limits, or probe for vulnerabilities
                outside a coordinated disclosure.
              </li>
              <li>
                Generate disallowed content — including CSAM, content that facilitates real-world
                violence, non-consensual sexual content, targeted harassment, or instructions to
                create weapons of mass harm.
              </li>
              <li>Upload malware or attempt to access other people's data.</li>
            </ul>
            <p className="mt-2">
              How you use the software on your <em>own</em> instance is up to you, within the law
              and your providers' terms. We may suspend access to the website or hosted demo for
              violations of this section.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">5. Your content</h2>
            <p>
              You own the agents, swarms, prompts, dashboards, data and other content you create
              ("Your Content"). On a self-hosted instance it stays in your database — the
              maintainers claim no license to it and never receive it. If you submit content to the
              project website (e.g. the contact form), you grant us only the limited right to use it
              to respond to you.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">6. AI outputs</h2>
            <p>
              Outputs from LLMs, agents and swarms can be inaccurate, incomplete, biased or
              offensive. You are solely responsible for reviewing outputs before relying on or
              sharing them, and must not use them to make consequential decisions about a real
              person without qualified human review.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">7. Third-party services</h2>
            <p>
              AgentSwarms connects to third-party providers you configure (model providers,
              OAuth/SSO identity providers, email, databases, and warehouses). Your use of those
              providers is subject to their terms, and the maintainers are not responsible for their
              outages, changes, or content.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">8. Disclaimers</h2>
            <p>
              THE SOFTWARE AND THE SERVICE ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT
              WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
              PARTICULAR PURPOSE, AND NON-INFRINGEMENT. The maintainers do not warrant that the
              software will be uninterrupted, secure, or error-free, or that AI outputs will be
              accurate.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">9. Limitation of liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE AGENTSWARMS MAINTAINERS AND CONTRIBUTORS
              WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE
              DAMAGES, OR ANY LOSS OF PROFITS, REVENUE, DATA OR GOODWILL, ARISING FROM THE SOFTWARE
              OR THE SERVICE. Because the software is provided free of charge under the Elastic
              License 2.0, the maintainers' total aggregate liability for any claim will not exceed
              USD 0.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">10. Changes to these terms</h2>
            <p>
              We may update these Terms from time to time. Material changes will be noted on the
              site. Continued use of the website or demo after changes take effect constitutes
              acceptance of the updated Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground">11. Contact</h2>
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
