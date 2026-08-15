// Server functions for configuring signed viewers on an embed key.
//
// The signing secret is the whole security boundary, so it is minted, shown
// and stored here rather than in the browser: the client receives the
// plaintext exactly once, in the response that creates it, and what lands in
// the row is ciphertext under the provider-credentials envelope. There is no
// "show me the secret again" — the owner rotates instead, which is the same
// answer every other credential in this product gives.
//
// Ownership is verified server-side on every call. The access token is the
// only thing trusted from the caller.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { auditEvent } from "@/utils/audit.server";
import { encryptViewerSecret, generateViewerSecret } from "@/utils/embedViewer.server";

async function requireEmbedKeyOwner(accessToken: string, embedKeyId: string) {
  const { data: auth, error: authErr } = await supabaseAdmin.auth.getUser(accessToken);
  if (authErr || !auth.user) throw new Error("Unauthorized");
  const { data, error } = await supabaseAdmin
    .from("embed_keys")
    .select("id, user_id, name, resource_type, viewer_secret")
    .eq("id", embedKeyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Embed key not found");
  if (data.user_id !== auth.user.id) throw new Error("Only the owner can change this embed");
  return data;
}

/** Attribute names double as widget column names, so keep them SQL-ish. */
const ATTRIBUTE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const embedSetSignedViewer = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      accessToken: z.string().min(10),
      embedKeyId: z.string().uuid(),
      enabled: z.boolean(),
      /** Attribute names every viewer token must carry. */
      attributes: z.array(z.string()).max(8),
      /** Mint a new secret, invalidating every token the host already issued. */
      regenerate: z.boolean().optional(),
    }),
  )
  .handler(
    async ({
      data,
    }): Promise<{ secret?: string; attributes: string[]; requireSignedViewer: boolean }> => {
      const row = await requireEmbedKeyOwner(data.accessToken, data.embedKeyId);

      const attributes = [
        ...new Set(data.attributes.map((a) => a.trim()).filter(Boolean)),
      ] as string[];
      for (const a of attributes) {
        if (!ATTRIBUTE_RE.test(a)) {
          throw new Error(
            `"${a}" is not a usable attribute name. Each one must match a column in your widget ` +
              `results: letters, digits and underscores, not starting with a digit.`,
          );
        }
      }

      if (data.enabled) {
        if (row.resource_type !== "bi_dashboard") {
          // Nothing enforces per-viewer scoping on an agent or swarm embed,
          // so offering the switch there would be a badge vouching for
          // nothing. The DB refuses it too.
          throw new Error("Signed viewers apply to dashboard embeds only.");
        }
        if (attributes.length === 0) {
          throw new Error(
            "Name at least one viewer attribute. Without one, a valid token would unlock the " +
              "whole dashboard rather than one customer's slice of it.",
          );
        }
      }

      // A secret is minted when asked for, and whenever enabling a key that
      // has none — never silently reused across a rotation.
      const needsSecret = data.regenerate || (data.enabled && !row.viewer_secret);
      const secret = needsSecret ? generateViewerSecret() : undefined;

      const { error } = await supabaseAdmin
        .from("embed_keys")
        .update({
          require_signed_viewer: data.enabled,
          viewer_attributes: attributes,
          ...(secret ? { viewer_secret: await encryptViewerSecret(secret) } : {}),
        })
        .eq("id", data.embedKeyId);
      if (error) throw new Error(error.message);

      // Rotating a signing secret breaks every token the host has already
      // minted, and turning the requirement off makes a per-customer embed
      // public. Both belong in the audit log.
      void auditEvent({
        userId: row.user_id,
        action: data.enabled ? "embed.signed_viewer.enabled" : "embed.signed_viewer.disabled",
        resourceType: "embed_key",
        resourceId: row.id,
        resourceName: row.name,
        detail: { attributes, secret_rotated: Boolean(secret) },
      });

      return { secret, attributes, requireSignedViewer: data.enabled };
    },
  );
