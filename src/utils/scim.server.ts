// SCIM 2.0 provisioning, the server side: the token check every request
// passes, and the User and Group operations over Supabase Auth, profiles
// and the IAM groups the rest of the platform already reads.
//
// One rule runs through all of it: SCIM may never remove the last way in.
// A superadmin cannot be deactivated or deleted from here, whatever the
// IdP says — an IdP misconfiguration (or a compromised token) must not be
// able to lock the instance. The refusal is a 403 the IdP shows an admin.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  SCIM_CONTENT_TYPE,
  SCIM_GROUP_SCHEMA,
  SCIM_SCHEMA,
  ScimError,
  applyGroupPatch,
  applyUserPatch,
  displayNameFrom,
  hashScimToken,
  looksLikeScimToken,
  parseScimFilter,
  readPatch,
  readScimUser,
  scimErrorBody,
  type ScimGroupState,
  type ScimPatchOp,
  type ScimUserState,
} from "@/lib/scim";
import { auditEvent } from "@/utils/audit.server";
import { isBootstrapAdmin } from "@/utils/iam.server";
import { envInt, rateLimitedGlobal } from "@/utils/rateLimit.server";

const BAN_DURATION = "87600h"; // the same ~10 years the IAM page uses
const MAX_BODY_BYTES = 256 * 1024;

// --- Responses ---------------------------------------------------------------

export const scimJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, ...headers },
  });

export const scimFail = (status: number, detail: string, scimType?: string) =>
  scimJson(scimErrorBody(status, detail, scimType), status);

/** Run a handler and turn a ScimError into the SCIM error body it means. */
export async function scimHandler(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ScimError) return scimFail(e.status, e.message, e.scimType);
    const message = (e as Error).message || "Internal error";
    console.error("[scim]", message);
    return scimFail(500, message);
  }
}

export async function readScimBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ScimError(413, "Request body too large", "tooLarge");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ScimError(400, "Request body is not JSON", "invalidSyntax");
  }
}

/** The resource id is the last path segment; read it from the path, never a header. */
export function idFromPath(request: Request): string {
  const url = new URL(request.url);
  const last = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return decodeURIComponent(last);
}

/** `https://host/api/scim/v2`, from the request so the IdP's own view of us is used. */
export function scimBaseUrl(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}/api/scim/v2`;
}

// --- Authentication ------------------------------------------------------------

export type ScimActor = {
  tokenId: string;
  label: string;
  createdBy: string | null;
};

export type ScimAuth = { ok: true; actor: ScimActor } | { ok: false; response: Response };

/**
 * Authenticate `Authorization: Bearer scim_...`. Unknown and revoked tokens
 * are rate limited together so a token cannot be guessed at speed; a known
 * token is counted so the SSO tab can show when the IdP last synced.
 */
export async function authenticateScim(request: Request): Promise<ScimAuth> {
  const raw = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const limit = envInt("SCIM_RATE_LIMIT_PER_MIN", 300);
  if (await rateLimitedGlobal("scim", limit)) {
    return { ok: false, response: scimFail(429, "Too many requests", "tooMany") };
  }
  if (!looksLikeScimToken(raw)) {
    return {
      ok: false,
      response: scimJson(scimErrorBody(401, "A provisioning token is required"), 401, {
        "WWW-Authenticate": 'Bearer realm="scim"',
      }),
    };
  }
  const hash = await hashScimToken(raw);
  const { data: row } = await supabaseAdmin
    .from("iam_scim_tokens")
    .select("id, label, created_by, revoked_at, use_count")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!row || row.revoked_at) {
    if (row) {
      auditEvent({
        userId: row.created_by,
        actorEmail: `scim:${row.label}`,
        action: "scim.access.denied",
        resourceType: "scim_token",
        resourceId: row.id,
        detail: { reason: "revoked" },
      });
    }
    return {
      ok: false,
      response: scimJson(scimErrorBody(401, "Invalid or revoked provisioning token"), 401, {
        "WWW-Authenticate": 'Bearer realm="scim"',
      }),
    };
  }
  void supabaseAdmin
    .from("iam_scim_tokens")
    .update({ last_used_at: new Date().toISOString(), use_count: (row.use_count ?? 0) + 1 })
    .eq("id", row.id)
    .then(() => undefined);
  return { ok: true, actor: { tokenId: row.id, label: row.label, createdBy: row.created_by } };
}

function audit(actor: ScimActor, action: string, resource: Record<string, unknown> = {}) {
  auditEvent({
    userId: actor.createdBy,
    actorEmail: `scim:${actor.label}`,
    action,
    resourceType: typeof resource.resourceType === "string" ? resource.resourceType : undefined,
    resourceId: typeof resource.resourceId === "string" ? resource.resourceId : undefined,
    resourceName: typeof resource.resourceName === "string" ? resource.resourceName : undefined,
    detail: {
      token_id: actor.tokenId,
      ...(resource.detail as Record<string, unknown> | undefined),
    },
  });
}

// --- Users ------------------------------------------------------------------------

type AdminUser = {
  id: string;
  email?: string;
  created_at?: string;
  updated_at?: string;
  banned_until?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
};

async function listAllAuthUsers(): Promise<AdminUser[]> {
  const users: AdminUser[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 500 });
    if (error) throw new ScimError(500, error.message);
    users.push(...(data.users as unknown as AdminUser[]));
    if (data.users.length < 500) break;
  }
  return users;
}

function isBanned(u: AdminUser): boolean {
  return Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now());
}

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
};

async function profilesFor(userIds: string[]): Promise<Map<string, ProfileRow>> {
  if (!userIds.length) return new Map();
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("user_id, display_name, first_name, last_name")
    .in("user_id", userIds);
  return new Map((data ?? []).map((p) => [p.user_id, p as ProfileRow]));
}

async function groupsFor(
  userIds: string[],
): Promise<Map<string, { value: string; display: string }[]>> {
  const out = new Map<string, { value: string; display: string }[]>();
  if (!userIds.length) return out;
  const { data: memberships } = await supabaseAdmin
    .from("iam_group_members")
    .select("user_id, group_id")
    .in("user_id", userIds);
  const groupIds = [...new Set((memberships ?? []).map((m) => m.group_id))];
  if (!groupIds.length) return out;
  const { data: groups } = await supabaseAdmin
    .from("iam_groups")
    .select("id, name")
    .in("id", groupIds);
  const nameOf = new Map((groups ?? []).map((g) => [g.id, g.name]));
  for (const m of memberships ?? []) {
    const list = out.get(m.user_id) ?? [];
    list.push({ value: m.group_id, display: nameOf.get(m.group_id) ?? m.group_id });
    out.set(m.user_id, list);
  }
  return out;
}

export function userResource(
  u: AdminUser,
  profile: ProfileRow | undefined,
  groups: { value: string; display: string }[],
  baseUrl: string,
) {
  const meta = u.app_metadata ?? {};
  const userName = typeof meta.scim_user_name === "string" ? meta.scim_user_name : (u.email ?? "");
  const givenName = profile?.first_name ?? undefined;
  const familyName = profile?.last_name ?? undefined;
  return {
    schemas: [SCIM_SCHEMA.user],
    id: u.id,
    ...(typeof meta.scim_external_id === "string" ? { externalId: meta.scim_external_id } : {}),
    userName,
    ...(givenName || familyName
      ? {
          name: {
            ...(givenName ? { givenName } : {}),
            ...(familyName ? { familyName } : {}),
            formatted: [givenName, familyName].filter(Boolean).join(" "),
          },
        }
      : {}),
    ...(profile?.display_name ? { displayName: profile.display_name } : {}),
    active: !isBanned(u),
    emails: u.email ? [{ value: u.email, primary: true, type: "work" }] : [],
    groups,
    meta: {
      resourceType: "User",
      created: u.created_at ?? null,
      lastModified: u.updated_at ?? u.created_at ?? null,
      location: `${baseUrl}/Users/${u.id}`,
    },
  };
}

async function resourcesForUsers(users: AdminUser[], baseUrl: string) {
  const ids = users.map((u) => u.id);
  const [profiles, groups] = await Promise.all([profilesFor(ids), groupsFor(ids)]);
  return users.map((u) => userResource(u, profiles.get(u.id), groups.get(u.id) ?? [], baseUrl));
}

/** Users matching a lookup filter, or every user when there is none. */
export async function listScimUsers(filter: string | null, baseUrl: string) {
  const parsed = parseScimFilter(filter);
  const all = await listAllAuthUsers();
  let users = all;
  if (parsed) {
    const want = parsed.value.toLowerCase();
    switch (parsed.attribute) {
      case "username":
      case "emails.value":
      case 'emails[type eq "work"].value':
      case "emails[primary eq true].value":
        users = all.filter(
          (u) =>
            (u.email ?? "").toLowerCase() === want ||
            String(u.app_metadata?.scim_user_name ?? "").toLowerCase() === want,
        );
        break;
      case "externalid":
        users = all.filter((u) => String(u.app_metadata?.scim_external_id ?? "") === parsed.value);
        break;
      case "id":
        users = all.filter((u) => u.id === parsed.value);
        break;
      default:
        throw new ScimError(
          400,
          `Unsupported filter attribute: ${parsed.attribute}`,
          "invalidFilter",
        );
    }
  }
  users.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  return resourcesForUsers(users, baseUrl);
}

async function getAuthUser(id: string): Promise<AdminUser> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, `No user ${id}`);
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
  if (error || !data.user) throw new ScimError(404, `No user ${id}`);
  return data.user as unknown as AdminUser;
}

export async function getScimUser(id: string, baseUrl: string) {
  const u = await getAuthUser(id);
  return (await resourcesForUsers([u], baseUrl))[0];
}

async function stateOf(u: AdminUser): Promise<ScimUserState> {
  const profile = (await profilesFor([u.id])).get(u.id);
  const meta = u.app_metadata ?? {};
  return {
    email: (u.email ?? "").toLowerCase(),
    userName: typeof meta.scim_user_name === "string" ? meta.scim_user_name : (u.email ?? ""),
    externalId: typeof meta.scim_external_id === "string" ? meta.scim_external_id : null,
    givenName: profile?.first_name ?? null,
    familyName: profile?.last_name ?? null,
    // What the IdP set explicitly, not the derived name on the profile — so
    // an IdP that never sends displayName keeps it following the names.
    displayName: typeof meta.scim_display_name === "string" ? meta.scim_display_name : null,
    active: !isBanned(u),
  };
}

/** A superadmin, or the bootstrap admin, is out of SCIM's reach for deactivation and deletion. */
async function assertNotProtected(userId: string, what: string): Promise<void> {
  const { data: role } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("role", "superadmin")
    .maybeSingle();
  if (role || (await isBootstrapAdmin(userId))) {
    throw new ScimError(
      403,
      `This account is a superadmin; SCIM cannot ${what} it. Demote it in IAM first.`,
    );
  }
}

async function writeProfile(userId: string, state: ScimUserState): Promise<void> {
  const display = displayNameFrom({
    displayName: state.displayName,
    name: { givenName: state.givenName ?? undefined, familyName: state.familyName ?? undefined },
    email: state.email,
  });
  const patch = {
    display_name: display,
    first_name: state.givenName,
    last_name: state.familyName,
  };
  const { data: existing } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  const { error } = existing
    ? await supabaseAdmin.from("profiles").update(patch).eq("user_id", userId)
    : await supabaseAdmin.from("profiles").insert({ user_id: userId, ...patch });
  if (error) throw new ScimError(500, `Could not write the profile: ${error.message}`);
}

async function applyState(
  u: AdminUser,
  before: ScimUserState,
  after: ScimUserState,
  actor: ScimActor,
): Promise<void> {
  const changes: Record<string, unknown> = {};
  const authPatch: Record<string, unknown> = {};
  if (after.email !== before.email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(after.email)) {
      throw new ScimError(400, "The email is not valid", "invalidValue");
    }
    authPatch.email = after.email;
    authPatch.email_confirm = true;
    changes.email = after.email;
  }
  if (
    after.externalId !== before.externalId ||
    after.userName !== before.userName ||
    after.displayName !== before.displayName
  ) {
    authPatch.app_metadata = {
      ...(u.app_metadata ?? {}),
      scim_external_id: after.externalId,
      scim_user_name: after.userName,
      scim_display_name: after.displayName,
    };
    if (after.externalId !== before.externalId) changes.externalId = after.externalId;
    if (after.userName !== before.userName) changes.userName = after.userName;
  }
  if (after.active !== before.active) {
    if (!after.active) await assertNotProtected(u.id, "deactivate");
    authPatch.ban_duration = after.active ? "none" : BAN_DURATION;
    changes.active = after.active;
  }
  if (Object.keys(authPatch).length) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(u.id, authPatch);
    if (error) throw new ScimError(500, error.message);
  }
  if (
    after.givenName !== before.givenName ||
    after.familyName !== before.familyName ||
    after.displayName !== before.displayName
  ) {
    await writeProfile(u.id, after);
    changes.name = { givenName: after.givenName, familyName: after.familyName };
    if (after.displayName !== before.displayName) changes.displayName = after.displayName;
  }
  if (Object.keys(changes).length) {
    audit(
      actor,
      "active" in changes
        ? after.active
          ? "scim.user.activate"
          : "scim.user.deactivate"
        : "scim.user.update",
      {
        resourceType: "user",
        resourceId: u.id,
        resourceName: after.email,
        detail: { changes },
      },
    );
  }
}

export async function createScimUser(body: unknown, actor: ScimActor, baseUrl: string) {
  const input = readScimUser(body);
  const all = await listAllAuthUsers();
  const clash = all.find((u) => (u.email ?? "").toLowerCase() === input.email);
  if (clash) {
    throw new ScimError(409, `A user with userName ${input.email} already exists`, "uniqueness");
  }
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: input.email,
    email_confirm: true,
    app_metadata: {
      provisioned_by: "scim",
      scim_external_id: input.externalId ?? null,
      scim_user_name: input.userName ?? input.email,
      scim_display_name: input.displayName ?? null,
    },
    user_metadata: {
      full_name: displayNameFrom(input),
    },
  });
  if (error || !data.user) throw new ScimError(500, error?.message ?? "Could not create the user");
  const state: ScimUserState = {
    email: input.email,
    userName: input.userName ?? input.email,
    externalId: input.externalId ?? null,
    givenName: input.name?.givenName ?? null,
    familyName: input.name?.familyName ?? null,
    displayName: input.displayName ?? null,
    active: input.active !== false,
  };
  await writeProfile(data.user.id, state);
  if (!state.active) {
    const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, {
      ban_duration: BAN_DURATION,
    });
    if (banErr) throw new ScimError(500, banErr.message);
  }
  audit(actor, "scim.user.create", {
    resourceType: "user",
    resourceId: data.user.id,
    resourceName: input.email,
    detail: { externalId: state.externalId, active: state.active },
  });
  return getScimUser(data.user.id, baseUrl);
}

/** PUT: the IdP sends the whole resource; the attributes this server stores are replaced. */
export async function replaceScimUser(
  id: string,
  body: unknown,
  actor: ScimActor,
  baseUrl: string,
) {
  const u = await getAuthUser(id);
  const input = readScimUser(body);
  const before = await stateOf(u);
  const after: ScimUserState = {
    email: input.email,
    userName: input.userName ?? input.email,
    externalId: input.externalId === undefined ? before.externalId : input.externalId,
    givenName: input.name ? (input.name.givenName ?? null) : before.givenName,
    familyName: input.name ? (input.name.familyName ?? null) : before.familyName,
    displayName: input.displayName === undefined ? before.displayName : input.displayName,
    active: input.active === undefined ? before.active : input.active,
  };
  await applyState(u, before, after, actor);
  return getScimUser(id, baseUrl);
}

export async function patchScimUser(id: string, body: unknown, actor: ScimActor, baseUrl: string) {
  const u = await getAuthUser(id);
  const ops: ScimPatchOp[] = readPatch(body);
  const before = await stateOf(u);
  const after = applyUserPatch(before, ops);
  await applyState(u, before, after, actor);
  return getScimUser(id, baseUrl);
}

export async function deleteScimUser(id: string, actor: ScimActor): Promise<void> {
  const u = await getAuthUser(id);
  await assertNotProtected(u.id, "delete");
  const { error } = await supabaseAdmin.auth.admin.deleteUser(u.id);
  if (error) throw new ScimError(500, error.message);
  audit(actor, "scim.user.delete", {
    resourceType: "user",
    resourceId: u.id,
    resourceName: u.email ?? u.id,
  });
}

// --- Groups ------------------------------------------------------------------------

type GroupRow = {
  id: string;
  name: string;
  external_id: string | null;
  created_at: string;
};

async function membersOf(
  groupIds: string[],
): Promise<Map<string, { value: string; display: string }[]>> {
  const out = new Map<string, { value: string; display: string }[]>();
  if (!groupIds.length) return out;
  const { data: memberships } = await supabaseAdmin
    .from("iam_group_members")
    .select("group_id, user_id")
    .in("group_id", groupIds);
  const userIds = [...new Set((memberships ?? []).map((m) => m.user_id))];
  const profiles = await profilesFor(userIds);
  for (const m of memberships ?? []) {
    const list = out.get(m.group_id) ?? [];
    list.push({ value: m.user_id, display: profiles.get(m.user_id)?.display_name ?? m.user_id });
    out.set(m.group_id, list);
  }
  return out;
}

function groupResource(
  g: GroupRow,
  members: { value: string; display: string }[],
  baseUrl: string,
) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: g.id,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    displayName: g.name,
    members,
    meta: {
      resourceType: "Group",
      created: g.created_at,
      lastModified: g.created_at,
      location: `${baseUrl}/Groups/${g.id}`,
    },
  };
}

const GROUP_COLUMNS = "id, name, external_id, created_at";

export async function listScimGroups(filter: string | null, baseUrl: string) {
  const parsed = parseScimFilter(filter);
  let q = supabaseAdmin.from("iam_groups").select(GROUP_COLUMNS).order("name");
  if (parsed) {
    switch (parsed.attribute) {
      case "displayname":
        q = q.ilike(
          "name",
          parsed.value.replace(/[%_]/g, (c) => `\\${c}`),
        );
        break;
      case "externalid":
        q = q.eq("external_id", parsed.value);
        break;
      case "id":
        q = q.eq("id", parsed.value);
        break;
      default:
        throw new ScimError(
          400,
          `Unsupported filter attribute: ${parsed.attribute}`,
          "invalidFilter",
        );
    }
  }
  const { data, error } = await q;
  if (error) throw new ScimError(500, error.message);
  const rows = (data ?? []) as GroupRow[];
  const members = await membersOf(rows.map((g) => g.id));
  return rows.map((g) => groupResource(g, members.get(g.id) ?? [], baseUrl));
}

async function getGroupRow(id: string): Promise<GroupRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, `No group ${id}`);
  const { data } = await supabaseAdmin
    .from("iam_groups")
    .select(GROUP_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new ScimError(404, `No group ${id}`);
  return data as GroupRow;
}

export async function getScimGroup(id: string, baseUrl: string) {
  const g = await getGroupRow(id);
  const members = await membersOf([g.id]);
  return groupResource(g, members.get(g.id) ?? [], baseUrl);
}

function readGroup(body: unknown): {
  displayName: string;
  externalId: string | null | undefined;
  members: string[];
} {
  if (!body || typeof body !== "object") {
    throw new ScimError(400, "A Group resource is required", "invalidSyntax");
  }
  const b = body as Record<string, unknown>;
  const displayName = typeof b.displayName === "string" ? b.displayName.trim() : "";
  if (!displayName) throw new ScimError(400, "displayName is required", "invalidValue");
  if (displayName.length > 80)
    throw new ScimError(400, "displayName is longer than 80 characters", "invalidValue");
  const members = Array.isArray(b.members)
    ? (b.members as Record<string, unknown>[])
        .map((m) => (m && typeof m === "object" ? m.value : m))
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  return {
    displayName,
    externalId:
      b.externalId === null ? null : typeof b.externalId === "string" ? b.externalId : undefined,
    members: [...new Set(members)],
  };
}

/** Every member id must be a user; a wrong id is the IdP's mistake to hear about, not a silent skip. */
async function assertUsersExist(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ScimError(400, `Member ${id} is not a user id`, "invalidValue");
    const { data } = await supabaseAdmin.auth.admin.getUserById(id);
    if (!data.user) throw new ScimError(400, `Member ${id} is not a user`, "invalidValue");
  }
}

async function writeMembers(
  groupId: string,
  before: string[],
  after: string[],
  actor: ScimActor,
): Promise<void> {
  const add = after.filter((m) => !before.includes(m));
  const remove = before.filter((m) => !after.includes(m));
  await assertUsersExist(add);
  if (add.length) {
    const { error } = await supabaseAdmin.from("iam_group_members").upsert(
      add.map((user_id) => ({ group_id: groupId, user_id, added_by: actor.createdBy })),
      { onConflict: "group_id,user_id", ignoreDuplicates: true },
    );
    if (error) throw new ScimError(500, error.message);
  }
  if (remove.length) {
    const { error } = await supabaseAdmin
      .from("iam_group_members")
      .delete()
      .eq("group_id", groupId)
      .in("user_id", remove);
    if (error) throw new ScimError(500, error.message);
  }
}

export async function createScimGroup(body: unknown, actor: ScimActor, baseUrl: string) {
  const input = readGroup(body);
  const { data: clash } = await supabaseAdmin
    .from("iam_groups")
    .select("id")
    .ilike(
      "name",
      input.displayName.replace(/[%_]/g, (c) => `\\${c}`),
    )
    .maybeSingle();
  if (clash)
    throw new ScimError(409, `A group named ${input.displayName} already exists`, "uniqueness");
  await assertUsersExist(input.members);
  const { data: row, error } = await supabaseAdmin
    .from("iam_groups")
    .insert({
      name: input.displayName,
      description: "Provisioned by the identity provider",
      created_by: actor.createdBy,
      external_id: input.externalId ?? null,
    })
    .select(GROUP_COLUMNS)
    .single();
  if (error) throw new ScimError(500, error.message);
  await writeMembers(row.id, [], input.members, actor);
  audit(actor, "scim.group.create", {
    resourceType: "iam_group",
    resourceId: row.id,
    resourceName: input.displayName,
    detail: { externalId: input.externalId ?? null, members: input.members.length },
  });
  return getScimGroup(row.id, baseUrl);
}

async function applyGroupState(
  g: GroupRow,
  before: ScimGroupState,
  after: ScimGroupState,
  actor: ScimActor,
) {
  const patch: { name?: string; external_id?: string | null } = {};
  if (after.displayName !== before.displayName) patch.name = after.displayName;
  if (after.externalId !== before.externalId) patch.external_id = after.externalId;
  if (Object.keys(patch).length) {
    const { error } = await supabaseAdmin.from("iam_groups").update(patch).eq("id", g.id);
    if (error) {
      throw new ScimError(
        error.code === "23505" ? 409 : 500,
        error.code === "23505"
          ? `A group named ${after.displayName} already exists`
          : error.message,
        error.code === "23505" ? "uniqueness" : undefined,
      );
    }
  }
  await writeMembers(g.id, before.members, after.members, actor);
  const added = after.members.filter((m) => !before.members.includes(m)).length;
  const removed = before.members.filter((m) => !after.members.includes(m)).length;
  if (Object.keys(patch).length || added || removed) {
    audit(actor, "scim.group.update", {
      resourceType: "iam_group",
      resourceId: g.id,
      resourceName: after.displayName,
      detail: { ...patch, members_added: added, members_removed: removed },
    });
  }
}

async function groupState(g: GroupRow): Promise<ScimGroupState> {
  const members = await membersOf([g.id]);
  return {
    displayName: g.name,
    externalId: g.external_id,
    members: (members.get(g.id) ?? []).map((m) => m.value),
  };
}

export async function replaceScimGroup(
  id: string,
  body: unknown,
  actor: ScimActor,
  baseUrl: string,
) {
  const g = await getGroupRow(id);
  const input = readGroup(body);
  const before = await groupState(g);
  await applyGroupState(
    g,
    before,
    {
      displayName: input.displayName,
      externalId: input.externalId === undefined ? before.externalId : input.externalId,
      members: input.members,
    },
    actor,
  );
  return getScimGroup(id, baseUrl);
}

export async function patchScimGroup(id: string, body: unknown, actor: ScimActor, baseUrl: string) {
  const g = await getGroupRow(id);
  const ops = readPatch(body);
  const before = await groupState(g);
  const after = applyGroupPatch(before, ops);
  await applyGroupState(g, before, after, actor);
  return getScimGroup(id, baseUrl);
}

export async function deleteScimGroup(id: string, actor: ScimActor): Promise<void> {
  const g = await getGroupRow(id);
  const { error } = await supabaseAdmin.from("iam_groups").delete().eq("id", g.id);
  if (error) throw new ScimError(500, error.message);
  audit(actor, "scim.group.delete", {
    resourceType: "iam_group",
    resourceId: g.id,
    resourceName: g.name,
  });
}
