// The home dashboard's status band: a check that could not be read is said
// so, and is never the ground for "Everything is running".
//
// FOUND FROM THE UI. Every health count landed as `count ?? 0`, so a read
// that failed was a zero, and a dashboard whose reads had all failed said
// "Everything is running". And the SQL-models chip asked the column for a
// value it cannot hold ("error"; it holds built / failed / skipped), so a
// failing model was "Everything is running" with every read answering.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bandSummary, type Attention } from "@/lib/dashboardStatus";

const page = readFileSync("src/routes/_authenticated/dashboard.tsx", "utf8");
const band = readFileSync("src/components/dashboard/StatusBand.tsx", "utf8");

const item = (label: string, count: number | null): Attention => ({ label, count, to: "/x" });

describe("bandSummary", () => {
  it("says everything is running only when every check answered with nothing", () => {
    const s = bandSummary([item("a", 0), item("b", 0)], false);
    expect(s.state).toBe("ok");
    expect(s.text).toBe("Everything is running");
  });

  it("never says everything is running over a check that could not be read", () => {
    const s = bandSummary([item("a", 0), item("b", null)], false);
    expect(s.state).toBe("unknown");
    expect(s.unknown).toBe(1);
    expect(s.text).toBe("Nothing failing among what could be checked — 1 check could not be read");
    expect(s.text).not.toContain("Everything is running");
  });

  it("counts what needs attention over the checks that answered, and names the rest", () => {
    const s = bandSummary([item("a", 2), item("b", null), item("c", null), item("d", 1)], false);
    expect(s.state).toBe("attention");
    expect(s.total).toBe(3);
    expect(s.text).toBe("3 things need attention · 2 checks could not be read");
  });

  it("keeps the plain sentence when every check answered", () => {
    expect(bandSummary([item("a", 1)], false).text).toBe("1 thing needs attention");
  });

  it("is loading before anything answered, whatever the counts say", () => {
    expect(bandSummary([item("a", null)], true).state).toBe("loading");
  });
});

describe("the dashboard maps a failed read to null, not zero", () => {
  it("for every health check", () => {
    expect(page).toContain("reads[k].error ? null : (reads[k].count ?? 0)");
    expect(page).not.toMatch(/syncs: sy\.count \?\? 0/);
    expect(page).not.toMatch(/sqlModels: sqb\.count \?\? 0/);
    for (const k of [
      "syncs",
      "warehouses",
      "schedules",
      "pipelineRuns",
      "incidents",
      "workflows",
      "sqlModels",
    ]) {
      expect(page, k).toContain(`error: healthErrors.${k}`);
    }
  });

  it("and each card says when its check could not be made", () => {
    expect(page).toContain('if (count === null) return "could not be checked";');
    expect((page.match(/warn: warnFor\(/g) ?? []).length).toBe(5);
    expect(page).toContain('? "health could not be checked"');
  });

  it("asks the SQL-models column for a value it can hold", () => {
    const read = page.slice(
      page.indexOf('.from("sql_models")'),
      page.indexOf('supabase.from("budget_settings")'),
    );
    expect(read).toContain('.eq("last_status", "failed")');
    // The predicate, not the word: the read's own comment names the old value.
    expect(read).not.toContain('.eq("last_status", "error")');
  });
});

describe("the band renders the unread checks", () => {
  it("as chips of their own, with the reason on hover", () => {
    expect(band).toContain("const unread = items.filter((i) => i.count === null);");
    expect(band).toContain("{i.label} — could not be read");
    expect(band).toContain("title={i.error}");
    expect(band).toContain('const ok = summary.state === "ok";');
  });
});
