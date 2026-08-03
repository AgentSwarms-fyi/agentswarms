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
//         · PII policy                — detect/redact/block before send
//
//  Output · PII policy                — detect/redact/block in assistant text
//         · blockProfanity            — redact in final assistant text
//         · contentSafetyLevel        — flag/redact unsafe terms
//         · enableCitationCheck       — flag responses missing [n] markers
//         · enableHallucinationFilter — flag unsupported claims when grounded
//
//  Anything not listed above is preserved for future enforcement but is
//  currently INERT — saved on the agent, read by nothing:
//
//         · maxTurnsPerConversation
//         · rateLimitPerMinute
//         · requireApprovalAboveTokens
//         · customFilterPrompt
//
//  That is disclosed to the operator in Agent Builder, under "Saved but not
//  yet enforced". A governance control that silently does nothing is worse
//  than an absent one, because it manufactures false assurance — so the
//  disclosure is the feature, not an apology for a gap.
//
//  This comment used to say the state was surfaced "honestly via
//  `inertFields`". There is no `inertFields`, and there never was: the
//  disclosure is a paragraph of prose in AgentForm.tsx. Naming a symbol that
//  does not exist sends the next reader looking for a mechanism instead of
//  the paragraph they actually need to update.
//
//  tests/unit/guardrailsInert.test.ts holds both halves in place: it fails if
//  one of these four starts being enforced while the paragraph still says it
//  is not, AND if one of the enforced settings stops being read while the UI
//  still advertises it.

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
  /**
   * PII policy. `blockPII` above is the legacy on/off switch and is still
   * honoured: when it is true and no mode was chosen, the policy behaves as
   * mode "redact" over the default entity set, both directions.
   *
   *   off    — no detection
   *   redact — replace matches with [REDACTED_*] and carry on
   *   block  — refuse the turn outright (for data that must never transit)
   */
  piiMode: "off" | "redact" | "block";
  /** Which detectors run. Empty = the default set. */
  piiEntities: PiiEntity[];
  /** Whether the policy applies to prompts, completions, or both. */
  piiApplyTo: "input" | "output" | "both";
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
  piiMode: "off",
  piiEntities: [],
  piiApplyTo: "both",
};

// Coerce arbitrary JSON-ish input (e.g. from the agents.tools column) into a
// fully-populated Guardrails object. Unknown keys are dropped, unknown enum
// values fall back to defaults.
export function parseGuardrails(raw: unknown): Guardrails {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GUARDRAILS };
  const r = raw as Record<string, unknown>;
  const safetyRaw = r.contentSafetyLevel;
  const safety: Guardrails["contentSafetyLevel"] =
    safetyRaw === "low" || safetyRaw === "medium" || safetyRaw === "high" ? safetyRaw : "off";
  // Backward compatibility: agents saved before the PII policy existed only
  // have `blockPII`. Treat that as redaction over the default entity set so
  // their behaviour is unchanged by this upgrade.
  const modeRaw = r.piiMode;
  const piiMode: Guardrails["piiMode"] =
    modeRaw === "redact" || modeRaw === "block" || modeRaw === "off"
      ? modeRaw
      : r.blockPII === true
        ? "redact"
        : "off";
  return {
    enableInputFilters:
      typeof r.enableInputFilters === "boolean"
        ? r.enableInputFilters
        : DEFAULT_GUARDRAILS.enableInputFilters,
    enableOutputFilters:
      typeof r.enableOutputFilters === "boolean"
        ? r.enableOutputFilters
        : DEFAULT_GUARDRAILS.enableOutputFilters,
    blockPII: typeof r.blockPII === "boolean" ? r.blockPII : DEFAULT_GUARDRAILS.blockPII,
    blockProfanity:
      typeof r.blockProfanity === "boolean" ? r.blockProfanity : DEFAULT_GUARDRAILS.blockProfanity,
    maxTurnsPerConversation:
      typeof r.maxTurnsPerConversation === "number"
        ? r.maxTurnsPerConversation
        : DEFAULT_GUARDRAILS.maxTurnsPerConversation,
    maxInputLength:
      typeof r.maxInputLength === "number" && r.maxInputLength > 0
        ? r.maxInputLength
        : DEFAULT_GUARDRAILS.maxInputLength,
    rateLimitPerMinute:
      typeof r.rateLimitPerMinute === "number"
        ? r.rateLimitPerMinute
        : DEFAULT_GUARDRAILS.rateLimitPerMinute,
    topicRestrictions: typeof r.topicRestrictions === "string" ? r.topicRestrictions : "",
    allowedTopics: typeof r.allowedTopics === "string" ? r.allowedTopics : "",
    blockedPatterns: typeof r.blockedPatterns === "string" ? r.blockedPatterns : "",
    requireApprovalAboveTokens:
      typeof r.requireApprovalAboveTokens === "number" ? r.requireApprovalAboveTokens : 0,
    enableCitationCheck:
      typeof r.enableCitationCheck === "boolean"
        ? r.enableCitationCheck
        : DEFAULT_GUARDRAILS.enableCitationCheck,
    enableHallucinationFilter:
      typeof r.enableHallucinationFilter === "boolean"
        ? r.enableHallucinationFilter
        : DEFAULT_GUARDRAILS.enableHallucinationFilter,
    contentSafetyLevel: safety,
    customFilterPrompt: typeof r.customFilterPrompt === "string" ? r.customFilterPrompt : "",
    piiMode,
    piiEntities: Array.isArray(r.piiEntities)
      ? (r.piiEntities.filter((e): e is PiiEntity =>
          PII_ENTITIES.includes(e as PiiEntity),
        ) as PiiEntity[])
      : [],
    piiApplyTo:
      r.piiApplyTo === "input" || r.piiApplyTo === "output" || r.piiApplyTo === "both"
        ? r.piiApplyTo
        : "both",
  };
}

/** Effective PII policy for a parsed guardrail set (resolves the legacy flag). */
export function piiPolicy(g: Guardrails): {
  mode: "off" | "redact" | "block";
  entities: PiiEntity[];
  onInput: boolean;
  onOutput: boolean;
} {
  const mode = g.piiMode;
  return {
    mode,
    entities: g.piiEntities.length ? g.piiEntities : [...DEFAULT_PII_ENTITIES],
    onInput: mode !== "off" && g.piiApplyTo !== "output",
    onOutput: mode !== "off" && g.piiApplyTo !== "input",
  };
}

// True if any field in `g` is non-default. Cheap pre-flight check used to
// short-circuit guardrail work when nothing is configured.
export function isAnyGuardrailActive(g: Guardrails): boolean {
  return (
    g.enableInputFilters ||
    g.enableOutputFilters ||
    g.blockPII ||
    g.piiMode !== "off" ||
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

// Detectors are ordered most-specific-first and applied in sequence, so a
// string that could match several categories (a card number also looks like a
// long phone number) is claimed by the tighter pattern first.
//
// Precision over recall throughout: a false positive silently corrupts the
// user's text, which is worse than missing an exotic identifier. Nothing here
// tries to detect names or postal addresses — those cannot be done with
// regexes at acceptable precision.
export const PII_ENTITIES = [
  "email",
  "api_key",
  "iban",
  "ssn",
  "credit_card",
  "phone",
  "ip",
  "dob",
] as const;
export type PiiEntity = (typeof PII_ENTITIES)[number];

export const PII_ENTITY_LABELS: Record<PiiEntity, string> = {
  email: "Email addresses",
  api_key: "API keys & tokens",
  iban: "Bank accounts (IBAN)",
  ssn: "National IDs (SSN)",
  credit_card: "Payment card numbers",
  phone: "Phone numbers",
  ip: "IP addresses",
  dob: "Dates of birth",
};

/** Luhn check — the standard checksum every real payment card satisfies. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

type Detector = {
  name: PiiEntity;
  re: RegExp;
  mask: string;
  /** Optional second-stage check to reject look-alikes. */
  validate?: (match: string) => boolean;
};

/**
 * Does this look like a calendar date rather than a number?
 *
 * Used to keep the phone detector off dates. Accepts the separators people
 * actually write (`-`, `/`, `.`) in both field orders, and checks the parts are
 * in range so a genuine number like `1234-56-7890` is not excused as a date.
 */
function isDateShaped(raw: string): boolean {
  const m = raw.trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const inDay = (n: number) => n >= 1 && n <= 31;
  const inMonth = (n: number) => n >= 1 && n <= 12;
  const inYear = (n: number) => n >= 1000 && n <= 9999;
  // yyyy-mm-dd, or dd-mm-yyyy / mm-dd-yyyy.
  return (inYear(a) && inMonth(b) && inDay(c)) || (inDay(a) && inMonth(b) && inYear(c));
}

const PII_DETECTORS: Detector[] = [
  { name: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, mask: "[REDACTED_EMAIL]" },
  // Provider-shaped secrets. These leak far more often than people expect,
  // usually pasted into a prompt while debugging.
  {
    name: "api_key",
    // Prefixed formats first, then the two-part ones. Extended after probing
    // the original list against the keys people actually paste: it matched
    // `sk-`, AWS ACCESS KEY IDs, classic GitHub PATs, Slack, Google and JWTs,
    // and missed Stripe (`sk_live_` — an underscore, so the `sk-` branch never
    // fired), AWS SECRET access keys, GitHub's fine-grained PATs, Groq,
    // HuggingFace and Supabase service keys. A payment provider's live secret
    // going through unredacted is the sharp one.
    re: new RegExp(
      [
        "\\bsk-[A-Za-z0-9_-]{16,}", // OpenAI / Anthropic
        "\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}", // Stripe
        "\\bAKIA[0-9A-Z]{16}", // AWS access key id
        "\\bASIA[0-9A-Z]{16}", // AWS temporary access key id
        "\\bghp_[A-Za-z0-9]{20,}", // GitHub PAT (classic)
        "\\bgithub_pat_[A-Za-z0-9_]{22,}", // GitHub PAT (fine-grained)
        "\\bgh[opsu]_[A-Za-z0-9]{20,}", // other GitHub token kinds
        "\\bxox[baprs]-[A-Za-z0-9-]{10,}", // Slack
        "\\bAIza[0-9A-Za-z_-]{20,}", // Google
        "\\bgsk_[A-Za-z0-9]{20,}", // Groq
        "\\bhf_[A-Za-z0-9]{20,}", // HuggingFace
        "\\bsb[pk]_[A-Za-z0-9]{20,}", // Supabase
        "\\bglpat-[A-Za-z0-9_-]{16,}", // GitLab
        "\\bdop_v1_[A-Za-z0-9]{32,}", // DigitalOcean
        // JWT: three base64url segments.
        "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
      ].join("|"),
      "g",
    ),
    mask: "[REDACTED_SECRET]",
  },
  // AWS SECRET access keys have no prefix — 40 base64-ish characters — so they
  // can only be found next to a label. Unlabelled, they are indistinguishable
  // from a hash and matching them blindly would redact half of every log.
  {
    name: "api_key",
    re: /\b(?:aws_secret_access_key|secret_access_key|aws_secret)\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    mask: "[REDACTED_SECRET]",
  },
  // IBAN: 2-letter country + 2 check digits + up to 30 alphanumerics.
  { name: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, mask: "[REDACTED_IBAN]" },
  // US SSN — strict dashed format keeps the false-positive rate near zero.
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: "[REDACTED_SSN]" },
  // Payment cards: 13–19 digits with optional separators, Luhn-validated so
  // order numbers and long identifiers aren't mangled.
  {
    // Digit-first and digit-last so a trailing separator isn't swallowed
    // (which used to glue the mask onto the next word).
    name: "credit_card",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    mask: "[REDACTED_CARD]",
    validate: (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    },
  },
  // Phone numbers: require a leading '+' or a separator so bare integers and
  // years don't match.
  {
    name: "phone",
    // ANCHORED TO THE WHOLE DIGIT RUN, both ends.
    //
    // The pattern captures at most three groups, so against a longer run it
    // used to match a window and leave the remainder: `4111 1111 1111 1112`
    // came back as `[REDACTED_PHONE] 1112`, corrupting the value while leaving
    // part of it in place — worse than either redacting it or not. Backtracking
    // then found the LAST three groups just as happily, so a trailing guard
    // alone was not enough; both ends are needed.
    //
    // Lookbehind: not preceded by a digit, or by a digit and a separator.
    // Lookahead: not followed by a digit, or by a separator and a digit.
    re: /(?<!\d)(?<!\d[ -])(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?|\b\d{2,4}[ -])\d{2,4}[ -]?\d{2,4}\b(?![ -]?\d)/g,
    mask: "[REDACTED_PHONE]",
    validate: (m) => {
      const digits = m.replace(/\D/g, "");
      // Too few digits to be a real number.
      if (digits.length < 7) return false;
      // No upper bound is checked here on purpose. E.164 caps a real number at
      // fifteen digits, and the pattern above already cannot match more than
      // that (+NNN NNNN NNNN NNNN = 15), so a `> 15` guard would be a branch
      // that can never run — mutation testing caught it surviving, which is
      // how a check that protects nothing announces itself. Longer digit runs
      // are excluded by the run anchoring instead.
      // A DATE IS NOT A PHONE NUMBER. `2024-01-15` is 4-2-2 digits with
      // separators and eight digits total, so it satisfied both the pattern
      // and the length check — every ISO date in a prompt or an answer was
      // replaced with [REDACTED_PHONE] and counted as a phone in the trace.
      // On a product whose primary dimension is time, that means an agent
      // with PII redaction switched on cannot discuss a date.
      if (isDateShaped(m)) return false;
      return true;
    },
  },
  {
    name: "ip",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}\b/gi,
    mask: "[REDACTED_IP]",
    validate: (m) =>
      m.includes(":") || m.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255),
  },
  // Dates of birth written explicitly (labelled), to avoid eating every date.
  {
    name: "dob",
    re: /\b(?:d\.?o\.?b\.?|date of birth|born(?: on)?)\s*[:-]?\s*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/gi,
    mask: "[REDACTED_DOB]",
  },
];

const DEFAULT_PII_ENTITIES: PiiEntity[] = ["email", "api_key", "ssn", "credit_card", "phone"];

/**
 * Redact PII in-place. Returns the cleaned text plus per-category counts
 * (surfaced in traces and as a chat warning).
 *
 * `entities` selects which detectors run; omit for the default set.
 */
export function redactPII(
  text: string,
  entities?: readonly PiiEntity[],
): { text: string; counts: Record<string, number> } {
  const on = new Set<PiiEntity>(entities?.length ? entities : DEFAULT_PII_ENTITIES);
  const counts: Record<string, number> = {};
  let out = text;
  for (const p of PII_DETECTORS) {
    if (!on.has(p.name)) continue;
    let n = 0;
    out = out.replace(p.re, (m) => {
      // A detector that fails its own validation leaves the text untouched.
      if (p.validate && !p.validate(m)) return m;
      n += 1;
      return p.mask;
    });
    if (n > 0) counts[p.name] = n;
  }
  return { text: out, counts };
}

/** Detect without modifying — used by the "block" mode and for previews. */
export function detectPII(text: string, entities?: readonly PiiEntity[]): Record<string, number> {
  return redactPII(text, entities).counts;
}

// Tiny opt-in profanity list. Intentionally short — production users should
// extend this via a custom filter prompt (see Guardrails.customFilterPrompt).
// Matched word-boundary, case-insensitive. We DON'T ship a comprehensive
// slur list in source — the goal is to demonstrate enforcement, not to be
// the world's filter database.
const PROFANITY = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "piss",
  "cunt",
  "motherfucker",
  "f*ck",
  "sh*t",
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
    "kill yourself",
    "suicide method",
    "how to make a bomb",
    "build a bomb",
    "child porn",
    "cp ",
    "rape ",
  ],
  medium: [
    "self-harm",
    "weapon making",
    "explosive recipe",
    "drug synthesis",
    "torture method",
    "stalking",
  ],
  high: [
    "weapon",
    "gun ",
    "knife attack",
    "violence",
    "drugs",
    "narcotic",
    "hate speech",
    "racial slur",
    "extremist",
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

/**
 * Does this pattern have the shape that backtracks catastrophically?
 *
 * THIS IS A DENIAL-OF-SERVICE GUARD, not a style check. These patterns are
 * typed by an operator into Agent Builder's "blocked patterns" box and then run
 * server-side on every message. JavaScript regexes are synchronous and there is
 * no way to time one out, so a pattern like `(a+)+$` against a 33-character
 * input does not slow one agent down — it pins the event loop and the whole
 * process stops answering ANY request, for every user. Measured before this
 * guard existed: no return after 30 seconds on 33 characters.
 *
 * The shape that does it is a quantified group whose body is itself unbounded —
 * `(a+)+`, `(a*)*`, `([a-z]+)+`, `(\w+\s?)*` — or a quantified group with
 * alternation that can match the same text two ways, `(a|a)*`. Detected by
 * walking the groups rather than by another regex, because a regex that parses
 * regexes is how this class of bug gets missed.
 */
export function looksCatastrophic(src: string): boolean {
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "(" || src[i - 1] === "\\") continue;
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === "\\") {
        j++;
        continue;
      }
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= src.length) continue; // unbalanced; new RegExp will reject it
    const body = src.slice(i + 1, j).replace(/\\./g, "");
    const quantified = /^(?:[+*]|\{\d+,\}?)/.test(src.slice(j + 1));
    if (!quantified) continue;
    if (/[+*]|\{\d+,\}/.test(body)) return true; // nested unbounded quantifier
    if (body.includes("|")) return true; // overlapping alternation
  }
  return false;
}

/** Longest text a user pattern is ever run against. Defence in depth. */
const MAX_PATTERN_INPUT = 20_000;

// Compile a "one-pattern-per-line" textarea into safe RegExps.
// Patterns that fail to compile, or that could backtrack catastrophically, are
// skipped (logged to console once).
function compilePatterns(raw: string): RegExp[] {
  if (!raw.trim()) return [];
  const out: RegExp[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (looksCatastrophic(t)) {
      console.warn("[guardrails] pattern skipped — catastrophic backtracking risk:", t);
      continue;
    }
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
    // Second layer under looksCatastrophic: even a well-formed pattern is
    // superlinear on a long enough string, and maxInputLength is operator-set
    // (it may be huge, or input filters may be on with no cap configured).
    const probe = input.length > MAX_PATTERN_INPUT ? input.slice(0, MAX_PATTERN_INPUT) : input;
    for (const re of patterns) {
      if (re.test(probe)) {
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

  // 5. PII policy on the prompt. This runs regardless of enableInputFilters:
  //    data protection is a separate concern from content filtering, and an
  //    operator who turned PII handling on means it unconditionally.
  const pii = piiPolicy(g);
  if (pii.onInput) {
    const redacted = redactPII(input, pii.entities);
    const found = Object.entries(redacted.counts);
    if (found.length > 0 && pii.mode === "block") {
      return {
        allowed: false,
        reason:
          `Your message looks like it contains personal or sensitive data ` +
          `(${found.map(([k]) => k.replace(/_/g, " ")).join(", ")}). ` +
          `This agent is configured not to send that to the model — remove it and try again.`,
        outboundText: input,
        redactions: redacted.counts,
      };
    }
    // redact mode: the model never sees the raw values.
    return { allowed: true, outboundText: redacted.text, redactions: redacted.counts };
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

export function applyOutputGuardrails(
  raw: string,
  g: Guardrails,
  ctx: OutputContext,
): OutputDecision {
  let text = raw;
  const warnings: string[] = [];
  let blocked = false;

  // PII on the way out — independent of enableOutputFilters for the same
  // reason as the input side: it's a data-protection control, not a content
  // preference. Catches an agent echoing back records it read from a table or
  // knowledge base.
  const pii = piiPolicy(g);
  if (pii.onOutput) {
    const r = redactPII(text, pii.entities);
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const summary = Object.entries(r.counts)
        .map(([k, n]) => `${k.replace(/_/g, " ")}: ${n}`)
        .join(", ");
      if (pii.mode === "block") {
        blocked = true;
        warnings.push(`Response withheld — it contained personal data (${summary}).`);
        return {
          text:
            "[This response was withheld because it contained personal or sensitive data " +
            `(${summary}), which this agent is configured never to return.]`,
          warnings,
          blocked,
        };
      }
      text = r.text;
      warnings.push(`PII redacted (${summary}).`);
    }
  }

  if (g.enableOutputFilters) {
    if (g.blockProfanity) {
      const p = redactProfanity(text);
      text = p.text;
      if (p.count > 0)
        warnings.push(`Profanity redacted (${p.count} term${p.count === 1 ? "" : "s"}).`);
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
      warnings.push(
        `Output blocked by content-safety guardrail (${g.contentSafetyLevel}) for: ${matched.slice(0, 3).join(", ")}.`,
      );
      text =
        "[This response was blocked by the agent's content-safety guardrail. " +
        `Triggered terms: ${matched.slice(0, 5).join(", ")}.]`;
    }
  }

  return { text, warnings, blocked };
}
