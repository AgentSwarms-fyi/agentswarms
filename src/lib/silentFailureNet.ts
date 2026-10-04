// Nothing the reader starts may fail without saying so.
//
// FOUND IN R245. The Iceberg publish button reads
//
//   try { const r = await publishFn(...); if (!r.ok) return toast.error(r.error); ... }
//   finally { setBusy(false); }
//
// — a `finally` with no `catch`. When the server function RESOLVES with
// `ok: false` the reader is told; when it REJECTS, the spinner stops, the
// dialog stays open and nothing at all is said. That is what "No toast" in the
// 2026-10-01 run meant, over a publish the catalog had refused.
//
// A sweep found **68** handlers of that exact shape: ones that care enough to
// toast `ok: false` and still swallow a rejection. Each deserves its own
// sentence, and the ones that matter most are getting them. This is the floor
// underneath that work — a last resort so that no action can fail in complete
// silence while the sentences are written one at a time.
//
// It fires only for rejections nothing else handled, so a handler with its own
// catch is unaffected and there is no double toast.
import { toast } from "sonner";

export type SilentFailure = { title: string; description: string };

/** Errors that are a normal part of working, not a failure to report. */
function isExpected(reason: unknown): boolean {
  const name = (reason as { name?: string } | null)?.name ?? "";
  // An abort is what a cancel button, a superseded search or an unmounted
  // component looks like; a reader who caused it does not need telling.
  if (name === "AbortError" || name === "CanceledError") return true;
  const text = messageOf(reason).toLowerCase();
  return text.includes("aborted") || text.includes("the operation was aborted");
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

/**
 * What to say about a rejection nothing else reported, or null to stay quiet.
 *
 * Kept apart from the listener so the decision can be tested without a DOM —
 * the suite runs in node, and a rule about what the reader is told should not
 * be provable only through an event listener.
 *
 * Deliberately vague about WHAT failed, because at this level that is not
 * known: saying "the last thing you did" and showing the real message beats
 * both silence and a confident guess at the wrong action.
 */
export function silentFailureToast(
  reason: unknown,
  seen: { message: string; at: number },
  now = Date.now(),
): SilentFailure | null {
  if (isExpected(reason)) return null;
  const message = messageOf(reason).slice(0, 300);
  // React and TanStack can surface one failure more than once; a reader does
  // not need to be told three times.
  if (message === seen.message && now - seen.at < 4000) return null;
  seen.message = message;
  seen.at = now;
  return {
    title: "That did not finish",
    description: message || "Something failed without saying why. Try again.",
  };
}

/** Wire it to the window. Returns the teardown. */
export function installSilentFailureNet(): () => void {
  if (typeof window === "undefined") return () => {};
  const seen = { message: "", at: 0 };
  const onRejection = (ev: PromiseRejectionEvent) => {
    const said = silentFailureToast(ev.reason, seen);
    if (said) toast.error(said.title, { description: said.description });
  };
  window.addEventListener("unhandledrejection", onRejection);
  return () => window.removeEventListener("unhandledrejection", onRejection);
}

/**
 * What a handler with its own catch says (R263). The net above is the floor:
 * it can only say "That did not finish", because it does not know what the
 * reader was doing. A handler does, so it names the action - "Could not save
 * the feature view" - with the real message under it. A cancel stays quiet
 * here too.
 *
 * Pure, for the same reason as silentFailureToast: the decision is tested
 * without a DOM.
 */
export function failureToast(action: string, reason: unknown): SilentFailure | null {
  if (isExpected(reason)) return null;
  return {
    title: `Could not ${action}`,
    description: messageOf(reason).slice(0, 300) || "It failed without saying why. Try again.",
  };
}

/**
 * Report a handler's failure. Pass the id of a loading toast the handler
 * showed, so the failure replaces it rather than leaving it spinning.
 */
export function reportFailure(
  action: string,
  reason: unknown,
  opts: { id?: string | number } = {},
): void {
  const said = failureToast(action, reason);
  if (said) toast.error(said.title, { description: said.description, id: opts.id });
  else if (opts.id !== undefined) toast.dismiss(opts.id);
}
