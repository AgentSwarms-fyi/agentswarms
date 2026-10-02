// Prompt Compare's cost and tokens, from the stream the server sent (R194).
//
// FOUND IN R194, the first round of sweep 4 ("two surfaces, two answers"),
// while smoke-testing the real image 6b8a7e784718. Prompt Compare ran
// Gemini 2.5 Flash against GPT-5 Mini and showed "Est. cost —" for both and
// "~1" tokens, under a footnote saying cost and tokens come from the server.
// The raw bodies, tee'd in the browser, each arrived as ONE chunk ending
// `data: [DONE]` then `event: cost` with the real figures (Flash $0.0000046,
// 7/1; Mini $0.00012325, 13/60), and the Traces page showed them too. The
// page had its own stream reader, which stopped at `[DONE]`. It now uses the
// shared reader.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readChatStream, type ChatUsage } from "@/lib/chatStream";

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });

const delta = (t: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

describe("readChatStream", () => {
  it("reads the cost event that follows [DONE] in the same chunk", async () => {
    // The body exactly as the browser received it: one chunk.
    const body = stream([
      delta("O") +
        delta("K") +
        "data: [DONE]\n\n" +
        'event: cost\ndata: {"model":"openai/gpt-5-mini","costUsd":0.00012325,"tokensIn":13,"tokensOut":60}\n\n',
    ]);
    let usage: ChatUsage | null = null;
    const text = await readChatStream(body, { usage: (u) => (usage = u) });
    expect(text).toBe("OK");
    expect(usage).toEqual({
      model: "openai/gpt-5-mini",
      costUsd: 0.00012325,
      tokensIn: 13,
      tokensOut: 60,
    });
  });

  it("hands each piece of text to `delta` as it arrives, and none that is empty", async () => {
    const pieces: string[] = [];
    const body = stream([delta("Hel"), delta(""), delta("lo"), "data: [DONE]\n\n"]);
    const text = await readChatStream(body, { delta: (d) => pieces.push(d) });
    expect(pieces).toEqual(["Hel", "lo"]);
    expect(text).toBe("Hello");
  });
});

describe("Prompt Compare", () => {
  const SRC = readFileSync("src/routes/_authenticated/prompt-compare.tsx", "utf8");

  it("reads the chat stream with the shared reader, not a copy of its own", () => {
    expect(SRC).toContain('import { readChatStream, type ChatUsage } from "@/lib/chatStream";');
    expect(SRC).toMatch(/await readChatStream\(resp\.body, \{/);
    expect(SRC).toMatch(/usage: \(u\) => \{\s*usage\.value = u;\s*\}/);
    expect(SRC).not.toContain('"[DONE]"');
    expect(SRC).not.toContain("getReader()");
  });
});

describe("every stream reader in the app", () => {
  // The survey that closed R194: every reader of an SSE body skips `[DONE]`
  // and reads on. One that stops there loses whatever the server sends after.
  // A `break` stops the read loop. A `return` is left out on purpose: the
  // server's upstream readers (chat.ts, the Gemini adapter) return from a
  // per-line `consumeLine`, which skips the line and reads on.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk("src");

  it("does not stop reading at [DONE]", () => {
    const stoppers = files.filter((f) =>
      /["']\[DONE\]["']\s*\)\s*(\{\s*)?break\b/.test(readFileSync(f, "utf8")),
    );
    expect(stoppers).toEqual([]);
  });
});
