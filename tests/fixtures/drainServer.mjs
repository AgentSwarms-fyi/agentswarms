// Child process for serverDrain.test.ts's real-signal test. Streams `ticks`
// SSE events, one every `everyMs`, and shuts down either the way server.mjs
// does now ("drain") or the way it did before R463 ("legacy": srvx's own
// SIGTERM handler left on, plus a second handler that exits once close()
// settles).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [mode = "drain", ticksArg = "15", everyArg = "100"] = process.argv.slice(2);
const ticks = Number(ticksArg);
const everyMs = Number(everyArg);

const { serve } = await import("srvx");
const { installDrain } = await import(pathToFileURL(path.join(root, "serverDrain.mjs")).href);

const options = {
  port: 0,
  hostname: "127.0.0.1",
  silent: true,
  fetch: () =>
    new Response(
      new ReadableStream({
        async start(c) {
          for (let i = 0; i < ticks; i++) {
            c.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
            await new Promise((r) => setTimeout(r, everyMs));
          }
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
};
if (mode === "drain") options.gracefulShutdown = false;
const server = serve(options);
await server.ready();

if (mode === "drain") {
  installDrain({ server, who: "test", log: { log() {}, warn() {} } });
} else {
  let closing = false;
  process.on("SIGTERM", () => {
    if (closing) return;
    closing = true;
    Promise.resolve(server.close?.()).finally(() => process.exit(0));
  });
}
process.send?.({ port: Number(new URL(server.url).port) });
