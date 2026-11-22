#!/usr/bin/env node
// Generates the handbook's text, section by section, for the assistant.
//
// The search index (build-docs-index.mjs) knows titles and headings, which is
// enough to find a page and not enough to answer "how do I schedule a
// dashboard?". The assistant answers from what the handbook says, so it needs
// the words under each heading, and a link to the heading so the reader can
// check it. The pages are TSX; this reads them with the TypeScript parser,
// keeping what a reader sees (text, table cells, notes) and none of the
// markup, in reading order, cut at every H2 and H3.
//
// The output is a .server.ts module: it is read by the assistant's tool on the
// server and never shipped to the browser.
//
//   node scripts/build-docs-text.mjs           write it
//   node scripts/build-docs-text.mjs --check   fail if it is out of date (CI)
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROUTES = "src/routes";
const OUT = "src/utils/assistant/docsText.server.ts";
/** A section longer than this is cut: the tool quotes, it does not reprint. */
const MAX_SECTION = 2400;

const routeOf = (file) =>
  file === "docs.index.tsx"
    ? "/docs"
    : "/docs/" +
      file
        .replace(/^docs\./, "")
        .replace(/\.tsx$/, "")
        .replace(/_\./g, ".")
        .replace(/\./g, "/");

// JSX text keeps entities as written (&apos;); the reader sees the character.
const ENTITIES = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  rarr: "→",
  larr: "←",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  times: "×",
  middot: "·",
};
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/g, (m, name) => ENTITIES[name] ?? m);

const tidy = (s) =>
  decode(s)
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();

/**
 * The values a page prints from the code ({TRASH_RETENTION_DAYS}), when they
 * are plain numbers or strings exported from src/lib: the reader sees "30",
 * so the assistant should read "30", not the constant's name.
 */
function importedConstants(src) {
  const out = new Map();
  for (const m of src.matchAll(/^import \{([^}]*)\} from "@\/lib\/([\w/]+)";$/gm)) {
    const file = ["ts", "tsx"].map((x) => `src/lib/${m[2]}.${x}`).find((f) => fs.existsSync(f));
    if (!file) continue;
    const lib = fs.readFileSync(file, "utf8");
    for (const name of m[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (!/^\w+$/.test(name)) continue;
      const v = lib.match(
        new RegExp(`^export const ${name}\\s*=\\s*(\\d+(?:\\.\\d+)?|"[^"]*")\\s*;`, "m"),
      );
      if (v) out.set(name, v[1].replace(/^"|"$/g, ""));
    }
  }
  return out;
}

/** What a reader sees of one page, cut into sections at its headings. */
function sectionsOf(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = importedConstants(src);
  const valueOf = (name) => constants.get(name) ?? name;
  let title = "";
  let description = "";
  const sections = [];
  let current = { id: "", heading: "", parts: [] };
  const push = (t) => {
    if (t && t.trim()) current.parts.push(t);
  };
  const tagName = (n) =>
    ts.isJsxElement(n)
      ? n.openingElement.tagName.getText(sf)
      : ts.isJsxSelfClosingElement(n)
        ? n.tagName.getText(sf)
        : "";
  const attr = (n, name) => {
    const attrs = ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes;
    for (const a of attrs.properties) {
      if (ts.isJsxAttribute(a) && a.name.getText(sf) === name && a.initializer) {
        if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
        if (ts.isJsxExpression(a.initializer) && a.initializer.expression) {
          return a.initializer.expression;
        }
      }
    }
    return undefined;
  };
  const textOfNode = (n) => {
    const out = [];
    const walk = (x) => {
      if (ts.isJsxText(x)) out.push(x.text);
      else if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) out.push(x.text);
      else if (ts.isTemplateExpression(x)) {
        out.push(x.head.text);
        for (const span of x.templateSpans) {
          walk(span.expression);
          out.push(span.literal.text);
        }
      } else if (ts.isIdentifier(x) && x.parent && ts.isJsxExpression(x.parent)) {
        // {TRASH_RETENTION_DAYS}: a value the page reads from the code. The
        // name says what it is better than a blank would.
        out.push(valueOf(x.text));
      } else if (ts.isJsxAttribute(x)) {
        // Attributes are markup (className, href, id) except the ones that
        // carry words a reader sees.
        const n = x.name.getText(sf);
        if (["title", "label", "alt", "headers", "rows", "items", "caption"].includes(n)) {
          if (x.initializer) walk(x.initializer);
        }
      } else ts.forEachChild(x, walk);
    };
    walk(n);
    return out.join(" ");
  };
  const visit = (n) => {
    const tag = tagName(n);
    if (tag === "DocsHeader") {
      const t = attr(n, "title");
      const d = attr(n, "description");
      if (typeof t === "string") title = t;
      if (typeof d === "string") description = d;
      return;
    }
    if (tag === "H2" || tag === "H3") {
      const id = attr(n, "id");
      if (typeof id === "string") {
        sections.push(current);
        current = { id, heading: tidy(textOfNode(n)), parts: [] };
        return;
      }
    }
    if (tag === "Table") {
      // A table reads as its rows, each "cell — cell — cell".
      const rows = attr(n, "rows");
      const headers = attr(n, "headers");
      if (headers && typeof headers !== "string") push(tidy(textOfNode(headers)) + ":");
      if (rows && typeof rows !== "string" && ts.isArrayLiteralExpression(rows)) {
        for (const row of rows.elements) {
          if (ts.isArrayLiteralExpression(row)) {
            const line = row.elements.map((c) => tidy(textOfNode(c))).join(" — ");
            push(/[.!?:]$/.test(line) ? line : line + ".");
          } else push(tidy(textOfNode(row)));
        }
      }
      return;
    }
    if (ts.isJsxText(n)) {
      push(n.text);
      return;
    }
    if (ts.isJsxExpression(n) && n.expression) {
      if (ts.isStringLiteral(n.expression)) push(n.expression.text);
      else if (ts.isIdentifier(n.expression)) push(valueOf(n.expression.text));
      else ts.forEachChild(n, visit);
      return;
    }
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      // A paragraph, a list item, a note: keep its words, then a break so
      // the next block does not run into this one.
      if (ts.isJsxElement(n)) for (const c of n.children) visit(c);
      else {
        const words = ["title", "label", "caption"]
          .map((a) => attr(n, a))
          .filter((v) => typeof v === "string");
        for (const w of words) push(w);
      }
      if (/^(P|Li|Note|Callout|Step|li|p|H4|Pre|Code)$/.test(tag)) push("\n");
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  sections.push(current);
  return {
    title: tidy(title),
    description: tidy(description),
    sections: sections
      .map((s) => ({ id: s.id, heading: s.heading, text: tidy(s.parts.join(" ")) }))
      .filter((s) => s.text.length > 0)
      .map((s) => ({
        ...s,
        text:
          s.text.length > MAX_SECTION
            ? s.text.slice(0, MAX_SECTION).replace(/\s\S*$/, "") + " …"
            : s.text,
      })),
  };
}

const out = [];
for (const file of fs
  .readdirSync(ROUTES)
  .filter((f) => /^docs\..+\.tsx$/.test(f))
  .sort()) {
  const src = fs.readFileSync(path.join(ROUTES, file), "utf8");
  const page = sectionsOf(file, src);
  if (!page.title) continue;
  for (const s of page.sections) {
    out.push({
      route: routeOf(file),
      page: page.title,
      id: s.id,
      heading: s.heading || page.title,
      text: s.id ? s.text : [page.description, s.text].filter(Boolean).join(" "),
    });
  }
}

const body = `// GENERATED by scripts/build-docs-text.mjs — do not edit by hand.
//
// The handbook's words, one entry per section, for the assistant's
// docs_search tool. Server-only. Run \`npm run docs:index\` after changing a
// documentation page; \`npm run check:docs\` fails when this is stale.

export type DocsTextSection = {
  /** The page's address: /docs/... */
  route: string;
  /** The page's title. */
  page: string;
  /** The heading's id ("" for the page's opening). */
  id: string;
  heading: string;
  text: string;
};

export const DOCS_TEXT: DocsTextSection[] = ${JSON.stringify(out, null, 1)};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
const size = `${out.length} sections, ${Math.round(Buffer.byteLength(body) / 1024)} KB`;
if (process.argv.includes("--check")) {
  if (current !== body) {
    console.error("docs text is stale — run: npm run docs:index");
    process.exit(1);
  }
  console.log(`docs text current: ${size}.`);
} else {
  fs.writeFileSync(OUT, body, "utf8");
  console.log(`wrote ${OUT}: ${size}.`);
}
