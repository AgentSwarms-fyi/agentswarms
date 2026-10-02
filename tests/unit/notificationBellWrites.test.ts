// The notification bell: a write that failed is undone on screen and said —
// "cleared" notifications that are still there come back, and say why.
//
// FOUND FROM THE UI. With every DELETE to notifications rejected, "Clear
// all" emptied the popover and the unread badge; on the next open the
// notifications were all back. Mark-read did the same to the badge.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bell = readFileSync("src/components/NotificationBell.tsx", "utf8");
const fn = (name: string, until: string) => {
  const i = bell.indexOf(name);
  expect(i, name).toBeGreaterThanOrEqual(0);
  const j = bell.indexOf(until, i);
  expect(j, until).toBeGreaterThan(i);
  return bell.slice(i, j);
};

describe("the bell's three writes", () => {
  it("leave no bare write statement", () => {
    expect(bell).not.toMatch(
      /^\s*await supabase\.from\("notifications"\)\.(update|delete)\([^\n]*;\s*$/m,
    );
    expect(bell).not.toMatch(/^\s*await supabase\s*\n\s*\.from\("notifications"\)/m);
  });

  it("mark-all-read undoes itself and says so when the write fails", () => {
    const f = fn("async function markAllRead()", "async function clearAll()");
    expect(f).toContain("const before = items;");
    expect(f).toContain("const { error } = await supabase");
    expect(f).toContain("setItems(before);");
    expect(f).toContain('toast.error("Could not mark the notifications read"');
  });

  it("clear-all undoes itself and says the notifications are still there", () => {
    const f = fn("async function clearAll()", "async function markRead(");
    expect(f).toContain('const { error } = await supabase.from("notifications").delete()');
    expect(f).toContain("setItems(before);");
    expect(f).toContain("They are still there.");
  });

  it("mark-read undoes itself and says so", () => {
    const f = fn("async function markRead(", "return (");
    expect(f).toContain("const { error } = await supabase");
    expect(f).toContain(".update({ read_at: now })");
    expect(f).toContain('.eq("id", id)');
    expect(f).toContain("setItems(before);");
    expect(f).toContain('toast.error("Could not mark the notification read"');
  });
});
