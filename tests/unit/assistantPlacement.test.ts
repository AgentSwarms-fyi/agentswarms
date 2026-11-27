// The open assistant sits beside the page only while the page keeps room.
//
// It opened as a 380px column beside the page, and the page gave up that width.
// On a laptop that squeezed the page: a 1366px window with the app's sidebar
// open left it 730px, and the swarm canvas, which keeps its own 320px node
// inspector, was left a strip between the two panels. Now, when beside would
// leave the page under 960px, the assistant floats over the page's right edge
// and the page keeps its width.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_PANEL_WIDTH,
  MIN_PAGE_WIDTH_BESIDE_ASSISTANT,
  assistantPlacement,
} from "@/lib/assistantPlacement";

// The width right of the app's sidebar (256px open, 48px as icons).
const room = (screen: number, sidebar = 256) => screen - sidebar;

describe("where the assistant sits", () => {
  it("beside the page on a wide screen, where the page keeps its room", () => {
    expect(assistantPlacement(room(1920))).toBe("beside");
    expect(assistantPlacement(room(2560))).toBe("beside");
  });

  it("over the page on a laptop, where beside would squeeze it", () => {
    expect(assistantPlacement(room(1366))).toBe("over"); // the page would be 730px
    expect(assistantPlacement(room(1440))).toBe("over");
    expect(assistantPlacement(room(1536))).toBe("over"); // 1920 at 125% scaling
  });

  it("beside again on the same laptop once the sidebar is folded to icons", () => {
    expect(assistantPlacement(room(1440, 48))).toBe("beside");
  });

  it("changes exactly where the page would drop under its minimum", () => {
    const edge = ASSISTANT_PANEL_WIDTH + MIN_PAGE_WIDTH_BESIDE_ASSISTANT;
    expect(assistantPlacement(edge)).toBe("beside");
    expect(assistantPlacement(edge - 1)).toBe("over");
  });
});

describe("the panel", () => {
  const panel = readFileSync("src/components/assistant/AssistantPanel.tsx", "utf8");
  const aside = panel.slice(
    panel.indexOf("<aside"),
    panel.indexOf("<PanelBody", panel.indexOf("<aside")),
  );

  it("is as wide as the placement assumes", () => {
    expect(aside).toContain(`"w-[${ASSISTANT_PANEL_WIDTH}px] border-l bg-background"`);
  });

  it("takes the page's width only beside it, and floats over it otherwise", () => {
    expect(aside).toMatch(
      /placement === "beside"\s*\?\s*"sticky z-30 shrink-0 self-start"\s*:\s*"fixed right-0 z-40 shadow-2xl"/,
    );
    expect(aside).toContain("ref={setPanel}");
  });

  it("measures its parent, which keeps its width whichever way the panel sits", () => {
    expect(panel).toMatch(/const room = panel\?\.parentElement;/);
    expect(panel).toMatch(/setPlacement\(assistantPlacement\(room\.clientWidth\)\)/);
    expect(panel).toMatch(/new ResizeObserver\(measure\)[\s\S]{0,40}ro\.observe\(room\)/);
  });

  it("sits in the layout row it measures", () => {
    const layout = readFileSync("src/components/AppLayout.tsx", "utf8");
    expect(layout).toMatch(
      /<div className="flex min-w-0 flex-1">\s*<main[\s\S]*?<\/main>\s*<AssistantPanel state=\{assistant\} \/>\s*<\/div>/,
    );
  });
});
