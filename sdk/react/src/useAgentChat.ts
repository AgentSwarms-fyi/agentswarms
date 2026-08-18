// Headless chat hook for an AgentSwarms embed key.
//
// Everything visual is yours: the hook owns the wire protocol, streaming
// state and cancellation, and hands back plain data. The server owns every
// control that matters — key validity, expiry, the domain allow-list, rate
// limits, the owner's budget, model governance, guardrails — so nothing in
// this file (or in your bundle) can widen access. The embed key is public by
// construction; treat it like a site key, not a secret.
import { useCallback, useMemo, useRef, useState } from "react";

import { createSseParser, mapChatFrame, type ChatEvent, type Citation } from "./protocol";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AgentChatStatus = "idle" | "streaming" | "error";

export type UseAgentChatOptions = {
  /** Your AgentSwarms origin, e.g. "https://agents.your-domain.com". */
  baseUrl: string;
  /** The embed key from /embeds — public, like a site key. */
  embedKey: string;
  /** Swarm embeds only: address one node of the swarm. */
  nodeId?: string;
  /** Seed the conversation (e.g. a welcome message). */
  initialMessages?: ChatMessage[];
  /** Called for every typed event, if you want the raw stream too. */
  onEvent?: (event: ChatEvent) => void;
};

export type UseAgentChat = {
  messages: ChatMessage[];
  status: AgentChatStatus;
  /** Why the last send failed, or null. Refusals are NOT errors — a guardrail
   *  or budget refusal arrives as a normal assistant message, by design. */
  error: string | null;
  /** Knowledge-base citations for the current answer, when the agent used any. */
  citations: Citation[];
  /** Visual-BI widget spec for the current answer, when enabled on the key. */
  widget: unknown | null;
  /** True while an answer is streaming. */
  isStreaming: boolean;
  send: (text: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
};

export function useAgentChat(options: UseAgentChatOptions): UseAgentChat {
  const { baseUrl, embedKey, nodeId, onEvent } = options;
  const [messages, setMessages] = useState<ChatMessage[]>(options.initialMessages ?? []);
  const [status, setStatus] = useState<AgentChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [widget, setWidget] = useState<unknown | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const endpoint = useMemo(() => `${baseUrl.replace(/\/+$/, "")}/api/embed/chat`, [baseUrl]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    setMessages(options.initialMessages ?? []);
    setStatus("idle");
    setError(null);
    setCitations([]);
    setWidget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || status === "streaming") return;

      stop();
      const controller = new AbortController();
      abortRef.current = controller;

      const userMessage: ChatMessage = { role: "user", content: trimmed };
      // The history we SEND is captured before render state updates — the
      // server sees exactly what the user saw when they hit send.
      const history = [...messagesRef.current, userMessage];
      setMessages(history);
      setStatus("streaming");
      setError(null);
      setCitations([]);
      setWidget(null);

      let assistantText = "";
      let assistantShown = false;
      const appendDelta = (delta: string) => {
        assistantText += delta;
        if (!assistantShown) {
          assistantShown = true;
          setMessages((prev) => [...prev, { role: "assistant", content: assistantText }]);
        } else {
          setMessages((prev) =>
            prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantText } : m)),
          );
        }
      };

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            embedKey,
            nodeId,
            // The browser's Origin header is what the server's allow-list
            // actually checks; this field mirrors what iframe embeds report.
            parentOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
            messages: history,
          }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok && !contentType.includes("text/event-stream")) {
          // Hard errors are JSON: bad key, expired, wrong site, rate limited…
          let message = `Request failed (${response.status})`;
          try {
            const parsed = (await response.json()) as { error?: string };
            if (parsed.error) message = parsed.error;
          } catch {
            /* keep the status message */
          }
          setError(message);
          setStatus("error");
          return;
        }
        if (!response.body) {
          setError("The server returned no stream.");
          setStatus("error");
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser((frame) => {
          const event = mapChatFrame(frame);
          if (!event) return;
          onEvent?.(event);
          if (event.type === "delta") appendDelta(event.text);
          else if (event.type === "citations") setCitations(event.citations);
          else if (event.type === "widget") setWidget(event.widget);
        });

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.flush();
        setStatus("idle");
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          // A deliberate stop is not an error; whatever streamed stays.
          setStatus("idle");
          return;
        }
        setError((e as Error).message || "Network error");
        setStatus("error");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [embedKey, endpoint, nodeId, onEvent, status, stop],
  );

  // A ref mirror of messages, so send() can read the latest history without
  // being re-created on every keystroke of streaming output.
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  return {
    messages,
    status,
    error,
    citations,
    widget,
    isStreaming: status === "streaming",
    send,
    stop,
    reset,
  };
}
