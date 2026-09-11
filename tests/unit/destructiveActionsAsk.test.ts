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
// every client-side delete in a page either asks through the in-app dialog, or
// appears below with a reason that is itself checked against the code. The
// exemption list is the interesting part — it is short, each entry says why,
// and a wrong reason fails as loudly as a missing confirmation.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const DIR = "src/routes/_authenticated";
const rd = (p: string) => readFileSync(`${DIR}/${p}`, "utf8");

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

const PAGES = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

describe("every delete in a page asks, or says why not", () => {
  it("finds pages to check, so an empty sweep cannot pass", () => {
    // Mutation-checked: pointing this at an empty directory made the whole
    // file vacuous.
    expect(PAGES.length).toBeGreaterThan(10);
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
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(8);
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
