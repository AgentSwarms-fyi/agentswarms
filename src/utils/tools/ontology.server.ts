// The `ontology_query` agent tool: Agent Chat and swarms, reading and acting
// through an Enterprise Ontology.
//
// DENY BY DEFAULT, like metric_query: an agent reads only the ontologies named
// in its configuration, and the tool is not registered when it names none.
// The catalog of each (types, properties, links, metrics, the words people use
// for them) goes into the tool description, so the model plans in business
// names and never writes SQL; the plan is compiled by src/lib/ontology/compile
// and run as the CALLER — on a headless run, the agent's owner — through the
// governed lakehouse path, with the caller's share restrictions applied
// exactly as on the page. Answers carry the same trust envelope as the Ask tab.
//
// Actions: an agent may request one only when the action type allows agents;
// "propose" (the default for new types) records it for a person to approve.
import type { AgentToolContext, ToolDef } from "@/utils/tools/registry.server";
import {
  isFail,
  loadOntology,
  ontologyLimits,
  type OntologyAccess,
} from "@/utils/ontology/access.server";
import { runPlan } from "@/utils/ontology/ask.server";
import { requestAction } from "@/utils/ontology/actions.server";
import { runRows } from "@/utils/ontology/run.server";
import { aiCatalog, askPlanSchema } from "@/lib/ontology/catalog";
import {
  compileGetObject,
  CompileError,
  type CompileOpts,
  type Scalar,
} from "@/lib/ontology/compile";
import { findObjectType } from "@/lib/ontology/spec";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveGrantedResourceIds } from "@/utils/iam.server";

export const ontologyQueryTool: ToolDef = {
  type: "function",
  function: {
    name: "ontology_query",
    description:
      "Answer questions about the business through an Enterprise Ontology: its object types (Customer, Order…), " +
      "their properties, the links between them and their governed metrics. Operations:\n" +
      '- op "metric": {"objectType","metric","groupBy":[{"property","path":[{"link","direction"}],"grain"}],"filters":[{"property","op","value"}],"order","limit"} — totals, counts, averages. Prefer CERTIFIED metrics. Group only through links marked "at most one".\n' +
      '- op "objects": {"objectType","filters","search","path","targetFilters","properties","orderBy","limit"} — lists of objects; "path" walks links from the filtered set (the customers of these orders).\n' +
      '- op "object": {"objectType","key":{…}} — one object and its properties.\n' +
      '- op "action": {"action","key":{…},"params":{…}} — request a change through an action type the catalog lists for agents; it may wait for a person to approve.\n' +
      "Use names exactly as in the catalog. If the ontology cannot answer, say so instead of guessing.",
    parameters: {
      type: "object",
      properties: {
        ontology: { type: "string", description: "The ontology's name, from the catalog." },
        op: { type: "string", enum: ["metric", "objects", "object", "action"] },
        query: { type: "object", description: "For metric / objects: the query, as above." },
        objectType: { type: "string", description: "For object: the type." },
        key: { type: "object", description: "For object / action: the object's key properties." },
        action: { type: "string", description: "For action: the action type's name." },
        params: { type: "object", description: "For action: the parameters." },
        explanation: {
          type: "string",
          description: "One sentence: what you are computing, in business words.",
        },
      },
      required: ["ontology", "op"],
    },
  },
};

type Loaded = { id: string; name: string; access: OntologyAccess; opts: CompileOpts };

/** The ontologies `names` resolves to for this caller: their own, or shared and published. */
async function loadAllowed(ctx: AgentToolContext, names: string[]): Promise<Loaded[]> {
  if (!names.length) return [];
  const userId = ctx.scopeUserId ?? ctx.userId;
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const granted = [...(await resolveGrantedResourceIds(supabaseAdmin, userId, "ontology"))];
  const { data: own } = await supabaseAdmin
    .from("ontologies")
    .select("id, name")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  const { data: shared } = granted.length
    ? await supabaseAdmin.from("ontologies").select("id, name").in("id", granted)
    : { data: [] as { id: string; name: string }[] };
  const candidates = [...(own ?? []), ...(shared ?? [])].filter((o) =>
    wanted.has(o.name.toLowerCase()),
  );
  const { maxRows } = await ontologyLimits();
  const out: Loaded[] = [];
  // One ontology per name: the caller's own before one shared with them, the
  // most recently edited first. Names are unique per owner (ontologyCreate),
  // but a share can carry a name the caller also uses.
  for (const o of candidates) {
    if (out.some((x) => x.id === o.id || x.name.toLowerCase() === o.name.toLowerCase())) continue;
    const access = await loadOntology(userId, o.id, "read");
    if (isFail(access)) continue;
    out.push({
      id: o.id,
      name: o.name,
      access,
      opts: {
        seeRestricted: access.role === "owner",
        maxRows: Math.min(maxRows, 500),
        ...(access.policy ? { policy: access.policy } : {}),
      },
    });
  }
  return out;
}

export async function ontologyCatalogForCtx(
  ctx: AgentToolContext,
  names: string[],
): Promise<{ count: number; text: string }> {
  const loaded = await loadAllowed(ctx, names);
  const parts = loaded.map((l) => {
    const cat = aiCatalog(l.access.spec, l.opts);
    const actions = l.access.spec.actionTypes
      .filter((a) => a.agentMode !== "none")
      .map(
        (a) =>
          `  ! action ${a.name} on ${a.objectType} (${a.kind}; params: ${a.parameters.map((p) => p.name).join(", ") || "none"})${a.agentMode === "propose" || a.requiresApproval ? " — a person approves it" : ""}`,
      );
    const text = [cat, ...actions].join("\n");
    return `=== ONTOLOGY "${l.name}" ===\n${text.length > 12_000 ? `${text.slice(0, 12_000)}\n…(catalog truncated)` : text}`;
  });
  return { count: loaded.length, text: parts.join("\n\n") };
}

export async function runOntologyTool(
  ctx: AgentToolContext,
  args: Record<string, unknown>,
  allowedNames: string[],
): Promise<string> {
  const name = String(args.ontology ?? "").trim();
  if (!allowedNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())) {
    return JSON.stringify({ error: `This agent may not read the ontology "${name}"` });
  }
  const [l] = await loadAllowed(ctx, [name]);
  if (!l) return JSON.stringify({ error: `No ontology called "${name}" is available to you` });
  const userId = ctx.scopeUserId ?? ctx.userId;
  const op = String(args.op ?? "");
  try {
    if (op === "metric" || op === "objects") {
      const plan = askPlanSchema.safeParse({
        kind: op,
        explanation: String(args.explanation ?? "").slice(0, 500) || `${op} query`,
        query: args.query,
      });
      if (!plan.success || plan.data.kind === "refuse") {
        return JSON.stringify({
          error: `The query is not valid: ${plan.success ? "refused" : plan.error.issues[0]?.message}`,
        });
      }
      const ans = await runPlan(userId, l.access, l.opts, plan.data, {
        verified: null,
        model: null,
      });
      return JSON.stringify({
        explanation: ans.explanation,
        columns: ans.columns.map((c) => ({ key: c.key, type: c.objectType, masked: c.masked })),
        rows: ans.rows.slice(0, 200),
        total: ans.total,
        trust: ans.trust,
      });
    }
    if (op === "object") {
      const t = findObjectType(l.access.spec, String(args.objectType ?? ""));
      if (!t) return JSON.stringify({ error: `Unknown object type ${String(args.objectType)}` });
      const c = compileGetObject(
        l.access.spec,
        t.name,
        (args.key ?? {}) as Record<string, Scalar>,
        l.opts,
      );
      const r = await runRows(userId, c.sql, c.columns, { rowCap: 2, via: "ontology:agent" });
      if (!r.rows.length)
        return JSON.stringify({ error: `No ${t.name} with that key is visible to you` });
      return JSON.stringify({ objectType: t.name, object: r.rows[0] });
    }
    if (op === "action") {
      const out = await requestAction({
        userId,
        access: l.access,
        opts: l.opts,
        actionName: String(args.action ?? ""),
        key: (args.key ?? null) as Record<string, Scalar> | null,
        params: (args.params ?? {}) as Record<string, Scalar | null>,
        via: "agent",
      });
      if (!out.ok) return JSON.stringify({ error: out.error });
      return JSON.stringify(
        out.status === "proposed"
          ? {
              status: "proposed",
              action_id: out.action_id,
              note: "Waiting for a person to approve it.",
            }
          : { status: "applied", action_id: out.action_id, before: out.before, after: out.after },
      );
    }
    return JSON.stringify({ error: `Unknown op "${op}"` });
  } catch (e) {
    return JSON.stringify({
      error: e instanceof CompileError ? e.message : (e as Error).message.slice(0, 500),
    });
  }
}
