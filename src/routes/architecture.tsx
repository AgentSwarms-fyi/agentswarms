// Deployment topology, for the infrastructure reviewer.
//
// The question this page answers is "what will this put on my network, and
// what will it talk to" — asked before any pilot, and currently answerable
// only by reading a Dockerfile and a docs page. The diagram is inline SVG
// rather than an image so it stays legible at any zoom, works in both themes
// via currentColor, and cannot rot into a screenshot of an older topology.
import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const Route = createFileRoute("/architecture")({
  head: () => ({
    meta: [
      { title: "Architecture — AgentSwarms" },
      {
        name: "description",
        content:
          "Deployment topology for AgentSwarms: one stateless Node container, your Supabase project, and outbound calls to the model and data providers you configure. Scaling, egress and state.",
      },
    ],
  }),
  component: ArchitecturePage,
});

/** One box in the topology diagram. */
function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  accent,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        className={
          accent ? "fill-primary/10 stroke-primary/40" : "fill-transparent stroke-current/25"
        }
        strokeWidth={1.5}
      />
      <text
        x={x + w / 2}
        y={y + (sub ? h / 2 - 4 : h / 2 + 4)}
        textAnchor="middle"
        className="fill-current text-[12px] font-semibold"
      >
        {title}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + h / 2 + 12}
          textAnchor="middle"
          className="fill-current text-[10px] opacity-60"
        >
          {sub}
        </text>
      )}
    </g>
  );
}

function Arrow({ d, label, lx, ly }: { d: string; label?: string; lx?: number; ly?: number }) {
  return (
    <g>
      <path
        d={d}
        className="stroke-current/40"
        strokeWidth={1.5}
        fill="none"
        markerEnd="url(#ah)"
      />
      {label && lx !== undefined && ly !== undefined && (
        <text x={lx} y={ly} textAnchor="middle" className="fill-current text-[9px] opacity-60">
          {label}
        </text>
      )}
    </g>
  );
}

function Topology() {
  return (
    <svg
      viewBox="0 0 760 330"
      role="img"
      aria-label="AgentSwarms deployment topology: browsers reach one stateless container, which reads and writes your Supabase project and makes outbound calls to model providers and your data sources."
      className="w-full text-foreground"
    >
      <defs>
        <marker
          id="ah"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" className="fill-current opacity-40" />
        </marker>
      </defs>

      {/* Your infrastructure boundary */}
      <rect
        x={8}
        y={8}
        width={430}
        height={314}
        rx={12}
        className="fill-transparent stroke-current/15"
        strokeDasharray="5 4"
        strokeWidth={1.5}
      />
      <text
        x={20}
        y={26}
        className="fill-current text-[10px] font-semibold uppercase tracking-widest opacity-50"
      >
        Your infrastructure
      </text>

      <Box x={28} y={48} w={130} h={54} title="Browsers" sub="your users" />
      <Box x={28} y={140} w={130} h={54} title="Load balancer" sub="optional" />

      <Box
        x={218}
        y={92}
        w={190}
        h={70}
        title="AgentSwarms"
        sub="stateless Node container"
        accent
      />
      <Box x={218} y={210} w={190} h={70} title="Supabase" sub="Postgres · auth · storage" accent />

      {/* Outbound */}
      <Box
        x={508}
        y={40}
        w={220}
        h={56}
        title="Model providers"
        sub="OpenRouter, OpenAI, Anthropic, …"
      />
      <Box x={508} y={122} w={220} h={56} title="Your databases" sub="22 warehouse connectors" />
      <Box x={508} y={204} w={220} h={56} title="SaaS APIs" sub="Sheets, Stripe, Shopify, CRMs" />

      <Arrow d="M93,102 L93,140" />
      <Arrow d="M158,167 L218,135" />
      <Arrow d="M313,162 L313,210" label="RLS-scoped" lx={355} ly={190} />
      <Arrow d="M408,120 L508,72" label="your keys" lx={455} ly={86} />
      <Arrow d="M408,132 L508,150" label="read-only" lx={455} ly={130} />
      <Arrow d="M408,148 L508,228" label="read-only" lx={462} ly={196} />

      <text x={218} y={302} className="fill-current text-[10px] opacity-60">
        Scale horizontally — no sticky sessions, no local state
      </text>
    </svg>
  );
}

type Note = { title: string; body: string };

const DEPLOY: Note[] = [
  {
    title: "One container",
    body: "A single stateless Node process, shipped as a Docker image. DEPLOY_TARGET=node is the primary target; docker compose up is the documented path.",
  },
  {
    title: "One database",
    body: "A Supabase project you create and own — Postgres, auth and object storage. Migrations are applied with the Supabase CLI. Nothing else is required to run the platform.",
  },
  {
    title: "Scales horizontally",
    body: "The container holds no session state, so it runs behind an ordinary load balancer with no sticky sessions. Background work is coordinated through the database with a cross-instance lease, and can be disabled per-instance with DISABLE_INPROCESS_SCHEDULER so one node owns it.",
  },
  {
    title: "Health endpoint",
    body: "/api/health for liveness and readiness probes.",
  },
];

const EGRESS: Note[] = [
  {
    title: "Model providers",
    body: "Outbound HTTPS to whichever providers you configure, using your keys. Prompts and completions do not pass through any vendor of ours.",
  },
  {
    title: "Your data sources",
    body: "Outbound to the databases, warehouses and SaaS APIs you connect. Database drivers use their native ports; everything else is HTTPS. Connectors are documented to use read-only credentials and every query path rejects anything but SELECT-class statements.",
  },
  {
    title: "Private networks are reachable",
    body: "A warehouse inside your VPC is a normal deployment. Outbound requests are screened against cloud metadata and link-local addresses, but private ranges are deliberately allowed.",
  },
  {
    title: "No call-home",
    body: "No telemetry, no licence check, no usage reporting. Nothing is baked in: the cookie banner's optional analytics exist only if you configure your own VITE_GA_ID, and with it unset no banner is shown at all. An air-gapped deployment reaching only your own model endpoint is a supported configuration.",
  },
];

const SCALE: Note[] = [
  {
    title: "Aggregation runs in your warehouse",
    body: "Semantic-layer queries and linked warehouse tables compile to SQL that executes where the data lives, so a billion-row GROUP BY is your warehouse's work and only the grouped result travels. Result sets are capped (1,000 rows by default, 5,000 hard ceiling, 60s timeout) — that bounds what comes back, never the table.",
  },
  {
    title: "Prep folds into the warehouse when it can",
    body: "When every source in a flow is on one connection and every step is expressible in that dialect, the whole pipeline becomes one SQL statement run inside the warehouse — and the fold is proved against the real warehouse before it is trusted, so a refusal costs speed, never correctness. Mixed or non-foldable flows run locally instead, and the UI says which.",
  },
  {
    title: "Local datasets are laptop-scale, on purpose",
    body: "Uploaded and synced datasets are DuckDB tables capped at 500,000 rows and 100 MB by default. They exist for CSVs, samples and SaaS syncs. Past a few million rows, link the warehouse table rather than importing it.",
  },
  {
    title: "Dashboards default to a cached snapshot",
    body: "A warehouse-backed widget stores at most 500 rows so shared links render instantly. A chart that sums raw rows in the browser therefore shows a partial total if the refresh hit that cap — it is marked truncated rather than shown as confident. Aggregate pushdown (GROUP BY in SQL) or direct query mode gives the complete number.",
  },
];

const STATE: Note[] = [
  {
    title: "Everything durable is in Postgres",
    body: "Agents, swarms, datasets, dashboards, traces and audit events. Back up the Supabase project and you have backed up the platform.",
  },
  {
    title: "Object storage",
    body: "Uploaded documents, generated files and the columnar dataset mirrors live in Supabase storage buckets.",
  },
  {
    title: "Local disk is a cache only",
    body: "The Parquet mirror cache is on local disk and is disposable — losing it costs speed, never data. Give it a real volume on a container host so it survives restarts.",
  },
];

function Section({ title, blurb, items }: { title: string; blurb?: string; items: Note[] }) {
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

function ArchitecturePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="mt-6 font-display text-4xl font-semibold tracking-tight text-foreground">
          Architecture
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-muted-foreground">
          What this puts on your network, and what it talks to. The whole platform is one stateless
          container and one Supabase project; everything else is an outbound call to somewhere you
          already trust.
        </p>

        <div className="mt-10 rounded-xl bg-card p-6 ring-1 ring-border">
          <Topology />
        </div>

        <Section title="Deployment" items={DEPLOY} />
        <Section
          title="Egress"
          blurb="Every outbound destination, and nothing else. Useful if you are writing firewall rules."
          items={EGRESS}
        />
        <Section
          title="Scale"
          blurb="What is bounded, and by what. Full numbers and the environment variables that change them are in docs/SCALE_AND_LIMITS.md."
          items={SCALE}
        />
        <Section
          title="State and backup"
          blurb="What has to survive, and what is safe to lose."
          items={STATE}
        />

        <p className="mt-10 text-xs text-muted-foreground">
          Full deployment options and environment variables are in{" "}
          <span className="font-mono">docs/DEPLOYMENT.md</span>; every row, timeout and concurrency
          cap is in <span className="font-mono">docs/SCALE_AND_LIMITS.md</span>. See also{" "}
          <Link to="/security" className="underline hover:text-foreground">
            Security
          </Link>{" "}
          and{" "}
          <Link to="/license" className="underline hover:text-foreground">
            Licensing
          </Link>
          .
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
