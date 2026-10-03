// An irreversible delete asks first, or says in writing why it does not.
//
// This exists because finding them one at a time did not work. A guard was
// written for the knowledge base, and the source delete RIGHT NEXT TO IT —
// which cascades every document synced from that source — still went on one
// click. Then a chat delete was reported from use. A sweep afterwards found
// five more: a KB source, a KB document, an MCP server, an eval case, and
// disconnecting a model provider, which deletes a key that is never shown
// again.
//
// So the rule is enforced over the whole directory rather than per feature:
// every client-side delete either asks through the in-app dialog, or appears
// below with a reason that is itself checked against the code. The exemption
// list is the interesting part — it is short, each entry says why, and a wrong
// reason fails as loudly as a missing confirmation.
//
// R242 WIDENED THE SWEEP, because it had the same shape as the bug it was
// written to stop. "The whole directory" was `src/routes/_authenticated` —
// pages only — and a delete is just as destructive from a dialog in
// `src/components`. Twelve of them were there, unswept, including a swarm
// chat transcript deleted on one click by a trash icon one row from the chat
// you are in: the exact control, with the exact comment explaining why it
// earns a question, that Agent Chat had already been fixed for in R72. A
// guard whose scope is narrower than the rule it enforces reads as coverage
// and is not.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const PAGE_DIR = "src/routes/_authenticated";
const DIRS = [PAGE_DIR, "src/components"];
/** A bare name is a page, as it always was; a path is taken as given. */
const rd = (p: string) => readFileSync(p.includes("/") ? p : `${PAGE_DIR}/${p}`, "utf8");

/** Every .tsx under the swept roots, pages and components alike. */
function sweptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) out.push(full);
    }
  };
  for (const d of DIRS) walk(d);
  return out;
}

/** Deletes that legitimately do not ask, and the reason, and its proof. */
const EXEMPT: Record<string, { why: string; provenBy: RegExp }> = {
  deleteAgent: {
    why: "an AlertDialog at the call site asks, and the handler only runs from its action button",
    provenBy: /if \(confirmDelete\) void deleteAgent\(confirmDelete\)/,
  },
  performDeleteSwarm: {
    why: "same shape: the name says it, and an AlertDialogAction is the only caller",
    provenBy: /onClick=\{performDeleteSwarm\}/,
  },
  regenerateResponse: {
    why: "not a delete a reader performs — it replaces an answer, and the rows go as part of that",
    provenBy: /regenerateResponse/,
  },
  editAndResend: {
    why: "the same: editing a message re-runs the turn, and the superseded rows go with it",
    provenBy: /editAndResend/,
  },
  deleteMessage: {
    why: "one message inside a transcript that stays; the chat itself asks, which is the loss that matters",
    provenBy: /async function deleteConversation/,
  },

  // ── Found by R242's widened sweep, in src/components ──────────────────────
  handleDelete: {
    why: "SwarmGallery: an AlertDialogAction is the only caller, same shape as performDeleteSwarm",
    provenBy: /onClick=\{\(\) => handleDelete\(s\.id, s\.name\)\}/,
  },
  revokeKey: {
    why: "SwarmDeployDialog: an AlertDialogAction is the only caller",
    provenBy: /AlertDialogAction[\s\S]{0,400}revokeKey\(/,
  },
  remove: {
    why: "SwarmVersionsDialog: an AlertDialogAction is the only caller. ComponentLibraryDialog's own `remove` asks directly, so both spellings are covered",
    provenBy: /AlertDialogAction[\s\S]{0,400}remove\(/,
  },
  saveCap: {
    why: "GroupBudgetsTab: not a delete a reader performs — emptying the cap field clears the ceiling, and the row delete IS that save",
    provenBy: /Empty input clears the ceiling entirely rather than storing 0/,
  },
  withdrawSource: {
    why: "AddSourceDialog: a compensating rollback (R192) — it takes back a source whose document write failed, and marks it when even that fails",
    provenBy: /The document was not saved: \$\{why\}/,
  },
  deleteMemoryItem: {
    why: "AgentForm: one item inside a memory that stays, and clearing the whole memory asks — the same reasoning as deleteMessage",
    provenBy: /clearAllMemoryItems[\s\S]{0,600}confirmAsk/,
  },
};

/** Every `supabase.from("x").delete()` in a page, with its enclosing function. */
function deletesIn(file: string): { fn: string; table: string }[] {
  const src = rd(file);
  const out: { fn: string; table: string }[] = [];
  for (const m of src.matchAll(/supabase\s*\.from\("([a-z_]+)"\)\s*\.delete\(\)/g)) {
    const before = src.slice(0, m.index);
    const fns = [...before.matchAll(/(?:async )?function (\w+)\(|const (\w+) = async/g)];
    const last = fns[fns.length - 1];
    out.push({ fn: last?.[1] ?? last?.[2] ?? "?", table: m[1]! });
  }
  return out;
}

/** The enclosing function's body, roughly — to the next top-level function. */
function bodyOf(file: string, fn: string): string {
  const src = rd(file);
  const at = src.search(new RegExp(`(?:async )?function ${fn}\\(|const ${fn} = async`));
  if (at < 0) return "";
  const rest = src.slice(at + 1);
  const next = rest.search(/\n {2}(?:const \w+ = async|(?:async )?function \w+\()/);
  return rest.slice(0, next === -1 ? undefined : next);
}

const PAGES = sweptFiles();

describe("every delete in a page asks, or says why not", () => {
  it("finds pages to check, so an empty sweep cannot pass", () => {
    // Mutation-checked: pointing this at an empty directory made the whole
    // file vacuous.
    expect(PAGES.length).toBeGreaterThan(40);
    // Pinned per ROOT, because the pages directory alone already clears any
    // whole-sweep floor — 47 files — so a sweep that narrowed back to pages
    // would pass a total count while checking none of the 245 component
    // files. That is the shape of the bug this file exists to stop, and it
    // nearly reappeared in the fix for it.
    const pages = PAGES.filter((f) => f.startsWith("src/routes/_authenticated/"));
    const components = PAGES.filter((f) => f.startsWith("src/components/"));
    expect(pages.length, "pages are not being swept").toBeGreaterThan(10);
    expect(components.length, "components are not being swept").toBeGreaterThan(100);
    const inComponents = components.flatMap((f) => deletesIn(f)).length;
    expect(inComponents, "no deletes found in components — the sweep narrowed").toBeGreaterThan(5);
    const total = PAGES.flatMap((p) => deletesIn(p)).length;
    expect(total, "no deletes found — the matcher stopped matching").toBeGreaterThan(10);
  });

  it("asks before every one that is not exempt", () => {
    const silent: string[] = [];
    for (const page of PAGES) {
      for (const { fn, table } of deletesIn(page)) {
        if (EXEMPT[fn]) continue;
        const body = bodyOf(page, fn);
        if (!body.includes("confirmAsk")) silent.push(`${page}: ${fn} deletes ${table}`);
      }
    }
    expect(silent, `these delete on one click with no question: ${silent.join("; ")}`).toEqual([]);
  });

  it("holds each exemption to the reason it gives", () => {
    // An exemption whose reason stopped being true is worse than none: it
    // reads as considered and is not.
    const stale: string[] = [];
    for (const [fn, { provenBy }] of Object.entries(EXEMPT)) {
      const page = PAGES.find((p) => provenBy.test(rd(p)));
      if (!page) stale.push(fn);
    }
    expect(stale, `exemptions whose stated reason no longer holds: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps the exemption list short enough to read", () => {
    // If this needs raising, the question to ask is whether the newest entry
    // is really an exception or just an inconvenience.
    // Raised from 8 to 11 by R242, and the reason matters: the list grew
    // because the SWEEP grew to cover src/components, not because the standard
    // slipped. Every entry added is one of the three shapes already accepted
    // here — an AlertDialog at the call site, a write that is not a delete the
    // reader performs, or one row inside a container whose own deletion asks.
    // The one candidate that rested on "it is only notices" was given a
    // question instead (NotificationBell), which is the answer this cap is
    // meant to provoke.
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(11);
  });
});

describe("the questions name what is lost", () => {
  // "Are you sure?" tells a reader nothing they did not already know. Each of
  // these was written because the loss is bigger than the row being deleted.
  it.each([
    ["knowledge.tsx", /Every document synced from it goes too/],
    ["knowledge.tsx", /chunks and embeddings go with it/],
    ["mcp.tsx", /Agents using its tools lose them/],
    ["evaluations.tsx", /future runs no longer test it/],
    ["integrations.tsx", /deleted, not disabled/],
    ["playground.tsx", /Every message in this chat goes with it/],
  ])("%s says what goes", (page, phrase) => {
    expect(rd(page)).toMatch(phrase);
  });

  it("warns that a disconnected provider's key cannot be read back", () => {
    // The one with no undo at all: the key is stored encrypted and never
    // shown again, so "disconnect" is not a toggle.
    expect(rd("integrations.tsx")).toMatch(/the old one cannot be read back/);
  });
});
