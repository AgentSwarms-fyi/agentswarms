// What this deployment actually has, and what state it is in.
//
// The page this replaces answered "what can the platform do?" with twelve
// static tiles describing features — the same nine hundred pixels whether the
// account had one agent or a thousand pipelines. That is a brochure, and the
// sidebar already carries it. The question a dashboard should answer is "what
// do *I* have, and is it working?", which is a different question with a
// different answer every day.
//
// So each row is a real count from a real table, and a capability with nothing
// in it says so and offers the way in. Nothing here is aspirational: a row
// reads "3 pipelines · 1 failed today" or it reads "Not set up yet".

import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type SurfaceItem = {
  label: string;
  icon: LucideIcon;
  count: number;
  /** Plural noun for the count — "pipelines", "models". */
  noun: string;
  to: string;
  /** Something wrong in this capability, said in place of the usual subline. */
  warn?: string | null;
  /** Shown when the count is zero: the reason to set it up. */
  invite: string;
};

export function PlatformSurface({ items, loading }: { items: SurfaceItem[]; loading: boolean }) {
  // Set-up things first, in count order; the empty ones fall to the bottom
  // where they read as an invitation instead of a wall of zeroes.
  const sorted = [...items].sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0));

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {sorted.map((it) => {
        const empty = it.count === 0;
        const Icon = it.icon;
        return (
          <Link key={it.label} to={it.to} className="group block">
            <Card
              className={cn(
                "h-full transition-colors hover:border-primary/40",
                empty && "border-dashed bg-transparent",
              )}
            >
              <CardContent className="flex items-start gap-3 p-4">
                <span
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                    empty ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
                  )}
                >
                  <Icon className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-1.5">
                    {/* Wraps rather than truncates. At four columns "Knowledge
                        bases" clipped to "Knowledge ba…", and a label that
                        cannot say its own name is worse than a two-line row. */}
                    <p className="text-sm font-medium leading-tight">{it.label}</p>
                    <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  {loading ? (
                    <p className="mt-1 h-4 w-20 animate-pulse rounded bg-muted" />
                  ) : empty ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{it.invite}</p>
                  ) : (
                    <p className="mt-0.5 truncate text-xs">
                      <span className="font-semibold tabular-nums">{it.count}</span>{" "}
                      <span className="text-muted-foreground">{it.noun}</span>
                      {it.warn && <span className="text-amber-500"> &middot; {it.warn}</span>}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
