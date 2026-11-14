// A slow answer's headers sent early, behind a proxy that gives up first (R481).
//
// CloudFront waits at most 60 s for an origin's first byte, then answers 504.
// A chat turn whose tool rounds take longer (30 to 95 s is common for an
// agent that queries data) sent nothing until they finished, so behind
// CloudFront, which deploy/aws puts in front when there is no domain, the
// user lost the turn.
//
// With EARLY_HEADERS_AFTER_MS set, a response that is not ready by then is
// answered at once as an event stream: comments (": waiting") keep the
// connection alive, the real answer's stream follows when it exists, and a
// failure arrives as `event: error` with the status it would have had. Every
// reader of /api/chat handles that event (chatStream.ts, the playground, the
// canvas runtime).
//
// Off unless set, so a response everywhere else keeps its real status. Behind
// CloudFront the status a slow failure would have had is lost either way.
export type EarlyHeadersOptions = {
  afterMs: number;
  heartbeatMs?: number;
  /** CORS and the like, on the early response. */
  headers?: Record<string, string>;
};

export const EARLY_HEARTBEAT_MS = 15_000;

/** EARLY_HEADERS_AFTER_MS as a positive number of milliseconds, or null: off. */
export function earlyHeadersAfterMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const n = Number((env.EARLY_HEADERS_AFTER_MS ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const enc = new TextEncoder();

function errorEvent(message: string, status: number): Uint8Array {
  return enc.encode(`event: error\ndata: ${JSON.stringify({ error: message, status })}\n\n`);
}

async function messageOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === "string" && j.error) return j.error;
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 500) || `The request failed (HTTP ${res.status})`;
}

type Settled = { res: Response } | { err: unknown };

export async function withEarlyHeaders(
  work: Promise<Response>,
  opts: EarlyHeadersOptions,
): Promise<Response> {
  const settled: Promise<Settled> = work.then(
    (res) => ({ res }),
    (err: unknown) => ({ err }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), opts.afterMs);
  });
  const first = await Promise.race([settled, late]);
  clearTimeout(timer);
  if (first !== "late") {
    if ("err" in first) throw first.err;
    return first.res;
  }

  const heartbeatMs = opts.heartbeatMs ?? EARLY_HEARTBEAT_MS;
  let beat: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  let upstream: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (b: Uint8Array) => {
        if (!cancelled) controller.enqueue(b);
      };
      send(enc.encode(": waiting\n\n"));
      beat = setInterval(() => send(enc.encode(": waiting\n\n")), heartbeatMs);
      const done = await settled;
      clearInterval(beat);
      if (cancelled) return;
      try {
        if ("err" in done) {
          const e = done.err;
          send(errorEvent(e instanceof Error ? e.message : String(e), 500));
        } else if (!done.res.ok) {
          send(errorEvent(await messageOf(done.res), done.res.status));
        } else if (
          done.res.body &&
          (done.res.headers.get("content-type") ?? "").includes("text/event-stream")
        ) {
          upstream = done.res.body.getReader();
          for (;;) {
            const { done: end, value } = await upstream.read();
            if (end || cancelled) break;
            if (value) send(value);
          }
        } else {
          send(
            errorEvent(
              `The answer was not an event stream (${done.res.headers.get("content-type") ?? "no type"})`,
              502,
            ),
          );
        }
      } catch (e) {
        send(errorEvent(e instanceof Error ? e.message : String(e), 502));
      }
      if (!cancelled) controller.close();
    },
    cancel(reason) {
      cancelled = true;
      clearInterval(beat);
      upstream?.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...(opts.headers ?? {}),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      // So a support session can tell why a failure came as an event.
      "X-Early-Headers": "1",
    },
  });
}
