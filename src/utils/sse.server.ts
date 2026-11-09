// Keep an event stream alive while it has nothing to say.
//
// A streamed reply can go quiet for a long time between events: a slow first
// token, a tool round in the middle of an answer. Anything between the browser
// and this server counts that silence: an AWS ALB closes a connection idle
// past its idle timeout, CloudFront drops an origin that sends nothing for its
// read timeout (30 s by default), and nginx and corporate proxies have their
// own. Without traffic, a reply that was still being written died as a
// network error (R463).
//
// The fix is the one the SSE format provides for exactly this: a comment line,
// `: ka`, every SSE_HEARTBEAT_MS (15 s) of silence. Every SSE parser ignores
// comment lines. Ours skip any line that does not start with `data:`
// (chatStream, embedClient, a2aClient, swarmRuntime, the playgrounds), and so
// do the OpenAI and MCP SDKs, so the browser never sees it.
//
// A comment is only written between events, never in the middle of one: a
// source that emitted half an event and paused would otherwise have the
// comment spliced into it.
const KEEPALIVE = new TextEncoder().encode(": ka\n\n");

/** 15 s by default; SSE_HEARTBEAT_MS=0 turns it off. */
export function sseHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SSE_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === "") return 15_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 15_000;
}

/** True when `chunk` ends exactly at an event boundary (a blank line). */
function endsAtBoundary(chunk: Uint8Array): boolean {
  const n = chunk.length;
  if (n >= 2 && chunk[n - 1] === 10 && chunk[n - 2] === 10) return true; // \n\n
  // \r\n\r\n
  return (
    n >= 4 &&
    chunk[n - 1] === 10 &&
    chunk[n - 2] === 13 &&
    chunk[n - 3] === 10 &&
    chunk[n - 4] === 13
  );
}

/**
 * The same stream, with `: ka` comments written into any silence longer than
 * `intervalMs`. Backpressure is the source's: data is pulled only as the
 * consumer reads. Cancelling the result cancels the source.
 */
export function withSseHeartbeat(
  source: ReadableStream<Uint8Array> | null,
  intervalMs: number = sseHeartbeatMs(),
): ReadableStream<Uint8Array> | null {
  if (!source || !(intervalMs > 0)) return source;
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let atBoundary = true;
  let finished = false;
  let out: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // (Re)start the silence clock. Called at start and after every chunk, so a
  // comment is only ever written after intervalMs with nothing sent.
  const arm = () => {
    stopTimer();
    if (finished) return;
    timer = setTimeout(() => {
      if (finished || !out) return;
      if (atBoundary) {
        try {
          out.enqueue(KEEPALIVE);
        } catch {
          finished = true;
          return;
        }
      }
      arm();
    }, intervalMs);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
      arm();
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          finished = true;
          stopTimer();
          controller.close();
          return;
        }
        if (value && value.byteLength > 0) {
          controller.enqueue(value);
          atBoundary = endsAtBoundary(value);
        }
        arm();
      } catch (e) {
        finished = true;
        stopTimer();
        controller.error(e);
      }
    },
    cancel(reason) {
      finished = true;
      stopTimer();
      return reader.cancel(reason);
    },
  });
}
