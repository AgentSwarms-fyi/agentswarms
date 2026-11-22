import { History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OrphanedSession } from "@/hooks/use-session-restore";

function timeAgo(savedAt: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - savedAt) / 60000));
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * Non-blocking: a slim line above the app header, not a modal. It never stops
 * anyone using the page they landed on, and stays until they choose.
 *
 * Quiet on purpose. It was a tinted bar in the brand colour with two buttons
 * that did the same thing ("Start Fresh" and ×), shown on every page until
 * answered: the loudest thing on screen was a question about yesterday.
 */
export function SessionRestoreBanner({
  session,
  onRestore,
  onStartFresh,
}: {
  session: OrphanedSession;
  onRestore: () => void;
  onStartFresh: () => void;
}) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b bg-muted/60 px-4 py-1.5 text-sm"
    >
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <History className="h-3.5 w-3.5 shrink-0" />
        <p className="min-w-0 truncate">
          You were on <span className="font-medium text-foreground">{session.label}</span>{" "}
          {timeAgo(session.savedAt)}.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={onRestore}>
          Go back there
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={onStartFresh}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
