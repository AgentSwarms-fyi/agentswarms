// Client helpers for the public /embed/* pages.
//
// The embedding page's origin is read from document.referrer (browsers set
// it truthfully for iframe navigations) and sent with every call so the
// server can enforce the key's domain allow-list. `?preview=1` adds the
// owner's session token, which bypasses the domain check for the owner
// only — that is how the /dashboard preview links work.

import { supabase } from "@/integrations/supabase/client";
import type { Citation } from "@/utils/tools/kb.server";

export function getParentOrigin(): string | null {
  try {
    const anc = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (anc && anc.length > 0) return anc[0];
  } catch {
    /* not supported */
  }
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function getPreviewToken(enabled: boolean): Promise<string | undefined> {
  if (!enabled) return undefined;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export type EmbedResolve =
  | { type: "agent"; name: string; description: string | null }
  | {
      type: "swarm";
      name: string;
      description: string | null;
      nodes: unknown[];
      edges: unknown[];
    }
  | {
      type: "bi_dashboard";
      name: string;
      description: string | null;
      widgets: unknown;
      layout: unknown;
      pages: unknown;
      filters: unknown;
      theme: unknown;
      updated_at: string;
      allowAi: boolean;
    };

export async function resolveEmbed(
  key: string,
  preview: boolean,
): Promise<{ ok: true; data: EmbedResolve } | { ok: false; error: string }> {
  const res = await fetch("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "resolve",
      key,
      parentOrigin: getParentOrigin(),
      previewToken: await getPreviewToken(preview),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as EmbedResolve & { error?: string };
  if (!res.ok || body.error) {
    return { ok: false, error: body.error ?? `Embed error (${res.status})` };
  }
  return { ok: true, data: body };
}

export async function askEmbedDashboard(args: {
  key: string;
  preview: boolean;
  question: string;
}): Promise<string> {
  const res = await fetch("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "ask",
      key: args.key,
      parentOrigin: getParentOrigin(),
      previewToken: await getPreviewToken(args.preview),
      question: args.question,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `Ask failed (${res.status})`);
  return body.answer ?? "";
}

export type EmbedChatMessage = { role: "user" | "assistant"; content: string };

/** Stream a chat turn; resolves to the full assistant text. */
export async function streamEmbedChat(args: {
  key: string;
  preview: boolean;
  messages: EmbedChatMessage[];
  nodeId?: string;
  onToken: (t: string) => void;
  onCitations?: (c: Citation[]) => void;
  /** A visual BI widget generated for this answer (agents with biVisuals on). */
  onWidget?: (w: unknown) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch("/api/embed/chat", {
    method: "POST",
    signal: args.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embedKey: args.key,
      parentOrigin: getParentOrigin(),
      previewToken: await getPreviewToken(args.preview),
      nodeId: args.nodeId,
      messages: args.messages,
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    let msg = `Chat failed (${res.status})`;
    try {
      msg = (JSON.parse(txt) as { error?: string }).error ?? msg;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let currentEvent = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        currentEvent = "message";
        continue;
      }
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      try {
        const p = JSON.parse(payload) as {
          citations?: Citation[];
          widget?: unknown;
          choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
        };
        if (currentEvent === "citations" && p.citations) {
          args.onCitations?.(p.citations);
          continue;
        }
        if (currentEvent === "widget" && p.widget) {
          args.onWidget?.(p.widget);
          continue;
        }
        const delta = p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.message?.content ?? "";
        if (typeof delta === "string" && delta) {
          text += delta;
          args.onToken(delta);
        }
      } catch {
        /* keep-alive lines */
      }
    }
  }
  return text;
}
