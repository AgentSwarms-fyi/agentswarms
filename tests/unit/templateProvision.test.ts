// Making an agent from an agent template (R530). The client is the caller's
// own, but a client can be allowed to read more than its own rows, so every
// lookup names the caller; and using a template twice opens what it made the
// first time instead of writing the template over the person's changes.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/tools/embedding.server", () => ({ embedAndStoreDocuments: vi.fn() }));
vi.mock("@/utils/tools/embedTarget.server", () => ({ resolveEmbedArgs: vi.fn(async () => null) }));

import { REAL_TEMPLATES } from "@/lib/realTemplates";
import { provisionAgentTemplate } from "@/utils/templates/provision.server";

type Op = [string, unknown[]];
type Call = { table: string; ops: Op[] };

/** A client that records every call; a select answers with `rows[table]`, an insert with a new id. */
function fakeDb(rows: Record<string, unknown[]> = {}) {
  const calls: Call[] = [];
  let next = 0;
  const db = {
    from(table: string) {
      const rec: Call = { table, ops: [] };
      calls.push(rec);
      let single = false;
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const inserted = rec.ops.some(([o]) => o === "insert");
              const data = inserted ? [{ id: `${table}-new-${++next}` }] : (rows[table] ?? []);
              return (resolve: (v: unknown) => void) =>
                resolve({ data: single ? (data[0] ?? null) : data, error: null });
            }
            return (...args: unknown[]) => {
              if (prop === "single" || prop === "maybeSingle") single = true;
              rec.ops.push([String(prop), args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { db: db as never, calls };
}

const has = (c: Call, op: string, ...args: unknown[]) =>
  c.ops.some(([o, a]) => o === op && JSON.stringify(a) === JSON.stringify(args));
const inserting = (c: Call) => c.ops.some(([o]) => o === "insert");

describe("provisionAgentTemplate", () => {
  it("names the caller in every lookup", async () => {
    for (const t of REAL_TEMPLATES) {
      const { db, calls } = fakeDb();
      const res = await provisionAgentTemplate(db, "u1", t.id);
      expect(res.ok, t.id).toBe(true);
      const lookups = calls.filter((c) => !inserting(c));
      expect(lookups.length, t.id).toBeGreaterThan(0);
      for (const c of lookups)
        expect(has(c, "eq", "user_id", "u1"), `${t.id}: ${c.table}`).toBe(true);
    }
  });

  it("makes the agent, tagged with its template, its documents, and its example approval", async () => {
    const t = REAL_TEMPLATES.find((x) => x.id === "support-kb-agent")!;
    const { db, calls } = fakeDb();
    const res = await provisionAgentTemplate(db, "u1", t.id);
    expect(res).toMatchObject({ ok: true, reused: false, templateId: t.id });

    const agent = calls.find((c) => c.table === "agents" && inserting(c))!;
    const row = agent.ops.find(([o]) => o === "insert")![1][0] as Record<string, unknown>;
    expect(row.user_id).toBe("u1");
    expect(row.name).toBe(`Demo · ${t.title}`);
    // The template's id is in tools, where the lookup reads it; the
    // description every agent card shows stays the template's own words (an
    // internal tag showed on the card, found in the R530 browser test).
    expect(row.description).toBe(t.tagline);
    expect((row.tools as Record<string, unknown>).templateId).toBe(t.id);
    const lookup = calls.find((c) => c.table === "agents" && !inserting(c))!;
    expect(has(lookup, "eq", "tools->>templateId", t.id)).toBe(true);

    const docs = calls.filter((c) => c.table === "knowledge_documents" && inserting(c));
    expect(docs).toHaveLength(t.seedDocuments.length);
    expect(calls.some((c) => c.table === "approvals" && inserting(c))).toBe(!!t.approvalSeed);
  });

  it("opens the agent made before, and changes nothing", async () => {
    const { db, calls } = fakeDb({ agents: [{ id: "a-old", knowledge_base_id: "kb-old" }] });
    const res = await provisionAgentTemplate(db, "u1", "support-kb-agent");
    expect(res).toEqual({
      ok: true,
      agentId: "a-old",
      knowledgeBaseId: "kb-old",
      templateId: "support-kb-agent",
      reused: true,
    });
    expect(calls.some((c) => c.ops.some(([o]) => o === "insert" || o === "update"))).toBe(false);
  });

  it("refuses a template that is not there, before touching anything", async () => {
    const { db, calls } = fakeDb();
    expect(await provisionAgentTemplate(db, "u1", "nope")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(calls).toEqual([]);
  });
});
