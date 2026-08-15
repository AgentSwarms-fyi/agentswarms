// Marketing mocks for the "numbers agents can trust" section.
//
// Every one of these depicts behaviour that actually ships — the fan-out
// refusal, the governed badge, the analyst's step trace, the verification
// badge that expires. A marketing mock showing a capability the product does
// not have is the same species of lie the product exists to prevent, so each
// mock's text is copied from what the real surface says.
//
// Pure CSS/SVG, no screenshots, theme-aware via design tokens.
import { AlertTriangle, BadgeCheck, Check, ShieldCheck, X } from "lucide-react";

/**
 * The compile-time fan-out refusal.
 *
 * This is the differentiator that is hardest to show and easiest to explain:
 * every other tool answers this question with a number, and the number is
 * wrong because the join multiplied the rows.
 */
export function FanOutRefusalMock() {
  return (
    <div className="glow-card relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-2xl">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px] font-bold tracking-tight">revenue by campaign</span>
        <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[9px] text-muted-foreground">
          orders ⋈ order_lines
        </span>
      </div>

      {/* What every other tool returns */}
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-center gap-1.5">
          <X className="h-3 w-3 text-destructive" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
            What a naive join returns
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold tabular-nums text-destructive/80 line-through">
            $4,182,900
          </span>
          <span className="text-[10px] text-muted-foreground">
            counted 3.2× — one row per order line
          </span>
        </div>
      </div>

      {/* What the compiler does instead */}
      <div className="mt-2.5 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3 w-3 text-primary" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
            What the compiler does
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">
          &ldquo;<span className="font-medium">revenue</span> is declared at the{" "}
          <span className="font-mono text-[10px]">order</span> grain, and this query joins{" "}
          <span className="font-mono text-[10px]">order_lines</span> (many per order). Summing it
          here would multiply it.&rdquo;
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {["refused at compile", "join named", "fix suggested"].map((t) => (
            <span
              key={t}
              className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[8.5px] font-semibold text-primary"
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-3 text-center text-[10px] leading-relaxed text-muted-foreground">
        A refusal you can act on beats a number you can&rsquo;t defend.
      </p>
    </div>
  );
}

const TRACE = [
  { n: 1, goal: "Revenue by region, last 2 quarters", governed: true, rows: 12, verdict: "pass" },
  {
    n: 2,
    goal: "Same split by segment, to isolate the driver",
    governed: true,
    rows: 9,
    verdict: "pass",
  },
  {
    n: 3,
    goal: "Renewal rate for the segment that moved",
    governed: false,
    rows: 4,
    verdict: "refined",
  },
];

/**
 * The analyst's reasoning trace.
 *
 * The point being made is not "an AI answered" — everyone has that. It is that
 * the approach, each step's governed status, its row count and its self-check
 * verdict are all on screen before the finding is.
 */
export function AnalystTraceMock() {
  return (
    <div className="glow-card relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold tracking-tight">
          &ldquo;Why did revenue fall in EMEA?&rdquo;
        </span>
        <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
          <BadgeCheck className="h-2.5 w-2.5" /> Verified
        </span>
      </div>

      <p className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[10.5px] italic leading-relaxed text-muted-foreground">
        Revenue moved on two axes at once, so I&rsquo;ll separate region from segment before
        attributing the fall — a single query would confound them.
      </p>

      <div className="mt-2.5 space-y-1.5">
        {TRACE.map((s) => (
          <div key={s.n} className="rounded-lg border border-border/60 bg-background/50 p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] text-muted-foreground">{s.n}.</span>
              <span className="flex-1 truncate text-[10.5px] font-medium">{s.goal}</span>
              {s.governed ? (
                <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[8px] font-semibold text-primary">
                  governed
                </span>
              ) : (
                <span className="shrink-0 rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[8px] font-semibold text-muted-foreground">
                  raw SQL
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
              <span className="font-mono">{s.rows} rows</span>
              <span className="text-muted-foreground/40">·</span>
              <span
                className={
                  s.verdict === "pass"
                    ? "flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
                    : "flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
                }
              >
                {s.verdict === "pass" ? (
                  <Check className="h-2.5 w-2.5" />
                ) : (
                  <AlertTriangle className="h-2.5 w-2.5" />
                )}
                self-check {s.verdict}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2.5 rounded-lg border border-border/50 bg-background p-2.5">
        <p className="text-[10.5px] leading-relaxed">
          EMEA fell <span className="font-semibold">8.4%</span>; enterprise renewals account for{" "}
          <span className="font-semibold">142%</span> of the decline, partly offset by SMB growth{" "}
          <span className="text-muted-foreground">(step 2)</span>.
        </p>
      </div>

      <p className="mt-2.5 text-center text-[10px] leading-relaxed text-muted-foreground">
        Edit any step&rsquo;s SQL and the green tick <span className="font-medium">expires</span> —
        a badge must not outlive what it vouched for.
      </p>
    </div>
  );
}

/** Row filters and column masks resolved per viewer, at compile time. */
export function GovernedAccessMock() {
  return (
    <div className="rounded-xl border border-border/60 bg-background/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[9.5px] text-muted-foreground">
          region ∈ &#123;&#123;user.region&#125;&#125;
        </span>
        <span className="text-muted-foreground/60">→</span>
        {["resolved per viewer", "compiled into SQL", "same on every engine"].map((s) => (
          <span
            key={s}
            className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[8.5px] font-semibold text-primary"
          >
            {s}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        An unresolvable attribute <span className="font-medium text-foreground">refuses</span> the
        query rather than compiling an empty filter — silent zero rows read as &ldquo;there is no
        data&rdquo;.
      </p>
    </div>
  );
}
