// A knowledge base's uploaded file is named a file, and Add Source says when
// what it added was not indexed (R208).
//
// FOUND IN R208, driven in the kept knowledge base "R192 add-source": its
// uploaded r192-*.txt sources read "MANUAL · Manual paste" and their
// documents "Manual"; and r208-one.txt, added with the embed call failing,
// was announced "1 file added" with no word of indexing.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { indexNote } from "@/lib/kbIndexNote";
import { isUploadedFile, kbSourceBadge } from "@/lib/kbSourceLabel";

describe("kbSourceBadge", () => {
  it("names an uploaded text file a file, and a paste a paste", () => {
    const upload = { kind: "manual", config: { filename: "r208-one.txt", size_bytes: 55 } };
    const paste = { kind: "manual", config: {} };
    expect(isUploadedFile(upload)).toBe(true);
    expect(kbSourceBadge(upload)).toBe("File");
    expect(isUploadedFile(paste)).toBe(false);
    expect(kbSourceBadge(paste)).toBe("Manual");
    expect(kbSourceBadge({ kind: "manual", config: null })).toBe("Manual");
    expect(kbSourceBadge({ kind: "manual", config: { filename: "" } })).toBe("Manual");
  });

  it("keeps the other kinds' names", () => {
    expect(kbSourceBadge({ kind: "pdf" })).toBe("PDF");
    expect(isUploadedFile({ kind: "pdf" })).toBe(true);
    expect(kbSourceBadge({ kind: "csv" })).toBe("CSV");
    expect(kbSourceBadge({ kind: "url" })).toBe("URL");
    expect(kbSourceBadge({ kind: "github" })).toBe("GitHub");
    expect(kbSourceBadge(undefined)).toBe("Manual");
  });
});

describe("indexNote", () => {
  it("is nothing when every document was indexed", () => {
    expect(indexNote({ ok: { warnings: [] } })).toBeNull();
    expect(indexNote({ ok: { skipped: false } })).toBeNull();
  });

  it("says a failed or skipped embed, and warnings", () => {
    expect(indexNote({ error: new TypeError("Failed to fetch") })).toBe(
      "Not indexed yet: Failed to fetch. Re-index retries; until then it is found by keyword only.",
    );
    expect(indexNote({ ok: { skipped: true, reason: "no_api_key" } })).toMatch(
      /^Not indexed: no embedding key is set/,
    );
    expect(indexNote({ ok: { warnings: ["a.txt: empty", "b.txt: empty"] } })).toBe(
      "Indexed with 2 warnings: a.txt: empty",
    );
  });
});

describe("the dialog and the page", () => {
  const dialog = readFileSync("src/components/knowledge/AddSourceDialog.tsx", "utf8");
  const page = readFileSync("src/routes/_authenticated/knowledge.tsx", "utf8");

  it("reads what the embed step did, on both paths that add a document", () => {
    expect(dialog).not.toContain("embedding failed:");
    expect(dialog.match(/await embedAndNote\(/g)?.length).toBe(2);
    // A call that throws is an error outcome, not an empty success.
    expect(dialog).toMatch(/\} catch \(err\) \{\s*outcome = \{ error: err \};/);
    expect(dialog).toContain(
      'if (note) toast.warning("Document added, not fully indexed", { description: note });',
    );
    expect(dialog).toMatch(
      /if \(note\) toast\.warning\(`\$\{addedTitle\}, not fully indexed`, \{ description: note \}\);/,
    );
  });

  it("names sources and documents through kbSourceLabel", () => {
    expect(page).toContain("const sourceBadge = kbSourceBadge(sourceForDoc);");
    expect(page).toMatch(/: isUploadedFile\(src\)\s*\? "Uploaded file"\s*: "Manual paste"/);
    expect(page).toMatch(/CONNECTOR_LABELS\[src\.kind as ConnectorKind\]\s*: kbSourceBadge\(src\)/);
  });
});
