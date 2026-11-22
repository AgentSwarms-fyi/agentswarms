// "Favourites" as a filter on a list page: one chip that narrows the list to
// what you starred there. The same chip, in the same words, on every page
// that lists a kind of thing. Its state is src/hooks/use-favourites-filter.ts.
//
// It is not drawn until something on the page is starred, so a page nobody
// has starred anything on looks exactly as it did.
import { Star } from "lucide-react";

import type { FavouritesFilterState } from "@/hooks/use-favourites-filter";
import { cn } from "@/lib/utils";

export function FavouritesFilter({
  filter,
  className,
}: {
  filter: FavouritesFilterState;
  className?: string;
}) {
  if (filter.count === 0) return null;
  return (
    <button
      type="button"
      aria-pressed={filter.on}
      onClick={filter.toggle}
      title={filter.on ? "Show everything again" : "Show only what you starred"}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs outline-none transition focus-visible:ring-2 focus-visible:ring-ring",
        filter.on
          ? "border-amber-500/40 bg-amber-500/10 font-medium text-foreground"
          : "border-border/70 text-muted-foreground hover:border-amber-500/40 hover:text-foreground",
        className,
      )}
    >
      <Star
        className={cn("h-3.5 w-3.5", filter.on && "text-amber-500 dark:text-amber-400")}
        fill={filter.on ? "currentColor" : "none"}
      />
      Favourites
      <span className="tabular-nums opacity-70">{filter.count}</span>
    </button>
  );
}
