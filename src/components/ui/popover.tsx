import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

/**
 * The open dialog to portal into, or null when there isn't one.
 *
 * WHY THIS EXISTS. Radix Dialog locks page scrolling with react-remove-scroll,
 * which allows wheel events only inside the dialog's own DOM subtree and
 * cancels them everywhere else. A popover portalled to <body> is *outside*
 * that subtree, so its list could be scrolled by dragging the scrollbar or by
 * keyboard — and not by the mouse wheel, which is how everyone actually
 * scrolls a 400-model picker. The CSS was always right; the events were being
 * swallowed one level up.
 *
 * Portalling into the open dialog puts the popover back inside the allowed
 * subtree. Outside a dialog this is null and the popover portals to <body>
 * exactly as before, so nothing else moves.
 */
function useDialogContainer(): HTMLElement | null {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  // AFTER commit, not during render. A dialog and the popover inside it mount
  // in the SAME React pass, and during the render phase the dialog's DOM node
  // does not exist yet — querying for it there always found nothing, which is
  // exactly how the first version of this fix silently did nothing at all.
  React.useLayoutEffect(() => {
    setContainer(document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]'));
  }, []);
  return container;
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, collisionBoundary, ...props }, ref) => {
  const container = useDialogContainer();
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        // Collide against the DIALOG, not the viewport, whenever we portalled
        // into one. DialogContent is translate-x/y-[-50%] with overflow-y-auto:
        // the transform makes it the containing block for the popper's
        // position:fixed, so the popover cannot escape it, and the overflow
        // then CLIPS whatever hangs outside. Radix defaults to viewport
        // collision, so it would happily place a popover past the dialog's
        // edge -- fits the screen, invisible to the user. Passing the dialog
        // here also makes --radix-popover-content-available-height report the
        // space that actually exists, which is what content max-heights read.
        collisionBoundary={collisionBoundary ?? (container ? [container] : undefined)}
        className={cn(
          "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-popover-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
