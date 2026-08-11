// The wire contract of a budget refusal.
//
// The decision logic is covered by budgetSpend.test.ts and the page's honesty
// by budgetCapDisclosure.test.ts. What neither covered is what a caller
// actually receives when the cap bites — and until now nobody had ever seen it,
// because ENFORCE_BUDGET_CAP had never been switched on anywhere.
//
// VERIFIED LIVE on this instance before writing this file. With
// ENFORCE_BUDGET_CAP=true, a $4.00 cap and $4.13 of month-to-date spend:
//
//   POST /api/chat -> 402
//   {"error":"budget_exceeded","message":"You have reached your monthly AI
//    budget ($4.00). (spent $4.13 of $4.00 this month.)"}
//
// and the guard on the guard — cap raised to $20.00, cache expired, the
// IDENTICAL request returned 200 with a real completion. So the refusal was
// the cap and not something incidental. Env and cap were restored afterwards.
//
// These assertions exist so the shape cannot drift silently. 402 in particular
// is load-bearing: toolLoop treats it as non-retryable, and an embed that got
// a 500 instead would retry a call the operator meant to stop.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { budgetMessage } from "@/utils/budgetGuard.server";

const CHAT = readFileSync("src/routes/api/chat.ts", "utf8");
const EMBED = readFileSync("src/routes/api/embed.ts", "utf8");
const EMBED_CHAT = readFileSync("src/routes/api/embed.chat.ts", "utf8");
const SWARM_RUN = readFileSync("src/routes/api/swarm.run.ts", "utf8");
const GUARD = readFileSync("src/utils/budgetGuard.server.ts", "utf8");

describe("a refused call is refused the same way everywhere", () => {
  it("the chat route answers 402 with a budget_exceeded code", () => {
    const block = CHAT.slice(CHAT.indexOf("const budget = await getBudgetDecision"));
    expect(block).toContain('error: "budget_exceeded"');
    expect(block.slice(0, 900)).toContain("status: 402");
  });

  it("the JSON embed route answers 402 too", () => {
    expect(EMBED).toMatch(/budgetMessage\(budget\)\s*\}\s*,\s*402\s*\)/);
  });

  it("the swarm API route answers 402 too", () => {
    expect(SWARM_RUN).toMatch(/budgetMessage\(budget\)\s*\}\s*,\s*402\s*\)/);
  });

  it("the streaming embed route says so in-stream rather than failing silently", () => {
    // SSE cannot carry a status code once the stream is open, so the refusal
    // has to arrive as content. Dropping the stream instead would look like a
    // network glitch to the widget.
    expect(EMBED_CHAT).toMatch(/if \(budget\.over\) return sseOnce\(budgetMessage\(budget\)\)/);
  });

  it("every gated route consults the same decision function", () => {
    for (const [name, src] of [
      ["chat", CHAT],
      ["embed", EMBED],
      ["embed.chat", EMBED_CHAT],
      ["swarm.run", SWARM_RUN],
    ] as const) {
      expect(src, `${name} does not consult getBudgetDecision`).toContain("getBudgetDecision");
    }
  });
});

describe("the refusal message names the ceiling that was hit", () => {
  it("distinguishes personal, team and credential caps", () => {
    const user = budgetMessage({ over: true, scope: "user", spend: 4.13, cap: 4 });
    const group = budgetMessage({ over: true, scope: "group", spend: 9, cap: 8 });
    const cred = budgetMessage({ over: true, scope: "credential", spend: 2, cap: 1 });
    expect(user).toContain("$4.00");
    expect(user).toMatch(/your monthly AI budget/i);
    // Three ceilings, three different remedies — "raise your own limit" is
    // useless advice to someone blocked by their team's cap.
    expect(group).toMatch(/team/i);
    expect(group).toMatch(/administrator/i);
    expect(cred).toMatch(/integration/i);
    expect(cred).toMatch(/owner/i);
    expect(new Set([user, group, cred]).size).toBe(3);
  });
});

describe("enforcement stays opt-in, and off means off", () => {
  it("reads ENFORCE_BUDGET_CAP and treats anything else as off", () => {
    expect(GUARD).toMatch(/\/\^\(1\|true\|yes\)\$\/i\.test\(process\.env\.ENFORCE_BUDGET_CAP/);
  });

  it("returns an allow decision immediately when enforcement is off", () => {
    // The measured default. Every deployment that has never set the variable
    // is in this branch, so it must not touch the database at all.
    const fn = GUARD.slice(
      GUARD.indexOf("export async function getBudgetDecision"),
      GUARD.indexOf("/** Human-readable refusal"),
    );
    expect(fn).toMatch(/if \(!budgetEnforcementEnabled\(\)\) return allow;/);
  });

  it("an unknown spend is not silently treated as zero, in all three scopes", () => {
    // The original bug in this area: `data ?? []` summed a failed query to $0,
    // so the cap stopped enforcing exactly when it mattered most.
    //
    // Asserting that the string "budgetFailsClosed()" merely APPEARS is not
    // enough — mutation testing showed that survives renaming the function,
    // because the orphaned call sites keep the text alive. Each scope's
    // unknown-spend BRANCH is what has to be pinned.
    expect(GUARD, "the personal scope no longer honours fail-closed").toMatch(
      /return budgetFailsClosed\(\) \? \{ over: true, spend: 0, cap \} : miss;/,
    );
    expect(GUARD, "the credential scope no longer honours fail-closed").toMatch(
      /if \(spend === null\) \{\s*if \(budgetFailsClosed\(\)\) decision = \{ over: true, scope: "credential"/,
    );
    expect(GUARD, "the group scope no longer honours fail-closed").toMatch(
      /if \(budgetFailsClosed\(\)\) \{\s*decision = \{ over: true, scope: "group"/,
    );
    expect(GUARD, "a null spend is being read as zero again").not.toMatch(
      /spend\s*\?\?\s*0\s*\)\s*>=\s*cap/,
    );
  });
});
