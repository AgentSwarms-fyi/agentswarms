// Two cursors for one source is a refusal, not a silent corruption.
//
// Auto-ingest persists a JSON ledger of the files it has seen. An incremental
// cursor persists a scalar high-water mark. Both wrote `_watermarks[node]` and
// both read ETL_<NODE>_CURSOR, and the scalar was emitted second — so it
// overwrote the ledger, and the next run handed a date to `json.loads` inside
// the sandbox.
//
// Run one looked perfect. Run two died with a Python JSON error nobody could
// map back to "you turned on two switches the compiler cannot combine", and
// the persisted cursor was left in a state the pipeline could not recover from
// without deleting a database row by hand.
import { describe, expect, it } from "vitest";

import { compileGraph } from "@/utils/etl/codegen";

/** An object-storage source, with whichever cursors the test wants. */
function graphWith(config: Record<string, unknown>) {
  return {
    nodes: [
      { id: "n1", kind: "source", label: "landing", config },
      {
        id: "n2",
        kind: "target",
        label: "out",
        config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "append" },
      },
    ],
    edges: [{ from: "n1", to: "n2" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const AUTO = {
  type: "object_storage",
  source_id: "s1",
  path: "landing/*.csv",
  format: "csv",
  new_files_only: true,
};

describe("auto-ingest and a row cursor cannot share a source", () => {
  it("refuses the combination, naming the node and the column", () => {
    const g = graphWith({ ...AUTO, incremental: { cursor_column: "updated_at" } });
    expect(() => compileGraph(g)).toThrow(/auto-ingest AND an incremental cursor/i);
    expect(() => compileGraph(g)).toThrow(/updated_at/);
    expect(() => compileGraph(g)).toThrow(/landing/);
  });

  it("allows auto-ingest on its own", () => {
    expect(() => compileGraph(graphWith(AUTO))).not.toThrow();
  });

  it("allows a row cursor on its own", () => {
    expect(() =>
      compileGraph(
        graphWith({
          type: "object_storage",
          source_id: "s1",
          path: "landing/*.csv",
          format: "csv",
          incremental: { cursor_column: "updated_at" },
        }),
      ),
    ).not.toThrow();
  });

  it("explains the choice rather than only refusing", () => {
    // A refusal that does not say what to do instead is a dead end: both
    // switches look reasonable and the difference between them (files versus
    // rows) is the thing the user needs told.
    let message = "";
    try {
      compileGraph(graphWith({ ...AUTO, incremental: { cursor_column: "updated_at" } }));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/new FILES/);
    expect(message).toMatch(/new ROWS/);
  });
});
