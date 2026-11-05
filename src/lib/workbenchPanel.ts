// Whether the Workbench's BI Agent and SQL Chat panel is showing. How this browser
// likes the page, so it is kept here and not on the account. It reads as open until
// someone hides it, and as open when the browser keeps nothing: on the server, in a
// private window, or with site data blocked.
const KEY = "agentswarms.workbench_agent_panel";

export function readAgentPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeAgentPanelOpen(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    /* The panel still toggles; the choice just lasts until the page is left. */
  }
}
