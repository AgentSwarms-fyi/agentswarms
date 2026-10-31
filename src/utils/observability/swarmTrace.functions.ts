// Server functions that record an in-page (canvas) swarm run, for the browser
// tracer (observability/tracer.ts) and the Cancel buttons. Each authenticates
// the caller and hands their id to swarmTraceStore.server.ts, which holds every
// rule (R421, VA-2026-10-25-31): a browser can read its runs but no longer
// write them, so these are its only way to record one.
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  cancelRun,
  cancelRunSchema,
  finishRun,
  finishRunSchema,
  finishStep,
  finishStepSchema,
  recordEdge,
  recordEdgeSchema,
  startRun,
  startRunSchema,
  startStep,
  startStepSchema,
} from "@/utils/observability/swarmTraceStore.server";

export const startSwarmRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => startRunSchema.parse(data))
  .handler(({ data, context }) => startRun(context.userId, data));

export const startSwarmStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => startStepSchema.parse(data))
  .handler(({ data, context }) => startStep(context.userId, data));

export const finishSwarmStep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => finishStepSchema.parse(data))
  .handler(({ data, context }) => finishStep(context.userId, data));

export const recordSwarmEdge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => recordEdgeSchema.parse(data))
  .handler(({ data, context }) => recordEdge(context.userId, data));

export const finishSwarmRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => finishRunSchema.parse(data))
  .handler(({ data, context }) => finishRun(context.userId, data));

export const cancelSwarmRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => cancelRunSchema.parse(data))
  .handler(({ data, context }) => cancelRun(context.userId, data));
