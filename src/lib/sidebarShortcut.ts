// Ctrl+B (or Cmd+B) and Ctrl+\ open and close the app's sidebar, unless the
// key was meant for what has focus. A spreadsheet or a text editor takes
// Ctrl+B for bold and says so by preventing the key's default; the sidebar
// flipping as well made every Ctrl+B in Sheets reflow the grid under the
// pointer (R123).

export const SIDEBAR_KEYS = ["b", "\\"];

export function isSidebarShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  if (event.defaultPrevented) return false;
  return SIDEBAR_KEYS.includes(event.key) && (event.metaKey || event.ctrlKey);
}
