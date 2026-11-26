// Notebook files as a team keeps them in its repository (R543).
//
// A notebook committed from here is a percent-format Python file. A notebook
// written somewhere else arrives as whatever its author's tools wrote: a
// percent file with cell titles, a plain script, or a Jupyter .ipynb. This
// reads all three into cells and writes a linked notebook back in the format
// its file already has, so a teammate's .ipynb stays an .ipynb in the
// repository and the diff in a pull request is about cells, not about format.
//
// Outputs are never written: a repository holds the code, and an output can
// hold the data it ran on.
//
// Pure: no network, no database.
import type { NotebookCell } from "@/utils/git/notebookSource";

/** A notebook file over this is refused before it is parsed. */
export const NOTEBOOK_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** And a notebook with more cells than this. */
export const NOTEBOOK_MAX_CELLS = 1000;

export type NotebookFileFormat = "py" | "ipynb";

export function notebookFileFormat(path: string): NotebookFileFormat | null {
  const p = path.toLowerCase();
  if (p.endsWith(".ipynb")) return "ipynb";
  if (p.endsWith(".py")) return "py";
  return null;
}

export type ParsedNotebookFile =
  | { ok: true; format: NotebookFileFormat; title: string; cells: NotebookCell[] }
  | { ok: false; error: string };

/** The file's name without folders or extension, for a title nothing else gives. */
export function fileTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  return (
    name
      .replace(/\.(py|ipynb)$/i, "")
      .replace(/[_-]+/g, " ")
      .trim() || "Notebook"
  );
}

const cap = (cells: NotebookCell[]): ParsedNotebookFile | null =>
  cells.length > NOTEBOOK_MAX_CELLS
    ? {
        ok: false,
        error: `The notebook has ${cells.length} cells; at most ${NOTEBOOK_MAX_CELLS} are read`,
      }
    : null;

/** Read a notebook file of either format into cells. */
export function parseNotebookFile(path: string, text: string): ParsedNotebookFile {
  const format = notebookFileFormat(path);
  if (!format) return { ok: false, error: "Only .py and .ipynb notebooks are read" };
  if (new TextEncoder().encode(text).length > NOTEBOOK_FILE_MAX_BYTES) {
    return { ok: false, error: `The file is over ${NOTEBOOK_FILE_MAX_BYTES / (1024 * 1024)} MB` };
  }
  return format === "ipynb" ? parseIpynb(path, text) : parsePercent(path, text);
}

// ── Percent format (and plain scripts) ──────────────────────────────────

/**
 * `# %%` starts a code cell and `# %% [markdown]` (or `[md]`) a markdown one;
 * either may carry a title after it, as other tools write them. Anything
 * before the first marker is the header: its `# title:` line is the title.
 * A file with no marker at all is one code cell.
 */
function parsePercent(path: string, text: string): ParsedNotebookFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const marker = /^#\s?%%(?:\s+(.*))?$/;
  if (!lines.some((l) => marker.test(l.trimEnd()))) {
    const source = text.replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
    return {
      ok: true,
      format: "py",
      title: fileTitle(path),
      cells: source ? [{ type: "code", source }] : [],
    };
  }
  let title: string | null = null;
  const cells: NotebookCell[] = [];
  let current: { type: "markdown" | "code"; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const raw = current.lines.join("\n");
    const text =
      current.type === "markdown"
        ? raw
            .split("\n")
            .map((l) => (l.startsWith("# ") ? l.slice(2) : l === "#" ? "" : l))
            .join("\n")
        : raw;
    const source = text.replace(/^\n+|\s+$/g, "");
    if (source.trim() !== "") cells.push({ type: current.type, source });
    current = null;
  };
  for (const line of lines) {
    const m = marker.exec(line.trimEnd());
    if (m) {
      flush();
      const rest = (m[1] ?? "").trim();
      current = { type: /^\[(markdown|md)\]/i.test(rest) ? "markdown" : "code", lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else {
      const t = /^#\s*title:\s*(.+)$/i.exec(line.trim());
      if (t && !title) title = t[1].trim();
    }
  }
  flush();
  return cap(cells) ?? { ok: true, format: "py", title: title || fileTitle(path), cells };
}

// ── Jupyter ─────────────────────────────────────────────────────────────

type IpynbCell = { cell_type?: unknown; source?: unknown };

function parseIpynb(path: string, text: string): ParsedNotebookFile {
  let nb: { nbformat?: unknown; cells?: unknown; metadata?: { title?: unknown } };
  try {
    nb = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `The .ipynb is not valid JSON (${(e as Error).message})` };
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) {
    return { ok: false, error: "The .ipynb has no cells" };
  }
  if (nb.nbformat !== 4) {
    return { ok: false, error: `The .ipynb is format ${String(nb.nbformat)}; format 4 is read` };
  }
  const cells: NotebookCell[] = [];
  for (const c of nb.cells as IpynbCell[]) {
    const source = Array.isArray(c.source)
      ? c.source.map(String).join("")
      : typeof c.source === "string"
        ? c.source
        : "";
    const trimmed = source.replace(/\s+$/, "");
    if (!trimmed.trim()) continue;
    // A raw cell is text nobody runs: kept, as markdown.
    cells.push({ type: c.cell_type === "code" ? "code" : "markdown", source: trimmed });
  }
  const metaTitle = typeof nb.metadata?.title === "string" ? nb.metadata.title.trim() : "";
  const heading = cells.find((c) => c.type === "markdown")?.source.match(/^#\s+(.+)$/m)?.[1];
  return (
    cap(cells) ?? {
      ok: true,
      format: "ipynb",
      title: metaTitle || heading?.trim() || fileTitle(path),
      cells,
    }
  );
}

/**
 * Cells as a Jupyter notebook (format 4.5), with no outputs and no execution
 * counts, keys in a fixed order and one-space indents as Jupyter writes them,
 * so writing the same cells twice is byte-identical.
 */
export function cellsToIpynb(cells: NotebookCell[], meta: { title: string }): string {
  const lines = (s: string) => {
    const parts = s.split("\n");
    return parts.map((l, i) => (i < parts.length - 1 ? `${l}\n` : l)).filter((l) => l !== "");
  };
  const doc = {
    cells: cells.map((c, i) =>
      c.type === "code"
        ? {
            cell_type: "code",
            execution_count: null,
            id: `cell-${i + 1}`,
            metadata: {},
            outputs: [],
            source: lines(c.source),
          }
        : { cell_type: "markdown", id: `cell-${i + 1}`, metadata: {}, source: lines(c.source) },
    ),
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
      title: meta.title,
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(doc, null, 1)}\n`;
}

// ── What an update would change ─────────────────────────────────────────

export type CellChanges = { before: number; after: number; changed: number };

/**
 * Cells compared by position: how many there were, how many there will be,
 * and how many of the positions both have hold different text. Plain on
 * purpose; the repository's own diff is where the detail lives.
 */
export function cellChanges(before: NotebookCell[], after: NotebookCell[]): CellChanges {
  const n = Math.min(before.length, after.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (before[i].type !== after[i].type || before[i].source.trim() !== after[i].source.trim()) {
      changed++;
    }
  }
  return { before: before.length, after: after.length, changed };
}

export function noCellChanges(c: CellChanges): boolean {
  return c.before === c.after && c.changed === 0;
}

export function cellChangesLine(c: CellChanges): string {
  if (noCellChanges(c)) return "No changes";
  const parts: string[] = [];
  if (c.after !== c.before) parts.push(`${c.before} → ${c.after} cells`);
  if (c.changed) parts.push(`${c.changed} cell${c.changed === 1 ? "" : "s"} changed`);
  return parts.join(", ");
}

/** A folder a person may browse: relative, no walking out. */
export function validRepoFolder(folder: string): boolean {
  const f = folder.trim().replace(/^\/+|\/+$/g, "");
  return (
    f.length > 0 &&
    f.length <= 300 &&
    /^[A-Za-z0-9 ._/-]+$/.test(f) &&
    !f.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}
