// The small line above a page's title that says which part of the product you
// are in.
//
// It is read from the nav map, not written on the page. Written on the page it
// was a second copy of the rail, and second copies drift: the Knowledge Base
// said "Data & BI" long after it had moved to Build, and nothing noticed,
// because nothing compared the two. Asked of the map, a page that moves to
// another group changes its own label.
import { useMatch } from "@tanstack/react-router";

import { navGroupForPath } from "@/lib/appNav";
import { cn } from "@/lib/utils";

export function PageEyebrow({
  fallback,
  className,
}: {
  /** For a page the rail does not list (Settings, Account): what to say instead. */
  fallback?: string;
  className?: string;
}) {
  // The path of the route this label is drawn in, not the address bar's. The
  // address changes the moment a link is pressed, while the page being left
  // stays on screen until the next one has loaded: read from the address, a
  // Sheets page on its way out said "Build" above "Sheets".
  const pathname = useMatch({ strict: false, select: (match) => match.pathname });
  const label = navGroupForPath(pathname)?.label ?? fallback;
  if (!label) return null;
  return (
    <p
      className={cn(
        // Quiet: it says where you are. The title says what this is.
        "mb-1 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {label}
    </p>
  );
}
