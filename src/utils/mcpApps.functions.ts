// Server functions behind MCP Builder: CRUD, deploy/stop, keys, exposure,
// internal registration, versions and the owner-only test console.
//
// Every function is scoped to the caller's own apps. Reads and ordinary writes
// go through the caller's JWT client so RLS is the backstop; only the parts
// that must cross a trust boundary — hashing a key, resolving a secret,
// touching a running container — use the service role, and each of those
// re-checks ownership first.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { auditEvent } from "@/utils/audit.server";
import {
  generateMcpApiKey,
  generateMcpSlug,
  hashMcpApiKey,
  mcpKeyPrefix,
} from "@/utils/mcpApps/keys";
import { MCP_PROTOCOL_VERSION, parseJsonOrSse } from "@/utils/mcpApps/protocol";
import { templateById } from "@/lib/mcpTemplates";

type Fail = { ok: false; error: string };

export type McpAppSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  deploy_error: string | null;
  keep_warm: boolean;
  idle_ttl_minutes: number;
  is_public: boolean;
  allowed_origins: string[];
  secret_refs: string[];
  requested_egress_hosts: string[];
  requirements: string;
  // `any` rather than `unknown`: an MCP input schema is arbitrary JSON, and the
  // server-fn serialisation check rejects `unknown` index signatures outright.
  tools: { name: string; description?: string; inputSchema?: Record<string, any> }[];
  tools_changed_at: string | null;
  tools_approved_at: string | null;
  /**
   * Fingerprint of the tool list currently deployed.
   *
   * Surfaced so the review UI can send back the fingerprint it actually
   * rendered — approving by app id alone would bless whatever the tools became
   * between opening the diff and clicking the button.
   */
  tools_hash: string | null;
  registered_server_id: string | null;
  last_deployed_at: string | null;
  updated_at: string;
};

const LIST_COLUMNS =
  "id, name, slug, description, status, deploy_error, keep_warm, idle_ttl_minutes, is_public, " +
  "allowed_origins, secret_refs, requested_egress_hosts, requirements, tools, tools_changed_at, " +
  "tools_approved_at, tools_hash, registered_server_id, last_deployed_at, updated_at";

/** Fetch one app under the caller's own RLS, so a foreign id simply isn't found. */
async function ownedApp(
  supabase: { from: (t: string) => any },
  appId: string,
): Promise<{ ok: true; app: any } | Fail> {
  const { data } = await supabase.from("mcp_apps").select("*").eq("id", appId).maybeSingle();
  if (!data) return { ok: false, error: "MCP server not found" };
  return { ok: true, app: data };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export const mcpAppList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Fail | { ok: true; apps: McpAppSummary[] }> => {
    const { data, error } = await context.supabase
      .from("mcp_apps")
      .select(LIST_COLUMNS)
      .order("updated_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, apps: (data ?? []) as unknown as McpAppSummary[] };
  });

export const mcpAppGet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(
    async ({
      data,
      context,
    }): Promise<Fail | { ok: true; app: McpAppSummary & { source_code: string } }> => {
      const owned = await ownedApp(context.supabase, data.id);
      if (!owned.ok) return owned;
      return { ok: true, app: owned.app };
    },
  );

export const mcpAppCreate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
        template: z.string().max(60).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true; id: string }> => {
    const tpl = templateById(data.template);
    const { data: row, error } = await context.supabase
      .from("mcp_apps")
      .insert({
        user_id: context.userId,
        name: data.name,
        // Server-generated: the slug is the public path segment, so letting a
        // user pick it would let them squat or shadow someone else's URL.
        slug: generateMcpSlug(data.name),
        description: data.description ?? tpl.tagline,
        source_code: tpl.source,
        requirements: tpl.requirements,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Could not create the server" };
    return { ok: true, id: row.id };
  });

const SaveSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  source_code: z.string().max(500_000).optional(),
  requirements: z.string().max(20_000).optional(),
  keep_warm: z.boolean().optional(),
  idle_ttl_minutes: z.number().int().min(1).max(1440).optional(),
  allowed_origins: z.array(z.string().max(200)).max(50).optional(),
  requested_egress_hosts: z.array(z.string().max(200)).max(50).optional(),
  // Only "{{secret:NAME}}" may back an env var — never a literal, which would
  // otherwise sit in the database in the clear.
  secret_refs: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=\{\{\s*secret:[A-Za-z][A-Za-z0-9_]*\s*\}\}$/))
    .max(50)
    .optional(),
});

export const mcpAppSave = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveSchema.parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    const { id, ...patch } = data;
    const { error } = await context.supabase.from("mcp_apps").update(patch).eq("id", id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const mcpAppDelete = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;

    // Tear the container down first: the cascade would remove the row and
    // leave an orphaned sandbox running with nothing left to address it.
    const { stopApp } = await import("@/utils/mcpApps/service.server");
    await stopApp(data.id).catch(() => {});
    await unregisterInternal(owned.app);

    const { error } = await context.supabase.from("mcp_apps").delete().eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: context.userId,
      action: "mcp_app.delete",
      resourceType: "mcp_app",
      resourceId: data.id,
      resourceName: owned.app.name,
    });
    return { ok: true };
  });

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const mcpAppDeploy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(
    async ({
      data,
      context,
    }): Promise<
      Fail | { ok: true; tools: { name: string }[]; toolsChanged: boolean; logs?: string }
    > => {
      const owned = await ownedApp(context.supabase, data.id);
      if (!owned.ok) return owned;

      // Building an MCP server IS running server-side code, so it is gated by
      // exactly the same grant as the Developer workspace rather than a second,
      // parallel permission an administrator would have to discover.
      const { canUseRuntime } = await import("@/utils/notebookRuntime/config.server");
      if (!(await canUseRuntime(context.userId))) {
        return {
          ok: false,
          error:
            "Your administrator has not granted you access to the server runtime, which MCP servers run on.",
        };
      }

      const { deploy } = await import("@/utils/mcpApps/service.server");
      const result = await deploy(owned.app);
      auditEvent({
        userId: context.userId,
        action: result.ok ? "mcp_app.deploy" : "mcp_app.deploy_failed",
        resourceType: "mcp_app",
        resourceId: data.id,
        resourceName: owned.app.name,
        detail: result.ok ? { tools: result.tools.length } : { error: result.error },
      });
      if (!result.ok) return { ok: false, error: result.error };
      if (result.toolsChanged) {
        auditEvent({
          userId: context.userId,
          action: "mcp_app.tools_changed",
          resourceType: "mcp_app",
          resourceId: data.id,
          resourceName: owned.app.name,
        });
      }
      return { ok: true, tools: result.tools, toolsChanged: result.toolsChanged };
    },
  );

export const mcpAppStop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;
    const { stopApp } = await import("@/utils/mcpApps/service.server");
    await stopApp(data.id);
    auditEvent({
      userId: context.userId,
      action: "mcp_app.stop",
      resourceType: "mcp_app",
      resourceId: data.id,
      resourceName: owned.app.name,
    });
    return { ok: true };
  });

export const mcpAppLogs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true; logs: string }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;
    const { logsOf } = await import("@/utils/mcpApps/service.server");
    return { ok: true, logs: (await logsOf(data.id)).slice(-40_000) };
  });

/** Re-approve the tool list after a change, unblocking agent calls. */
/**
 * Approve the CURRENT tool list, binding the approval to the list reviewed.
 *
 * The gate at the edge is a timestamp comparison — calls are blocked while
 * `tools_changed_at > tools_approved_at`. Approving therefore used to mean
 * "stamp now", which approves whatever the tools happen to be at that instant,
 * not what the owner was looking at:
 *
 *   1. owner opens the diff and sees tool list A
 *   2. a deploy lands, tools become list B, tools_changed_at moves
 *   3. owner clicks Approve — tools_approved_at is now LATER than the change
 *   4. list B is approved and nobody ever read it
 *
 * The whole point of the control is that a human sees the new descriptions,
 * because a tool description is an instruction the calling model obeys. An
 * approval that can attach to an unseen list is not that control.
 *
 * `tools_hash` is the fingerprint the review dialog rendered. Requiring it
 * closes the window: if the fingerprint moved between render and click, the
 * approval is refused and the owner re-reads the diff. Optional so an older
 * client keeps working, but a supplied-and-stale hash is always rejected.
 */
export const mcpAppApproveTools = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), tools_hash: z.string().max(200).optional() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;
    if (data.tools_hash && owned.app.tools_hash !== data.tools_hash) {
      return {
        ok: false,
        error:
          "The tool list changed while you were reviewing it. Reload and read the new one before approving.",
      };
    }
    const { error } = await context.supabase
      .from("mcp_apps")
      .update({ tools_approved_at: new Date().toISOString() })
      .eq("id", data.id)
      // Belt and braces: the row must still carry the fingerprint we checked,
      // so a deploy landing between the check and this write loses the race
      // rather than winning it silently.
      .eq("tools_hash", owned.app.tools_hash ?? "");
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: context.userId,
      action: "mcp_app.tools_approved",
      resourceType: "mcp_app",
      resourceId: data.id,
      resourceName: owned.app.name,
      detail: { tools_hash: owned.app.tools_hash ?? null },
    });
    return { ok: true };
  });

/**
 * Owner-only test console: call the sandbox directly.
 *
 * Deliberately does NOT go through /api/mcp/s/<slug>. Testing must work before
 * the server is exposed publicly and without minting a key you would then have
 * to remember to revoke.
 */
export const mcpAppTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        tool: z.string().max(200).optional(),
        args: z.record(z.string(), z.any()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true; result: any }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;

    const { ensureRunning, handshake } = await import("@/utils/mcpApps/service.server");
    const { MCP_SERVICE_PATH } = await import("@/utils/notebookRuntime/orchestrator");
    const started = await ensureRunning(owned.app);
    if (!started.ok) return { ok: false, error: started.message };

    if (!data.tool) {
      const shook = await handshake(started.endpoint);
      return shook.ok ? { ok: true, result: shook.tools } : { ok: false, error: shook.message };
    }

    // A fresh session per test call: the console is stateless, and reusing one
    // would make results depend on the order the user happened to click.
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    const url = `${started.endpoint}${MCP_SERVICE_PATH}`;
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "agentswarms-test-console", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const sid = init.headers.get("Mcp-Session-Id");
    await init.text().catch(() => "");
    const withSession = sid ? { ...headers, "Mcp-Session-Id": sid } : headers;
    await fetch(url, {
      method: "POST",
      headers: withSession,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    const res = await fetch(url, {
      method: "POST",
      headers: withSession,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: data.tool, arguments: data.args ?? {} },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const parsed = parseJsonOrSse(await res.text(), res.headers.get("content-type") ?? "");
    if (parsed?.error?.message) return { ok: false, error: parsed.error.message };
    return { ok: true, result: parsed?.result ?? parsed };
  });

// ── Keys and exposure ───────────────────────────────────────────────────────

export type McpKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  tool_allowlist: string[];
  ip_allowlist: string[];
  is_active: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  use_count: number;
  created_at: string;
};

export const mcpAppKeysList = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true; keys: McpKeyRow[] }> => {
    const { data: rows, error } = await context.supabase
      .from("mcp_app_keys")
      .select(
        "id, name, key_prefix, tool_allowlist, ip_allowlist, is_active, expires_at, revoked_at, last_used_at, last_used_ip, use_count, created_at",
      )
      .eq("app_id", data.id)
      // The internal key is managed by the platform, not issued by the user.
      // Listing it would invite someone to revoke it and silently break every
      // agent that depends on the server.
      .eq("is_internal", false)
      .order("created_at", { ascending: false });
    if (error) return { ok: false, error: error.message };
    return { ok: true, keys: (rows ?? []) as McpKeyRow[] };
  });

export const mcpAppKeyCreate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(80),
        tool_allowlist: z.array(z.string().max(200)).max(100).optional(),
        ip_allowlist: z.array(z.string().max(64)).max(50).optional(),
        expires_at: z.string().datetime().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true; key: string; id: string }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;

    const plaintext = generateMcpApiKey();
    const { data: row, error } = await supabaseAdmin
      .from("mcp_app_keys")
      .insert({
        app_id: data.id,
        user_id: context.userId,
        name: data.name,
        key_hash: await hashMcpApiKey(plaintext),
        key_prefix: mcpKeyPrefix(plaintext),
        tool_allowlist: data.tool_allowlist ?? [],
        ip_allowlist: data.ip_allowlist ?? [],
        expires_at: data.expires_at ?? null,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Could not create the key" };

    auditEvent({
      userId: context.userId,
      action: "mcp_app.key_create",
      resourceType: "mcp_app",
      resourceId: data.id,
      resourceName: owned.app.name,
      detail: { key_id: row.id, name: data.name },
    });
    // The only time the plaintext leaves this function.
    return { ok: true, key: plaintext, id: row.id };
  });

export const mcpAppKeyRevoke = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), key_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    // Revoked, not deleted: the row is the record of whatever the key already
    // called, and last_used_at is how you notice one has leaked.
    const { error } = await context.supabase
      .from("mcp_app_keys")
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq("id", data.key_id)
      .eq("app_id", data.id);
    if (error) return { ok: false, error: error.message };
    auditEvent({
      userId: context.userId,
      action: "mcp_app.key_revoke",
      resourceType: "mcp_app",
      resourceId: data.id,
      detail: { key_id: data.key_id },
    });
    return { ok: true };
  });

export const mcpAppSetPublic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), is_public: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true; url: string | null }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;
    const { error } = await context.supabase
      .from("mcp_apps")
      .update({ is_public: data.is_public })
      .eq("id", data.id);
    if (error) return { ok: false, error: error.message };

    auditEvent({
      userId: context.userId,
      action: data.is_public ? "mcp_app.expose" : "mcp_app.unexpose",
      resourceType: "mcp_app",
      resourceId: data.id,
      resourceName: owned.app.name,
    });

    const { resolveInternalOrigin } = await import("@/utils/internalOrigin.server");
    return {
      ok: true,
      url: data.is_public ? `${resolveInternalOrigin()}/api/mcp/s/${owned.app.slug}` : null,
    };
  });

// ── Registration for this instance's agents ─────────────────────────────────

/**
 * Publish the server into `mcp_servers` so agents can call it.
 *
 * Writes an ordinary connected-server row pointing at our own endpoint, which
 * means `list_mcp_servers` / `mcp_list_tools` / `mcp_call_tool` pick it up with
 * no changes to the tool registry at all. The bearer token is a key flagged
 * `is_internal`, so it works even while the app is not exposed publicly and
 * never appears in the owner's key list to be revoked by accident.
 */
export const mcpAppRegisterInternal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true; server_id: string }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;
    const app = owned.app;

    if (app.status !== "ready") {
      return { ok: false, error: "Deploy the server successfully before registering it." };
    }

    const { resolveInternalOrigin } = await import("@/utils/internalOrigin.server");
    const endpoint = `${resolveInternalOrigin()}/api/mcp/s/${app.slug}`;

    // Preflight the endpoint through the SAME guard the agent tool will use at
    // call time. resolveInternalOrigin() falls back to loopback, which
    // `mcp_call_tool` refuses when an operator sets BLOCK_PRIVATE_NETWORK_FETCH
    // — so without this the registration would appear to succeed and every
    // agent call would fail later with an SSRF message that names neither this
    // feature nor its fix. Checked BEFORE any key is reissued, so a refusal
    // leaves an already-registered server working.
    const { assertPublicUrl } = await import("@/utils/ssrfGuard.server");
    const reachable = await assertPublicUrl(endpoint);
    if (!reachable.ok) {
      return {
        ok: false,
        error:
          `Agents could not reach this server at ${endpoint} — ${reachable.error}. ` +
          `Set PUBLIC_APP_URL to an address this instance can call itself on, then try again.`,
      };
    }

    // Reissue rather than reuse: we cannot read back a hashed key, so a
    // re-registration mints a fresh one and retires the old.
    await supabaseAdmin
      .from("mcp_app_keys")
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq("app_id", app.id)
      .eq("is_internal", true)
      .is("revoked_at", null);

    const plaintext = generateMcpApiKey();
    const { error: keyErr } = await supabaseAdmin.from("mcp_app_keys").insert({
      app_id: app.id,
      user_id: context.userId,
      name: "Internal (agents)",
      key_hash: await hashMcpApiKey(plaintext),
      key_prefix: mcpKeyPrefix(plaintext),
      is_internal: true,
    });
    if (keyErr) return { ok: false, error: keyErr.message };

    const { encryptMcpAuthToken } = await import("@/lib/mcp/auth.server");
    const enc = await encryptMcpAuthToken(plaintext);

    const payload = {
      user_id: context.userId,
      name: app.name,
      type: "custom" as const,
      endpoint,
      description: app.description || "Built with MCP Builder.",
      auth_type: "token" as const,
      auth_token: null,
      auth_token_enc: enc,
      status: "connected",
      tools_count: Array.isArray(app.tools) ? app.tools.length : 0,
      tools: app.tools as Database["public"]["Tables"]["mcp_servers"]["Insert"]["tools"],
      last_ping: new Date().toISOString(),
    };

    let serverId = app.registered_server_id as string | null;
    if (serverId) {
      const { error } = await supabaseAdmin.from("mcp_servers").update(payload).eq("id", serverId);
      if (error) serverId = null; // row was deleted from /mcp — fall through and recreate
    }
    if (!serverId) {
      const { data: row, error } = await supabaseAdmin
        .from("mcp_servers")
        .insert(payload)
        .select("id")
        .single();
      if (error || !row) return { ok: false, error: error?.message ?? "Could not register" };
      serverId = row.id;
    }

    await context.supabase
      .from("mcp_apps")
      .update({ registered_server_id: serverId })
      .eq("id", app.id);
    auditEvent({
      userId: context.userId,
      action: "mcp_app.register_internal",
      resourceType: "mcp_app",
      resourceId: app.id,
      resourceName: app.name,
    });
    return { ok: true, server_id: serverId };
  });

export const mcpAppUnregisterInternal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    const owned = await ownedApp(context.supabase, data.id);
    if (!owned.ok) return owned;
    await unregisterInternal(owned.app);
    await context.supabase
      .from("mcp_apps")
      .update({ registered_server_id: null })
      .eq("id", data.id);
    auditEvent({
      userId: context.userId,
      action: "mcp_app.unregister_internal",
      resourceType: "mcp_app",
      resourceId: data.id,
      resourceName: owned.app.name,
    });
    return { ok: true };
  });

/** Drop the mcp_servers row and retire the internal key it authenticated with. */
async function unregisterInternal(app: { id: string; registered_server_id: string | null }) {
  if (app.registered_server_id) {
    await supabaseAdmin.from("mcp_servers").delete().eq("id", app.registered_server_id);
  }
  await supabaseAdmin
    .from("mcp_app_keys")
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq("app_id", app.id)
    .eq("is_internal", true)
    .is("revoked_at", null);
}

// ── Versions ────────────────────────────────────────────────────────────────

export type McpVersionRow = {
  id: string;
  version: number;
  created_at: string;
  source_code: string;
  requirements: string;
};

export const mcpAppVersions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<Fail | { ok: true; versions: McpVersionRow[] }> => {
    const { data: rows, error } = await context.supabase
      .from("mcp_app_versions")
      .select("id, version, created_at, source_code, requirements")
      .eq("app_id", data.id)
      .order("version", { ascending: false })
      .limit(50);
    if (error) return { ok: false, error: error.message };
    return { ok: true, versions: (rows ?? []) as McpVersionRow[] };
  });

export const mcpAppRestoreVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), version_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }): Promise<Fail | { ok: true }> => {
    const { data: version } = await context.supabase
      .from("mcp_app_versions")
      .select("source_code, requirements")
      .eq("id", data.version_id)
      .eq("app_id", data.id)
      .maybeSingle();
    if (!version) return { ok: false, error: "Version not found" };

    // Restores the SOURCE only; the running container keeps serving the old
    // code until the user deploys, which is the same rule as any other edit.
    const { error } = await context.supabase
      .from("mcp_apps")
      .update({ source_code: version.source_code, requirements: version.requirements })
      .eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });
