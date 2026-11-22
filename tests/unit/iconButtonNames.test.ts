// Every icon-only button says what it does (found in R516's UI test: the
// prompt cards' edit and delete buttons were read by a screen reader as
// "button", "button"; a scan found 43 like them across the app).
//
// Parsed with the TypeScript compiler, not matched with a regex: a <Button>
// or <button> whose only child is a lucide icon must carry an aria-label, a
// title or aria-labelledby. `asChild` buttons take their name from the child
// they render; a spread may carry the name, so it is left to the reader.
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function unnamedIconButtons(file: string): number[] {
  const src = readFileSync(file, "utf8");
  if (!src.includes("lucide-react")) return [];
  const icons = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g))
    for (const n of m[1].split(",")) {
      const name = n
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name && !name.startsWith("type ")) icons.add(name);
    }
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n)) {
      const tag = n.openingElement.tagName.getText(sf);
      if (tag === "Button" || tag === "button") {
        const props = n.openingElement.attributes.properties;
        const attrs = props.filter(ts.isJsxAttribute).map((a) => a.name.getText(sf));
        const named = attrs.some((a) => ["aria-label", "title", "aria-labelledby"].includes(a));
        const spread = props.some(ts.isJsxSpreadAttribute);
        const kids = n.children.filter((c) => !(ts.isJsxText(c) && !c.text.trim()));
        const only = kids.length === 1 ? kids[0] : null;
        const iconTag =
          only && ts.isJsxSelfClosingElement(only)
            ? only.tagName.getText(sf)
            : only && ts.isJsxElement(only)
              ? only.openingElement.tagName.getText(sf)
              : null;
        if (iconTag && icons.has(iconTag) && !named && !spread && !attrs.includes("asChild")) {
          lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

describe("icon-only buttons", () => {
  it("each say what pressing them does", () => {
    const offenders: string[] = [];
    for (const f of tsxFiles(join(ROOT, "src"))) {
      for (const line of unnamedIconButtons(f))
        offenders.push(`${relative(ROOT, f).replace(/\\/g, "/")}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it("catches one that does not", () => {
    const tmp = join(ROOT, "tests/unit/__fixtures__icon-button.tsx");
    writeFileSync(
      tmp,
      'import { Trash2 } from "lucide-react";\nexport const X = () => (<>\n<Button onClick={f}><Trash2 /></Button>\n<Button aria-label="Delete it"><Trash2 /></Button>\n</>);\n',
    );
    try {
      expect(unnamedIconButtons(tmp)).toEqual([3]);
    } finally {
      unlinkSync(tmp);
    }
  });
});
