// The assistant's two server tools, run with stand-in clients: what they
// return, and what they refuse.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/objectSearch/sources.server", () => ({
  loadObjectIndex: vi.fn(async () => ({
    entries: [
      { kind: "dashboard", id: "d1", name: "Sales overview", mine: true, detail: "Q3 numbers" },
      { kind: "dashboard", id: "d2", name: "Churn [beta]", mine: false },
      { kind: "agent", id: "a1", name: "Sales helper", mine: true },
      { kind: "workbook", id: "w1", name: "Sales sample", mine: false, sample: true },
    ],
    capped: [],
    failed: [],
  })),
  searchCappedKinds: vi.fn(async () => []),
}));
vi.mock("@/utils/objectSearch/extras.server", () => ({
  indexExtrasFor: () => ({}),
  SEALED_NAMES: { analysis: () => null },
}));

const { formatMatches, hrefOf, runDocsSearch, runFindMyWork } =
  await import("@/utils/assistant/tools.server");
const { loadObjectIndex } = await import("@/utils/objectSearch/sources.server");

type Ctx = Parameters<typeof runFindMyWork>[0];
const ctx = (over: Partial<Ctx> = {}): Ctx =>
  ({ userId: "u1", authToken: "t", sb: {} as Ctx["sb"], ...over }) as Ctx;

describe("docs_search", () => {
  it("returns linked sections from the handbook", async () => {
    const out = await runDocsSearch(ctx(), { query: "restore something I deleted" });
    expect(out).toMatch(/^\[Dashboard › Trash\]\(\/docs\/dashboard#trash\)/m);
  });

  it("says plainly when the handbook has nothing", async () => {
    const out = await runDocsSearch(ctx(), { query: "zzqx frobnicate" });
    expect(out).toMatch(/no section on that/);
  });
});

describe("find_my_work", () => {
  it("lists matches with a link that opens each, and whose they are", async () => {
    const out = await runFindMyWork(ctx(), { query: "sales" });
    expect(out).toContain("- [Sales overview](/bi/d1) — Dashboard · Q3 numbers");
    expect(out).toContain("- [Sales helper](/agents?open=a1) — Agent");
    expect(out).toContain("- [Sales sample](/sheets/w1) — Workbook · sample");
  });

  it("narrows to one kind", async () => {
    const out = await runFindMyWork(ctx(), { query: "sales", kind: "agent" });
    expect(out).toContain("Sales helper");
    expect(out).not.toContain("Sales overview");
  });

  it("keeps a name from breaking the link it is written into", () => {
    expect(
      formatMatches([{ kind: "dashboard", id: "d2", name: "Churn [beta]", mine: false }]),
    ).toBe("- [Churn beta](/bi/d2) — Dashboard · shared with you");
  });

  it("refuses without the reader's own token, before reading anything", async () => {
    vi.mocked(loadObjectIndex).mockClear();
    expect(await runFindMyWork(ctx({ authToken: undefined }), { query: "sales" })).toMatch(
      /only in the signed-in app/,
    );
    expect(await runFindMyWork(ctx({ scopeUserId: "u1" }), { query: "sales" })).toMatch(
      /only in the signed-in app/,
    );
    expect(loadObjectIndex).not.toHaveBeenCalled();
  });

  it("says what it looked for when nothing matches", async () => {
    expect(await runFindMyWork(ctx(), { query: "zzqx", kind: "report" })).toBe(
      'Nothing of the user\'s reports has a name matching "zzqx".',
    );
  });

  it("writes an app link with its search", () => {
    expect(hrefOf({ kind: "swarm", id: "s1", name: "x" })).toBe("/swarms?swarm=s1&view=canvas");
  });
});
