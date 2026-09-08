// SCIM 2.0 (RFC 7643 / 7644), the part that needs no database: the wire
// shapes, the filter the IdPs actually send, the PATCH semantics, and the
// token format. Pure so the routes, the server module and the tests share
// one reading of the protocol.
//
// What an IdP does with a SCIM server is narrow and well trodden: look a
// user up by userName or externalId, create them, PATCH `active` to false
// when they leave, and keep groups' members in step. Okta sends PATCH with
// path-less values; Entra sends paths. Both are honoured; everything else
// in the spec that neither uses (bulk, sorting, ETags, complex filters) is
// declared unsupported in ServiceProviderConfig rather than half-built.

export const SCIM_TOKEN_PREFIX = "scim_";

export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCIM_SCHEMA = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  serviceProviderConfig: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const;
export const SCIM_GROUP_SCHEMA = SCIM_SCHEMA.group;

/** The most results one page returns; `count` above it is clamped, not refused. */
export const SCIM_MAX_RESULTS = 200;

export class ScimError extends Error {
  status: number;
  scimType?: string;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

export function scimErrorBody(status: number, detail: string, scimType?: string) {
  return {
    schemas: [SCIM_SCHEMA.error],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

// --- Tokens ----------------------------------------------------------------

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new plaintext token. Shown to the admin once and never stored. */
export function generateScimToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return SCIM_TOKEN_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** SHA-256 of the plaintext, hex — what lives in the database. */
export async function hashScimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Enough of the token to tell two apart in a list; not enough to use. */
export function scimTokenPrefix(token: string): string {
  return token.slice(0, SCIM_TOKEN_PREFIX.length + 6);
}

export function looksLikeScimToken(token: string): boolean {
  return (
    typeof token === "string" &&
    token.startsWith(SCIM_TOKEN_PREFIX) &&
    token.length >= SCIM_TOKEN_PREFIX.length + 16 &&
    token.length <= 120
  );
}

// --- Filters ----------------------------------------------------------------

export type ScimFilter = { attribute: string; value: string };

/**
 * Parse the one filter shape IdPs send on lookups: `attr eq "value"`.
 * The attribute is normalised to lower case; the value keeps its case (the
 * caller decides whether userName compares case-insensitively — it does).
 * Anything else — and/or, co, sw, pr, grouping — is refused as invalidFilter
 * rather than silently matching nothing, which an IdP would read as "the
 * user does not exist" and then create a duplicate.
 */
export function parseScimFilter(filter: string | null | undefined): ScimFilter | null {
  if (filter == null || filter.trim() === "") return null;
  const m =
    /^\s*([A-Za-z][A-Za-z0-9_.:]*(?:\[[^\]]*\])?(?:\.[A-Za-z][A-Za-z0-9_]*)?)\s+eq\s+(.+?)\s*$/i.exec(
      filter,
    );
  if (!m) throw new ScimError(400, `Unsupported filter: ${filter}`, "invalidFilter");
  const attribute = m[1].toLowerCase();
  let value = m[2];
  if (value.startsWith('"')) {
    // One quoted value: a second unescaped quote means a compound filter
    // (`a eq "x" and b eq "y"`), which this server does not evaluate.
    const inner = value.slice(1, -1);
    if (!value.endsWith('"') || value.length < 2 || /(^|[^\\])"/.test(inner)) {
      throw new ScimError(400, `Unsupported filter: ${filter}`, "invalidFilter");
    }
    value = inner.replace(/\\"/g, '"');
  } else if (/\s/.test(value)) {
    throw new ScimError(400, `Unsupported filter: ${filter}`, "invalidFilter");
  }
  return { attribute, value };
}

// --- Users ------------------------------------------------------------------

export type ScimName = { givenName?: string; familyName?: string; formatted?: string };

/** The attributes of a User this server stores; the rest of the schema is ignored. */
export type ScimUserInput = {
  userName?: string;
  externalId?: string | null;
  name?: ScimName;
  displayName?: string | null;
  active?: boolean;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Read a User resource body (POST or PUT). `userName` is the email; when an
 * IdP sends a non-email userName (Entra can), the primary work email is used
 * as the account's email and userName is kept beside it. An email is
 * required either way: an account without one cannot sign in.
 */
export function readScimUser(body: unknown): ScimUserInput & { email: string } {
  if (!body || typeof body !== "object") {
    throw new ScimError(400, "A User resource is required", "invalidSyntax");
  }
  const b = body as Record<string, unknown>;
  const userName = str(b.userName)?.trim();
  const emails = Array.isArray(b.emails) ? (b.emails as Record<string, unknown>[]) : [];
  const primary = emails.find((e) => e && e.primary === true) ?? emails[0];
  const emailFromList = str(primary?.value)?.trim();
  const email = (userName && userName.includes("@") ? userName : emailFromList) ?? userName;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ScimError(
      400,
      "userName (or a primary email) must be an email address",
      "invalidValue",
    );
  }
  const name =
    b.name && typeof b.name === "object"
      ? {
          givenName: str((b.name as Record<string, unknown>).givenName),
          familyName: str((b.name as Record<string, unknown>).familyName),
          formatted: str((b.name as Record<string, unknown>).formatted),
        }
      : undefined;
  const active = typeof b.active === "boolean" ? b.active : parseBoolean(b.active);
  return {
    userName: userName || email,
    email: email.toLowerCase(),
    externalId: b.externalId === null ? null : str(b.externalId),
    name,
    displayName: b.displayName === null ? null : str(b.displayName),
    active,
  };
}

function parseBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "True") return true;
  if (v === "false" || v === "False") return false;
  return undefined;
}

/** A display name from what the IdP sent, in the order people expect. */
export function displayNameFrom(input: {
  displayName?: string | null;
  name?: ScimName;
  email: string;
}): string {
  if (input.displayName) return input.displayName;
  const full = [input.name?.givenName, input.name?.familyName].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (input.name?.formatted) return input.name.formatted;
  return input.email.split("@")[0];
}

// --- PATCH -------------------------------------------------------------------

export type ScimPatchOp = { op: "add" | "replace" | "remove"; path?: string; value?: unknown };

export function readPatch(body: unknown): ScimPatchOp[] {
  if (!body || typeof body !== "object") {
    throw new ScimError(400, "A PatchOp is required", "invalidSyntax");
  }
  const ops = (body as Record<string, unknown>).Operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new ScimError(400, "Operations must be a non-empty array", "invalidSyntax");
  }
  return ops.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const op = String(o.op ?? "").toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, `Unsupported PATCH op: ${String(o.op)}`, "invalidSyntax");
    }
    const path = str(o.path)?.trim();
    if (op === "remove" && !path) {
      throw new ScimError(400, "remove needs a path", "noTarget");
    }
    return { op, path: path || undefined, value: o.value };
  });
}

export type ScimUserState = {
  email: string;
  userName: string;
  externalId: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  active: boolean;
};

/**
 * Apply PATCH operations to a user. Path-less operations carry an object of
 * attributes (Okta: `{"op":"replace","value":{"active":false}}`); Entra
 * sends `path: "active"` and sometimes `"name.givenName"`. Attributes this
 * server does not store are ignored, as the spec allows; a value of the
 * wrong type is refused so a typo cannot deactivate everyone.
 */
export function applyUserPatch(current: ScimUserState, ops: ScimPatchOp[]): ScimUserState {
  const next = { ...current };
  const set = (path: string, value: unknown) => {
    const p = path.toLowerCase().replace(/^urn:ietf:params:scim:schemas:core:2\.0:user:/, "");
    switch (p) {
      case "active": {
        const v = parseBoolean(value);
        if (v === undefined) throw new ScimError(400, "active must be a boolean", "invalidValue");
        next.active = v;
        return;
      }
      case "username": {
        const v = str(value)?.trim();
        if (!v) throw new ScimError(400, "userName must be a string", "invalidValue");
        next.userName = v;
        if (v.includes("@")) next.email = v.toLowerCase();
        return;
      }
      case "externalid":
        next.externalId = value == null ? null : String(value);
        return;
      case "displayname":
        next.displayName = value == null ? null : String(value);
        return;
      case "name.givenname":
        next.givenName = value == null ? null : String(value);
        return;
      case "name.familyname":
        next.familyName = value == null ? null : String(value);
        return;
      case "name": {
        if (value && typeof value === "object") {
          const n = value as Record<string, unknown>;
          if ("givenName" in n) next.givenName = n.givenName == null ? null : String(n.givenName);
          if ("familyName" in n)
            next.familyName = n.familyName == null ? null : String(n.familyName);
        }
        return;
      }
      case "emails":
      case 'emails[type eq "work"].value':
      case "emails[primary eq true].value": {
        const v = Array.isArray(value)
          ? str((value[0] as Record<string, unknown> | undefined)?.value)
          : str(value);
        if (v && v.includes("@")) next.email = v.trim().toLowerCase();
        return;
      }
      default:
        return; // an attribute this server does not store
    }
  };
  for (const op of ops) {
    if (op.op === "remove") {
      set(op.path!, null);
      continue;
    }
    if (op.path) {
      set(op.path, op.value);
      continue;
    }
    if (!op.value || typeof op.value !== "object") {
      throw new ScimError(400, "A path-less operation needs an object value", "invalidValue");
    }
    for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) set(k, v);
  }
  return next;
}

export type ScimGroupState = { displayName: string; externalId: string | null; members: string[] };

/**
 * Apply PATCH operations to a group. Members arrive as `[{value: id}]`;
 * removal names one member with `members[value eq "id"]` or clears them
 * with `members`. Order in `members` is not significant.
 */
export function applyGroupPatch(current: ScimGroupState, ops: ScimPatchOp[]): ScimGroupState {
  const next = { ...current, members: [...current.members] };
  const memberIds = (value: unknown): string[] => {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    return list
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).value : m))
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  };
  const setAttr = (path: string, value: unknown, op: "add" | "replace") => {
    const p = path.toLowerCase();
    if (p === "displayname") {
      const v = str(value)?.trim();
      if (!v) throw new ScimError(400, "displayName must be a string", "invalidValue");
      next.displayName = v;
    } else if (p === "externalid") {
      next.externalId = value == null ? null : String(value);
    } else if (p === "members") {
      const ids = memberIds(value);
      if (op === "replace") next.members = [...new Set(ids)];
      else next.members = [...new Set([...next.members, ...ids])];
    }
  };
  for (const op of ops) {
    if (op.op === "remove") {
      const p = op.path!;
      const one = /^members\[\s*value\s+eq\s+"?([^"\]]+)"?\s*\]$/i.exec(p);
      if (one) {
        next.members = next.members.filter((m) => m !== one[1]);
      } else if (p.toLowerCase() === "members") {
        next.members = [];
      } else if (p.toLowerCase() === "externalid") {
        next.externalId = null;
      } else {
        throw new ScimError(400, `Cannot remove ${p}`, "noTarget");
      }
      continue;
    }
    if (op.path) {
      setAttr(op.path, op.value, op.op);
      continue;
    }
    if (!op.value || typeof op.value !== "object") {
      throw new ScimError(400, "A path-less operation needs an object value", "invalidValue");
    }
    for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
      setAttr(k, v, op.op);
    }
  }
  return next;
}

// --- Lists -------------------------------------------------------------------

/** Read `startIndex` (1-based) and `count` the way RFC 7644 §3.4.2.4 says. */
export function readPage(url: URL): { startIndex: number; count: number } {
  const start = Number.parseInt(url.searchParams.get("startIndex") ?? "1", 10);
  const count = Number.parseInt(url.searchParams.get("count") ?? String(SCIM_MAX_RESULTS), 10);
  return {
    startIndex: Number.isFinite(start) && start >= 1 ? start : 1,
    count: Number.isFinite(count)
      ? Math.max(0, Math.min(count, SCIM_MAX_RESULTS))
      : SCIM_MAX_RESULTS,
  };
}

export function listResponse<T>(all: T[], page: { startIndex: number; count: number }) {
  const slice = all.slice(page.startIndex - 1, page.startIndex - 1 + page.count);
  return {
    schemas: [SCIM_SCHEMA.list],
    totalResults: all.length,
    startIndex: page.startIndex,
    itemsPerPage: slice.length,
    Resources: slice,
  };
}

// --- Discovery ---------------------------------------------------------------

export function serviceProviderConfig(baseUrl: string) {
  return {
    schemas: [SCIM_SCHEMA.serviceProviderConfig],
    documentationUri: `${baseUrl.replace(/\/api\/scim\/v2$/, "")}/docs/iam`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "A provisioning token minted on the SSO tab, sent as Authorization: Bearer",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` },
  };
}

export function resourceTypes(baseUrl: string) {
  return [
    {
      schemas: [SCIM_SCHEMA.resourceType],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_SCHEMA.user,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
    },
    {
      schemas: [SCIM_SCHEMA.resourceType],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: SCIM_GROUP_SCHEMA,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` },
    },
  ];
}

const attr = (
  name: string,
  type: "string" | "boolean" | "complex",
  extra: Record<string, unknown> = {},
) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

export function schemas(baseUrl: string) {
  return [
    {
      schemas: [SCIM_SCHEMA.schema],
      id: SCIM_SCHEMA.user,
      name: "User",
      description: "A person who can sign in",
      attributes: [
        attr("userName", "string", { required: true, uniqueness: "server" }),
        attr("externalId", "string"),
        attr("displayName", "string"),
        attr("active", "boolean"),
        attr("name", "complex", {
          subAttributes: [attr("givenName", "string"), attr("familyName", "string")],
        }),
        attr("emails", "complex", {
          multiValued: true,
          subAttributes: [attr("value", "string"), attr("primary", "boolean")],
        }),
        attr("groups", "complex", {
          multiValued: true,
          mutability: "readOnly",
          subAttributes: [attr("value", "string"), attr("display", "string")],
        }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_SCHEMA.user}` },
    },
    {
      schemas: [SCIM_SCHEMA.schema],
      id: SCIM_GROUP_SCHEMA,
      name: "Group",
      description: "An IAM group; grants and model rules may name it",
      attributes: [
        attr("displayName", "string", { required: true, uniqueness: "server" }),
        attr("externalId", "string"),
        attr("members", "complex", {
          multiValued: true,
          subAttributes: [attr("value", "string"), attr("display", "string")],
        }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_GROUP_SCHEMA}` },
    },
  ];
}
