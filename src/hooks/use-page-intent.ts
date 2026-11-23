// Acts on a link's request to open one object or start a new one, once, and
// then takes the request out of the address.
//
// "Once" matters: the request is in the address, and a page re-renders many
// times while it loads. Without the guard a dialog closed by hand would open
// again on the next render; without clearing, a reload would open it again.
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { withoutPageIntent, type PageIntent } from "@/lib/pageIntent";

export function usePageIntent(
  intent: PageIntent,
  opts: {
    /**
     * The list has loaded. Opening waits for this, because "not found" can
     * only be said about a list that is all there.
     */
    ready: boolean;
    /** Open the object with this id. Return false when there is no such one. */
    onOpen?: (id: string) => boolean | void;
    /**
     * Start a new one; from `template` when the link names one (the template
     * gallery's links do). Return false when the page has no such template.
     */
    onNew?: (template?: string) => boolean | void;
    /** What one of these is called, for the "not found" message. */
    noun: string;
  },
) {
  const navigate = useNavigate();
  const latest = useRef(opts);
  latest.current = opts;
  const done = useRef<string | null>(null);

  useEffect(() => {
    const clear = () =>
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => withoutPageIntent(prev),
        replace: true,
        // Tidying the address is not leaving the page. A page that guards
        // unsaved edits would otherwise ask "discard your changes?" about a
        // navigation that discards nothing.
        ignoreBlocker: true,
      } as never);

    if (intent.new === 1) {
      // A template waits for the page, like opening does: starting from one
      // can depend on what is already there (a copy already made, the
      // template list the page loads).
      if (intent.template && !opts.ready) return;
      const key = `new:${intent.template ?? ""}`;
      if (done.current !== key) {
        done.current = key;
        const started = latest.current.onNew?.(intent.template);
        if (started === false && intent.template) {
          toast.error(
            `There is no ${latest.current.noun} template called “${intent.template}” any more. Templates lists the ones there are.`,
          );
        }
      }
      clear();
      return;
    }
    if (intent.open) {
      if (!opts.ready) return;
      const key = `open:${intent.open}`;
      if (done.current !== key) {
        done.current = key;
        const found = latest.current.onOpen?.(intent.open);
        if (found === false) {
          toast.error(
            `That ${latest.current.noun} is not here any more, or is no longer shared with you.`,
          );
        }
      }
      clear();
      return;
    }
    done.current = null;
  }, [intent.open, intent.new, intent.template, opts.ready, navigate]);
}
