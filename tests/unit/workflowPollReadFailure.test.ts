// A step whose status could not be read has not finished.
//
// FOUND IN R255, from the sweep-7 "destructive on a blip" row: "workflow steps
// fail and re-run". pollNode answered every failed status read with gone() -
// "the run it started is no longer there" - so the step finished FAILED, the
// workflow's retry started the target again while the first was still running,
// and a pending approval read as gone.
import { describe, expect, it, vi } from "vitest";

type Resp = { data: unknown; error: { message: string } | null };

const db = vi.hoisted(() => ({ read: { data: null, error: null } as Resp }));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () => Promise.resolve(db.read);
    return b;
  };
  return { supabaseAdmin: { from: () => chain() } };
});

const KINDS = [
  ["pipeline", "run-1"],
  ["sql_models", "build-1"],
  ["ml_schedule", "retrain:job-1"],
  ["notebook", "session-1"],
  ["sub_workflow", "wf-run-1"],
  ["approval", "approval:ap-1"],
] as const;

describe("pollNode", () => {
  it.each(KINDS)("keeps polling a %s step whose status could not be read", async (kind, ref) => {
    db.read = { data: null, error: { message: "connection reset" } };
    const { pollNode } = await import("@/utils/workflows/adapters.server");
    // Before R255: { done: true, ok: false, error: "The … it started is no longer there" }.
    expect(await pollNode({ userId: "u1", kind, targetRunId: ref })).toEqual({ done: false });
  });

  it.each(KINDS)("still fails a %s step whose target really is gone", async (kind, ref) => {
    db.read = { data: null, error: null };
    const { pollNode } = await import("@/utils/workflows/adapters.server");
    const out = await pollNode({ userId: "u1", kind, targetRunId: ref });
    expect(out).toMatchObject({ done: true, ok: false });
    expect((out as { error: string }).error).toMatch(/is no longer there/);
  });
});
