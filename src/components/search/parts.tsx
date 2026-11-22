// The small pieces a search result is drawn from, shared by the palette and
// the results page so a row looks the same in both.
import { formatDistanceToNowStrict } from "date-fns";
import type { LucideIcon } from "lucide-react";

import { objectKind, type ObjectEntry } from "@/lib/objectKinds";
import { matchRanges } from "@/lib/objectSearch";
import { cn } from "@/lib/utils";

/** An icon on a quiet tile. Sized by the caller's row, not by the icon. */
export function IconTile({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground",
        className,
      )}
    >
      {/* Inline size: the palette's container styles every svg in a row. */}
      <Icon style={{ width: 16, height: 16 }} />
    </span>
  );
}

/**
 * `text` with the typed words set in a stronger weight. Weight only, no
 * coloured block: in a list of results the eye should land on the names, and
 * a highlighter stripe on every row is the loudest thing on the screen.
 */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(query, text);
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([from, to], i) => {
    if (from > at) out.push(text.slice(at, from));
    out.push(
      <mark key={i} className="bg-transparent font-semibold text-foreground">
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** "3 days ago", or nothing when the time is unknown. */
export function agoLabel(iso?: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  if (Math.abs(now.getTime() - t.getTime()) < 60_000) return "just now";
  return formatDistanceToNowStrict(t, { addSuffix: true });
}

/** Whose it is, when it is not the reader's own. */
export function OwnershipTag({ entry }: { entry: Pick<ObjectEntry, "mine" | "sample"> }) {
  const label = entry.sample ? "Sample" : entry.mine ? null : "Shared with you";
  if (!label) return null;
  return (
    <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

/** One result's text: the name, then what it is and what it says about itself. */
export function ObjectText({ entry, query }: { entry: ObjectEntry; query: string }) {
  const kind = objectKind(entry.kind);
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "truncate text-sm",
            query.trim() ? "text-foreground/75" : "text-foreground",
          )}
        >
          <Highlighted text={entry.name} query={query} />
        </span>
        <OwnershipTag entry={entry} />
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {kind.label}
        {entry.detail ? (
          <>
            {" · "}
            <Highlighted text={entry.detail} query={query} />
          </>
        ) : null}
      </span>
    </span>
  );
}
