// Which model a call runs on, decided in one place.
//
// Every surface that calls a model (agent chat, swarm nodes, BI, the
// lakehouse's AI SQL, Ask over an ontology, the Sheets assistant, document
// reading, memory, generators…) may carry its own choice: an agent's model, a
// node's, a picker's, an admin's per-section setting. That choice wins. When
// there is none, or it cannot run for this user — its provider is unknown,
// not connected for them (no key of their own, none shared with them, no
// instance key), or their IAM model rules do not allow it — the call runs on
// the instance's DEFAULT MODEL, which an administrator sets under Admin →
// Developer runtime → AI services → Default model. It is not read from .env.
//
// The default is checked the same way: a default this user may not use is an
// error that says so, never a silent third choice. Every fallback is
// returned (`fellBack`) so the caller can record it in its trace.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { parseGatewayModel } from "@/utils/gateway/keys";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/providers";
import { getEffectiveModelRules } from "@/utils/iam.server";
import {
  loadCredentialRowShared,
  resolveOpenAICompatTransport,
  type OpenAICompatTransport,
} from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import type { ProviderId } from "@/utils/providers/types";
import { isModelAllowed } from "@/lib/iamRules";

/** Used only until an administrator sets the default. */
export const BUILTIN_DEFAULT_MODEL = "openrouter/google/gemini-2.5-flash";

export type ModelTarget = { provider: ProviderId; model: string };

export type InstanceDefault = ModelTarget & { spec: string; source: "admin" | "built-in" };

/** "openrouter/google/gemini-2.5-flash" → { provider: "openrouter", model: "google/gemini-2.5-flash" }. */
export function parseModelSpec(spec: string | null | undefined): ModelTarget | null {
  const t = parseGatewayModel((spec ?? "").trim(), GATEWAY_PROVIDERS);
  return t && t.kind === "model" ? { provider: t.provider as ProviderId, model: t.model } : null;
}

export function specOf(t: ModelTarget): string {
  return `${t.provider}/${t.model}`;
}

let cached: { at: number; spec: string | null } | null = null;
const CACHE_MS = 15_000;

/** Forget the cached setting (the admin just saved a new default). */
export function forgetDefaultModel(): void {
  cached = null;
}

/**
 * The administrator's default model spec, or null. Read on its own, not with
 * the other runtime settings: on a database whose migration has not added
 * the column yet, that read must not take every other setting down with it.
 */
export async function adminDefaultModelSpec(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.spec;
  const { data, error } = await supabaseAdmin
    .from("notebook_runtime_settings")
    .select("default_model")
    .eq("id", true)
    .maybeSingle();
  const row = (error ? null : data) as { default_model?: string | null } | null;
  const spec = row?.default_model?.trim() || null;
  cached = { at: Date.now(), spec };
  return spec;
}

/** The instance's default model: the administrator's, else the built-in one. */
export async function instanceDefaultModel(): Promise<InstanceDefault> {
  const admin = parseModelSpec(await adminDefaultModelSpec());
  if (admin) return { ...admin, spec: specOf(admin), source: "admin" };
  const builtIn = parseModelSpec(BUILTIN_DEFAULT_MODEL)!;
  return { ...builtIn, spec: BUILTIN_DEFAULT_MODEL, source: "built-in" };
}

export type Unavailable = {
  reason: "unknown_provider" | "not_configured" | "not_allowed";
  message: string;
};

/** The client IAM model rules are read with: the caller's own, or the service role. */
export type IamClient = Parameters<typeof getEffectiveModelRules>[0];

/** Why `t` cannot run for `userId`, or null when it can. */
export async function modelUnavailable(
  userId: string,
  t: ModelTarget,
  iamClient: IamClient = supabaseAdmin as unknown as IamClient,
): Promise<Unavailable | null> {
  if (!(GATEWAY_PROVIDERS as readonly string[]).includes(t.provider)) {
    return { reason: "unknown_provider", message: `"${t.provider}" is not a provider` };
  }
  const rules = await getEffectiveModelRules(iamClient, userId);
  if (rules && !isModelAllowed(rules, t.provider, t.model)) {
    return {
      reason: "not_allowed",
      message: `${specOf(t)} is not allowed for this account (Admin → IAM → Model access)`,
    };
  }
  const transport = await resolveOpenAICompatTransport({ userId, provider: t.provider }).catch(
    () => null,
  );
  if (transport && (transport.apiKey || t.provider === "ollama")) return null;
  if (await loadCredentialRowShared(userId, t.provider).catch(() => null)) return null;
  return {
    reason: "not_configured",
    message: `${t.provider} is not connected for this account (Integrations → LLM Providers)`,
  };
}

export type ChosenModel = ModelTarget & {
  spec: string;
  /** Where it came from: the caller's choice, or the instance default. */
  source: "requested" | "default";
  /** Set when a choice was made and could not be used. */
  fellBack: { from: string; reason: string } | null;
};

/**
 * A fallback an internal caller already made before calling /api/chat (AI in
 * SQL, document reading, the Sheets assistant resolve their model first), so
 * the trace the chat route writes still says it fell back. Anything that is
 * not that shape is nothing.
 */
export function fallbackFromCaller(v: unknown): ChosenModel["fellBack"] {
  if (!v || typeof v !== "object") return null;
  const { from, reason } = v as { from?: unknown; reason?: unknown };
  return typeof from === "string" && from && typeof reason === "string"
    ? { from: from.slice(0, 200), reason: reason.slice(0, 500) }
    : null;
}

export type ModelRequest = {
  /** A provider id; a bare model with no provider is an OpenRouter model, as it always was. */
  provider?: string | null;
  model?: string | null;
};

/**
 * The model this call runs on for `userId`: the request if it names a model
 * this user can run, else the instance default. A provider named without a
 * model is no choice. Refuses (with the reasons) only when the default cannot
 * run either.
 */
export async function chooseModel(
  userId: string,
  request: ModelRequest | null | undefined,
  opts: { iamClient?: IamClient } = {},
): Promise<({ ok: true } & ChosenModel) | { ok: false; status: number; error: string }> {
  const provider = request?.provider?.trim().toLowerCase() || null;
  const model = request?.model?.trim() || null;
  let tried: { spec: string; reason: string } | null = null;

  const attempt = async (t: ModelTarget, source: ChosenModel["source"]) => {
    const why = await modelUnavailable(userId, t, opts.iamClient);
    if (!why) return { ok: true as const, ...t, spec: specOf(t), source, fellBack: null };
    tried = { spec: specOf(t), reason: why.message };
    return null;
  };

  if (model) {
    // A model with no provider is an OpenRouter model id, as it has always
    // been ("openai/gpt-4o-mini" is OpenRouter's name for it, not the OpenAI
    // provider). A caller holding a full "provider/model" setting parses it
    // with parseModelSpec first.
    const t = { provider: (provider ?? "openrouter") as ProviderId, model };
    const ok = await attempt(t, "requested");
    if (ok) return ok;
  }

  const d = await instanceDefaultModel();
  const why = await modelUnavailable(userId, d, opts.iamClient);
  const first = tried as { spec: string; reason: string } | null;
  if (why) {
    const where =
      d.source === "admin"
        ? "Admin → Developer runtime → AI services → Default model"
        : "Admin → Developer runtime → AI services → Default model (none is set yet, so the built-in one was tried)";
    return {
      ok: false,
      status: why.reason === "not_allowed" ? 403 : 400,
      error:
        (first ? `${first.spec} can't be used: ${first.reason}. ` : "") +
        `The default model, ${d.spec}, can't be used either: ${why.message}. It is set under ${where}.`,
    };
  }
  return {
    ok: true,
    provider: d.provider,
    model: d.model,
    spec: d.spec,
    source: "default",
    fellBack: first ? { from: first.spec, reason: first.reason } : null,
  };
}

export type CompatTarget = {
  transport: OpenAICompatTransport;
  model: string;
  spec: string;
  fellBack: ChosenModel["fellBack"];
};

/**
 * The chosen model (see chooseModel) with the connection that reaches it, for
 * a caller that speaks OpenAI Chat Completions itself (memory, Q&A pairs): a
 * choice on a provider that does not is treated as no choice.
 */
export async function openAiCompatTarget(
  userId: string,
  request: ModelRequest | null,
): Promise<({ ok: true } & CompatTarget) | { ok: false; error: string }> {
  const compatible = !request?.provider || isBiCompatProvider(request.provider);
  const c = await chooseModel(userId, compatible ? request : null);
  if (!c.ok) return { ok: false, error: c.error };
  if (!isBiCompatProvider(c.provider)) {
    return {
      ok: false,
      error: `${c.spec} can't be used here (it needs an OpenAI-compatible provider). Change the default under Admin → Developer runtime → AI services → Default model.`,
    };
  }
  const transport = await resolveOpenAICompatTransport({ userId, provider: c.provider });
  if (!transport || (!transport.apiKey && c.provider !== "ollama")) {
    return { ok: false, error: `${c.provider} is not connected for this account.` };
  }
  return { ok: true, transport, model: c.model, spec: c.spec, fellBack: c.fellBack };
}

/**
 * A provider's error that means "no such model" (a retired id, a typo, a
 * model the account cannot reach): the one runtime failure a call retries on
 * the default model, since the choice simply is not available.
 */
export function isUnknownModelError(status: number, text: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /model[^.]{0,80}(not found|does not exist|not a valid|is not available|unknown|invalid|no endpoints|not supported)|(not a valid|unknown|invalid|unsupported) model|model_not_found|no endpoints found for/i.test(
    text,
  );
}
