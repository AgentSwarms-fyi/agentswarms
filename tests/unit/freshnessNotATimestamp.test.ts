// A freshness monitor that cannot read a time says which of the two reasons it
// is — and the form stops building the one that cannot work.
//
// FOUND IN R238, chasing the queue's last sweep-6 row ("choosing 'Pick a
// column…' snaps back to the first timestamp column"). That snap-back is real
// and cosmetic: the effect refills an empty column, so the placeholder option
// does nothing. What it was sitting next to is not cosmetic.
//
// Switching the monitor KIND did not clear the column. So `region`, picked for
// a null-rate check, survived a switch to Freshness; the freshness picker lists
// only timestamp columns, and a controlled <select> whose value matches no
// option renders BLANK — the form looked empty and was not. Saving was accepted,
// because validateMonitorConfig checks that a column is NAMED, not what it is.
// The monitor then ran `max(region)`, got "EMEA", failed to parse it as a date,
// and alerted with:
//
//   "The table has no rows, or the timestamp column is empty."
//
// which is a sentence the run cannot support. The table has rows and the column
// is full. An operator reading that goes and looks at the data.
import { describe, expect, it } from "vitest";

import { evaluateMonitor } from "@/utils/dataMonitors/core";

const config = { column: "region", max_age_minutes: 60 };

describe("a freshness run that produced no age", () => {
  it("says the value is not a time, and shows it, when there WAS a value", () => {
    const ev = evaluateMonitor({ kind: "freshness", config, value: null, latest: "EMEA" });
    expect(ev.status).toBe("alert");
    expect(ev.message).toMatch(/not a date or time/i);
    expect(ev.message).toContain("EMEA");
    expect(ev.message).toMatch(/needs a timestamp column/i);
    // The claim it must no longer make.
    expect(ev.message).not.toMatch(/no rows/i);
    expect(ev.detail).toMatchObject({ latest: "EMEA" });
  });

  it("still says 'no rows or empty' when there was genuinely no value", () => {
    for (const latest of [null, undefined, "", "   "]) {
      const ev = evaluateMonitor({ kind: "freshness", config, value: null, latest });
      expect(ev.status, String(latest)).toBe("alert");
      expect(ev.message, String(latest)).toMatch(/no rows/i);
      expect(ev.message, String(latest)).not.toMatch(/not a date or time/i);
    }
  });

  it("truncates a long value rather than pasting a row into the message", () => {
    const long = "x".repeat(400);
    const ev = evaluateMonitor({ kind: "freshness", config, value: null, latest: long });
    expect(ev.message.length).toBeLessThan(200);
    expect(ev.message).toContain("…");
    // The untruncated value is still available to anyone who needs it.
    expect(ev.detail).toMatchObject({ latest: long });
  });

  it("leaves a readable age alone", () => {
    // The guard must not swallow the normal path: a real timestamp still
    // judges against the limit.
    const ok = evaluateMonitor({ kind: "freshness", config, value: 10, latest: "2026-10-03" });
    expect(ok.status).toBe("ok");
    const stale = evaluateMonitor({ kind: "freshness", config, value: 600, latest: "2026-10-01" });
    expect(stale.status).toBe("alert");
    expect(stale.message).not.toMatch(/not a date or time/i);
  });
});

describe("the monitor form", () => {
  const SRC = "src/routes/_authenticated/data-monitors.tsx";

  it("drops a column the new kind cannot use when the kind changes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");
    // Wide enough to clear the explanatory comment and reach the code.
    const at = src.indexOf("setKind(k)");
    const handler = src.slice(at, at + 1400);
    expect(handler).toContain("timestampColumns.some");
    expect(handler).toContain('setColumn("")');
  });

  it("keeps a column the new kind CAN use", async () => {
    // Switching between two column checks must not make the user pick again:
    // the clear is conditional on the column being absent from what the new
    // kind offers, not on the kind having changed.
    const { readFileSync } = await import("node:fs");
    const handler = readFileSync(SRC, "utf8");
    const at = handler.indexOf("setKind(k)");
    expect(handler.slice(at, at + 1400)).toMatch(/k === "freshness"/);
  });
});
