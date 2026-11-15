// What a field that holds a secret stores, read and written in one place.
//
// A credential is never typed into a form any more: it is picked from the
// secrets the user may use (R493). The field then stores either a reference,
// `{{secret:NAME}}`, which the server swaps for the value at use time, or, for
// the few fields built that way, the bare NAME. Both spellings are the
// server's: SECRET_REF_SOURCE is the resolver's own pattern
// (src/utils/secrets.server.ts; secretRefs.test.ts holds the two together),
// so nothing here can call a value a reference that the server would send out
// as literal text, or the other way round.
//
// PURE: no server or React imports.

/** The resolver's pattern for one reference, as source text. */
export const SECRET_REF_SOURCE = String.raw`\{\{\s*secret:([A-Za-z][A-Za-z0-9_]*)\s*\}\}`;

/** A secret's name, as the database enforces it (user_secrets) and the resolver reads it. */
export const SECRET_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The longest name the database accepts. */
export const SECRET_NAME_MAX = 64;

const WHOLE_REF = new RegExp(`^\\s*${SECRET_REF_SOURCE}\\s*$`);

/** Whether `name` could name a secret: a letter, then letters, digits and `_`, at most 64. */
export function isSecretName(name: string): boolean {
  return name.length <= SECRET_NAME_MAX && SECRET_NAME_RE.test(name);
}

/** The reference a field stores for a secret: `{{secret:NAME}}`. */
export function secretRef(name: string): string {
  if (!isSecretName(name)) throw new Error(`"${name}" is not a secret name`);
  return `{{secret:${name}}}`;
}

/**
 * The secret a value names when the whole value is one reference, else null.
 * Whitespace inside the braces is the resolver's to accept, so it is accepted
 * here; `secret` is lower-case and touches its colon, as the resolver wants.
 */
export function parseSecretRef(value: string | null | undefined): string | null {
  const m = WHOLE_REF.exec(value ?? "");
  return m ? m[1] : null;
}

/** Whether a value holds at least one reference the server will resolve. */
export function containsSecretRef(value: string | null | undefined): boolean {
  return new RegExp(SECRET_REF_SOURCE).test(value ?? "");
}

/**
 * Whether a `{{…}}` expression, its braces already stripped, is a secret
 * reference: the flow-state templater leaves exactly these for the server.
 */
export function isSecretRefExpr(expr: string): boolean {
  return /^secret:[A-Za-z][A-Za-z0-9_]*$/.test(expr.trim());
}

// ── Header values ───────────────────────────────────────────────────────────

/** What may come before a secret in a header value, in the order a picker offers them. */
export const HEADER_SECRET_PREFIXES = ["", "Bearer ", "Basic ", "Token "] as const;
export type HeaderSecretPrefix = (typeof HEADER_SECRET_PREFIXES)[number];

const HEADER_REF = new RegExp(`^\\s*(Bearer |Basic |Token )?${SECRET_REF_SOURCE}\\s*$`);

/**
 * A header value that is a secret, with or without a scheme in front:
 * `Bearer {{secret:API_TOKEN}}` is the API_TOKEN secret behind "Bearer ".
 * Null for anything else, a template or typed text included.
 */
export function parseHeaderSecret(
  value: string | null | undefined,
): { prefix: HeaderSecretPrefix; name: string } | null {
  const m = HEADER_REF.exec(value ?? "");
  if (!m) return null;
  return { prefix: (m[1] ?? "") as HeaderSecretPrefix, name: m[2] };
}

/** The header value for a secret behind an optional scheme. */
export function headerSecretValue(prefix: HeaderSecretPrefix, name: string): string {
  return `${prefix}${secretRef(name)}`;
}

/**
 * Header names that carry a credential. A value typed into one of these that
 * is neither a reference nor a template is a key saved in plain text.
 */
export function isCredentialHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return (
    n === "authorization" ||
    n === "proxy-authorization" ||
    n === "cookie" ||
    /api[-_]?key|access[-_]?key|auth[-_]?key|secret|token|password|passwd|^x-auth/.test(n)
  );
}

/** A key typed into a credential header: not a reference, not a template. */
export function isTypedHeaderKey(headerName: string, value: string): boolean {
  return (
    isCredentialHeader(headerName) &&
    value.trim() !== "" &&
    !value.includes("{{") &&
    parseHeaderSecret(value) === null
  );
}

/**
 * Where a header row's value comes from when it is first shown: a secret when
 * it holds one, or holds a key typed in directly (which the picker shows as a
 * key saved in the field, never its text), or is an empty credential header.
 */
export function initialHeaderSource(headerName: string, value: string): "text" | "secret" {
  if (parseHeaderSecret(value)) return "secret";
  if (isTypedHeaderKey(headerName, value)) return "secret";
  if (!value.trim() && isCredentialHeader(headerName)) return "secret";
  return "text";
}

/** A name a field can suggest for a new secret: upper-case letters, digits and `_`. */
export function suggestSecretName(text: string): string {
  const s = text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const named = /^[A-Z]/.test(s) ? s : s ? `KEY_${s}` : "";
  return named.slice(0, SECRET_NAME_MAX).replace(/_+$/, "");
}

// ── What a field holds ──────────────────────────────────────────────────────

/** How a field stores its secret: a reference, or the bare name. */
export type SecretFormat = "ref" | "name";

export type SecretFieldState =
  /** Nothing chosen. */
  | { kind: "empty" }
  /** A secret, by name. Whether it still exists is the list's to say. */
  | { kind: "secret"; name: string }
  /** A key saved in the field itself. It works, and is never shown. */
  | { kind: "raw" }
  /** Text that names no secret and is no key either: a bare-name field holding something else. */
  | { kind: "invalid"; text: string };

/**
 * What a secret field's stored value is. `storedKey` says a key is saved for
 * this field on the server, out of this page's reach (a write-only field
 * whose form starts empty).
 */
export function readSecretField(
  value: string | null | undefined,
  format: SecretFormat,
  storedKey = false,
): SecretFieldState {
  const v = value ?? "";
  if (!v.trim()) return storedKey ? { kind: "raw" } : { kind: "empty" };
  if (format === "name") {
    const name = v.trim();
    return isSecretName(name) ? { kind: "secret", name } : { kind: "invalid", text: name };
  }
  const name = parseSecretRef(v);
  return name ? { kind: "secret", name } : { kind: "raw" };
}

/** The value a field stores for a picked secret. */
export function secretFieldValue(name: string, format: SecretFormat): string {
  return format === "name" ? name : secretRef(name);
}

/**
 * A write-only key field's saved state, read from the stored config a page can
 * see (an `integrations` row). A reference is stored as it is, so the picker
 * can show it; a key is stored encrypted under `<field>_enc` (or, from before
 * that, in plain text), and the page learns only that one is there.
 */
export function savedSecretField(
  config: Record<string, unknown> | null | undefined,
  field: string,
): { ref: string; stored: boolean } {
  if (!config) return { ref: "", stored: false };
  const plain = typeof config[field] === "string" ? (config[field] as string).trim() : "";
  if (parseSecretRef(plain)) return { ref: plain, stored: false };
  return { ref: "", stored: config[`${field}_enc`] != null || plain !== "" };
}
