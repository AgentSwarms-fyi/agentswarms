// The question comes before the screen changes.
//
// FOUND IN R244, by driving the real image after a green gate. R242 gave the
// notification bell's "Clear all" a confirmation, and put it one line too low:
//
//   const before = items;
//   setItems([]);            // the panel empties here
//   if (!(await confirmAsk({…}))) return;   // …and the question comes after
//
// Cancel therefore returned without restoring, and the panel sat on "No
// notifications" over thirty rows that were still in the database, until a
// reload brought them back. The data was never at risk; the screen simply said
// something that was not true, which is the whole of R70's rule — "an
// optimistic switch is a promise about the database" — broken by the fix for
// it.
//
// 9,209 tests passed over that change, because every one of them asked WHETHER
// a control confirms and none asked WHEN. This file asks when.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Handlers that both ask and update optimistically, and where each lives. */
const GUARDED: { file: string; fn: string; optimism: RegExp }[] = [
  {
    file: "src/components/NotificationBell.tsx",
    fn: "clearAll",
    optimism: /setItems\(\[\]\)/,
  },
  {
    file: "src/components/swarms/SwarmChatDialog.tsx",
    fn: "deleteChat",
    optimism: /setChats\(/,
  },
  {
    file: "src/components/swarms/SwarmDeployDialog.tsx",
    fn: "deleteSchedule",
    optimism: /setSchedules\(/,
  },
  {
    file: "src/components/bi/ScheduleDialog.tsx",
    fn: "deleteAlert",
    optimism: /setAlerts\(/,
  },
];

/**
 * The same text with comments removed.
 *
 * Needed because the first version of this file was defeated by its own fix:
 * the comment explaining the bug quoted `setItems([])`, the search found THAT
 * and reported the flip as happening before the question it was written below.
 * A test about order must read code, not prose about code.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The handler's body: from its signature to the next one at the same depth. */
function bodyOf(file: string, fn: string): string {
  const src = readFileSync(file, "utf8");
  const at = src.search(new RegExp(`(?:async )?function ${fn}\\(|const ${fn} = async`));
  expect(at, `${fn} not found in ${file}`).toBeGreaterThan(-1);
  const rest = src.slice(at + 1);
  const next = rest.search(/\n {2}(?:const \w+ = async|(?:async )?function \w+\()/);
  return codeOnly(rest.slice(0, next === -1 ? undefined : next));
}

describe("a handler that asks and also updates the screen", () => {
  it.each(GUARDED)("$fn asks before it changes anything", ({ file, fn, optimism }) => {
    const body = bodyOf(file, fn);
    const ask = body.indexOf("confirmAsk(");
    expect(ask, `${fn} does not ask at all`).toBeGreaterThan(-1);
    const flip = body.search(optimism);
    expect(flip, `${fn} never updates its list — check this entry`).toBeGreaterThan(-1);
    expect(
      ask,
      `${fn}: the screen changes before the reader has answered. Cancel then leaves ` +
        `the UI saying something the database does not.`,
    ).toBeLessThan(flip);
  });

  it("the bell restores its list when the delete fails, and says what is true", () => {
    // The other half of R70's rule, which was already right and must stay so:
    // an optimistic change that the write rejects has to come back.
    const body = bodyOf("src/components/NotificationBell.tsx", "clearAll");
    const onError = body.slice(body.indexOf("if (error)"));
    expect(onError).toContain("setItems(before)");
    expect(onError).toMatch(/They are still there/);
  });
});
