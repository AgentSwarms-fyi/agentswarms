// Marketing mocks for the Business Intelligence section of the landing
// page. Pure CSS/SVG (no screenshots), theme-aware via design tokens, and
// deliberately echoing the real BI workspace: KPI cards, bar + line charts
// with a forecast tail, a donut, an ontology fragment and an alert toast.

const SERIES = [34, 46, 41, 58, 52, 66, 74, 71, 86, 92];
const BARS = [42, 66, 38, 82, 55, 71, 47, 90];

function linePath(values: number[], w: number, h: number, pad = 4): string {
  const max = Math.max(...values);
  const step = (w - pad * 2) / (values.length - 1);
  return values
    .map(
      (v, i) => `${i === 0 ? "M" : "L"} ${pad + i * step} ${h - pad - (v / max) * (h - pad * 2)}`,
    )
    .join(" ");
}

export function BiDashboardMock() {
  const w = 260;
  const h = 96;
  const solid = linePath(SERIES.slice(0, 8), w * 0.78, h);
  return (
    <div className="glow-card relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-2xl">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold tracking-tight text-foreground">
            Revenue Review — Q3
          </span>
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
            Published
          </span>
        </div>
        <span className="hidden rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[9px] text-muted-foreground sm:inline">
          Refreshes daily · 06:00 UTC
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {/* KPI cards */}
        {[
          { l: "MRR", v: "$128.4k", d: "+12.4%", up: true },
          { l: "Active customers", v: "1,842", d: "+6.1%", up: true },
          { l: "Churn", v: "1.9%", d: "−0.4 pts", up: false },
        ].map((k) => (
          <div key={k.l} className="rounded-xl border border-border/60 bg-background/60 p-3">
            <p className="text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
              {k.l}
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums tracking-tight text-foreground">
              {k.v}
            </p>
            <p
              className={`text-[9px] font-medium tabular-nums ${
                k.up ? "text-emerald-500" : "text-rose-400"
              }`}
            >
              {k.up ? "▲" : "▼"} {k.d} vs prior period
            </p>
          </div>
        ))}

        {/* Line chart with forecast tail */}
        <div className="col-span-2 rounded-xl border border-border/60 bg-background/60 p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
              MRR trend + forecast
            </p>
            <div className="flex gap-0.5">
              {["D", "W", "M", "Q"].map((g) => (
                <span
                  key={g}
                  className={`rounded px-1 text-[8px] font-semibold ${
                    g === "M" ? "bg-primary/15 text-primary" : "text-muted-foreground/70"
                  }`}
                >
                  {g}
                </span>
              ))}
            </div>
          </div>
          <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
            <defs>
              <linearGradient id="bi-mock-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.25" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1="4"
                x2={w - 4}
                y1={h * f}
                y2={h * f}
                stroke="var(--border)"
                strokeWidth="0.75"
                strokeDasharray="2 4"
              />
            ))}
            <path
              d={`${solid} L ${w * 0.78 - 4} ${h - 4} L 4 ${h - 4} Z`}
              fill="url(#bi-mock-area)"
            />
            <path
              d={solid}
              fill="none"
              stroke="var(--primary)"
              strokeWidth="2"
              strokeLinecap="round"
            />
            {/* Forecast tail + corridor */}
            <path
              d={`M ${w * 0.78 - 4} 22 L ${w - 6} 10`}
              stroke="var(--primary)"
              strokeWidth="1.75"
              strokeDasharray="4 4"
              fill="none"
            />
            <path
              d={`M ${w * 0.78 - 4} 22 L ${w - 6} 2 M ${w * 0.78 - 4} 22 L ${w - 6} 20`}
              stroke="var(--muted-foreground)"
              strokeOpacity="0.4"
              strokeWidth="0.9"
              strokeDasharray="2 4"
              fill="none"
            />
            <circle cx={w * 0.78 - 4} cy="22" r="2.5" fill="var(--primary)" />
            <text x={w - 52} y={h - 8} fontSize="7" fill="var(--muted-foreground)">
              forecast ±1.96σ
            </text>
          </svg>
        </div>

        {/* Donut */}
        <div className="rounded-xl border border-border/60 bg-background/60 p-3">
          <p className="mb-1.5 text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
            Plan mix
          </p>
          <div className="flex items-center gap-2.5">
            <div
              className="h-14 w-14 shrink-0 rounded-full"
              style={{
                background:
                  "conic-gradient(#4E79A7 0 46%, #F28E2B 46% 74%, #59A14F 74% 90%, #B07AA1 90% 100%)",
                WebkitMask: "radial-gradient(circle, transparent 55%, #000 56%)",
                mask: "radial-gradient(circle, transparent 55%, #000 56%)",
              }}
            />
            <div className="space-y-0.5 text-[8.5px] text-muted-foreground">
              {[
                ["#4E79A7", "Enterprise 46%"],
                ["#F28E2B", "Pro 28%"],
                ["#59A14F", "Starter 16%"],
              ].map(([c, l]) => (
                <p key={l} className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                  {l}
                </p>
              ))}
            </div>
          </div>
        </div>

        {/* Bar chart with drill breadcrumb + avg line */}
        <div className="col-span-2 rounded-xl border border-border/60 bg-background/60 p-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
              Revenue by region
            </p>
            <p className="text-[8px] text-muted-foreground">
              All › <span className="font-semibold text-foreground">EMEA</span>
              <span className="text-muted-foreground/60"> · click to drill into country</span>
            </p>
          </div>
          <div className="relative flex h-16 items-end gap-1.5">
            <div className="absolute inset-x-0 top-[38%] border-t border-dashed border-rose-400/60" />
            <span className="absolute right-0 top-[26%] text-[7px] font-medium text-rose-400">
              target
            </span>
            {BARS.map((v, i) => (
              <div
                key={i}
                className={`flex-1 rounded-t ${i === 3 ? "bg-primary" : "bg-primary/45"}`}
                style={{ height: `${v}%` }}
              />
            ))}
          </div>
        </div>

        {/* Ontology fragment */}
        <div className="relative rounded-xl border border-border/60 bg-background/60 p-3">
          <p className="mb-2 text-[8px] font-bold uppercase tracking-widest text-muted-foreground">
            Ontology
          </p>
          <div className="space-y-1.5">
            {[
              { n: "customers", c: "#4E79A7" },
              { n: "orders", c: "#E15759" },
              { n: "Pricing FAQ", c: "#B07AA1" },
            ].map((e) => (
              <div
                key={e.n}
                className="flex items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 py-1"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: e.c }} />
                <span className="font-mono text-[8.5px] text-foreground">{e.n}</span>
              </div>
            ))}
          </div>
          <svg
            className="pointer-events-none absolute right-2 top-7 h-[70%] w-3"
            viewBox="0 0 10 100"
          >
            <path
              d="M 5 10 C 10 30, 10 50, 5 55 M 5 55 C 10 70, 10 85, 5 92"
              stroke="#d97706"
              strokeWidth="1.2"
              strokeDasharray="4 3"
              fill="none"
            />
          </svg>
        </div>
      </div>

      {/* Alert toast */}
      <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-xl backdrop-blur">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <p className="text-[9px] font-medium text-popover-foreground">
          Alert: MRR crossed <span className="tabular-nums">$120k</span> — notified
        </p>
      </div>
    </div>
  );
}

/** Compact "one goal in, dashboard out" strip for the generate feature. */
export function GenerateFlowMock() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/50 p-3">
      <span className="rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[9.5px] text-muted-foreground">
        "monthly revenue review by plan"
      </span>
      <span className="text-muted-foreground/60">→</span>
      {["plan", "6 questions", "SQL ×6", "charts", "layout"].map((s, i) => (
        <span
          key={s}
          className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[8.5px] font-semibold text-primary"
          style={{ animationDelay: `${i * 0.1}s` }}
        >
          {s}
        </span>
      ))}
      <span className="text-muted-foreground/60">→</span>
      <span className="rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-[9.5px] font-semibold text-emerald-600 dark:text-emerald-400">
        dashboard ✓
      </span>
    </div>
  );
}
