// Swarm versions under a failed write (R190).
//
// FOUND IN R190, from the R189 round on the same dialog. `snapshotSwarmVersion`
// swallowed its insert error, which is right for the autosave on Save and
// wrong for its other two callers. Driven on "Approval durability check" with
// the insert refused from the browser: "Save version" toasted "Version saved"
// and the list still held only the Initial version; and Restore, after a
// confirm promising "Your current graph is saved as a snapshot first, so you
// can restore back", replaced a 6-node canvas with the 5-node snapshot and
// kept no "Before restore" version. The helper is tested by behaviour; its
// two callers live in components and are pinned by source.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  insertError: null as { message: string } | null,
  ids: [] as { id: string }[],
  calls: [] as string[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => ({
    insert: async () => {
      state.calls.push(`${table}.insert`);
      return { error: state.insertError };
    },
    select: () => ({
      eq: () => ({
        order: async () => {
          state.calls.push(`${table}.select`);
          return { data: state.ids, error: null };
        },
      }),
    }),
    delete: () => ({
      in: async () => {
        state.calls.push(`${table}.delete`);
        return { error: null };
      },
    }),
  });
  return { supabase: { from } };
});

import { snapshotSwarmVersion } from "@/lib/swarmVersions";

const snap = () =>
  snapshotSwarmVersion({
    swarmId: "s1",
    userId: "u1",
    nodes: [],
    edges: [],
    label: "R190",
    kind: "manual",
  });

beforeEach(() => {
  state.insertError = null;
  state.ids = [];
  state.calls = [];
});

describe("snapshotSwarmVersion", () => {
  it("says why a version did not land, and prunes nothing", async () => {
    state.insertError = { message: "R190: the insert was refused" };
    await expect(snap()).resolves.toBe("R190: the insert was refused");
    expect(state.calls).toEqual(["swarm_versions.insert"]);
  });

  it("resolves to null when it landed, and still prunes past the cap", async () => {
    state.ids = Array.from({ length: 31 }, (_, i) => ({ id: `v${i}` }));
    await expect(snap()).resolves.toBeNull();
    expect(state.calls).toEqual([
      "swarm_versions.insert",
      "swarm_versions.select",
      "swarm_versions.delete",
    ]);
  });
});

const DIALOG = readFileSync("src/components/swarms/SwarmVersionsDialog.tsx", "utf8");
const CANVAS = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");

const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  return src.slice(a, src.indexOf(to, a));
};

describe("Save version", () => {
  const save = between(DIALOG, "const saveVersion = async () => {", "const restore = async");

  it("says the version was not saved, keeps the label, and does not say it was", () => {
    expect(save).toMatch(/const error = await snapshotSwarmVersion\(/);
    const failed = save.indexOf("if (error) {");
    expect(failed).toBeGreaterThan(0);
    const branch = save.slice(failed, save.indexOf("return;", failed));
    expect(branch).toContain('toast.error("The version was not saved", { description: error });');
    expect(branch).not.toContain("setLabel(");
    expect(save.indexOf('setLabel("")')).toBeGreaterThan(failed);
    expect(save.indexOf('toast.success("Version saved")')).toBeGreaterThan(failed);
  });
});

describe("Restore", () => {
  const handler = between(
    CANVAS,
    "const handleRestoreVersion = async (",
    "// Auto-arrange nodes left-to-right",
  );

  it("replaces nothing when the snapshot of the current graph did not land", () => {
    expect(handler).toMatch(/const error = await snapshotSwarmVersion\(/);
    const failed = handler.indexOf("if (error) {");
    expect(failed).toBeGreaterThan(0);
    expect(handler.slice(failed, failed + 400)).toContain('toast.error("Nothing was restored"');
    expect(handler.slice(failed, failed + 400)).toContain("so the restore could not be undone");
    expect(handler.slice(failed, handler.indexOf("return false;", failed))).not.toContain(
      "setNodes(",
    );
    expect(handler.indexOf("setNodes(vNodes);")).toBeGreaterThan(
      handler.indexOf("return false;", failed),
    );
    expect(handler).toMatch(
      /toast\.success\("Version restored — hit Save to keep it\."\);\s*return true;/,
    );
  });

  it("leaves the dialog open when nothing was restored", () => {
    const restore = between(DIALOG, "const restore = async", "const remove = async");
    expect(restore).toContain("const restored = await onRestore(vNodes, vEdges);");
    expect(restore).toContain("if (restored) onOpenChange(false);");
  });
});
