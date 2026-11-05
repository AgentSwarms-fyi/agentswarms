// Hiding the Workbench's BI Agent and SQL Chat panel.
//
// There is no DOM renderer for this page in the suite (see workbenchToolbar.test.ts),
// so what is decided in a function is tested as behaviour, and the page's wiring is
// pinned from its source. The toggle itself was driven in the browser.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgentPanelOpen, writeAgentPanelOpen } from "@/lib/workbenchPanel";

const src = readFileSync("src/routes/_authenticated/data-sql.tsx", "utf8");

const browser = (stored: Record<string, string> = {}) => {
  const localStorage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
  };
  vi.stubGlobal("window", { localStorage });
  return stored;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remembering the choice", () => {
  it("is open for anyone who has not chosen", () => {
    browser();
    expect(readAgentPanelOpen()).toBe(true);
  });

  it("stays hidden, and stays open, once chosen", () => {
    browser();
    writeAgentPanelOpen(false);
    expect(readAgentPanelOpen()).toBe(false);
    writeAgentPanelOpen(true);
    expect(readAgentPanelOpen()).toBe(true);
  });

  it("is open on the server, which has no window", () => {
    expect(readAgentPanelOpen()).toBe(true);
    expect(() => writeAgentPanelOpen(false)).not.toThrow();
  });

  it("does not break a browser that refuses storage", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("blocked");
      },
    });
    expect(readAgentPanelOpen()).toBe(true);
    expect(() => writeAgentPanelOpen(false)).not.toThrow();
  });
});

describe("the page", () => {
  const panelClass = src.slice(src.indexOf('id="workbench-agent-panel"'));

  it("reads the choice after mount, so hydration cannot leave the panel showing", () => {
    expect(src).toContain("const [agentPanelOpen, setAgentPanelOpen] = useState(true);");
    expect(src).toMatch(
      /useLayoutEffect\(\(\) => \{\s*setAgentPanelOpen\(readAgentPanelOpen\(\)\);/,
    );
  });

  it("saves the choice when it is made", () => {
    expect(src).toMatch(/setAgentPanelOpen\(next\);\s*writeAgentPanelOpen\(next\);/);
  });

  it("keeps the panel mounted, so a chat survives being hidden", () => {
    expect(panelClass.slice(0, 220)).toContain('agentPanelOpen ? "flex" : "hidden"');
    expect(src).not.toMatch(/\{agentPanelOpen && \(?\s*<aside/);
  });

  it("does not fight its own display class", () => {
    // `flex flex-col` beside a conditional `hidden` is two displays, and which one
    // wins would depend on the order of the generated CSS.
    const cls = panelClass.slice(0, panelClass.indexOf("agentPanelOpen"));
    expect(cls).toContain("flex-col");
    expect(cls).not.toMatch(/[\s`]flex\s/);
  });

  it("names what it does, and says whether the panel is open", () => {
    const button = src.slice(src.indexOf("onClick={toggleAgentPanel}"));
    expect(button.slice(0, 420)).toContain("aria-expanded={agentPanelOpen}");
    expect(button.slice(0, 420)).toContain('aria-controls="workbench-agent-panel"');
    expect(button.slice(0, 420)).toContain('"Hide BI Agent and SQL Chat"');
    expect(button.slice(0, 420)).toContain('"Show BI Agent and SQL Chat"');
  });

  it("sits in the title row, so a narrow window does not lose a row of the editor", () => {
    const titleRow = src.slice(
      src.indexOf("flex items-center gap-2 min-w-0 flex-auto"),
      src.indexOf("flex min-w-0 flex-wrap items-center justify-end gap-1.5"),
    );
    expect(titleRow).toContain("onClick={toggleAgentPanel}");
    expect(titleRow).toContain("ml-auto");
  });

  it("leaves a way back that says what it is", () => {
    expect(src).toMatch(/<PanelRightOpen className="h-3\.5 w-3\.5 mr-1\.5" \/> BI Agent/);
  });

  it("does not point at a panel that is hidden", () => {
    expect(src).toContain('{agentPanelOpen ? " or ask the BI agent →" : ""}');
    expect(src).not.toMatch(/^\s*or ask the BI agent →$/m);
  });

  it("does not ask a model for suggestions nobody can see", () => {
    const effect = src.slice(src.indexOf("A model call, so not while the panel"));
    expect(effect.slice(0, 260)).toMatch(/agentPanelOpen &&\s*suggestionDatasets\.length > 0/);
  });

  it("loads them when the panel is opened", () => {
    expect(src).toContain("}, [agentPanelOpen, suggestionDatasets.length, suggestions.length]);");
  });
});
