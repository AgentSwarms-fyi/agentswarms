// "3 days ago", for a row that says when something last changed or was opened.
import { formatDistanceToNowStrict } from "date-fns";

/** "3 days ago", or nothing when the time is unknown. */
export function agoLabel(iso?: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  if (Math.abs(now.getTime() - t.getTime()) < 60_000) return "just now";
  return formatDistanceToNowStrict(t, { addSuffix: true });
}
