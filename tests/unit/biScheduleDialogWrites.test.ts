// BI schedule dialog: a write that failed is said, and the dialog shows what
// is actually stored — an alert switched off that is still on will still
// fire, and the switch must say so.
//
// FOUND FROM THE UI. With every PATCH to bi_alerts rejected, an alert's
// switch went off on screen and stayed on in the database; the dialog said
// nothing, and the alert kept firing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialog = readFileSync("src/components/bi/ScheduleDialog.tsx", "utf8");
const fn = (name: string, until: string) => {
  const i = dialog.indexOf(name);
  expect(i, name).toBeGreaterThanOrEqual(0);
  const j = dialog.indexOf(until, i);
  expect(j, until).toBeGreaterThan(i);
  return dialog.slice(i, j);
};

describe("the schedule dialog's writes", () => {
  it("leave no bare write statement", () => {
    expect(dialog).not.toMatch(
      /^\s*await supabase\.from\("[a-z_]+"\)\.(update|delete|insert|upsert)\([^\n]*;\s*$/m,
    );
  });

  it("removing a schedule that could not be removed keeps it in the dialog and says so", () => {
    const f = fn("async function removeSchedule()", "async function addAlert()");
    expect(f).toContain('const { error } = await supabase.from("bi_schedules").delete()');
    expect(f).toContain('toast.error("Could not remove the schedule"');
    expect(f.indexOf("return;")).toBeLessThan(f.indexOf("setSchedule(null);"));
  });

  it("deleting an alert that could not be deleted keeps it listed and says it will still fire", () => {
    const f = fn("async function deleteAlert(", "async function toggleAlert(");
    expect(f).toContain('const { error } = await supabase.from("bi_alerts").delete()');
    expect(f).toContain("It is still set and will still fire.");
    expect(f.indexOf("return;")).toBeLessThan(f.indexOf("setAlerts((prev) => prev.filter"));
  });

  it("switching an alert that could not be switched undoes the switch on screen and says so", () => {
    const f = fn("async function toggleAlert(", "async function toggleAlertEmail(");
    expect(f).toContain(
      'const { error } = await supabase.from("bi_alerts").update({ is_active: on })',
    );
    expect(f).toContain("{ ...x, is_active: !on }");
    expect(f).toContain('"Could not switch the alert off"');
    expect(f).toContain("still on and will still fire");
  });

  it("changing an alert's email setting that could not be changed leaves it unchanged and says so", () => {
    const f = fn("async function toggleAlertEmail(", "const widgetTitle =");
    expect(f).toContain("const { error } = await supabase");
    expect(f).toContain('toast.error("Could not change the alert\'s email setting"');
    expect(f.indexOf("return;")).toBeLessThan(f.indexOf("email_enabled: next } : x"));
  });
});
