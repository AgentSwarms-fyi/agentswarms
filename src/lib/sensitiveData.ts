// Which columns of a dataset hold personal data, read from their values as
// well as their names (R521).
//
// The catalog flagged personal data by column name alone. A name says what
// someone meant to put in a column, not what is in it: `contact` full of
// email addresses went unflagged, and `email_campaign_id` full of numbers was
// flagged. Here the values decide when they can, and the name speaks only
// where values cannot (a person's name or a postal address has no shape a
// pattern can check without guessing).
//
// THE PATTERNS ARE THE GUARDRAILS'. Chat already redacts email addresses,
// card numbers (checksum-validated), phone numbers (never a date), national
// IDs, IBANs, IP addresses and keys with them, and their precision has been
// argued over in tests. A second set here would drift from the first. What
// this file adds is the question a column asks: is the WHOLE value one of
// these, and how many of the values are?
//
// ADVISORY. A finding hides nothing by itself; the owner decides, on the
// dataset's page or in the approvals inbox. So a finding says how sure it is
// ("48 of 50 values are email addresses") instead of claiming more.
import { piiNameKind, type PiiNameKind } from "@/lib/piiHeuristic";
import { detectPII, redactPII, type PiiEntity } from "@/utils/guardrails";

export type SensitiveKind = PiiNameKind | "secret";

/** The approvals' action_type for a suggestion to hide a dataset's personal columns. */
export const HIDE_COLUMNS_ACTION = "dataset.hide_columns";

/** What a suggestion carries about each column, for the inbox to show. */
export type SuggestedColumn = { column: string; kind: SensitiveKind; evidence: string };

/** The dataset a suggestion is about, when its payload names one properly. */
export function suggestedDatasetId(payload: unknown): string | null {
  const id = (payload as { dataset_id?: unknown } | null)?.dataset_id;
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

/** The columns a suggestion's payload names, read defensively: its owner can write it. */
export function suggestedColumns(payload: unknown): SuggestedColumn[] {
  const list = (payload as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (f): f is SuggestedColumn =>
        !!f &&
        typeof (f as SuggestedColumn).column === "string" &&
        typeof (f as SuggestedColumn).evidence === "string" &&
        Object.prototype.hasOwnProperty.call(SENSITIVE_LABEL, (f as SuggestedColumn).kind),
    )
    .slice(0, 100);
}

/** What a column holds, as a reader would say it. */
export const SENSITIVE_LABEL: Record<SensitiveKind, string> = {
  email: "email addresses",
  ip: "IP addresses",
  card: "payment card numbers",
  bank_account: "bank account numbers",
  national_id: "ID numbers",
  phone: "phone numbers",
  birth_date: "dates of birth",
  person_name: "people's names",
  address: "postal addresses",
  pay: "pay or income",
  gender: "gender",
  secret: "keys or tokens",
};

/** One of them: "1 of 1 value is a phone number", "mentions an email address". */
const ONE: Partial<Record<SensitiveKind, string>> = {
  email: "an email address",
  card: "a payment card number",
  national_id: "an ID number",
  secret: "a key or token",
  phone: "a phone number",
  ip: "an IP address",
  bank_account: "a bank account number",
};

/** How a finding was reached. */
export type SensitiveBasis = "values" | "name and values" | "name" | "mentions";

export type SensitiveFinding = {
  column: string;
  kind: SensitiveKind;
  basis: SensitiveBasis;
  /** Values that matched; 0 for a finding from the name alone. */
  matched: number;
  /** Non-empty values looked at. */
  sampled: number;
  /** One sentence: what it holds and how that is known. */
  evidence: string;
};

/** The guardrail detectors a whole value is checked against. */
const VALUE_ENTITIES: readonly PiiEntity[] = [
  "email",
  "api_key",
  "iban",
  "ssn",
  "credit_card",
  "phone",
  "ip",
];

/**
 * Detectors precise enough to trust inside free text. A phone number or an IP
 * address in a sentence is too often an order number or a version.
 */
const MENTION_ENTITIES: readonly PiiEntity[] = ["email", "api_key", "ssn", "credit_card"];

const ENTITY_KIND: Partial<Record<PiiEntity, SensitiveKind>> = {
  email: "email",
  api_key: "secret",
  iban: "bank_account",
  ssn: "national_id",
  credit_card: "card",
  phone: "phone",
  ip: "ip",
};

/**
 * Kinds whose values always have their shape, so a column NAMED for one whose
 * values never show it is not one: every email address has an @, every IPv4
 * address four numbers. A phone number or an ID can be stored as bare digits,
 * so a name saying "phone" stands even when no value looks like one.
 */
const SHAPE_ALWAYS: ReadonlySet<SensitiveKind> = new Set(["email", "ip"]);

/** Whole values of these kinds count as mentions when too few for the column to be one. */
const WHOLE_COUNTS_AS_MENTION: readonly SensitiveKind[] = ["email", "secret", "national_id"];

/** A share of the values at or above this, and the column is that kind. */
export const VALUE_SHARE = 0.6;
/** Values longer than this are text, not an identifier; mentions are still read. */
const MAX_IDENTIFIER = 120;
/** Longer text is cut here before looking for mentions. */
const MAX_SCANNED = 4000;
/** Fewer values than this, and values that never match do not overrule a name. */
const OVERRULE_AFTER = 10;

/** IBAN's own check (ISO 13616): the rearranged number, mod 97, is 1. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/**
 * A value as text, or null when it is empty or not a plain value. A true or
 * false counts: a column of them is evidence too (FOUND ON REAL DATA, R521:
 * `IsEmailBounced`, all false, was "email addresses" by its name because its
 * values were not counted as values).
 */
function asText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * Which kind of personal data a whole value is, or null. The value must be the
 * identifier and nothing else: `alice@example.com` is an email address,
 * `write to alice@example.com` is not one (it mentions one).
 */
export function valueKind(value: string): SensitiveKind | null {
  const v = value.trim();
  if (!v || v.length > MAX_IDENTIFIER) return null;
  const { text, counts } = redactPII(v, VALUE_ENTITIES);
  const found = Object.entries(counts);
  if (found.length !== 1 || found[0][1] !== 1) return null;
  if (!/^\[REDACTED_[A-Z]+\]$/.test(text.trim())) return null;
  const entity = found[0][0] as PiiEntity;
  // The guardrail's IBAN pattern has no checksum: a product code shaped like
  // one would otherwise make a column of SKUs a column of bank accounts.
  if (entity === "iban" && !ibanValid(v)) return null;
  return ENTITY_KIND[entity] ?? null;
}

/** The kinds a value mentions inside other text. */
export function mentionedKinds(value: string): SensitiveKind[] {
  const counts = detectPII(value.slice(0, MAX_SCANNED), MENTION_ENTITIES);
  return Object.keys(counts)
    .map((e) => ENTITY_KIND[e as PiiEntity])
    .filter((k): k is SensitiveKind => !!k);
}

const of = (n: number, total: number) => `${n} of ${total} value${total === 1 ? "" : "s"}`;

/** One column, from its name and the values sampled from it. */
export function classifyColumn(
  column: string,
  values: readonly unknown[],
): SensitiveFinding | null {
  const texts = values.map(asText).filter((v): v is string => v !== null);
  const sampled = texts.length;
  const whole = new Map<SensitiveKind, number>();
  const mentions = new Map<SensitiveKind, number>();
  for (const t of texts) {
    const k = valueKind(t);
    if (k) {
      whole.set(k, (whole.get(k) ?? 0) + 1);
      continue;
    }
    for (const m of new Set(mentionedKinds(t))) mentions.set(m, (mentions.get(m) ?? 0) + 1);
  }

  const named = piiNameKind(column);
  const [best, bestN] = [...whole.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (best && bestN >= Math.min(3, sampled) && bestN / sampled >= VALUE_SHARE) {
    return {
      column,
      kind: best,
      basis: named === best ? "name and values" : "values",
      matched: bestN,
      sampled,
      evidence:
        bestN === 1
          ? `${of(1, sampled)} is ${ONE[best] ?? SENSITIVE_LABEL[best]}.`
          : `${of(bestN, sampled)} are ${SENSITIVE_LABEL[best]}.`,
    };
  }

  // A name whose kind always shows in its values, and enough values that
  // never show it: the name was wrong (`email_campaign_id` holds numbers).
  const overruled =
    named !== null &&
    SHAPE_ALWAYS.has(named) &&
    sampled >= OVERRULE_AFTER &&
    (whole.get(named) ?? 0) === 0;
  if (named && !overruled) {
    // The name alone, and what the values could not settle, said plainly so
    // the owner can judge: a column with nothing in it, or a few values none
    // of which is one.
    const label = SENSITIVE_LABEL[named];
    const contradicted = SHAPE_ALWAYS.has(named) && sampled > 0 && !whole.get(named);
    return {
      column,
      kind: named,
      basis: "name",
      matched: 0,
      sampled,
      evidence:
        values.length > 0 && sampled === 0
          ? `Its name suggests ${label}; none of the ${values.length} rows read has a value in it.`
          : contradicted
            ? `Its name suggests ${label}, though none of its ${sampled} value${sampled === 1 ? "" : "s"} is one.`
            : `Its name suggests ${label}.`,
    };
  }

  // A value that IS an email address also mentions one: a contact column half
  // full of addresses is personal even below the share that makes it an
  // email column. Not for card numbers: a column of numeric ids passes the
  // card checksum one time in ten by chance.
  for (const k of WHOLE_COUNTS_AS_MENTION) {
    const n = whole.get(k) ?? 0;
    if (n) mentions.set(k, (mentions.get(k) ?? 0) + n);
  }
  const [said, saidN] = [...mentions.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (said && saidN > 0) {
    return {
      column,
      kind: said,
      basis: "mentions",
      matched: saidN,
      sampled,
      evidence: `${of(saidN, sampled)} ${saidN === 1 ? "mentions" : "mention"} ${ONE[said] ?? SENSITIVE_LABEL[said]}.`,
    };
  }
  return null;
}

/** Every column that looks personal, in the dataset's column order. */
export function findSensitiveColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): SensitiveFinding[] {
  const out: SensitiveFinding[] = [];
  for (const c of columns) {
    const f = classifyColumn(
      c,
      rows.map((r) => r[c]),
    );
    if (f) out.push(f);
  }
  return out;
}

// ── Who can read them ──────────────────────────────────────────────────────

/** A grant's hidden columns, as the database compares them: trimmed, any case. */
const norm = (c: string) => c.trim().toLowerCase();

/** Whether a grant with this mask hides the column. */
export function hiddenBy(mask: readonly string[] | null | undefined, column: string): boolean {
  const want = norm(column);
  return (mask ?? []).some((m) => norm(m) === want);
}

/** For each finding, how many grants can still read its column. */
export function readersOf(
  findings: readonly SensitiveFinding[],
  masks: ReadonlyArray<readonly string[] | null | undefined>,
): Array<{ finding: SensitiveFinding; readers: number }> {
  return findings.map((finding) => ({
    finding,
    readers: masks.filter((m) => !hiddenBy(m, finding.column)).length,
  }));
}

/**
 * A grant's mask with more columns hidden. Keeps what it hid and how it was
 * spelled; adds only what it did not already hide, in the order given.
 */
export function maskWith(existing: readonly string[] | null | undefined, add: readonly string[]) {
  const out = [...(existing ?? [])];
  for (const c of add) if (c.trim() && !hiddenBy(out, c)) out.push(c.trim());
  return out;
}

/** An earlier suggestion for the same dataset, in any state. */
export type PriorSuggestion = { status: string; columns: readonly string[] };

/**
 * The columns to suggest hiding from a dataset's shares, or null for none.
 *
 * Only columns some grant can read: a column hidden from every grant needs no
 * suggestion. Never while one is still waiting for an answer (a second would
 * stack in the inbox), and never a column suggested before, whatever the
 * answer was: a rejection is the owner saying the share is meant to include
 * it, and asking again every few hours would teach them to stop reading.
 */
export function suggestionFor(
  findings: readonly SensitiveFinding[],
  masks: ReadonlyArray<readonly string[] | null | undefined>,
  prior: readonly PriorSuggestion[],
): string[] | null {
  if (!masks.length) return null;
  if (prior.some((p) => p.status === "pending")) return null;
  const asked = new Set(prior.flatMap((p) => p.columns.map(norm)));
  const cols = readersOf(findings, masks)
    .filter((r) => r.readers > 0 && !asked.has(norm(r.finding.column)))
    .map((r) => r.finding.column);
  return cols.length ? cols : null;
}

/** "email (email addresses) and phone (phone numbers)" */
export function describeColumns(findings: readonly SensitiveFinding[]): string {
  const parts = findings.map((f) => `${f.column} (${SENSITIVE_LABEL[f.kind]})`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
