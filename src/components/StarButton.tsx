// The star beside an object: press it to keep the object at hand under
// My work → Favourites and at the top of search.
//
// One component, so every star in the app says the same thing, answers at the
// same speed and reads the same store. It draws nothing on an install whose
// database has no table for marks yet.
import { Star } from "lucide-react";

import { setStar, useObjectMarks } from "@/hooks/use-object-marks";
import type { ObjectKindId } from "@/lib/objectKinds";
import { cn } from "@/lib/utils";

const QUIET = {
  collapse:
    "hidden group-hover/star:inline-flex group-focus-within/star:inline-flex [@media(hover:none)]:inline-flex",
  fade: "opacity-0 focus-visible:opacity-100 group-hover/star:opacity-100 group-focus-within/star:opacity-100 [@media(hover:none)]:opacity-100",
} as const;

export function StarButton({
  kind,
  id,
  name,
  quiet,
  className,
}: {
  kind: ObjectKindId;
  id: string;
  /** What is being starred, for a screen reader: "Add Sales to favourites". */
  name: string;
  /**
   * For a narrow rail, where a star on every row costs each name its last
   * characters. Until the row is pointed at or holds the keyboard, a star that
   * is off is either not drawn ("collapse": it takes no room) or drawn
   * invisible ("fade": it keeps its room, like other row actions that appear
   * on hover). A favourite always shows its star, and so does every star on a
   * screen with nothing to point with. The row carries the class
   * `group/star`.
   */
  quiet?: "collapse" | "fade";
  className?: string;
}) {
  const marks = useObjectMarks();
  if (marks.unavailable) return null;
  const on = marks.isStarred(kind, id);
  const says = on ? "Remove from favourites" : "Add to favourites";
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      title={says}
      // A star often sits on a row that is itself a link or a button.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void setStar(kind, id, !on);
      }}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition",
        "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        on
          ? "text-amber-500 hover:text-amber-600 dark:text-amber-400"
          : "text-muted-foreground/60 hover:text-foreground",
        quiet && !on && QUIET[quiet],
        className,
      )}
    >
      <Star className="h-4 w-4" fill={on ? "currentColor" : "none"} strokeWidth={on ? 1.5 : 1.75} />
    </button>
  );
}
