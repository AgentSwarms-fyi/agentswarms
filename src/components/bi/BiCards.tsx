// The cards visual (R500): one card per row, from templates. "tiles" stand
// side by side — a podium of three drivers with their picture, badges, name,
// time and points; "rows" are wide strips — a top three with position,
// badges, name and points, or the races still to run.
import { useMemo } from "react";

import { fmtBiValue } from "@/components/bi/biChartData";
import type { ChartSpec } from "@/lib/biAgent";
import { cardLine, cardLines, type CardSegment } from "@/lib/biCardTemplate";
import { safeImageSrc } from "@/lib/safeUrl";
import { cn } from "@/lib/utils";

type CardsChart = Extract<ChartSpec, { type: "cards" }>;

function Segments({ segs }: { segs: CardSegment[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-extrabold">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function Picture({ src, className }: { src: unknown; className: string }) {
  const url = safeImageSrc(src);
  if (!url) return null;
  return <img src={url} alt="" loading="lazy" className={cn("object-contain", className)} />;
}

export function BiCards({
  chart,
  rows,
  large,
}: {
  chart: CardsChart;
  rows: Record<string, unknown>[];
  large?: boolean;
}) {
  const fmt = useMemo(() => (v: unknown) => fmtBiValue(v, chart), [chart]);
  const layout = chart.layout ?? "tiles";
  const shown = rows.slice(0, Math.max(1, chart.max ?? (layout === "rows" ? 6 : 4)));
  const icons = (chart.iconFields ?? []).filter(Boolean);

  if (shown.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No rows to show.
      </div>
    );
  }

  if (layout === "rows") {
    // Sized by the card's own width, not the window's: a narrow card on a
    // wide screen squeezed a driver's name down to one letter — FOUND IN
    // R500's UI test. Below 24rem the small pictures go and the text steps
    // down a size.
    return (
      <div className="@container flex h-full flex-col justify-center gap-1.5 overflow-y-auto">
        {shown.map((row, i) => (
          <div
            key={i}
            className="flex min-h-0 flex-1 items-center gap-2 rounded-md bg-foreground/[0.06] px-2 py-1.5 @sm:gap-3 @sm:px-3"
          >
            {chart.lead && (
              <span className="w-6 shrink-0 text-center text-lg font-light tabular-nums @sm:w-8 @sm:text-2xl">
                <Segments segs={cardLine(chart.lead, row, fmt)} />
              </span>
            )}
            {icons.map((f) => (
              <Picture key={f} src={row[f]} className="hidden h-7 w-10 shrink-0 @sm:block" />
            ))}
            {chart.imageField && (
              <Picture
                src={row[chart.imageField]}
                className="h-10 w-10 shrink-0 rounded-md @sm:h-12 @sm:w-12"
              />
            )}
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "truncate text-[var(--primary)]",
                  large ? "text-3xl" : "text-base @sm:text-xl",
                )}
              >
                <Segments segs={cardLine(chart.title, row, fmt)} />
              </div>
              {cardLines(chart.body, row, fmt).map((segs, j) => (
                <div key={j} className="truncate text-xs text-muted-foreground">
                  <Segments segs={segs} />
                </div>
              ))}
            </div>
            {chart.value && (
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap tabular-nums",
                  large ? "text-3xl" : "text-base @sm:text-xl",
                )}
              >
                <Segments segs={cardLine(chart.value, row, fmt)} />
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="grid h-full gap-3"
      style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
    >
      {shown.map((row, i) => (
        <div key={i} className="flex min-h-0 flex-col items-center gap-1.5 text-center">
          {chart.heading && (
            <div className={cn("leading-tight", large ? "text-3xl" : "text-xl")}>
              <Segments segs={cardLine(chart.heading, row, fmt)} />
            </div>
          )}
          <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
            {chart.imageField && (
              <Picture
                src={row[chart.imageField]}
                className="h-full max-h-40 w-auto max-w-[70%] rounded-xl"
              />
            )}
            {icons.length > 0 && (
              <div className="absolute right-[8%] top-1/2 flex -translate-y-1/2 flex-col gap-1.5">
                {icons.map((f) => (
                  <Picture key={f} src={row[f]} className="h-6 w-9" />
                ))}
              </div>
            )}
          </div>
          <div
            className={cn(
              "w-full truncate leading-tight text-[var(--primary)]",
              large ? "text-3xl" : "text-xl",
            )}
          >
            <Segments segs={cardLine(chart.title, row, fmt)} />
          </div>
          {cardLines(chart.body, row, fmt).map((segs, j) => (
            <div key={j} className="w-full truncate text-xs leading-snug">
              <Segments segs={segs} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
