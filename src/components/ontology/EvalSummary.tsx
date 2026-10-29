// How the verified questions fare against a model: one line for a version in
// the list, and the per-question detail the publish dialog shows before a
// version is frozen (semantic CI).
import { BadgeCheck, CircleAlert, RefreshCw } from "lucide-react";
import type { EvalCounts } from "@/utils/ontology.functions";
import type { EvalOutcome } from "@/utils/ontology/evals.server";
import { cn } from "@/lib/utils";

export function EvalLine(props: { counts: EvalCounts; className?: string }) {
  const { total, same, changed, errors } = props.counts;
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-xs",
        errors > 0 ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground",
        props.className,
      )}
    >
      {errors > 0 ? (
        <CircleAlert className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
      )}
      {total} verified question{total === 1 ? "" : "s"}: {same} unchanged
      {changed > 0 && ` · ${changed} changed`}
      {errors > 0 && ` · ${errors} no longer answer${errors === 1 ? "s" : ""}`}
    </p>
  );
}

/** The questions that did not come back the same, broken ones first. */
export function EvalResults(props: { results: EvalOutcome[] }) {
  const notSame = props.results
    .filter((r) => r.status !== "same")
    .sort((a, b) => (a.status === "error" ? -1 : 0) - (b.status === "error" ? -1 : 0));
  if (!notSame.length) return null;
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
      {notSame.map((r) => (
        <li
          key={r.id}
          className={cn(
            "rounded-md border px-2.5 py-1.5",
            r.status === "error"
              ? "border-rose-500/40 bg-rose-500/5"
              : "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <p className="flex items-center gap-1.5 font-medium">
            {r.status === "error" ? (
              <CircleAlert className="h-3.5 w-3.5 text-rose-600" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 text-amber-600" aria-hidden />
            )}
            {r.question}
          </p>
          <p className="text-muted-foreground">
            {r.status === "error"
              ? (r.error ?? "No longer answers")
              : `Answers differently now (${r.rows ?? 0} row${r.rows === 1 ? "" : "s"}): new data or a changed definition`}
          </p>
        </li>
      ))}
    </ul>
  );
}
