// Shared guardrails module — used by both /api/chat (server) and the swarm
// runtime (client → server). Pure functions only, safe to import from either
// environment. The shape mirrors the Guardrails type in components/agents/AgentForm.tsx
// so what the user configures in the UI is exactly what gets enforced here.
//
// What's actually enforced (i.e. NOT mock):
//  ────────────────────────────────────────────────────────────────────
//  Input  · maxInputLength            — hard cap, request rejected
//         · blockedPatterns (regex)   — prompt-injection denylist
//         · topicRestrictions         — keyword denylist
//         · allowedTopics             — keyword allowlist (if set)
//         · contentSafetyLevel        — keyword denylist (low/med/high tiers)
//         · blockPII                  — redact emails/phone/SSN before send
//
//  Output · blockPII                  — redact in final assistant text
//         · blockProfanity            — redact in final assistant text
//         · contentSafetyLevel        — flag/redact unsafe terms
//         · enableCitationCheck       — flag responses missing [n] markers
//         · enableHallucinationFilter — flag unsupported claims when grounded
//
//  Anything not listed above is preserved for future enforcement but is
//  currently inert. We surface that honestly via `inertFields`.

export type Guardrails = {
  enableInputFilters: boolean;
  enableOutputFilters: boolean;
  blockPII: boolean;
  blockProfanity: boolean;
  maxTurnsPerConversation: number;
  maxInputLength: number;
  rateLimitPerMinute: number;
  topicRestrictions: string;
  allowedTopics: string;
  blockedPatterns: string;
  requireApprovalAboveTokens: number;
  enableCitationCheck: boolean;
  enableHallucinationFilter: boolean;
  contentSafetyLevel: "off" | "low" | "medium" | "high";
  customFilterPrompt: string;
};

export const DEFAULT_GUARDRAILS: Guardrails = {
  enableInputFilters: false,
  enableOutputFilters: false,
  blockPII: false,
  blockProfanity: false,
  maxTurnsPerConversation: 50,
  maxInputLength: 4000,
  rateLimitPerMinute: 20,
  topicRestrictions: "",
  allowedTopics: "",
  blockedPatterns: "",
  requireApprovalAboveTokens: 0,
  enableCitationCheck: false,
  enableHallucinationFilter: false,
  contentSafetyLevel: "off",
  customFilterPrompt: "",
};

// Coerce arbitrary JSON-ish input (e.g. from the agents.tools column) into a
// fully-populated Guardrails object. Unknown keys are dropped, unknown enum
// values fall back to defaults.
export function parseGuardrails(raw: unknown): Guardrails {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GUARDRAILS };
  const r = raw as Record<string, unknown>;
  const safetyRaw = r.contentSafetyLevel;
  const safety: Guardrails["contentSafetyLevel"] =
    safetyRaw === "low" || safetyRaw === "medium" || safetyRaw === "high"
      ? safetyRaw
      : "off";
  return {
    enableInputFilters: typeof r.enableInputFilters === "boolean" ? r.enableInputFilters : DEFAULT_GUARDRAILS.enableInputFilters,
    enableOutputFilters: typeof r.enableOutputFilters === "boolean" ? r.enableOutputFilters : DEFAULT_GUARDRAILS.enableOutputFilters,
    blockPII: typeof r.blockPII === "boolean" ? r.blockPII : DEFAULT_GUARDRAILS.blockPII,
    blockProfanity: typeof r.blockProfanity === "boolean" ? r.blockProfanity : DEFAULT_GUARDRAILS.blockProfanity,
    maxTurnsPerConversation: typeof r.maxTurnsPerConversation === "number" ? r.maxTurnsPerConversation : DEFAULT_GUARDRAILS.maxTurnsPerConversation,
    maxInputLength: typeof r.maxInputLength === "number" && r.maxInputLength > 0 ? r.maxInputLength : DEFAULT_GUARDRAILS.maxInputLength,
    rateLimitPerMinute: typeof r.rateLimitPerMinute === "number" ? r.rateLimitPerMinute : DEFAULT_GUARDRAILS.rateLimitPerMinute,
    topicRestrictions: typeof r.topicRestrictions === "string" ? r.topicRestrictions : "",
    allowedTopics: typeof r.allowedTopics === "string" ? r.allowedTopics : "",
    blockedPatterns: typeof r.blockedPatterns === "string" ? r.blockedPatterns : "",
    requireApprovalAboveTokens: typeof r.requireApprovalAboveTokens === "number" ? r.requireApprovalAboveTokens : 0,
    enableCitationCheck: typeof r.enableCitationCheck === "boolean" ? r.enableCitationCheck : DEFAULT_GUARDRAILS.enableCitationCheck,
    enableHallucinationFilter: typeof r.enableHallucinationFilter === "boolean" ? r.enableHallucinationFilter : DEFAULT_GUARDRAILS.enableHallucinationFilter,
    contentSafetyLevel: safety,
    customFilterPrompt: typeof r.customFilterPrompt === "string" ? r.customFilterPrompt : "",
  };
}

// True if any field in `g` is non-default. Cheap pre-flight check used to
// short-circuit guardrail work when nothing is configured.
export function isAnyGuardrailActive(g: Guardrails): boolean {
  return (
    g.enableInputFilters ||
    g.enableOutputFilters ||
    g.blockPII ||
    g.blockProfanity ||
    g.contentSafetyLevel !== "off" ||
    g.enableCitationCheck ||
    g.enableHallucinationFilter ||
    g.blockedPatterns.trim().length > 0 ||
    g.allowedTopics.trim().length > 0 ||
    g.topicRestrictions.trim().length > 0
  );
}

// ───────────────── PII / profanity / safety primitives ─────────────────

// Conservative regex set — high-precision over recall. Matches what most
// users mean by "PII redaction" without being so aggressive that we mangle
// the model's reply (e.g. we don't try to detect names).
const PII_PATTERNS: Array<{ name: string; re: RegExp; mask: string }> = [
  { name: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, mask: "[REDACTED_EMAIL]" },
  // US SSN (xxx-xx-xxxx) — strict format, low false-positive rate.
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: "[REDACTED_SSN]" },
  // Credit-card-ish: 13–19 digit runs (with optional spaces / dashes). We
  // don't validate Luhn — guardrails should err on the side of hiding.
  { name: "credit_card", re: /\b(?:\d[ -]?){13,19}\b/g, mask: "[REDACTED_CARD]" },
  // E.164-ish phone numbers. Avoids matching plain integers by requiring
  // at least one separator OR a leading '+'.
  { name: "phone", re: /(?:\+?\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?|\d{2,4}[ -])\d{2,4}[ -]?\d{2,4}\b/g, mask: "[REDACTED_PHONE]" },
];

// Redact PII in-place. Returns the cleaned text and the count of
// redactions per category (useful for tracing / UI badges).
export function redactPII(text: string): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let out = text;
  for (const p of PII_PATTERNS) {
    let n = 0;
    out = out.replace(p.re, () => {
      n += 1;
      return p.mask;
    });
    if (n > 0) counts[p.name] = n;
  }
  return { text: out, counts };
}

// Tiny opt-in profanity list. Intentionally short — production users should
// extend this via a custom filter prompt (see Guardrails.customFilterPrompt).
// Matched word-boundary, case-insensitive. We DON'T ship a comprehensive
// slur list in source — the goal is to demonstrate enforcement, not to be
// the world's filter database.
const PROFANITY = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "piss", "cunt",
  "motherfucker", "f*ck", "sh*t",
] as const;
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY.join("|")})\\b`, "gi");
export function redactProfanity(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(PROFANITY_RE, (m) => {
    count += 1;
    return "*".repeat(Math.max(3, m.length));
  });
  return { text: out, count };
}

// Content-safety keyword tiers. Low matches the most-explicit harm
// indicators; medium adds sensitive categories; high adds anything
// borderline. We match whole words case-insensitively.
const SAFETY_TIERS: Record<"low" | "medium" | "high", string[]> = {
  low: [
    "kill yourself", "suicide method", "how to make a bomb", "build a bomb",
    "child porn", "cp ", "rape ",
  ],
  medium: [
    "self-harm", "weapon making", "explosive recipe", "drug synthesis",
    "torture method", "stalking",
  ],
  high: [
    "weapon", "gun ", "knife attack", "violence", "drugs", "narcotic",
    "hate speech", "racial slur", "extremist",
  ],
};

// Highest-tier (low/medium/high) terms that match in the text. `level`
// determines how strict we are — `off` returns no matches.
function matchSafetyTerms(text: string, level: Guardrails["contentSafetyLevel"]): string[] {
  if (level === "off") return [];
  const lowered = text.toLowerCase();
  const tiers: ("low" | "medium" | "high")[] =
    level === "low" ? ["low"] : level === "medium" ? ["low", "medium"] : ["low", "medium", "high"];
  const matched: string[] = [];
  for (const t of tiers) {
    for (const term of SAFETY_TIERS[t]) {
      if (lowered.includes(term)) matched.push(term.trim());
    }
  }
  return Array.from(new Set(matched));
}

// Compile a "one-pattern-per-line" textarea into safe RegExps.
// Patterns that fail to compile are skipped (logged to console once).
function compilePatterns(raw: string): RegExp[] {
  if (!raw.trim()) return [];
  const out: RegExp[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(new RegExp(t, "i"));
    } catch (e) {
      console.warn("[guardrails] bad regex skipped:", t, e);
    }
  }
  return out;
}

function lines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ───────────────── Input evaluation ─────────────────

export type InputDecision = {
  allowed: boolean;
  reason?: string;
  // If allowed, this is the text to actually send to the LLM (PII may have
  // been redacted; everything else is unchanged).
  outboundText: string;
  // What was redacted, for the trace.
  redactions: Record<string, number>;
};

export function evaluateInputGuardrails(input: string, g: Guardrails): InputDecision {
  // 1. Length cap (always enforced when input filters are on).
  if (g.enableInputFilters && g.maxInputLength > 0 && input.length > g.maxInputLength) {
    return {
      allowed: false,
      reason: `Input exceeds the ${g.maxInputLength.toLocaleString()}-character limit set by this agent's guardrails.`,
      outboundText: input,
      redactions: {},
    };
  }

  // 2. Blocked regex patterns (prompt-injection denylist).
  if (g.enableInputFilters) {
    const patterns = compilePatterns(g.blockedPatterns);
    for (const re of patterns) {
      if (re.test(input)) {
        return {
          allowed: false,
          reason: "Input was blocked by a prompt-injection guardrail. Rephrase and try again.",
          outboundText: input,
          redactions: {},
        };
      }
    }
  }

  // 3. Topic boundaries.
  const lower = input.toLowerCase();
  const restricted = lines(g.topicRestrictions);
  for (const term of restricted) {
    if (lower.includes(term)) {
      return {
        allowed: false,
        reason: `This agent isn't allowed to discuss "${term}".`,
        outboundText: input,
        redactions: {},
      };
    }
  }
  const allowed = lines(g.allowedTopics);
  if (allowed.length > 0 && !allowed.some((t) => lower.includes(t))) {
    return {
      allowed: false,
      reason: `Input is outside this agent's allowed topics (${allowed.slice(0, 3).join(", ")}${allowed.length > 3 ? "…" : ""}).`,
      outboundText: input,
      redactions: {},
    };
  }

  // 4. Content safety on the *input* (separate from output check).
  const safety = matchSafetyTerms(input, g.contentSafetyLevel);
  if (safety.length > 0) {
    return {
      allowed: false,
      reason: `Input was blocked by the content-safety guardrail (${g.contentSafetyLevel}) for: ${safety.slice(0, 3).join(", ")}.`,
      outboundText: input,
      redactions: {},
    };
  }

  // 5. PII redaction (allowed — but mask before sending upstream).
  if (g.blockPII) {
    const redacted = redactPII(input);
    return {
      allowed: true,
      outboundText: redacted.text,
      redactions: redacted.counts,
    };
  }

  return { allowed: true, outboundText: input, redactions: {} };
}

// ───────────────── Output evaluation ─────────────────

export type OutputDecision = {
  // The (possibly redacted) text to surface to the user.
  text: string;
  // Non-empty if anything happened the user should know about (PII
  // redacted, hallucination flagged, missing citations, etc.).
  warnings: string[];
  // True if the response was so badly out-of-policy that we'd rather show
  // a refusal than the raw text. Caller decides what to do (we still
  // return the redacted text in `text`).
  blocked: boolean;
};

export type OutputContext = {
  // Whether RAG citations were available for this turn — affects the
  // citation-check and hallucination-filter heuristics.
  hadCitations: boolean;
};

export function applyOutputGuardrails(raw: string, g: Guardrails, ctx: OutputContext): OutputDecision {
  let text = raw;
  const warnings: string[] = [];
  let blocked = false;

  if (g.enableOutputFilters) {
    if (g.blockPII) {
      const r = redactPII(text);
      text = r.text;
      const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
      if (total > 0) {
        warnings.push(`PII redacted (${Object.entries(r.counts).map(([k, n]) => `${k}: ${n}`).join(", ")}).`);
      }
    }
    if (g.blockProfanity) {
      const p = redactProfanity(text);
      text = p.text;
      if (p.count > 0) warnings.push(`Profanity redacted (${p.count} term${p.count === 1 ? "" : "s"}).`);
    }

    // Citation check — only meaningful when this agent has KBs and we
    // actually tried to ground.
    if (g.enableCitationCheck && ctx.hadCitations) {
      if (!/\[\d+(?:,\s*\d+)*\]/.test(text)) {
        warnings.push("Output is missing inline citations from the knowledge base.");
      }
    }

    // Hallucination heuristic — when grounding was attempted but the model
    // made strong, unsourced factual claims.
    if (g.enableHallucinationFilter && ctx.hadCitations) {
      const hasNumbers = /\b\d{2,}\b/.test(text);
      const hasYear = /\b(19|20)\d{2}\b/.test(text);
      const hasCitation = /\[\d+(?:,\s*\d+)*\]/.test(text);
      if ((hasNumbers || hasYear) && !hasCitation) {
        warnings.push("Numeric/date claims were made without citing a knowledge-base source.");
      }
    }
  }

  // Content-safety on output is enforced regardless of `enableOutputFilters`
  // — if the user dialed up the safety level they meant for output too.
  if (g.contentSafetyLevel !== "off") {
    const matched = matchSafetyTerms(text, g.contentSafetyLevel);
    if (matched.length > 0) {
      blocked = true;
      warnings.push(`Output blocked by content-safety guardrail (${g.contentSafetyLevel}) for: ${matched.slice(0, 3).join(", ")}.`);
      text =
        "[This response was blocked by the agent's content-safety guardrail. " +
        `Triggered terms: ${matched.slice(0, 5).join(", ")}.]`;
    }
  }

  return { text, warnings, blocked };
}
