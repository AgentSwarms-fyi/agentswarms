// A server-to-server chat call (AI in SQL, document reading, the Sheets
// assistant, a headless swarm node) sends its memory settings with the call:
// memory off, no long-term scope. It has no session to read an agent's stored
// config with, and the route used to return the bare defaults for it — so
// the overrides were dropped and every such trace said short-term memory was
// on. Found reading an AI SQL trace in the default-model UI round.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/memory/recall.server", () => ({
  recallMemoryItems: async () => [],
  buildLtmBlock: () => "",
}));
vi.mock("@/utils/memory/summarize.server", () => ({ buildSummaryBlock: () => "" }));

import { withMemoryOverrides } from "@/utils/memory/memory.server";
import { DEFAULT_MEMORY_CONFIG } from "@/utils/memory/types";

describe("memory settings a call brings with it", () => {
  it("are laid over the defaults, and leave the defaults themselves alone", () => {
    const cfg = withMemoryOverrides(DEFAULT_MEMORY_CONFIG, {
      stm_enabled: false,
      ltm_enabled: false,
      ltm_scope: "none",
    });
    expect(cfg.stm_enabled).toBe(false);
    expect(cfg.ltm_enabled).toBe(false);
    expect(cfg.stm_window_messages).toBe(DEFAULT_MEMORY_CONFIG.stm_window_messages);
    expect(DEFAULT_MEMORY_CONFIG.stm_enabled).toBe(true);
  });

  it("switch long-term memory off for a run scoped to none, whatever else they say", () => {
    expect(
      withMemoryOverrides({ ...DEFAULT_MEMORY_CONFIG, ltm_enabled: true }, { ltm_scope: "none" })
        .ltm_enabled,
    ).toBe(false);
    expect(withMemoryOverrides(DEFAULT_MEMORY_CONFIG, undefined)).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  it("apply on the chat route's no-session path too", () => {
    const chat = readFileSync("src/routes/api/chat.ts", "utf8");
    const noSession = chat.slice(chat.indexOf("const memoryConfig = await (async () => {"));
    expect(noSession.slice(0, 600)).toMatch(
      /if \(!sb\) \{[\s\S]*?return withMemoryOverrides\(\s*DEFAULT_MEMORY_CONFIG,\s*body\.memoryOverrides/,
    );
  });
});
