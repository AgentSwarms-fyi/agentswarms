// Credentials for writing BACK to a SaaS tool.
//
// A reverse-ETL target writes through a connection that already exists — the
// same one that syncs contacts in syncs them back out. That is not just
// convenience: the alternative is asking someone to paste a second copy of the
// same CRM token into a pipeline node, which doubles the number of places a
// credential lives for no benefit at all.
//
// Nothing here is ever sent to a browser. The token is resolved as the
// pipeline's owner at run start, injected into the sandbox's environment, and
// pushed onto the run's scrub list so it cannot appear in a log line.
import type { SaasConfig } from "./types";
import { normaliseInstanceUrl, salesforceAuth } from "./salesforce.server";

/** The host and bearer token a SaaS write target needs. */
export async function saasWriteAuth(
  cfg: SaasConfig,
): Promise<{ base: string; token: string; vendor: string }> {
  // Narrowed on the provider itself rather than through a helper: the union
  // is what carries each provider's own fields, and a type guard over the
  // string would leave every one of them as `never`.
  if (cfg.provider === "hubspot") {
    if (!cfg.access_token) throw new Error("That HubSpot connection has no access token");
    return { base: "https://api.hubapi.com", token: cfg.access_token, vendor: "hubspot" };
  }
  if (cfg.provider !== "salesforce") {
    // Read-only by design rather than by omission: a Stripe charge or a Jira
    // issue created by a nightly pipeline is a different kind of decision from
    // updating a CRM record, and this is not the door for it.
    throw new Error(
      `${cfg.provider} connections can be read from but not written to. Writable destinations: HubSpot, Salesforce.`,
    );
  }
  // Salesforce mints a short-lived token per run from the connected app's
  // client credentials, and answers with the org's real instance URL — which
  // can differ from the configured login host on sandboxes and My Domain
  // redirects, so the returned one is the one to write to.
  const { token, instance } = await salesforceAuth({
    provider: "salesforce",
    instance_url: normaliseInstanceUrl(cfg.instance_url),
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
  });
  return { base: instance, token, vendor: "salesforce" };
}

/**
 * The host a target will talk to, for the egress allow-list.
 *
 * Worth knowing without authenticating: the run fails at the proxy long before
 * it fails at the API, and "api.hubapi.com is not on the allow-list" is a much
 * better error than a bare 403 from a proxy nobody remembers is there.
 */
export function saasWriteHost(cfg: SaasConfig): string | null {
  if (cfg.provider === "hubspot") return "api.hubapi.com";
  if (cfg.provider === "salesforce") {
    try {
      return new URL(normaliseInstanceUrl(cfg.instance_url)).host;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Load a connection to write through, as the pipeline's owner.
 *
 * OWNER-ONLY, deliberately — a connection shared through IAM can be READ from
 * (that is what a share is for) but not written to. Pushing records into
 * somebody else's CRM is a larger step than reading rows out of it, and the
 * share was granted for the latter. If that turns out to be needed it should
 * be its own grant, not a side effect of this one.
 *
 * The stored config is encrypted at rest; this is the only place a reverse-ETL
 * run decrypts it, and the plaintext goes straight into the sandbox's
 * environment and the run's scrub list.
 */
export async function loadWritableConnection(
  userId: string,
  connectionId: string,
): Promise<{ name: string; config: SaasConfig }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { decryptJson } = await import("@/utils/providers/crypto.server");
  const { data: row } = await supabaseAdmin
    .from("saas_connections")
    .select("name, config, is_active")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) throw new Error("that SaaS connection does not exist for this account");
  if (!row.is_active) throw new Error(`the SaaS connection "${row.name}" is disabled`);
  const enc = row.config as { ciphertext?: string; iv?: string };
  if (!enc?.ciphertext || !enc?.iv) {
    throw new Error(`the SaaS connection "${row.name}" has no stored credentials`);
  }
  return { name: row.name, config: await decryptJson<SaasConfig>(enc.ciphertext, enc.iv) };
}
