// What the button that shows and hides the menu says about itself, to a screen
// reader and to anything else that reads its state.
//
// On a phone the menu is a sheet with its own open state, and the desktop
// state stays "expanded" behind it. Read from the desktop state alone, the
// button said "Collapse sidebar, expanded" over a menu that was closed.

export type MenuButton = { expanded: boolean; label: string };

export function menuButton(args: {
  /** The menu is a sheet over the page, not a rail beside it. */
  isMobile: boolean;
  /** That sheet is open. */
  openMobile: boolean;
  /** The rail is at its full width. */
  railExpanded: boolean;
}): MenuButton {
  if (args.isMobile) {
    return { expanded: args.openMobile, label: args.openMobile ? "Close menu" : "Open menu" };
  }
  return {
    expanded: args.railExpanded,
    label: args.railExpanded ? "Collapse sidebar" : "Expand sidebar",
  };
}
