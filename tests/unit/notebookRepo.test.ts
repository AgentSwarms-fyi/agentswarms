// Notebooks from the team's repository (R543): reading .py and .ipynb files
// as other tools write them, writing a linked notebook back in its own
// format, and what an update from the repository would change.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NOTEBOOK_MAX_CELLS,
  cellChanges,
  cellChangesLine,
  cellsToIpynb,
  fileTitle,
  noCellChanges,
  notebookFileFormat,
  parseNotebookFile,
  validRepoFolder,
} from "@/lib/notebookFiles";
import { notebookToScript, scriptToCells } from "@/utils/git/notebookSource";

const rd = (p: string) => readFileSync(p, "utf8");

describe("a .py notebook", () => {
  it("reads cell markers with titles, [markdown] and [md], and the header's title", () => {
    const text = [
      "# ---",
      "# title: Churn exploration",
      "# ---",
      "",
      "# %% [markdown] Intro",
      "# # Churn",
      "#",
      "# Why customers leave.",
      "",
      "# %% Load the data",
      "import pandas as pd",
      'df = pd.read_parquet("orders.parquet")',
      "",
      "# %% [md]",
      "# Next: features",
      "",
      "#%%",
      "df.describe()",
      "",
    ].join("\n");
    const parsed = parseNotebookFile("analysis/churn.py", text);
    expect(parsed).toEqual({
      ok: true,
      format: "py",
      title: "Churn exploration",
      cells: [
        { type: "markdown", source: "# Churn\n\nWhy customers leave." },
        { type: "code", source: 'import pandas as pd\ndf = pd.read_parquet("orders.parquet")' },
        { type: "markdown", source: "Next: features" },
        { type: "code", source: "df.describe()" },
      ],
    });
  });

  it("reads a plain script as one code cell, titled from its name", () => {
    expect(parseNotebookFile("jobs/nightly_score.py", "print('hi')\n")).toEqual({
      ok: true,
      format: "py",
      title: "nightly score",
      cells: [{ type: "code", source: "print('hi')" }],
    });
  });

  it("reads back exactly what this platform writes", () => {
    const cells = [
      { type: "markdown" as const, source: "# Title\n\nSome text" },
      { type: "code" as const, source: "x = 1\nprint(x)" },
    ];
    const script = notebookToScript(cells, { id: "abc", title: "T", description: null });
    const parsed = parseNotebookFile("a.py", script);
    expect(parsed.ok && parsed.cells).toEqual(cells);
    expect(scriptToCells(script)).toEqual(cells);
  });
});

describe("a Jupyter notebook", () => {
  const nb = (cells: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells, ...extra });

  it("reads code, markdown and raw cells, and drops outputs and empty cells", () => {
    const text = nb([
      { cell_type: "markdown", source: ["# Fraud model\n", "\n", "Scores payments."] },
      {
        cell_type: "code",
        source: "import numpy as np\n",
        outputs: [{ output_type: "stream", text: "secret rows" }],
        execution_count: 3,
      },
      { cell_type: "raw", source: "notes" },
      { cell_type: "code", source: ["   \n"] },
    ]);
    const parsed = parseNotebookFile("nb/fraud.ipynb", text);
    expect(parsed).toEqual({
      ok: true,
      format: "ipynb",
      title: "Fraud model",
      cells: [
        { type: "markdown", source: "# Fraud model\n\nScores payments." },
        { type: "code", source: "import numpy as np" },
        { type: "markdown", source: "notes" },
      ],
    });
  });

  it("takes the title from metadata first, then a heading, then the file name", () => {
    const withMeta = parseNotebookFile("x.ipynb", nb([], { metadata: { title: "From meta" } }));
    expect(withMeta.ok && withMeta.title).toBe("From meta");
    const named = parseNotebookFile("dir/my_nb.ipynb", nb([{ cell_type: "code", source: "1" }]));
    expect(named.ok && named.title).toBe("my nb");
  });

  it("writes cells back without outputs, byte-identical twice, and reads them back", () => {
    const cells = [
      { type: "markdown" as const, source: "# A\n\nB" },
      { type: "code" as const, source: "x = 1\ny = 2" },
    ];
    const once = cellsToIpynb(cells, { title: "A" });
    expect(cellsToIpynb(cells, { title: "A" })).toBe(once);
    const doc = JSON.parse(once);
    expect(doc.nbformat).toBe(4);
    expect(doc.cells[1]).toMatchObject({
      cell_type: "code",
      outputs: [],
      execution_count: null,
      source: ["x = 1\n", "y = 2"],
    });
    const back = parseNotebookFile("a.ipynb", once);
    expect(back.ok && back.cells).toEqual(cells);
  });

  it("says what is wrong with a file it cannot read", () => {
    expect(parseNotebookFile("a.ipynb", "{nope")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(parseNotebookFile("a.ipynb", JSON.stringify({ nbformat: 3, cells: [] }))).toMatchObject({
      ok: false,
      error: "The .ipynb is format 3; format 4 is read",
    });
    expect(parseNotebookFile("a.txt", "x")).toMatchObject({
      ok: false,
      error: "Only .py and .ipynb notebooks are read",
    });
    expect(parseNotebookFile("a.py", " ".repeat(3 * 1024 * 1024))).toMatchObject({
      ok: false,
      error: "The file is over 2 MB",
    });
    const many = Array.from({ length: NOTEBOOK_MAX_CELLS + 1 }, (_, i) => `# %%\nx = ${i}`).join(
      "\n",
    );
    expect(parseNotebookFile("a.py", many)).toMatchObject({
      ok: false,
      error: expect.stringContaining("at most 1000 are read"),
    });
  });
});

describe("what an update would change", () => {
  it("counts cells and positions that differ", () => {
    const a = [
      { type: "code" as const, source: "x = 1" },
      { type: "code" as const, source: "y = 2" },
    ];
    expect(noCellChanges(cellChanges(a, a))).toBe(true);
    expect(cellChangesLine(cellChanges(a, a))).toBe("No changes");
    const b = [
      ...a.slice(0, 1),
      { type: "code" as const, source: "y = 3" },
      { type: "markdown" as const, source: "z" },
    ];
    expect(cellChanges(a, b)).toEqual({ before: 2, after: 3, changed: 1 });
    expect(cellChangesLine(cellChanges(a, b))).toBe("2 → 3 cells, 1 cell changed");
  });
});

describe("paths and folders", () => {
  it("knows the two formats, and titles a file by its name", () => {
    expect(notebookFileFormat("a/B.IPYNB")).toBe("ipynb");
    expect(notebookFileFormat("a/b.py")).toBe("py");
    expect(notebookFileFormat("a/b.r")).toBeNull();
    expect(fileTitle("x/daily-report_v2.py")).toBe("daily report v2");
  });

  it("browses folders inside the repository only", () => {
    for (const ok of ["notebooks", "agentswarms/notebooks", "src/analysis 2026"]) {
      expect(validRepoFolder(ok), ok).toBe(true);
    }
    for (const bad of ["", "..", "a/../b", "a//b", "./a", "a;b", "x".repeat(301)]) {
      expect(validRepoFolder(bad), bad).toBe(false);
    }
  });
});

describe("the server's paths", () => {
  const fns = rd("src/utils/notebookGit.functions.ts");

  it("commits an imported notebook back to its own file, in its own format", () => {
    expect(fns).toMatch(
      /if \(linked && !isGeneratedPath\(linked\.path, data\.notebook_id\)\) \{[\s\S]{0,900}?path: linked\.path,\s*content: renderForFile\(linked\.path, cells,/,
    );
    expect(fns).toContain("return path.endsWith(`-${notebookId.slice(0, 8)}.py`);");
    expect(fns).toMatch(
      /notebookFileFormat\(path\) === "ipynb"\s*\? cellsToIpynb\(cells, \{ title: meta\.title \}\)\s*: notebookToScript\(cells, meta\)/,
    );
  });

  it("restores, imports and updates through one reader that knows both formats", () => {
    for (const fn of ["nbGitRestore", "nbGitImport", "nbGitPullPreview", "nbGitPull"]) {
      const body = fns.slice(fns.indexOf(`export const ${fn} =`));
      expect(
        body.slice(
          0,
          body.indexOf("\nexport const ") > 0 ? body.indexOf("\nexport const ", 10) : undefined,
        ),
        fn,
      ).toContain("await readNotebookAt(");
    }
  });

  it("records the link, so a fresh import or update reads 'no uncommitted changes'", () => {
    for (const fn of ["nbGitImport", "nbGitPull"]) {
      const body = fns.slice(fns.indexOf(`export const ${fn} =`));
      expect(body, fn).toMatch(/notebookContentHash\(\s*notebookToScript\(cells,/);
      expect(body, fn).toContain('from("notebook_git_versions").insert(');
    }
    expect(fns).toContain('action: "notebook.git_import"');
    expect(fns).toContain('action: "notebook.git_pull"');
  });

  it("updates only from the commit the preview read", () => {
    const pull = fns.slice(fns.indexOf("export const nbGitPull ="));
    expect(pull).toContain("commit: z.string().regex(SHA),");
    expect(pull).toContain(
      "readNotebookAt(resolved.cfg, resolved.token, linked.path, data.commit)",
    );
  });
});

describe("found from the UI in R543", () => {
  it("joins the 'connect a repository' sentence to its link", () => {
    const src = rd("src/components/notebooks/NotebookImportDialog.tsx");
    expect(src).toMatch(/, under\{" "\}\s*<Link to="\/integrations" search=\{\{ tab: "git" \}\}/);
  });
});
