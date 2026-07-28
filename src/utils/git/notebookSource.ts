// Notebook ⇄ script conversion for Git versioning.
//
// Notebooks are stored as a JSON array of cells, which is a poor thing to put
// under version control: a one-word edit shows up as a rewritten JSON blob, and
// cell ids churn. So a notebook is committed as a plain Python file in the
// widely used "percent" format (`# %%` cell markers, the same convention
// Jupytext, VS Code and PyCharm use) — a reviewer sees a real Python diff, and
// the file still round-trips back into cells for a restore.
//
// Pure module (no `.server` suffix, no imports) so the format rules are
// unit-testable — `.server.ts` files are import-protected.

export type NotebookCell = { id?: string; type: "markdown" | "code"; source: string };

const CODE_MARKER = "# %%";
const MD_MARKER = "# %% [markdown]";

/** Filesystem-safe component built from a notebook title. */
export function notebookSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "notebook"
  );
}

/** Stable path for a notebook, so re-exports update the same file. */
export function notebookFilePath(basePath: string, title: string, id: string): string {
  const base = basePath.replace(/^\/+|\/+$/g, "") || "agentswarms";
  return `${base}/notebooks/${notebookSlug(title)}-${id.slice(0, 8)}.py`;
}

/** Comment out a markdown block so the file stays valid Python. */
function commentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `# ${line}` : "#"))
    .join("\n");
}

function uncommentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("# ") ? line.slice(2) : line === "#" ? "" : line))
    .join("\n");
}

/**
 * Render cells as a percent-format Python file.
 *
 * Deliberately contains **no timestamp**: an export that changes nothing must
 * produce a byte-identical file, otherwise every sync is a commit and the
 * history stops meaning anything.
 */
export function notebookToScript(
  cells: NotebookCell[],
  meta: { id: string; title: string; description?: string | null },
): string {
  const header = [
    "# ---",
    "# AgentSwarms notebook — generated file, edited in the Developer workspace.",
    `# notebook_id: ${meta.id}`,
    `# title: ${meta.title.replace(/\n/g, " ")}`,
    ...(meta.description ? [`# description: ${meta.description.replace(/\n/g, " ")}`] : []),
    "# ---",
  ].join("\n");

  // Trailing whitespace is trimmed so rendering is idempotent: a cell restored
  // from a commit re-renders to the same bytes as the cell that produced it,
  // which is what keeps "uncommitted changes" honest right after a restore.
  const body = cells.map((c) => {
    const source = c.source.replace(/\s+$/, "");
    return c.type === "markdown"
      ? `${MD_MARKER}\n${commentBlock(source)}`
      : `${CODE_MARKER}\n${source}`;
  });

  return `${[header, ...body].join("\n\n").replace(/\s+$/, "")}\n`;
}

/**
 * Parse a percent-format file back into cells — the restore half of the
 * round trip. Anything before the first marker (the header) is dropped.
 */
export function scriptToCells(script: string): NotebookCell[] {
  const lines = script.replace(/\r\n/g, "\n").split("\n");
  const cells: NotebookCell[] = [];
  let current: { type: "markdown" | "code"; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const raw = current.lines.join("\n");
    // Trim AFTER uncommenting: a markdown block's blank lines are stored as "#",
    // so trimming first leaves a stray newline once those become empty again.
    const text = (current.type === "markdown" ? uncommentBlock(raw) : raw).replace(
      /^\n+|\n+$/g,
      "",
    );
    // A trailing marker with nothing after it is not a cell.
    if (text.trim() !== "") cells.push({ type: current.type, source: text });
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === MD_MARKER) {
      flush();
      current = { type: "markdown", lines: [] };
    } else if (trimmed === CODE_MARKER) {
      flush();
      current = { type: "code", lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return cells;
}

/**
 * FNV-1a over the rendered script — a cheap "has this changed since the last
 * commit?" marker, not a cryptographic digest. Sync and dependency-free so it
 * can run anywhere, including the client.
 */
export function notebookContentHash(script: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < script.length; i++) {
    h ^= script.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
