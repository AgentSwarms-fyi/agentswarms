// The assistant's conversation, as the browser keeps it.
//
// It follows the reader from page to page and lasts as long as the tab: kept
// in this tab's session storage under the signed-in person's id, so a second
// person on the same browser never sees the first one's questions, and
// closing the tab forgets it. Nothing here is written to the database.

export type AssistantToolUse = {
  name: string;
  status: "running" | "ok" | "error" | "none";
};

export type AssistantMessage = {
  role: "user" | "assistant";
  content: string;
  /** What the answer looked up on the way, in order. */
  tools?: AssistantToolUse[];
  /** Set when the answer could not be had; the text says why. */
  error?: boolean;
  /** Where the reader was when they asked, for the line under a question. */
  where?: string;
};

/** How many messages a thread keeps; older ones fall off the top. */
export const THREAD_MAX = 40;
/** How much of the thread is sent with a question. */
export const SEND_MAX_MESSAGES = 16;
export const SEND_MAX_CHARS = 12_000;

export function threadKey(userId: string): string {
  return `agentswarms.assistant.thread:${userId}`;
}

/** A stored thread, or an empty one for anything that is not one. */
export function parseThread(raw: string | null | undefined): AssistantMessage[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { v?: unknown; messages?: unknown };
    if (v?.v !== 1 || !Array.isArray(v.messages)) return [];
    return v.messages
      .filter(
        (m): m is AssistantMessage =>
          !!m &&
          typeof m === "object" &&
          ((m as AssistantMessage).role === "user" ||
            (m as AssistantMessage).role === "assistant") &&
          typeof (m as AssistantMessage).content === "string",
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(Array.isArray(m.tools) ? { tools: m.tools } : {}),
        ...(m.error ? { error: true } : {}),
        ...(typeof m.where === "string" ? { where: m.where } : {}),
      }))
      .slice(-THREAD_MAX);
  } catch {
    return [];
  }
}

export function serializeThread(messages: readonly AssistantMessage[]): string {
  return JSON.stringify({ v: 1, messages: messages.slice(-THREAD_MAX) });
}

/**
 * The part of the thread the model reads with a new question: the latest
 * turns that fit, oldest dropped first. A failed answer and an empty one are
 * left out (the model never said them), and the result always starts with a
 * question, because a conversation that opens with an answer confuses some
 * providers.
 */
export function messagesToSend(
  messages: readonly AssistantMessage[],
  maxMessages = SEND_MAX_MESSAGES,
  maxChars = SEND_MAX_CHARS,
): Array<{ role: "user" | "assistant"; content: string }> {
  const usable = messages
    .filter((m) => !m.error && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const m = usable[i];
    if (out.length > 0 && chars + m.content.length > maxChars) break;
    // The newest question is sent whole up to the limit, even when long.
    const content = out.length === 0 ? m.content.slice(0, maxChars) : m.content;
    out.unshift({ role: m.role, content });
    chars += content.length;
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** What the reader is told a tool is doing, or did. */
export function toolLabel(t: AssistantToolUse): string {
  const running = t.status === "running";
  switch (t.name) {
    case "docs_search":
      return running ? "Reading the handbook…" : "Read the handbook";
    case "find_my_work":
      return running ? "Looking through your work…" : "Looked through your work";
    default:
      return running ? "Working…" : "Looked something up";
  }
}

/**
 * A link in an answer that moves this tab, or null for one that opens a new
 * tab. App pages and the reader's things move this tab, beside the panel.
 * The handbook has a layout of its own, without the panel, so following it in
 * place would take the panel away mid-conversation: it opens in a new tab, as
 * does anything outside the app.
 */
export function appPath(href: string | null | undefined): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h.startsWith("/") || h.startsWith("//") || h.startsWith("/\\")) return null;
  if (h === "/docs" || /^\/docs[/?#]/.test(h)) return null;
  return h;
}

/** Asked from elsewhere (the search box): the panel opens and asks it. */
export const ASK_EVENT = "agentswarms:assistant-ask";

export function askAssistant(question: string): void {
  const q = question.trim();
  if (!q || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ question: string }>(ASK_EVENT, { detail: { question: q } }),
  );
}

/**
 * Handbook links put back on the handbook in this app. Told to copy the
 * tool's links as given, a model still writes a handbook section under a web
 * address it remembers: "https://docs.example.com/docs/bi", or with the
 * /docs dropped, "https://docs.example.com/dashboard#trash" (both seen). The
 * tool only ever returns paths on this site, so such a link did not come from
 * it; the section it names is opened in this app's handbook, which matches
 * this version of the app. Other links are left as written.
 */
export function localHandbookLinks(markdown: string): string {
  return (
    markdown
      // Any host, a /docs path: keep the path.
      .replace(
        /\]\(\s*https?:\/\/[^\s/)]+(\/docs(?:[/?#][^\s)]*)?)\s*\)/g,
        (_m, path: string) => `](${path})`,
      )
      // A "docs." host with the /docs left off: put it back.
      .replace(
        /\]\(\s*https?:\/\/docs\.[^\s/)]+(\/[^\s)]*)?\s*\)/g,
        (_m, path: string | undefined) =>
          `](/docs${!path || path === "/" ? "" : path.startsWith("/docs") ? path.slice(5) : path})`,
      )
  );
}
