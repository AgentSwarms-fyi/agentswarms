// Headless AI-Analyst hook for an AgentSwarms embed key.
//
// The analyst endpoint streams whole-turn snapshots rather than text deltas:
// each `turn` event replaces the previous one (approach, steps, findings grow
// in place), `done` carries the final turn, `failed` carries an error. This
// hook keeps the finished turns as history and exposes the in-flight turn
// separately so a UI can render progress live.
import { useCallback, useMemo, useRef, useState } from "react";

import { createSseParser, mapAnalystFrame, type AnalystEvent } from "./protocol";

export type AnalystStatus = "idle" | "running" | "error";

export type UseAgentAnalystOptions = {
  /** Your AgentSwarms origin, e.g. "https://agents.your-domain.com". */
  baseUrl: string;
  /** The embed key from /embeds (resource type must be AI Analyst). */
  embedKey: string;
  /** Called for every typed event, if you want the raw stream too. */
  onEvent?: (event: AnalystEvent) => void;
};

export type UseAgentAnalyst = {
  /** Completed turns, oldest first. Shape matches the iframe embed's turns. */
  turns: unknown[];
  /** The turn currently streaming (approach/steps filling in), or null. */
  activeTurn: unknown | null;
  status: AnalystStatus;
  error: string | null;
  isRunning: boolean;
  ask: (question: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
};

export function useAgentAnalyst(options: UseAgentAnalystOptions): UseAgentAnalyst {
  const { baseUrl, embedKey, onEvent } = options;
  const [turns, setTurns] = useState<unknown[]>([]);
  const [activeTurn, setActiveTurn] = useState<unknown | null>(null);
  const [status, setStatus] = useState<AnalystStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<unknown[]>(turns);
  turnsRef.current = turns;

  const endpoint = useMemo(() => `${baseUrl.replace(/\/+$/, "")}/api/embed/analyst`, [baseUrl]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    setTurns([]);
    setActiveTurn(null);
    setStatus("idle");
    setError(null);
  }, [stop]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || status === "running") return;

      stop();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("running");
      setError(null);
      setActiveTurn(null);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            key: embedKey, // note: the analyst endpoint's field is `key`, not `embedKey`
            parentOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
            question: trimmed,
            priorTurns: turnsRef.current,
          }),
        });

        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok && !contentType.includes("text/event-stream")) {
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

        let failed = false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser((frame) => {
          const event = mapAnalystFrame(frame);
          if (!event) return;
          onEvent?.(event);
          if (event.type === "turn") setActiveTurn(event.turn);
          else if (event.type === "done") {
            setActiveTurn(null);
            setTurns((prev) => [...prev, event.turn]);
          } else {
            failed = true;
            setActiveTurn(null);
            setError(event.error);
          }
        });

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.flush();
        setStatus(failed ? "error" : "idle");
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setActiveTurn(null);
          setStatus("idle");
          return;
        }
        setError((e as Error).message || "Network error");
        setStatus("error");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [embedKey, endpoint, onEvent, status, stop],
  );

  return {
    turns,
    activeTurn,
    status,
    error,
    isRunning: status === "running",
    ask,
    stop,
    reset,
  };
}
