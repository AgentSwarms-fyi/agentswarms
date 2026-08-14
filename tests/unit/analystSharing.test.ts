// Sharing an analyst. The migration made analysts owner-only for a stated
// reason — an analyst runs with its owner's data access — so the risk in
// adding sharing is that it quietly widens that access, or that it does NOT
// and nobody says so. Both are failures; the second is the likelier one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  describeBlockedShare,
  groupAllowsModel,
  groupsBlocked,
  rankCaveats,
  shareCaveats,
} from "@/lib/analystSharing";

describe("what the sharer is told before they share", () => {
  it("warns that a warehouse analyst needs the recipient's OWN connection access", () => {
    const c = shareCaveats({ source: { kind: "warehouse", connection_id: "w1" } });
    const blocking = c.filter((x) => x.severity === "blocking");
    expect(blocking).toHaveLength(1);
    expect(blocking[0].text).toContain("their credentials, not yours");
  });

  it("names the datasets recipients still need granted", () => {
    const c = shareCaveats({
      source: { kind: "local", tables: ["orders", "customers"] },
      grantedTables: ["orders"],
    });
    const blocking = c.find((x) => x.severity === "blocking");
    expect(blocking?.text).toContain("customers");
    expect(blocking?.text).not.toContain("orders,");
  });

  it("says nothing is missing when every dataset is already granted", () => {
    const c = shareCaveats({
      source: { kind: "local", tables: ["orders"] },
      grantedTables: ["Orders"], // case-insensitive: same dataset
    });
    expect(c.some((x) => x.severity === "blocking")).toBe(false);
  });

  it("flags the ALL-datasets scope as resolving per reader", () => {
    // The sharp case: the analyst is not pointed at a fixed list of tables, so
    // shared it points at the RECIPIENT's datasets. Silently shipping that is
    // the difference between a shared analyst and a different analyst.
    const c = shareCaveats({ source: { kind: "local", tables: [] } });
    expect(c.some((x) => x.text.includes("their own datasets, not yours"))).toBe(true);
  });

  it("always warns that readers can get different numbers", () => {
    for (const source of [
      { kind: "local", tables: [] } as const,
      { kind: "local", tables: ["orders"] } as const,
      { kind: "warehouse", connection_id: "w1" } as const,
    ]) {
      const c = shareCaveats({ source });
      expect(c.some((x) => x.text.includes("different numbers to different people"))).toBe(true);
    }
  });

  it("always states that saved analyses are not shared", () => {
    // Threads hold rows fetched under the OWNER's access. The dialog has to
    // say they stay put, or a sharer will assume they travelled.
    const c = shareCaveats({ source: { kind: "local", tables: ["orders"] } });
    expect(c.some((x) => x.text.includes("Your saved analyses stay yours"))).toBe(true);
  });

  it("ranks blocking caveats above advisory ones", () => {
    // Deliberately fed in the WRONG order. Ranking a list that is already
    // ranked — which is what shareCaveats returns — proves nothing: an
    // identity function passes it.
    const ranked = rankCaveats([
      { severity: "advisory", text: "a1" },
      { severity: "blocking", text: "b1" },
      { severity: "advisory", text: "a2" },
      { severity: "blocking", text: "b2" },
    ]);
    expect(ranked.map((c) => c.text)).toEqual(["b1", "b2", "a1", "a2"]);
  });
});

describe("a group with no model rules of its own", () => {
  it("is unrestricted — IAM is default-allow at group level", () => {
    // Getting this backwards refuses every share in a workspace that has not
    // configured model rules, which is most of them.
    expect(groupAllowsModel(undefined, () => false)).toBe(true);
    expect(groupAllowsModel([], () => false)).toBe(true);
  });

  it("defers to its rules once it has any", () => {
    const rules = [{ provider: "openai", model_pattern: "gpt-5*" }];
    expect(groupAllowsModel(rules, () => false)).toBe(false);
    expect(groupAllowsModel(rules, () => true)).toBe(true);
  });
});

describe("refusing a share the model rules would break", () => {
  it("names every group that may not use the analyst's model", () => {
    const groups = [
      { id: "a", name: "Analysts" },
      { id: "b", name: "Interns" },
      { id: "c", name: "Finance" },
    ];
    const blocked = groupsBlocked(groups, (id) => id !== "b" && id !== "c");
    expect(blocked).toEqual(["Interns", "Finance"]);
  });

  it("blocks nobody when every group may use it", () => {
    expect(groupsBlocked([{ id: "a", name: "A" }], () => true)).toEqual([]);
  });

  it("produces no refusal when nothing is blocked", () => {
    expect(describeBlockedShare("openai::gpt-5-mini", [])).toBeNull();
  });

  it("names the model AND the groups, so the fix is obvious", () => {
    const msg = describeBlockedShare("openai::gpt-5-mini", ["Interns"]);
    expect(msg).toContain("openai::gpt-5-mini");
    expect(msg).toContain("Interns");
    expect(msg).toContain("Admin → IAM");
  });
});

describe("the grant conveys use, not the owner's access", () => {
  const migration = readFileSync(
    "supabase/migrations/20260826000000_ai_analyst_grants.sql",
    "utf8",
  );

  it("grants SELECT on analysts only — writes stay with the owner", () => {
    expect(migration).toContain("ON public.ai_analysts FOR SELECT");
    expect(migration).toContain("has_resource_access('ai_analyst', id, auth.uid())");
    // No FOR ALL / FOR UPDATE / FOR DELETE policy may be added here.
    expect(migration).not.toMatch(/ai_analysts FOR (ALL|UPDATE|DELETE|INSERT)/);
  });

  it("does NOT open threads to recipients", () => {
    // Threads hold result samples fetched under the owner's access; a reader
    // with narrower row filters would see exactly what those filters withhold.
    // The migration may DISCUSS threads (it explains why it leaves them
    // alone) — what it must not do is create a policy or alter the table.
    expect(migration).not.toMatch(/ON\s+public\.ai_analyst_threads/i);
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+public\.ai_analyst_threads/i);
    expect(migration).toMatch(/CREATE POLICY/i); // it does create one — on analysts
    expect(migration.match(/CREATE POLICY/gi)).toHaveLength(1);
  });

  it("registers the new resource type without dropping the existing ones", () => {
    // The CHECK is REPLACED, so this migration must restate the FULL current
    // set. Measured against the previous definition rather than a hardcoded
    // subset — a subset is what let this ship dropping five types
    // (catalog_source, integration, provider_credential, warehouse_connection,
    // saas_connection) while still passing.
    const prev = readFileSync("supabase/migrations/20260778000000_connection_grants.sql", "utf8");
    const at = prev.lastIndexOf("ADD CONSTRAINT iam_resource_grants_resource_type_check");
    const prevTypes = [...prev.slice(at, prev.indexOf(";", at)).matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(prevTypes.length).toBeGreaterThan(5);
    for (const t of prevTypes) {
      expect(migration, `${t} was dropped from the grant types`).toContain(`'${t}'`);
    }
    expect(migration).toContain("'ai_analyst'");
  });
});

describe("the wiring", () => {
  const page = readFileSync("src/routes/_authenticated/ai-analyst.tsx", "utf8");
  const fns = readFileSync("src/utils/analyst.functions.ts", "utf8");

  it("verifies ownership server-side on both share calls", () => {
    // The client can send any analyst_id. Ownership is not a UI concern.
    const get = fns.slice(fns.indexOf("analystGetShares"), fns.indexOf("analystSetShares"));
    const set = fns.slice(fns.indexOf("analystSetShares"));
    expect(get).toContain("requireAnalystOwner(data.access_token, data.analyst_id)");
    expect(set).toContain("requireAnalystOwner(data.access_token, data.analyst_id)");
    expect(fns).toContain("Only the owner can manage sharing");
  });

  it("refuses the grant BEFORE writing it when the model is disallowed", () => {
    const set = fns.slice(fns.indexOf("analystSetShares"));
    const refusalAt = set.indexOf("describeBlockedShare");
    const insertAt = set.indexOf('.from("iam_resource_grants").insert');
    expect(refusalAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(insertAt);
  });

  it("hides owner-only controls on an analyst shared with you", () => {
    // Scoped to the list row: a recipient pressing rename/edit/delete/share
    // would hit RLS and see what looks like a bug.
    const row = page.slice(page.indexOf("Owner-only controls."));
    const body = row.slice(0, row.indexOf("</Card>"));
    expect(body).toContain("a.user_id === user?.id ?");
    expect(body).toContain("openShare(a)");
    expect(body).toContain("Shared");
  });

  it("reads user_id so owned and shared can be told apart at all", () => {
    expect(page).toContain('.select("id, name, model, source, created_at, user_id")');
  });
});
