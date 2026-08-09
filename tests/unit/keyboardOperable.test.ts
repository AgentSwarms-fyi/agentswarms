// A control you can only reach with a mouse is a control some people cannot use.
//
// <Card onClick> / <div onClick> / <li onClick> render as plain elements: the
// mouse works and nothing else does. They are not in the tab order, Enter and
// Space do nothing, and they never enter the accessibility tree — a screen
// reader is not told they are controls, so they are not announced as any.
//
// This was load-bearing, not cosmetic. On /knowledge the knowledge-base picker
// is a Card, so SELECTING A KNOWLEDGE BASE — the only route to its documents —
// was mouse-only. Reading that page's accessibility tree returned two buttons
// for the entire screen; after the fix the three collections appear by name and
// Enter selects one. WCAG 2.1 SC 2.1.1 (Keyboard) is Level A, and "can a
// keyboard-only user operate this" is a question enterprise procurement asks in
// writing.
//
// The rule here is: the count may go DOWN, never up. The remaining sites are
// listed with a reason rather than hidden behind a passing test, because a
// silent backlog is how the 16 accumulated in the first place.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/** Elements that render as non-interactive DOM but are handed a click. */
const CLICKABLE = /<(Card|CardHeader|CardContent|div|span|li|tr)\b([^>]*?)onClick=([^>]*?)>/gs;

/**
 * Known-unfixed sites, each with why it is still here. These are NOT excused
 * forever — they are the remaining backlog, kept visible.
 *
 *   chart internals — clicking a bar/slice/row cross-filters the canvas. The
 *     right fix is not a tabIndex on every segment (that would make a 40-bar
 *     chart 40 tab stops) but an equivalent control elsewhere; that is a design
 *     decision, not a mechanical edit.
 *   list selections — straightforward, simply not done yet.
 */
const KNOWN: Record<string, string> = {
  "components/bi/BiChartParts.tsx": "chart internals — cross-filter by clicking a row/segment",
  "components/bi/BiChartRender.tsx": "chart internals — legend toggle",
  "components/observability/TraceFlowCanvas.tsx": "graph canvas node selection",
  "routes/_authenticated/bi.tsx": "list selection — not done yet",
  "components/agents/AgentForm.tsx": "list selection — not done yet",
  "components/data-sql/QueryHistoryPanel.tsx": "list selection — not done yet",
  "components/knowledge/KnowledgeGraphTab.tsx": "list selection — not done yet",
  "components/swarms/SwarmChatDialog.tsx": "list selection — not done yet",
  "routes/_authenticated/data-sql.tsx": "list selection — not done yet",
  "routes/_authenticated/playground.tsx": "list selection — not done yet",
};

/** Every file that still has a keyboard-unreachable clickable element. */
function offendingFiles(): string[] {
  const out = new Set<string>();
  for (const file of walk(resolve("src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CLICKABLE)) {
      const attrs = m[0];
      if (/role=["']button["']/.test(attrs)) continue;
      if (/tabIndex/.test(attrs)) continue;
      if (/onKeyDown|onKeyUp|onKeyPress/.test(attrs)) continue;
      out.add(file.replace(/\\/g, "/").split("/src/")[1]);
    }
  }
  return [...out].sort();
}

describe("clickable elements are operable by keyboard", () => {
  it("introduces no new mouse-only controls", () => {
    const unexpected = offendingFiles().filter((f) => !(f in KNOWN));
    expect(
      unexpected,
      "these give a click handler to an element a keyboard cannot reach.\n" +
        "Spread `clickable(fn, label)` from @/lib/clickable onto it, or use a real <button>:\n  " +
        unexpected.join("\n  "),
    ).toEqual([]);
  });

  it("keeps the backlog honest — a fixed file must leave the known list", () => {
    // Stops KNOWN from rotting into a permanent excuse list that no longer
    // describes the code.
    const still = new Set(offendingFiles());
    const stale = Object.keys(KNOWN).filter((f) => !still.has(f));
    expect(stale, `fixed — delete these from KNOWN:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("the four primary selection surfaces are fixed", () => {
    // The ones that gated a whole page's function. Named individually so a
    // regression points at the feature, not at a count.
    for (const f of [
      "routes/_authenticated/knowledge.tsx",
      "routes/_authenticated/semantics.tsx",
      "routes/_authenticated/admin.iam.tsx",
      "components/agents/ModelRegistryPicker.tsx",
    ]) {
      expect(offendingFiles(), `${f} regressed to mouse-only`).not.toContain(f);
    }
  });
});
