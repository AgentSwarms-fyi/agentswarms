// The dialog confirmAsk and promptAsk show: one host, mounted once at the app
// root. Why it exists, and why it is not window.confirm, is the header of
// confirm-dialog.ts; R346 moved the host here from that module.
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
import {
  connectConfirmHost,
  type ConfirmRequest,
  type Pending,
} from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";

/** Mounted once, near the root. confirmAsk and promptAsk talk to this. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  /**
   * What the dialog is SHOWING, which is not the same as whether it is open.
   *
   * Settling used to clear `pending`, and the content was derived from it — so
   * for the ~150ms Radix spends animating the dialog out, the question
   * vanished and the buttons fell back to their defaults. Every one of the
   * call sites flashed a generic "Confirm" on the way out, right after the
   * reader had decided something. This holds the last request until a new one
   * replaces it, so the dialog fades out still saying what it said.
   */
  const [shown, setShown] = useState<ConfirmRequest | null>(null);
  const [text, setText] = useState("");
  const resolver = useRef<Pending["resolve"] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () =>
      connectConfirmHost((p) => {
        resolver.current = p.resolve;
        setText(p.req.input?.defaultValue ?? "");
        setShown(p.req);
        setPending(p);
      }),
    [],
  );

  const settle = useCallback((value: boolean | string | null) => {
    // Exactly once. Escape also fires onOpenChange, and a caller left awaiting
    // for ever is the same silent nothing in a different costume.
    const r = resolver.current;
    resolver.current = null;
    setPending(null);
    r?.(value);
  }, []);

  // Read from `shown`, not `pending`: see the comment on `shown` above.
  const req = shown;
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
      <AlertDialogContent
        // An alert dialog focuses Cancel when it opens, which is the safe
        // default for a yes/no question. For a question that asks for text it
        // meant typing went nowhere and Enter cancelled (Rename, Row height,
        // Custom format…): the text box takes the keyboard, its text selected.
        onOpenAutoFocus={(e) => {
          if (!wantsText) return;
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {wantsText && (
          <Input
            ref={inputRef}
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
