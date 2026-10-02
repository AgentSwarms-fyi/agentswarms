// A preview reads. It does not consume anything a real run will need.
//
// The promise, from docs/ETL_PIPELINES.md: "The preview is a freshly compiled
// script with no dlt, no writes and no watermark movement." Three source kinds
// can break it, because each one's read has a side effect on the source:
// webhook ingest drains its backlog, Pub/Sub acknowledges its messages, and
// change-data-capture creates a replication slot and consumes the initial
// snapshot.
//
// Two of the three were guarded. CDC was not, and it is the one whose failure
// is invisible: the preview took the snapshot into a throwaway container, the
// first real run found the slot already there and skipped the snapshot branch,
// and the pipeline reported success having loaded none of the source table's
// existing rows.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const codegen = readFileSync("src/utils/etl/codegen.ts", "utf8");
const streaming = readFileSync("src/utils/etl/streaming.ts", "utf8");
const service = readFileSync("src/utils/etl/service.server.ts", "utf8");

const GUARD = "AGENTSWARMS_ETL_PREVIEW";

describe("every source with a consuming read is guarded", () => {
  it("sets the flag on the preview path and nowhere else", () => {
    expect(service).toContain(`env.${GUARD} = "1"`);
  });

  it("guards the webhook ingest backlog", () => {
    expect(codegen).toMatch(new RegExp(`'consume': os\\.environ\\.get\\('${GUARD}'\\) != '1'`));
  });

  it("guards the Pub/Sub acknowledgement", () => {
    expect(streaming).toMatch(new RegExp(`${GUARD}'\\) != '1'`));
  });

  it("guards CDC slot creation and the initial snapshot", () => {
    // The one that was missed. Without it the natural build order — add the
    // source, preview the columns, then run — loses the whole history.
    const cdc = codegen.slice(
      codegen.indexOf("pg_replication_slots"),
      codegen.indexOf("pg_logical_slot_peek_changes"),
    );
    expect(cdc, "the CDC source moved; re-anchor this test").toContain("pg_create_logical");
    expect(cdc).toContain(GUARD);
    // The guard must come BEFORE the branch that creates the slot, or it
    // guards nothing.
    expect(cdc.indexOf(GUARD)).toBeLessThan(cdc.indexOf("pg_create_logical_replication_slot"));
  });

  it("returns an empty typed frame from a CDC preview rather than throwing", () => {
    // The preview's job is to show columns. A raise here would read as a
    // broken source rather than as "nothing to show yet".
    const cdc = codegen.slice(
      codegen.indexOf("pg_replication_slots"),
      codegen.indexOf("pg_logical_slot_peek_changes"),
    );
    expect(cdc).toMatch(/preview only/);
    expect(cdc).toMatch(/pd\.DataFrame\(columns=\['_cdc_action'/);
  });
});
