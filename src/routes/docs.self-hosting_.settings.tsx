import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { C, Code, DocLink, DocsHeader, H2, H3, NextPrev, P } from "@/components/docs/DocsShell";
import {
  SETTINGS_REFERENCE,
  type SettingsEntry,
  type SettingsTier,
} from "@/components/docs/settingsReference";

export const Route = createFileRoute("/docs/self-hosting_/settings")({
  head: () => ({
    meta: [
      { title: "Install & deploy · All settings — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Every environment variable the server reads, from .env.example: required, recommended and optional, with what each does.",
      },
      {
        property: "og:title",
        content: "Install & deploy · All settings — AgentSwarms Documentation",
      },
      { property: "og:description", content: "Every setting, from .env.example." },
      { property: "og:url", content: "https://agentswarms.fyi/docs/self-hosting/settings" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/self-hosting/settings" }],
  }),
  component: SettingsPage,
});

const TOTAL = SETTINGS_REFERENCE.reduce(
  (n, t) =>
    n + t.sections.reduce((m, s) => m + s.entries.reduce((k, e) => k + e.settings.length, 0), 0),
  0,
);

/** `backticked` spans in .env.example's prose, as inline code. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`]+`)/g)
        .map((part, i) =>
          part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
            <C key={i}>{part.slice(1, -1)}</C>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
    </>
  );
}

function Entry({ entry }: { entry: SettingsEntry }) {
  if (!entry.settings.length) {
    return (
      <div className="mt-3">
        {entry.body.map((b, i) =>
          b.kind === "code" ? (
            <Code key={i}>{b.text}</Code>
          ) : (
            <P key={i}>
              <Inline text={b.text} />
            </P>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-border/60 bg-card/30 px-4 py-3">
      <dl className="space-y-1.5">
        {entry.settings.map((s) => (
          <div
            key={s.name}
            id={`setting-${s.name}`}
            className="scroll-mt-24 flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <dt className="font-mono text-[13px] font-semibold text-foreground">{s.line}</dt>
            {s.note && (
              <dd className="text-sm text-muted-foreground">
                <Inline text={s.note} />
              </dd>
            )}
          </div>
        ))}
      </dl>
      {entry.body.map((b, i) =>
        b.kind === "code" ? (
          <Code key={i}>{b.text}</Code>
        ) : (
          <p key={i} className="mt-2 text-sm leading-relaxed text-muted-foreground">
            <Inline text={b.text} />
          </p>
        ),
      )}
    </div>
  );
}

/** The reference with only the entries that mention the query. */
function filtered(query: string): SettingsTier[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_REFERENCE;
  return SETTINGS_REFERENCE.map((t) => ({
    ...t,
    sections: t.sections
      .map((s) => ({
        ...s,
        entries: s.entries.filter(
          (e) =>
            e.settings.length > 0 &&
            (e.settings.some(
              (x) => x.name.toLowerCase().includes(q) || x.note.toLowerCase().includes(q),
            ) ||
              e.body.some((b) => b.text.toLowerCase().includes(q))),
        ),
      }))
      .filter((s) => s.entries.length > 0 || s.title.toLowerCase().includes(q)),
  })).filter((t) => t.sections.length > 0);
}

function SettingsPage() {
  const [query, setQuery] = useState("");
  const tiers = useMemo(() => filtered(query), [query]);
  const shown = tiers.reduce(
    (n, t) =>
      n + t.sections.reduce((m, s) => m + s.entries.reduce((k, e) => k + e.settings.length, 0), 0),
    0,
  );
  return (
    <>
      <DocsHeader
        eyebrow="Self-hosting"
        title="Install & deploy · All settings"
        description="Every environment variable the server reads, from .env.example: required, recommended and optional, with what each does."
      />
      <P>
        Part of the <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink> guide. This page
        is <C>.env.example</C>, the file <C>scripts/setup.sh</C> copies to <C>.env</C>, laid out to
        read: {TOTAL} settings in three tiers. Only the first tier is needed for a first run. A line
        that starts with <C>#</C> is commented out, so the server uses its own default; the value
        shown is the one the file suggests.{" "}
        <DocLink to="/docs/self-hosting/configuration">Configuration</DocLink> explains the settings
        for each way of running the platform; this page lists them all.
      </P>
      <P>
        It is generated from the file, and the build checks that every variable the server reads
        appears in it, so a setting cannot be missing here and present in the code.
      </P>

      <label className="relative mt-6 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter: a name, or what it is for (proxy, Spark, KMS…)"
          aria-label="Filter settings"
          className="w-full rounded-lg border border-border/60 bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </label>
      {query.trim() && (
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {shown === 0 ? "No setting mentions that." : `${shown} of ${TOTAL} settings`}
        </p>
      )}

      {tiers.map((tier) => (
        <section key={tier.id}>
          <H2 id={tier.id}>{tier.title}</H2>
          {tier.sections.map((section) => (
            <section key={section.id}>
              <H3 id={section.id}>{section.title}</H3>
              {section.entries.map((entry, i) => (
                <Entry key={i} entry={entry} />
              ))}
            </section>
          ))}
        </section>
      ))}

      <NextPrev current="/docs/self-hosting/settings" />
    </>
  );
}
