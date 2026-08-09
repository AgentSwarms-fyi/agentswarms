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

const TAGS = ["Card", "CardHeader", "CardContent", "div", "span", "li", "tr"];

/**
 * Read the whole opening tag at `i`, tracking {} and quotes.
 *
 * THE OLD PATTERN WAS <(Card|div|…)\b([^>]*?)onClick=…> AND IT LIED. `[^>]`
 * stops at the first ">" inside the tag, and an arrow function in an earlier
 * prop contains one:
 *
 *   <Card draggable onDragStart={(e) => onDragStart(e, p)} onClick={…}>
 *                                    the "=>" ends the match ─┘
 *
 * Measured across src: the regex saw 12 sites in 10 files; a brace-aware scan
 * finds 16 in 13. The three it could not see were all drag-and-click controls —
 * the swarm node palette (17 click-to-add cards, the primary way to build a
 * swarm), the BI data-prep dataset list, and the CSV drop zone, whose hidden
 * file input cannot be focused either, so uploading a CSV was mouse-only end to
 * end. A backlog test that cannot see a quarter of the backlog is worse than no
 * test, because it reads as coverage.
 */
function readOpeningTag(src: string, i: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote && src[j - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(i, j + 1);
  }
  return null;
}

/** Every opening tag in `src` for an element that renders non-interactive. */
function clickableTags(src: string): string[] {
  const out: string[] = [];
  for (const tag of TAGS) {
    const re = new RegExp(`<${tag}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const full = readOpeningTag(src, m.index);
      if (full && /\bonClick=/.test(full)) out.push(full);
    }
  }
  return out;
}

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
    for (const attrs of clickableTags(src)) {
      if (/role=["']button["']/.test(attrs)) continue;
      if (/tabIndex/.test(attrs)) continue;
      if (/onKeyDown|onKeyUp|onKeyPress/.test(attrs)) continue;
      // `{...clickable(…)}` supplies all four at once.
      if (/\{\s*\.\.\.\s*clickable\(/.test(attrs)) continue;
      out.add(file.replace(/\\/g, "/").split("/src/")[1]);
    }
  }
  return [...out].sort();
}

describe("the scanner can see what it claims to scan", () => {
  // Guard on the guard. This suite's whole value is that it FINDS things, so a
  // blind spot in the finder reads as a clean bill of health. The previous
  // pattern had one, and it hid the swarm node palette for as long as this
  // test has existed.
  it("finds an onClick that comes after an arrow function in the same tag", () => {
    const tags = clickableTags(
      `<Card draggable onDragStart={(e) => go(e, p)} onClick={() => add(p)}>x</Card>`,
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain("onClick=");
  });

  it("finds an onClick after a prop containing a bare > comparison", () => {
    const tags = clickableTags(`<div hidden={count > 3} onClick={go}>x</div>`);
    expect(tags).toHaveLength(1);
  });

  it("does not mistake a later sibling tag's onClick for this one's", () => {
    const tags = clickableTags(`<div className="a">t</div>\n<button onClick={go}>b</button>`);
    expect(tags).toEqual([]);
  });

  it("still finds the simple case", () => {
    expect(clickableTags(`<li onClick={pick}>x</li>`)).toHaveLength(1);
  });
});

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
