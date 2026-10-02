import { History, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OrphanedSession } from "@/hooks/use-session-restore";

function timeAgo(savedAt: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - savedAt) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Prominent but non-blocking: a banner above the app header, not a modal —
 * it never stops the user from just using the app on whatever page they
 * landed on, and stays up (it isn't a self-dismissing toast) until they
 * make a choice.
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
      className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/25 bg-primary/10 px-4 py-2.5 text-sm text-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <History className="h-4 w-4 shrink-0 text-primary" />
        <p className="min-w-0 truncate">
          We found an unsaved session from your last visit.{" "}
          <span className="text-muted-foreground">
            You were on <span className="font-medium text-foreground">{session.label}</span>,{" "}
            {timeAgo(session.savedAt)}.
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" className="h-7 px-3 text-xs" onClick={onRestore}>
          Restore Session
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-3 text-xs" onClick={onStartFresh}>
          Start Fresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label="Dismiss"
          onClick={onStartFresh}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
