// Server functions behind Data & BI -> Enterprise Ontology: actions.
//
// Requesting an action on an object, deciding a proposed one, and the log of
// every change. The rules live in src/utils/ontology/actions.server.ts, which
// the agent tool shares.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  emailsFor,
  isFail,
  loadOntology,
  ontologyLimits,
  resolveCaller,
  type Fail,
} from "@/utils/ontology/access.server";
import { decideAction, requestAction, type ActionOutcome } from "@/utils/ontology/actions.server";
import { plainCell, type Cell } from "@/utils/ontology/run.server";
import { isMasked, type CompileOpts } from "@/lib/ontology/compile";
import { findObjectType } from "@/lib/ontology/spec";

const token = z.string().min(1);
const id = z.string().uuid();
const scalar = z.union([z.string().max(4000), z.number(), z.boolean()]);

async function ctxFor(accessToken: string, ontologyId: string, need: "read" | "own") {
  const caller = await resolveCaller(accessToken);
  if (!caller.ok) return caller;
  const a = await loadOntology(caller.userId, ontologyId, need);
  if (isFail(a)) return a;
  const { maxRows } = await ontologyLimits();
  const opts: CompileOpts = {
    seeRestricted: a.role === "owner",
    maxRows,
    ...(a.policy ? { policy: a.policy } : {}),
  };
  return { userId: caller.userId, a, opts };
}

export const ontologyActionRequest = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        action: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        key: z.record(z.string().max(64), scalar).nullable(),
        params: z.record(z.string().max(64), z.union([scalar, z.null()])),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<ActionOutcome | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id, "read");
    if (isFail(ctx)) return ctx;
    return requestAction({
      userId: ctx.userId,
      access: ctx.a,
      opts: ctx.opts,
      actionName: data.action,
      key: data.key,
      params: data.params,
      via: "ui",
    });
  });

export const ontologyActionDecide = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        action_id: z.string().uuid(),
        approve: z.boolean(),
        note: z.string().max(2000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<ActionOutcome | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id, "own");
    if (isFail(ctx)) return ctx;
    return decideAction({
      userId: ctx.userId,
      access: ctx.a,
      actionId: data.action_id,
      approve: data.approve,
      note: data.note,
    });
  });

export type ActionLogRow = {
  id: string;
  action_name: string;
  object_type: string;
  object_key: Record<string, Cell> | null;
  params: Record<string, Cell>;
  before: Record<string, Cell> | null;
  after: Record<string, Cell> | null;
  status: "proposed" | "applied" | "rejected" | "failed";
  via: "ui" | "agent" | "api";
  requested_by_email: string | null;
  decided_by_email: string | null;
  decision_note: string | null;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  mine: boolean;
};

export const ontologyActionLog = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        access_token: token,
        id,
        status: z.enum(["proposed", "applied", "rejected", "failed"]).optional(),
        object_type: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true; actions: ActionLogRow[] } | Fail> => {
    const ctx = await ctxFor(data.access_token, data.id, "read");
    if (isFail(ctx)) return ctx;
    let q = supabaseAdmin
      .from("ontology_actions")
      .select(
        "id, action_name, object_type, object_key, params, before, after, status, via, requested_by, decided_by, decision_note, error, created_at, decided_at",
      )
      .eq("ontology_id", data.id)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status) q = q.eq("status", data.status);
    if (data.object_type) q = q.eq("object_type", data.object_type);
    // A grantee sees their own requests; the owner sees every one.
    if (ctx.a.role !== "owner") q = q.eq("requested_by", ctx.userId);
    const { data: rows, error } = await q;
    if (error) return { ok: false, error: error.message };
    const emailOf = await emailsFor((rows ?? []).flatMap((r) => [r.requested_by, r.decided_by]));
    const hide = (type: string, row: unknown): Record<string, Cell> | null => {
      if (!row || typeof row !== "object") return null;
      const t = findObjectType(ctx.a.spec, type);
      return Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([k, v]): [string, Cell] => {
          const cell = plainCell(v);
          try {
            return [k, t && isMasked(ctx.a.spec, t, k, ctx.opts) ? null : cell];
          } catch {
            return [k, cell];
          }
        }),
      );
    };
    return {
      ok: true,
      actions: (rows ?? []).map((r) => ({
        id: r.id,
        action_name: r.action_name,
        object_type: r.object_type,
        object_key: (r.object_key as Record<string, Cell> | null) ?? null,
        params: hide(r.object_type, r.params) ?? {},
        before: hide(r.object_type, r.before),
        after: hide(r.object_type, r.after),
        status: r.status as ActionLogRow["status"],
        via: r.via as ActionLogRow["via"],
        requested_by_email: r.requested_by ? (emailOf.get(r.requested_by) ?? null) : null,
        decided_by_email: r.decided_by ? (emailOf.get(r.decided_by) ?? null) : null,
        decision_note: r.decision_note,
        error: r.error,
        created_at: r.created_at,
        decided_at: r.decided_at,
        mine: r.requested_by === ctx.userId,
      })),
    };
  });
