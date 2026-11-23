// Tutorials (R529): start one, follow it from page to page, put it away.
//
// Progress is never written by the browser. The page says which tutorial; the
// server reads what the caller made since starting it and works out which
// steps are done (src/lib/tutorialChecks.ts). The one thing it records on its
// own is finished_at, the first time every step is seen done.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TutorialProgress } from "@/lib/tutorialChecks";
import {
  activeTutorialRun,
  isTutorialId,
  TUTORIAL_IDS,
  type TutorialId,
  type TutorialRun,
} from "@/lib/tutorials";

/** Applied by the operator; until then the Learn page says this and nothing breaks. */
export const TUTORIALS_MIGRATION = "20261126000000";

const NOT_READY = `Tutorials need a database update first (migration ${TUTORIALS_MIGRATION}). Every other page works as before.`;

/** The run table is missing: the migration has not been applied. */
function tableMissing(message: string): boolean {
  return (
    /tutorial_runs/.test(message) && /(does not exist|schema cache|could not find)/i.test(message)
  );
}

export type TutorialState = {
  run: TutorialRun;
  progress: TutorialProgress | null;
  /** Why the steps could not be worked out just now. */
  error?: string;
};

export type LearnState =
  | { ready: false; message: string }
  | {
      ready: true;
      /** Every tutorial this person started, with its steps. */
      started: Partial<Record<TutorialId, TutorialState>>;
      needs: { model: boolean; lakehouse: boolean };
    };

export type GuideState =
  { ready: false } | { ready: true; active: (TutorialState & { id: TutorialId }) | null };

type Ctx = {
  supabase: import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >;
  userId: string;
};

async function loadRuns(ctx: Ctx): Promise<TutorialRun[] | "missing"> {
  const { data, error } = await ctx.supabase
    .from("tutorial_runs")
    .select("tutorial_id, started_at, finished_at, hidden")
    .eq("user_id", ctx.userId);
  if (error) {
    if (tableMissing(error.message)) return "missing";
    throw new Error(error.message);
  }
  return data ?? [];
}

async function stateOf(
  ctx: Ctx,
  run: TutorialRun & { tutorial_id: TutorialId },
): Promise<TutorialState> {
  try {
    const { loadTutorialRows } = await import("@/utils/tutorials/progress.server");
    const { tutorialProgress } = await import("@/lib/tutorialChecks");
    const progress = tutorialProgress(
      await loadTutorialRows(ctx.supabase, ctx.userId, run.tutorial_id, run.started_at),
    );
    let finished = run.finished_at;
    if (!finished && progress.done.every(Boolean)) {
      finished = new Date().toISOString();
      // Only the first time: a later look must not move the day it was done.
      await ctx.supabase
        .from("tutorial_runs")
        .update({ finished_at: finished })
        .eq("user_id", ctx.userId)
        .eq("tutorial_id", run.tutorial_id)
        .is("finished_at", null);
    }
    return { run: { ...run, finished_at: finished }, progress };
  } catch (e) {
    return {
      run,
      progress: null,
      error: e instanceof Error ? e.message : "The steps could not be checked.",
    };
  }
}

const isKnown = (r: TutorialRun): r is TutorialRun & { tutorial_id: TutorialId } =>
  isTutorialId(r.tutorial_id);

/** The Learn page: every tutorial started, its steps, and what the tutorials need. */
export const learnState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(() => ({}))
  .handler(async ({ context }): Promise<LearnState> => {
    const ctx = context as Ctx;
    const runs = await loadRuns(ctx);
    if (runs === "missing") return { ready: false, message: NOT_READY };
    const { hasModelAccess } = await import("@/utils/tutorials/progress.server");
    const { lakehouseEnabled } = await import("@/utils/lakehouse/core.server");
    const known = runs.filter(isKnown);
    const [states, model] = await Promise.all([
      Promise.all(known.map((r) => stateOf(ctx, r))),
      hasModelAccess(ctx.supabase, ctx.userId),
    ]);
    const started: Partial<Record<TutorialId, TutorialState>> = {};
    known.forEach((r, i) => (started[r.tutorial_id] = states[i]));
    return { ready: true, started, needs: { model, lakehouse: lakehouseEnabled() } };
  });

/**
 * The guide on every page: the tutorial being followed, if any. Asked on
 * every page change, so it answers "none" with one read, and "not set up"
 * without an error.
 */
export const tutorialGuideState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(() => ({}))
  .handler(async ({ context }): Promise<GuideState> => {
    const ctx = context as Ctx;
    const runs = await loadRuns(ctx);
    if (runs === "missing") return { ready: false };
    const run = activeTutorialRun(runs);
    if (!run || !isKnown(run)) return { ready: true, active: null };
    return { ready: true, active: { id: run.tutorial_id, ...(await stateOf(ctx, run)) } };
  });

const IdInput = z.object({ id: z.enum(TUTORIAL_IDS) });

type Done = { ok: true } | { ok: false; error: string };

function failed(message: string): Done {
  return { ok: false, error: tableMissing(message) ? NOT_READY : message };
}

/** The guide follows one tutorial: the others it was following are put away. */
async function followOnly(ctx: Ctx, id: TutorialId): Promise<string | null> {
  const { error } = await ctx.supabase
    .from("tutorial_runs")
    .update({ hidden: true })
    .eq("user_id", ctx.userId)
    .neq("tutorial_id", id)
    .eq("hidden", false);
  return error ? error.message : null;
}

/**
 * Start a tutorial, or start it again: what counts as done is measured from
 * now, so things made before do not tick it.
 */
export const startTutorial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => IdInput.parse(input))
  .handler(async ({ context, data }): Promise<Done> => {
    const ctx = context as Ctx;
    const { error } = await ctx.supabase.from("tutorial_runs").upsert(
      {
        user_id: ctx.userId,
        tutorial_id: data.id,
        started_at: new Date().toISOString(),
        finished_at: null,
        hidden: false,
      },
      { onConflict: "user_id,tutorial_id" },
    );
    if (error) return failed(error.message);
    const other = await followOnly(ctx, data.id);
    return other ? failed(other) : { ok: true };
  });

/** Bring a started tutorial's guide back, keeping its start and its ticks. */
export const resumeTutorial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => IdInput.parse(input))
  .handler(async ({ context, data }): Promise<Done> => {
    const ctx = context as Ctx;
    const { error } = await ctx.supabase
      .from("tutorial_runs")
      .update({ hidden: false })
      .eq("user_id", ctx.userId)
      .eq("tutorial_id", data.id);
    if (error) return failed(error.message);
    const other = await followOnly(ctx, data.id);
    return other ? failed(other) : { ok: true };
  });

/** Put the guide away. The tutorial stays on Learn, where it can be resumed. */
export const hideTutorial = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => IdInput.parse(input))
  .handler(async ({ context, data }): Promise<Done> => {
    const ctx = context as Ctx;
    const { error } = await ctx.supabase
      .from("tutorial_runs")
      .update({ hidden: true })
      .eq("user_id", ctx.userId)
      .eq("tutorial_id", data.id);
    return error ? failed(error.message) : { ok: true };
  });
