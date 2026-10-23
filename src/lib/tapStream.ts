// A stream passed through to its reader, that says how it ended exactly once
// (R363).
//
// FOUND FROM THE UI (R363). A chat turn's stream recorded its trace from two
// places: its `cancel`, when the reader left, and its read loop. The reader
// leaving (Stop, a closed tab, an API caller that hung up) cancelled the
// stream; `cancel` recorded "error: Stream cancelled", and the loop, which
// did not know, went on writing into the cancelled stream, threw "Invalid
// state: Controller is already closed", and recorded that as the error. An
// AI-gateway call cut by its caller left a finished 847-token answer on the
// Traces page as that error, written over the success it had already been
// recorded as. Here the end is decided once, in one place: the stream's own
// read loop, which a reader leaving ends.

/** How a tapped stream ended. */
export type StreamEnd =
  /** The upstream ended, and everything it sent was passed on. */
  | { how: "complete" }
  /** The reader went away before the upstream ended. Not a failure. */
  | { how: "left" }
  /** The upstream failed while the reader was still there. */
  | { how: "failed"; error: unknown };

export function tapStream(
  upstream: ReadableStream<Uint8Array>,
  hooks: {
    /**
     * The request this stream answers. Its caller leaving aborts it, and a
     * fetch tied to it then fails, sometimes before this stream hears that
     * its reader went: a failure after it aborted is the caller leaving.
     */
    signal?: AbortSignal;
    /** Each chunk, after it is passed on. */
    onChunk?: (chunk: Uint8Array) => void;
    /**
     * Called once, however the stream ends, and awaited before it closes.
     * `send` adds bytes to a complete stream before it closes; after any
     * other end it does nothing.
     */
    onEnd: (end: StreamEnd, send: (bytes: Uint8Array) => void) => void | Promise<void>;
  },
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let left = false;
  const nothing = () => {};
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // After the reader leaves the stream is cancelled, and writing to it throws.
      const send = (bytes: Uint8Array) => {
        if (!left) controller.enqueue(bytes);
      };
      let failure: { error: unknown } | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          send(value);
          hooks.onChunk?.(value);
        }
      } catch (error) {
        failure = { error };
      }
      if (left || (failure && hooks.signal?.aborted)) {
        await hooks.onEnd({ how: "left" }, nothing);
        // Ends a stream nobody has cancelled yet; does nothing to one that was.
        if (failure) controller.error(failure.error);
        return;
      }
      if (failure) {
        await hooks.onEnd({ how: "failed", error: failure.error }, nothing);
        controller.error(failure.error);
        return;
      }
      await hooks.onEnd({ how: "complete" }, send);
      if (!left) controller.close();
    },
    cancel(reason) {
      // The pending read then ends, and the loop above says "left".
      left = true;
      reader.cancel(reason).catch(() => {});
    },
  });
}
