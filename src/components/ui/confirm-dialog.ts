// Asking the user a question the browser cannot switch off.
//
// FOUND FROM THE UI. Dropping a lakehouse table did nothing: no dialog, no
// toast, no console error, no network request. The button was wired to the
// native `window.confirm()`, and a browser that suppresses dialogs makes that
// call return `false` without showing anything. Chrome offers exactly this —
// after a couple of dialogs it shows "prevent this page from creating
// additional dialogs", and once ticked EVERY destructive button in the app
// silently stops working. A suppressed dialog and a broken feature look
// identical from the outside, so the user re-clicks, concludes the product is
// broken, and is right to.
//
// The action itself was never the problem: the same drop succeeded the instant
// confirm() returned true. The failure was entirely in asking the question.
//
// One HOST, mounted once at the app root, rather than a hook per component:
// there were 21 of these call sites, and a mechanism that needs three edits
// per site is a mechanism that gets skipped on the twenty-second.
//
// `window.prompt` has the same flaw and a worse consequence — the analyst
// feedback box collected a REQUIRED reason through it, so a suppressed prompt
// silently recorded an empty one.
//
// This module is the asking half: confirmAsk, promptAsk and the one host they
// talk to. The host that shows the dialog is confirm-host.tsx (R346: split, so
// the call sites import no component and the host file exports only one).

export type ConfirmRequest = {
  title: string;
  /** The consequence, in the user's terms. Say what stops being true. */
  body?: string;
  /** A verb: "Drop table", "Delete". Never "OK". */
  actionLabel?: string;
  /** Ask for text instead of a yes/no. Resolves to the string, or null. */
  input?: { placeholder?: string; required?: boolean; defaultValue?: string };
};

export type Pending = {
  req: ConfirmRequest;
  resolve: (v: boolean | string | null) => void;
};

let deliver: ((p: Pending) => void) | null = null;

/**
 * Ask the question. Resolves false when dismissed, so a call site keeps the
 * shape it already had: `if (!(await confirmAsk({...}))) return;`
 *
 * If the host is somehow not mounted this REJECTS rather than resolving false.
 * Resolving false would reproduce the exact bug this file exists to remove — a
 * button that does nothing, quietly — and a rejection at least reaches a catch.
 */
export function confirmAsk(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (!deliver) return reject(new Error("Confirmation dialog is not mounted"));
    deliver({ req, resolve: (v) => resolve(Boolean(v)) });
  });
}

/** Ask for a line of text. Resolves null when dismissed or left empty-required. */
export function promptAsk(req: ConfirmRequest & { input: NonNullable<ConfirmRequest["input"]> }) {
  return new Promise<string | null>((resolve, reject) => {
    if (!deliver) return reject(new Error("Confirmation dialog is not mounted"));
    deliver({ req, resolve: (v) => resolve(typeof v === "string" ? v : null) });
  });
}

/**
 * The host connects here when it mounts, and the returned function disconnects
 * it. Until it connects, and after, every question rejects (see confirmAsk).
 */
export function connectConfirmHost(host: (p: Pending) => void): () => void {
  deliver = host;
  return () => {
    if (deliver === host) deliver = null;
  };
}
