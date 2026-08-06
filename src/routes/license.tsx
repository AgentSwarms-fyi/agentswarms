// Plain-English licensing and support page.
//
// Written because "read the LICENSE" is not an answer a procurement reviewer
// accepts, and because ELv2 is source-available rather than open source — a
// distinction legal teams care about a great deal and that a badge does not
// convey.
//
// Everything here restates LICENSE.md and README rather than adding to them. If
// the two ever disagree, LICENSE.md governs, and this page is the bug.
import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const Route = createFileRoute("/license")({
  head: () => ({
    meta: [
      { title: "Licensing & Support — AgentSwarms" },
      {
        name: "description",
        content:
          "What the Elastic License 2.0 permits: self-hosting, modification, internal and client use. What it does not: offering AgentSwarms as a hosted service. Commercial licensing and support options.",
      },
    ],
  }),
  component: LicensePage,
});

type Scenario = { q: string; a: "yes" | "no" | "ask"; body: string };

/**
 * The questions procurement actually asks, answered directly.
 *
 * A yes/no verdict first, then the reasoning. A page of prose that never
 * commits to an answer is what sends someone to a lawyer instead of to a
 * signature.
 */
const SCENARIOS: Scenario[] = [
  {
    q: "Can we run it inside our company for our own staff?",
    a: "yes",
    body: "Yes, on any number of machines, for any number of employees, with no fee and no registration. This is the case ELv2 is designed to allow.",
  },
  {
    q: "Can we modify the source?",
    a: "yes",
    body: "Yes. Fork it, patch it, build your own features on top. You may not remove or obscure the licensing and copyright notices.",
  },
  {
    q: "Can we redistribute it, or ship it inside our own product?",
    a: "yes",
    body: "Yes, provided it still carries the licence and notices, and provided you are not offering it to third parties as a hosted or managed service.",
  },
  {
    q: "Can a consultancy deploy it for a client?",
    a: "yes",
    body: "Yes. Installing, configuring and operating it on infrastructure the client owns is ordinary use. What is not permitted is you hosting it and selling access to it as your own service.",
  },
  {
    q: "Can we offer it to our customers as a hosted or managed service?",
    a: "no",
    body: 'No. This is the one substantive restriction in ELv2 and the reason the project is source-available rather than open source. A separate commercial licence covers this — it is available, so the answer is really "not under this licence".',
  },
  {
    q: "Can we strip out the licence-key or notice functionality?",
    a: "no",
    body: "No. ELv2 explicitly prohibits circumventing licence-key functionality and removing or obscuring the licensing, copyright or other notices.",
  },
  {
    q: "Can we use the AgentSwarms name or logo for our deployment?",
    a: "no",
    body: "No. The name, logo and hosted service are trademarks of the project author. ELv2 licenses the code, not the brand — rename your deployment.",
  },
  {
    q: "Do we owe anything if we exceed some usage threshold?",
    a: "no",
    body: "No. There is no seat count, no usage metering and no telemetry. The licence does not vary with how much you use it.",
  },
  {
    q: "Are the dependencies a problem for redistribution?",
    a: "no",
    body: "No. Every direct dependency is permissively licensed (MIT / Apache-2.0 / ISC / BSD). The full audit is in ACKNOWLEDGEMENTS.md in the repository.",
  },
  {
    q: "We need an indemnity, a warranty, or a signed agreement.",
    a: "ask",
    body: "ELv2 is provided as-is with no warranty, like most software licences of its kind. If your procurement requires an indemnity or a negotiated contract, that is a commercial licence conversation rather than a limitation of the software.",
  },
];

const VERDICT: Record<Scenario["a"], { label: string; cls: string }> = {
  yes: {
    label: "Yes",
    cls: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400",
  },
  no: { label: "No", cls: "bg-destructive/10 text-destructive ring-destructive/20" },
  ask: {
    label: "Talk to us",
    cls: "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-500",
  },
};

type Tier = { name: string; price: string; body: string; items: string[] };

/**
 * Support tiers, stated honestly.
 *
 * A project with no support statement is assumed to have nobody behind it.
 * Saying "community only, commercial available" is a stronger position than
 * silence even when tier one is GitHub issues.
 */
const SUPPORT: Tier[] = [
  {
    name: "Community",
    price: "Included",
    body: "How most people use the project.",
    items: [
      "GitHub issues and discussions",
      "Full documentation in the repository",
      "Best-effort response, no target time",
      "Public fixes ship in the normal release flow",
    ],
  },
  {
    name: "Commercial",
    price: "Contact us",
    body: "For teams that need an agreement rather than goodwill.",
    items: [
      "A licence covering hosted/managed-service use",
      "Agreed response targets",
      "A named contact and a private channel",
      "Deployment and upgrade assistance",
      "Security questionnaire and procurement support",
    ],
  },
];

function LicensePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="mt-6 font-display text-4xl font-semibold tracking-tight text-foreground">
          Licensing &amp; support
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-muted-foreground">
          AgentSwarms is <strong className="text-foreground">source-available</strong> under the
          Elastic License 2.0 — not open source, and the difference matters to a legal team. In one
          sentence: use it, change it, run it for yourself and your clients freely; do not turn it
          into a hosted service you sell. Everything below restates the{" "}
          <span className="font-mono text-xs">LICENSE.md</span> file rather than adding to it — if
          the two disagree, the licence governs.
        </p>

        <section className="mt-12">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            The questions you are going to be asked
          </h2>
          <div className="mt-5 space-y-3">
            {SCENARIOS.map((s) => (
              <div key={s.q} className="rounded-xl bg-card p-5 ring-1 ring-border">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`inline-flex shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ${VERDICT[s.a].cls}`}
                  >
                    {VERDICT[s.a].label}
                  </span>
                  <h3 className="text-sm font-semibold text-foreground">{s.q}</h3>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Support</h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Self-hosting means you operate it. These are the options for when you would rather not
            do that entirely alone.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {SUPPORT.map((t) => (
              <div key={t.name} className="rounded-xl bg-card p-6 ring-1 ring-border">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-base font-semibold text-foreground">{t.name}</h3>
                  <span className="text-sm font-medium text-muted-foreground">{t.price}</span>
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">{t.body}</p>
                <ul className="mt-4 space-y-2">
                  {t.items.map((i) => (
                    <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                      <span
                        aria-hidden
                        className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary"
                      />
                      {i}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 rounded-xl bg-card p-6 ring-1 ring-border">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            Still not sure which side of the line you are on?
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            The dividing question is almost always: are third parties paying you for access to
            AgentSwarms itself, or are they paying you for something else that happens to use it?
            The second is fine. If you are genuinely unsure,{" "}
            <Link to="/contact" className="font-medium text-primary hover:underline">
              ask
            </Link>{" "}
            — a commercial licence exists precisely so the answer does not have to be no.
          </p>
        </section>

        <p className="mt-10 text-xs text-muted-foreground">
          See also{" "}
          <Link to="/security" className="underline hover:text-foreground">
            Security
          </Link>{" "}
          for the posture your reviewer will want, and{" "}
          <span className="font-mono">ACKNOWLEDGEMENTS.md</span> for the dependency licence audit.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
