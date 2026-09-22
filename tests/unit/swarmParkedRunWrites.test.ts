// A parked swarm run: the approval row that puts it in front of a person,
// the stamp that says it is parked, and the resume that must not mistake a
// failed stamp for a run already resumed.
//
// FOUND FROM THE SURVEY (R90). The insert sat in a catch a supabase answer
// never reaches; the stamp dropped its error; and the approval path gated on
// the word that stamp writes rather than on the checkpoint a resume needs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ex = readFileSync("src/utils/swarmExecute.server.ts", "utf8");
const rs = readFileSync("src/utils/swarmResume.functions.ts", "utf8");
const between = (src: string, start: string, end: string) =>
  src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

const approval = between(
  ex,
  "async function createApprovalRequest(",
  "export async function executeSwarmServer(",
);
const finish = between(ex, "const finish = async (", "try {");

describe("parking a run at an approval", () => {
  it("says when nobody was asked, because the approval row could not be written", () => {
    expect(approval).toContain('const { error } = await supabaseAdmin.from("approvals").insert({');
    expect(approval).toContain("but nobody was asked");
    expect(approval).toContain("resume it by hand");
  });

  it("retries the suspended stamp once and says what a failure leaves", () => {
    expect((finish.match(/await park\(\)/g) ?? []).length).toBe(2);
    expect(finish).toContain("could not be marked suspended after two attempts");
    expect(finish).toContain("It will show as running until it is");
  });
});

describe("approving a parked run", () => {
  it("decides on the checkpoint, not on the word the stamp writes", () => {
    expect(rs).toContain('if (run.status === "success" || run.status === "error") {');
    expect(rs).not.toContain('if (run.status !== "suspended") {');
    expect(rs).toContain(
      'const { loadCheckpoint } = await import("@/utils/swarmCheckpoint.server");',
    );
    expect(rs).toContain("if (!(await loadCheckpoint(run.id, run.user_id))) {");
  });

  it("still treats a run with no checkpoint as one already resumed", () => {
    const gate = rs.slice(rs.indexOf("if (!(await loadCheckpoint(run.id, run.user_id))) {"));
    expect(gate.slice(0, 200)).toContain(
      'return { ok: true, status: run.status, runId: run.id, output: "" };',
    );
  });
});
