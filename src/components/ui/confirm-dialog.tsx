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
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

export type ConfirmRequest = {
  title: string;
  /** The consequence, in the user's terms. Say what stops being true. */
  body?: string;
  /** A verb: "Drop table", "Delete". Never "OK". */
  actionLabel?: string;
  /** Ask for text instead of a yes/no. Resolves to the string, or null. */
  input?: { placeholder?: string; required?: boolean; defaultValue?: string };
};

type Pending = {
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

/** Mounted once, near the root. Everything above talks to this. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const resolver = useRef<Pending["resolve"] | null>(null);

  useEffect(() => {
    deliver = (p) => {
      resolver.current = p.resolve;
      setText(p.req.input?.defaultValue ?? "");
      setPending(p);
    };
    return () => {
      deliver = null;
    };
  }, []);

  const settle = useCallback((value: boolean | string | null) => {
    // Exactly once. Escape also fires onOpenChange, and a caller left awaiting
    // for ever is the same silent nothing in a different costume.
    const r = resolver.current;
    resolver.current = null;
    setPending(null);
    r?.(value);
  }, []);

  const req = pending?.req;
  const wantsText = Boolean(req?.input);
  const blocked = wantsText && Boolean(req?.input?.required) && text.trim() === "";

  // The 21 converted call sites arrived as one sentence, because that is what a
  // native confirm() takes: `Delete "X"? This cannot be undone.` Rather than
  // edit all of them into title/body pairs — and rely on whoever writes the
  // twenty-second doing the same — split here, at the first question mark.
  // Anything that passes an explicit body keeps full control.
  const raw = req?.title ?? "";
  const split = req?.body === undefined ? raw.indexOf("? ") : -1;
  const title = split >= 0 ? raw.slice(0, split + 1) : raw;
  const body = req?.body ?? (split >= 0 ? raw.slice(split + 2) : "");

  // "Confirm" tells the user nothing about what is about to happen. The verb
  // they already read in the question does.
  const verb = /^(Delete|Drop|Remove|Restore|Discard|Revoke|Disconnect)\b/i.exec(title.trim())?.[1];
  const actionLabel =
    req?.actionLabel ?? (verb ? verb[0].toUpperCase() + verb.slice(1).toLowerCase() : "Confirm");

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => !open && settle(wantsText ? null : false)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {wantsText && (
          <Input
            autoFocus
            value={text}
            placeholder={req?.input?.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !blocked) settle(text);
            }}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(wantsText ? null : false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction disabled={blocked} onClick={() => settle(wantsText ? text : true)}>
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
