// What a brand new account sees instead of a console with nothing in it.
//
// The old page showed the same thing to everybody: five zeroes, a flat
// sparkline, three "no runs yet" messages and nine hundred pixels of feature
// tiles. A console with no data does not read as "quiet", it reads as broken,
// and the one thing a new account needs — the order to do things in — was the
// one thing it did not say.
//
// Each step is derived from real state, so ticking one is not something the
// page can be wrong about. The steps are in dependency order rather than
// feature order: nothing can run before a model key exists, and nothing is
// worth grounding before there is something to ground it in.

import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type Step = {
  title: string;
  /** Why this step exists, not what the button does. */
  why: string;
  done: boolean;
  to: string;
  cta: string;
};

export function FirstRun({ steps }: { steps: Step[] }) {
  const done = steps.filter((s) => s.done).length;
  // The first unfinished step is the only one with a button. A checklist where
  // every row shouts is a menu, and a menu is what the sidebar already is.
  const next = steps.findIndex((s) => !s.done);

  return (
    <Card>
      <CardContent className="p-6 sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight">
              Get your first answer out of it
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Five steps, in the order they depend on each other. Nothing here is a demo — every one
              of them leaves something real behind.
            </p>
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {done} of {steps.length} done
          </p>
        </div>

        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </div>

        <ol className="mt-5 space-y-1">
          {steps.map((s, i) => (
            <li
              key={s.title}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2.5",
                i === next && "bg-primary/5",
              )}
            >
              <span
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                  s.done
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                    : i === next
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                )}
              >
                {s.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    s.done && "text-muted-foreground line-through decoration-muted-foreground/40",
                  )}
                >
                  {s.title}
                </p>
                {!s.done && <p className="text-xs text-muted-foreground">{s.why}</p>}
              </div>
              {i === next && (
                <Button asChild size="sm" className="shrink-0">
                  <Link to={s.to}>
                    {s.cta}
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
