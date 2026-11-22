// The small pieces a search result is drawn from, shared by the palette and
// the results page so a row looks the same in both.
import { Link } from "@tanstack/react-router";
import { Star, type LucideIcon } from "lucide-react";

import { StarButton } from "@/components/StarButton";
import { recordOpened } from "@/hooks/use-object-marks";
import { linkToObject, objectKind, type ObjectEntry } from "@/lib/objectKinds";
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

/** A small filled star: this is one of your favourites. Says so, does nothing. */
export function StarMark() {
  return (
    <Star
      aria-label="Favourite"
      role="img"
      className="shrink-0 text-amber-500 dark:text-amber-400"
      style={{ width: 12, height: 12 }}
      fill="currentColor"
      strokeWidth={1.5}
    />
  );
}

/**
 * One object as a row of a list: a link that opens it, and its star.
 *
 * The star sits beside the link, not inside it. A button inside a link is two
 * things to press in one, and a screen reader announces only the link.
 */
export function ObjectRow({
  entry,
  query = "",
  when,
}: {
  entry: ObjectEntry;
  query?: string;
  /** "Opened 2 hours ago": what this list orders by, in words. */
  when?: string;
}) {
  const link = linkToObject(entry);
  const opened = () => void recordOpened(entry.kind, entry.id);
  return (
    <li className="flex items-center gap-1 pr-2 transition hover:bg-muted/50">
      <Link
        to={link.to as never}
        search={(link.search ?? {}) as never}
        // A middle click opens it in a new tab, and is an opening all the same.
        onClick={opened}
        onAuxClick={opened}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 outline-none focus-visible:bg-muted/60"
      >
        <IconTile icon={objectKind(entry.kind).icon} />
        <ObjectText entry={entry} query={query} />
        {when ? (
          <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
            {when}
          </span>
        ) : null}
      </Link>
      <StarButton kind={entry.kind} id={entry.id} name={entry.name} />
    </li>
  );
}
