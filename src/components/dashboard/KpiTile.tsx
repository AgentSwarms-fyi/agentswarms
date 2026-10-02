// One number, and what it is measured against.
//
// There was no shared stat tile in this codebase: analytics, ETL, ML, data
// monitors, the vector-store panel and the quality trends each defined their
// own, unexported, with different padding and different type sizes. This is
// the dashboard's, written to be liftable — it takes the union of what those
// six needed (a value, a qualifier, an optional progress bar, an optional
// tone) without inventing anything none of them had.
//
// `against` is the part most stat tiles get wrong: a number with nothing to
// compare it to is trivia. Spend means something against a cap, a success rate
// against yesterday, latency against what the user considers slow.

import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type KpiTone = "neutral" | "good" | "warn" | "bad";

const TONE: Record<KpiTone, string> = {
  neutral: "text-foreground",
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-red-500",
};

export function KpiTile({
  icon: Icon,
  label,
  value,
  against,
  tone = "neutral",
  progress,
  to,
  loading,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  /** What the number is measured against — a cap, a window, a baseline. */
  against?: string;
  tone?: KpiTone;
  /** 0–1, drawn as a bar under the value. Used for spend against a cap. */
  progress?: number | null;
  to?: string;
  loading?: boolean;
}) {
  const body = (
    <Card className={cn("h-full transition-colors", to && "hover:border-primary/40")}>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
        <div
          className={cn(
            "text-2xl font-semibold tracking-tight tabular-nums",
            TONE[tone],
            loading && "animate-pulse text-muted-foreground",
          )}
        >
          {loading ? "—" : value}
        </div>
        {typeof progress === "number" && (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                progress >= 1 ? "bg-red-500" : progress >= 0.8 ? "bg-amber-500" : "bg-primary",
              )}
              // Clamped: a cap that has been blown through is still a full bar,
              // not a bar wider than its track.
              style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
            />
          </div>
        )}
        {against && <p className="mt-1.5 text-[11px] text-muted-foreground">{against}</p>}
      </CardContent>
    </Card>
  );

  return to ? (
    <Link to={to} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}
