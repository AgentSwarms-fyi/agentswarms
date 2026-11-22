// The assistant's state: whether the panel is open, the conversation, and the
// one question in flight. Held by the app layout, which outlives every page,
// so the conversation follows the reader as they move around.
import { useCallback, useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { ASSISTANT_TOOLS } from "@/lib/assistantPrompt";
import {
  ASK_EVENT,
  messagesToSend,
  parseThread,
  serializeThread,
  threadKey,
  type AssistantMessage,
  type AssistantToolUse,
} from "@/lib/assistantThread";
import { readChatStream } from "@/lib/chatStream";

const OPEN_KEY = "agentswarms.assistant.open";

function readOpen(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function loadThread(userId: string): AssistantMessage[] {
  try {
    return parseThread(window.sessionStorage.getItem(threadKey(userId)));
  } catch {
    return [];
  }
}

function saveThread(userId: string, messages: readonly AssistantMessage[]) {
  try {
    if (messages.length)
      window.sessionStorage.setItem(threadKey(userId), serializeThread(messages));
    else window.sessionStorage.removeItem(threadKey(userId));
  } catch {
    /* storage refused: the thread lasts as long as the page */
  }
}

/** The sentence a reader can act on, from a refused request. */
async function refusalText(res: Response): Promise<string> {
  let message = "";
  try {
    const j = (await res.json()) as { message?: unknown; error?: unknown };
    message =
      typeof j.message === "string" ? j.message : typeof j.error === "string" ? j.error : "";
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return "You are signed out. Sign in again, then ask.";
  if (res.status === 402) return `The AI budget is used up${message ? `: ${message}` : "."}`;
  if (res.status === 403)
    return message || "Your role may not use the workspace's default model. Ask an administrator.";
  if (res.status === 429) return "The model is busy right now. Ask again in a moment.";
  return message || `The assistant could not answer (${res.status}).`;
}

export type AssistantState = ReturnType<typeof useAssistant>;

export function useAssistant() {
  const [open, setOpenState] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // A question asked from elsewhere, waiting for the panel to ask it with the
  // page's own context (only the panel knows where the reader is).
  // Numbered, so the same words asked twice are two questions.
  const [pending, setPending] = useState<{ id: number; question: string } | null>(null);
  const pendingSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Read after mount: the server renders the panel closed.
  useEffect(() => setOpenState(readOpen()), []);

  const setOpen = useCallback((next: boolean | ((was: boolean) => boolean)) => {
    setOpenState((was) => {
      const v = typeof next === "function" ? next(was) : next;
      try {
        window.localStorage.setItem(OPEN_KEY, v ? "1" : "0");
      } catch {
        /* a convenience only */
      }
      return v;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (alive) setUserId(data.session?.user.id ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserId(session?.user.id ?? null);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  // A different person (or none) gets their own thread, never the last one's.
  useEffect(() => {
    abortRef.current?.abort();
    setMessages(userId ? loadThread(userId) : []);
  }, [userId]);

  useEffect(() => {
    if (userId) saveThread(userId, messages);
  }, [userId, messages]);

  useEffect(() => {
    const onAsk = (e: Event) => {
      const q = (e as CustomEvent<{ question?: unknown }>).detail?.question;
      if (typeof q !== "string" || !q.trim()) return;
      setOpen(true);
      pendingSeq.current += 1;
      setPending({ id: pendingSeq.current, question: q.trim() });
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [setOpen]);

  /** The panel has asked the waiting question with this id. */
  const clearPending = useCallback((id: number) => {
    setPending((was) => (was?.id === id ? null : was));
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  /** Ask one question, with the instructions for where the reader is now. */
  const ask = useCallback(
    async (question: string, systemPrompt: string, where: string) => {
      const text = question.trim();
      if (!text || busy) return;
      const asked: AssistantMessage = { role: "user", content: text, where };
      const history = [...messages, asked];
      setMessages([...history, { role: "assistant", content: "", tools: [] }]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let answer = "";
      let tools: AssistantToolUse[] = [];
      const show = (patch: Partial<AssistantMessage>) =>
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant") copy[copy.length - 1] = { ...last, ...patch };
          return copy;
        });

      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        const res = await fetch("/api/chat", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            // No model named: the workspace's default, under the reader's
            // own model rules and budget, as every other surface.
            // Named "Assistant" on its trace (a fixed name the route allows).
            surface: "assistant",
            systemPrompt,
            temperature: 0.2,
            messages: messagesToSend(history),
            enabledTools: [...ASSISTANT_TOOLS],
            memoryOverrides: { stm_enabled: false, ltm_enabled: false, ltm_scope: "none" },
          }),
        });
        if (!res.ok || !res.body) {
          show({ content: await refusalText(res), error: true, tools: [] });
          return;
        }
        await readChatStream(res.body, {
          delta: (d) => {
            answer += d;
            show({ content: answer });
          },
          tool: (e) => {
            if (e.type === "tool_call") tools = [...tools, { name: e.name, status: "running" }];
            else {
              const at = tools.findIndex((t) => t.name === e.name && t.status === "running");
              if (at >= 0)
                tools = tools.map((t, i) =>
                  i === at ? { ...t, status: e.ok ? "ok" : "error" } : t,
                );
            }
            show({ tools });
          },
        });
        const settled = tools.map((t) =>
          t.status === "running" ? { ...t, status: "none" as const } : t,
        );
        show(
          answer.trim()
            ? { content: answer, tools: settled }
            : { content: "No answer came back. Ask again.", error: true, tools: settled },
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          show(
            answer.trim()
              ? { content: `${answer}\n\n*Stopped.*`, tools }
              : { content: "Stopped.", error: true, tools },
          );
        } else {
          show({
            content: "The assistant could not be reached. Check your connection and ask again.",
            error: true,
            tools,
          });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, messages],
  );

  return {
    open,
    setOpen,
    messages,
    busy,
    ask,
    stop,
    clear,
    pending,
    clearPending,
    signedIn: !!userId,
  };
}
