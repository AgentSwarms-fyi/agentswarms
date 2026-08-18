// Wire protocol for the AgentSwarms public embed endpoints.
//
// Framework-free on purpose: this file is the part of the SDK that must be
// exactly right, so it is pure, dependency-free, and unit-tested (with
// mutation coverage) in the main repo. The React hooks are thin shells over
// it.
//
// Both endpoints speak Server-Sent Events over a POST response:
//
//   POST /api/embed/chat      body { embedKey, parentOrigin?, nodeId?, messages }
//     event: citations   data: { citations: [...] }        (optional preamble)
//     data: {"choices":[{"delta":{"content":"..."}}]}      (OpenAI-style deltas)
//     event: widget      data: { widget: {...} }           (optional Visual BI)
//     data: [DONE]
//
//   POST /api/embed/analyst   body { key, parentOrigin?, question, priorTurns? }
//     event: turn        data: { turn }                    (progress snapshots)
//     event: done        data: { turn }                    (final)
//     event: failed      data: { error, status }
//
// Guardrail and budget refusals arrive as a normal delta frame containing the
// refusal text followed by [DONE] — by design, so a refusal renders exactly
// like an answer. Hard errors (bad key, rate limit, wrong resource type)
// arrive as a non-SSE JSON body `{ error }` with an HTTP error status.

/** One parsed frame from an SSE stream: `event:` name (or null) + raw data. */
export type SseFrame = { event: string | null; data: string };

/**
 * Incremental SSE tokenizer.
 *
 * Handles frames split across network chunks, CRLF line endings, comment
 * lines, multi-line `data:` fields (joined with newlines, per the SSE spec),
 * and ignores fields it does not know. Push chunks as they arrive; frames are
 * delivered in order via the callback.
 */
export function createSseParser(onFrame: (frame: SseFrame) => void): {
  push: (chunk: string) => void;
  /** Deliver a final unterminated frame, if the stream ended without \n\n. */
  flush: () => void;
} {
  let buffer = "";
  let event: string | null = null;
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) onFrame({ event, data: dataLines.join("\n") });
    event = null;
    dataLines = [];
  };

  const takeLine = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") return dispatch(); // blank line terminates the frame
    if (line.startsWith(":")) return; // comment
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      // Spec: a single leading space after the colon is not part of the value.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // unknown fields (id:, retry:) are deliberately ignored
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        takeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush() {
      if (buffer !== "") takeLine(buffer);
      dispatch();
    },
  };
}

// ── Chat endpoint mapping ─────────────────────────────────────────────────

export type Citation = { index: number; [k: string]: unknown };

export type ChatEvent =
  | { type: "citations"; citations: Citation[] }
  | { type: "delta"; text: string }
  | { type: "widget"; widget: unknown }
  | { type: "done" };

/**
 * Map one SSE frame from /api/embed/chat to a typed event, or null for
 * frames that carry nothing renderable (keep-alives, malformed lines —
 * skipped, never thrown: one bad frame must not kill a working stream).
 */
export function mapChatFrame(frame: SseFrame): ChatEvent | null {
  if (frame.data === "[DONE]") return { type: "done" };
  if (frame.event === "citations") {
    try {
      const parsed = JSON.parse(frame.data) as { citations?: unknown };
      if (Array.isArray(parsed.citations)) {
        return { type: "citations", citations: parsed.citations as Citation[] };
      }
    } catch {
      /* skip malformed frame */
    }
    return null;
  }
  if (frame.event === "widget") {
    try {
      const parsed = JSON.parse(frame.data) as { widget?: unknown };
      if (parsed.widget !== undefined) return { type: "widget", widget: parsed.widget };
    } catch {
      /* skip malformed frame */
    }
    return null;
  }
  // default frames: OpenAI-style delta chunks
  try {
    const parsed = JSON.parse(frame.data) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const text = parsed.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text.length > 0) return { type: "delta", text };
  } catch {
    /* skip malformed frame */
  }
  return null;
}

// ── Analyst endpoint mapping ──────────────────────────────────────────────

export type AnalystEvent =
  | { type: "turn"; turn: unknown }
  | { type: "done"; turn: unknown }
  | { type: "failed"; error: string; status?: number };

export function mapAnalystFrame(frame: SseFrame): AnalystEvent | null {
  if (frame.event !== "turn" && frame.event !== "done" && frame.event !== "failed") return null;
  try {
    const parsed = JSON.parse(frame.data) as {
      turn?: unknown;
      error?: unknown;
      status?: unknown;
    };
    if (frame.event === "failed") {
      return {
        type: "failed",
        error: typeof parsed.error === "string" ? parsed.error : "Analysis failed",
        status: typeof parsed.status === "number" ? parsed.status : undefined,
      };
    }
    if (parsed.turn === undefined) return null;
    return { type: frame.event, turn: parsed.turn };
  } catch {
    return null;
  }
}
