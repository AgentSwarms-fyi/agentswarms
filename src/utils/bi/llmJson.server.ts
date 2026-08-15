// "Ask a model for JSON, as user X" — the one implementation.
//
// This was the body of POST /api/bi, which is still its only interactive
// caller. It moved here when embedded AI Analysts arrived, because they need
// exactly this and cannot reach that endpoint: an anonymous embed visitor has
// no JWT to authenticate with, so the call is made on the analyst OWNER's
// credentials instead.
//
// Copying it would have been the easier change and the wrong one. What lives
// below is not a thin fetch — it is BYOK transport resolution, IAM model
// governance, a total (not per-attempt) deadline, one retry for the specific
// stochastic glitch that mangles a valid document, four distinct JSON-salvage
// passes, and a failure message that names which of three different faults
// actually occurred. A second copy would drift from this one silently, and
// the drift would show up as an embed that fails in ways the app does not.
//
// The caller supplies the userId and the supabase client used to read IAM
// rules; nothing here reads a session.
import { extractUsage, recordGatewayCall } from "@/utils/observability/recordGatewayUsage.server";
import { getEffectiveModelRules, isModelAllowed } from "@/utils/iam.server";
import {
  getProviderDefaultModel,
  resolveOpenAICompatTransport,
} from "@/utils/providers/credentials.server";
import { isBiCompatProvider } from "@/utils/providers/modelChoice";
import { describeJsonFault, repairJsonGlitches } from "@/utils/jsonFault";
import { isSlowReasoningModel, upstreamDeadlineMs } from "@/lib/llmDeadline";
import type { ProviderId } from "@/utils/providers/types";

const DEFAULT_MODEL = "google/gemini-2.5-flash";

/** Why retry at all: see the comment at the retry site below. */
const MAX_ATTEMPTS = 2;

export type LlmJsonServerResult =
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: string; raw?: string };

export type LlmJsonServerOpts = {
  /** Whose credentials, IAM rules and spend this call runs under. */
  userId: string;
  /** Client used to read IAM model rules — a user client or the service role. */
  iamClient: Parameters<typeof getEffectiveModelRules>[0];
  systemPrompt?: string;
  userPrompt: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** execution_traces.agent_name label. */
  surface: string;
  /** Meters the spend against something other than the user (e.g. an embed key). */
  costScope?: Parameters<typeof recordGatewayCall>[0]["costScope"];
};

export async function llmJsonServer(opts: LlmJsonServerOpts): Promise<LlmJsonServerResult> {
  const { userId, iamClient, costScope } = opts;
  const startedAt = Date.now();

  // Which of the caller's integrations executes the call. Defaults to
  // OpenRouter (the zero-config path with an operator env fallback).
  const provider = opts.provider || "openrouter";
  if (!isBiCompatProvider(provider)) {
    return { ok: false, status: 400, error: `Provider "${provider}" isn't available for BI.` };
  }

  // BYOK: the caller's own integration wins; for OpenRouter the operator's
  // shared env key is the zero-config fallback.
  const transport = await resolveOpenAICompatTransport({
    userId,
    provider: provider as ProviderId,
  });
  if (!transport || (!transport.apiKey && provider !== "ollama")) {
    return {
      ok: false,
      status: 503,
      error:
        `${provider} isn't configured. Connect it under Integrations` +
        (provider === "openrouter" ? " (or ask the operator to set OPENROUTER_API_KEY)." : "."),
    };
  }

  // Model precedence: explicit choice → the integration's default_model → the
  // operator's OPENROUTER_DEFAULT_MODEL → the instance default (OpenRouter
  // only). The env override matters on shared operator keys that only carry
  // credit for specific models.
  let model = opts.model || "";
  if (!model) model = (await getProviderDefaultModel(userId, provider as ProviderId)) ?? "";
  if (!model && provider === "openrouter") {
    model = process.env.OPENROUTER_DEFAULT_MODEL || DEFAULT_MODEL;
  }
  if (!model) {
    return {
      ok: false,
      status: 400,
      error:
        `Pick a model — your ${provider} integration has no default ` +
        "model set (Integrations → edit the connection).",
    };
  }

  // IAM model governance: same gate as /api/chat, against the executing
  // provider. It applies to embeds too — an administrator who disallowed a
  // model did not mean "except when a stranger asks".
  const rules = await getEffectiveModelRules(iamClient, userId);
  if (rules && !isModelAllowed(rules, provider, model)) {
    return {
      ok: false,
      status: 403,
      error: `Your administrator has not allowed the model ${provider}/${model}.`,
    };
  }
  const gatewayModelLabel = provider === "openrouter" ? model : `${provider}/${model}`;

  // Deadline on the upstream call — a hung provider must surface as a clear
  // error, not an infinite client spinner. Scaled by the completion budget AND
  // the model class; see src/lib/llmDeadline.ts.
  const completionCap = Math.min(
    typeof opts.maxTokens === "number" && opts.maxTokens > 0 ? opts.maxTokens : 0,
    16000,
  );
  const upstreamMs = upstreamDeadlineMs(completionCap, model);
  // A TOTAL budget across attempts, not a per-attempt one: a retry must never
  // push this past the client's own (slightly longer) deadline, or the client
  // aborts first and the specific server-side error never reaches anyone.
  const deadlineAt = startedAt + upstreamMs;

  // Carried out of the loop so the final response describes the LAST attempt
  // rather than degrading to a generic message.
  let lastCleaned = "";
  let lastUsage: ReturnType<typeof extractUsage> = null;
  // How many attempts were actually MADE. The budget check below can skip the
  // retry, and the failure message must not claim a retry that never ran.
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    const upstreamCtrl = new AbortController();
    const upstreamTimer = setTimeout(
      () => upstreamCtrl.abort(),
      Math.max(1_000, deadlineAt - Date.now()),
    );

    let r: Response;
    // Read inside the same try as the fetch: see the note on clearTimeout below.
    let payload = "";
    try {
      r = await fetch(transport.endpointUrl, {
        method: "POST",
        signal: upstreamCtrl.signal,
        headers: {
          "Content-Type": "application/json",
          ...(transport.apiKey ? { Authorization: `Bearer ${transport.apiKey}` } : {}),
          ...(transport.extraHeaders ?? {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                (opts.systemPrompt || "You are a helpful assistant.") +
                "\n\nYou MUST respond with a single valid JSON object. No prose, no markdown, no commentary.",
            },
            { role: "user", content: opts.userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: typeof opts.temperature === "number" ? opts.temperature : 0.1,
          // Larger structured outputs (e.g. a 20-slide deck plan) need a
          // higher completion cap or they truncate into invalid JSON.
          ...(completionCap > 0 ? { max_tokens: completionCap } : {}),
        }),
      });
      // Read the body here, still under the abort signal. fetch() resolves as
      // soon as the response HEADERS arrive, and a gateway sends those
      // immediately while the model is still generating — so the entire wait
      // happens during this read, not during fetch().
      payload = await r.text();
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // Record it. This path used to return without a trace, so a timed-out
        // run left no evidence anywhere — it simply vanished.
        void recordGatewayCall({
          userId,
          costScope,
          surface: opts.surface,
          model: gatewayModelLabel,
          promptText: opts.userPrompt,
          latencyMs: Date.now() - startedAt,
          status: "error",
          errorMessage: `Timed out after ${Math.round(upstreamMs / 1000)}s (max_tokens ${completionCap})`,
        });
        return {
          ok: false,
          status: 504,
          error:
            `${gatewayModelLabel} did not finish within ${Math.round(upstreamMs / 1000)}s. ` +
            (completionCap >= 12000
              ? "This is a large document plan — a faster model usually finishes it, or use Browser (Fast) mode."
              : isSlowReasoningModel(model)
                ? "Reasoning models spend most of that time thinking, and this one ran out " +
                  "of clock rather than failing. Ask again, or switch the analyst to a " +
                  "faster reasoning model — its Edit button is on the analyst card."
                : "Try again, or pick a different model."),
        };
      }
      throw e;
    } finally {
      // Cleared only now — after the body. Clearing it when fetch() resolved
      // disarmed the deadline at the exact moment the long wait began.
      clearTimeout(upstreamTimer);
    }

    if (!r.ok) {
      const errText = payload;
      void recordGatewayCall({
        userId,
        costScope,
        surface: opts.surface,
        model: gatewayModelLabel,
        promptText: opts.userPrompt,
        latencyMs: Date.now() - startedAt,
        status: "error",
        errorMessage: `Gateway ${r.status}: ${errText.slice(0, 200)}`,
      });
      // Name the model. This surface can run on a different model from the one
      // the caller thinks they picked, and a bare "credits exhausted" sends
      // people to check the wrong account.
      if (r.status === 429) {
        return {
          ok: false,
          status: 429,
          error: `Rate limited on ${gatewayModelLabel}. Please retry shortly.`,
        };
      }
      if (r.status === 402) {
        return {
          ok: false,
          status: 402,
          error:
            `No credits for ${gatewayModelLabel} on ${provider}. ` +
            "Add credit, or pick a model your account can use.",
        };
      }
      return {
        ok: false,
        status: r.status,
        error: `Gateway error ${r.status}: ${errText.slice(0, 200)}`,
      };
    }

    // Already read above, under the deadline — parse rather than re-read.
    let data: { choices?: Array<{ message?: { content?: string } }> };
    try {
      data = JSON.parse(payload || "{}");
    } catch {
      return {
        ok: false,
        status: 502,
        error: `${gatewayModelLabel} returned a malformed response body.`,
      };
    }
    const text = data.choices?.[0]?.message?.content ?? "{}";
    const usage = extractUsage(data);

    void recordGatewayCall({
      userId,
      costScope,
      surface: opts.surface,
      model: gatewayModelLabel,
      promptText: opts.userPrompt,
      responseText: text,
      tokensIn: usage?.tokensIn,
      tokensOut: usage?.tokensOut,
      latencyMs: Date.now() - startedAt,
      status: "success",
      responsePreview: text.slice(0, 800),
    });

    // The gateway with response_format: json_object should return clean JSON,
    // but be defensive: models that ignore the flag wrap it in a fence, prefix
    // it with prose, or both.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const cleaned = (fenced ? fenced[1] : text).trim();
    const candidates = [cleaned];
    // Object or array — a plan is an object, but some stages legitimately
    // return an array, and the old regex only ever looked for {...}.
    for (const re of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
      const m = cleaned.match(re);
      if (m) candidates.push(m[0]);
    }
    // Keep the FIRST failure: candidates[0] is the fence-stripped payload,
    // which is the one the model actually meant to send. The later
    // brace/bracket slices are salvage attempts, and their errors describe the
    // salvage, not the real fault.
    let firstErr: unknown;
    for (const c of candidates) {
      try {
        return { ok: true, result: JSON.parse(c) };
      } catch (e) {
        if (firstErr === undefined) firstErr = e;
      }
    }
    // Strict parsing failed. Before spending another 50 seconds and another 7k
    // tokens on a retry, try the one repair that is known to apply here — and
    // record it, because a repair that happens silently hides an upstream
    // defect that will otherwise never get fixed.
    const repaired = repairJsonGlitches(cleaned);
    if (repaired !== null) {
      try {
        const result = JSON.parse(repaired);
        void recordGatewayCall({
          userId,
          costScope,
          surface: opts.surface,
          model: gatewayModelLabel,
          promptText: opts.userPrompt,
          latencyMs: Date.now() - startedAt,
          status: "success",
          errorMessage:
            `Repaired a duplicated JSON key from ${gatewayModelLabel} ` +
            `(attempt ${attempt}/${MAX_ATTEMPTS}). ${describeJsonFault(cleaned, firstErr)}`,
        });
        return { ok: true, result };
      } catch {
        /* the repair did not produce valid JSON either — fall through */
      }
    }

    lastCleaned = cleaned;
    lastUsage = usage;

    // Record WHY, pointing AT the fault: a truncated response looks completely
    // different from a prose preamble, and the trace previously said "success"
    // with no hint that parsing had failed afterwards.
    void recordGatewayCall({
      userId,
      costScope,
      surface: opts.surface,
      model: gatewayModelLabel,
      promptText: opts.userPrompt,
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorMessage:
        `Unparseable JSON (attempt ${attempt}/${MAX_ATTEMPTS}, ${text.length} chars, ` +
        `${usage?.tokensOut ?? "?"} tokens out${fenced ? ", fenced" : ""}). ` +
        describeJsonFault(cleaned, firstErr),
    });

    // Retry only if a second attempt of comparable length still fits the total
    // budget. Starting one with barely any clock left just burns the caller's
    // tokens and then times out, which is strictly worse than returning the
    // (now specific) error while there's time to show it.
    //
    // Why retry at all: a malformed-JSON reply here is a STOCHASTIC model
    // glitch, not a deterministic fault. Measured on this endpoint, ~1 in 6 of
    // these document plans came back as a complete, well-formed-looking
    // document containing a single stuttered token — `"type": "type": "table"`
    // — at some random offset.
    const spent = Date.now() - startedAt;
    if (attempt < MAX_ATTEMPTS && spent * 2 + 5_000 <= upstreamMs) continue;
    break;
  }

  // Name the RIGHT failure. An earlier message asserted "the model ignored the
  // JSON-only instruction" whenever tokensOut sat below the cap — and `usage`
  // is often absent, so `?? 0` quietly made every failure look like that one.
  // These are three different problems with three fixes.
  const truncated =
    completionCap > 0 && lastUsage != null && lastUsage.tokensOut >= completionCap - 8;
  const looksComplete = /^[[{]/.test(lastCleaned) && /[\]}]$/.test(lastCleaned);
  return {
    ok: false,
    status: 502,
    error:
      `${gatewayModelLabel} did not return valid JSON. ` +
      (truncated
        ? "It hit the output limit mid-document — try Browser (Fast) mode or a model with a larger output budget."
        : looksComplete
          ? "It returned a complete document whose JSON is malformed inside — a stray token in a long field. " +
            (attemptsMade > 1
              ? "Retrying it once failed the same way; a larger model normally gets this right."
              : "There wasn't time in the budget to retry — try again, or use Browser (Fast) mode.")
          : "The reply wasn't JSON at all — the model ignored the JSON-only instruction; a different model normally fixes it."),
    raw: lastCleaned.slice(0, 400),
  };
}
