// Server function for creating an MCP server row with its bearer token
// encrypted at rest. The browser used to insert mcp_servers directly (plaintext
// auth_token); it now posts here so the token is AES-GCM encrypted server-side
// and never stored in the clear. Imported by the client route, so the crypto
// helper is dynamically imported inside the handler.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const SaveSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["database", "filesystem", "git", "api", "custom"]),
  endpoint: z.string().min(1).max(2000),
  description: z.string().max(2000).optional().default(""),
  auth_type: z.enum(["none", "token"]).default("none"),
  auth_token: z.string().max(4000).optional().default(""),
});

export const saveMcpServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveSchema.parse(input))
  .handler(
    async ({ data, context }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
      const { supabase, userId } = context;
      const { encryptMcpAuthToken } = await import("./auth.server");

      // Only encrypt+store a token when the server actually uses bearer auth.
      const enc = data.auth_type === "token" ? await encryptMcpAuthToken(data.auth_token) : null;

      const { data: row, error } = await supabase
        .from("mcp_servers")
        .insert({
          user_id: userId,
          name: data.name,
          type: data.type,
          endpoint: data.endpoint,
          description: data.description || "Custom MCP server.",
          auth_type: data.auth_type,
          auth_token: null,
          auth_token_enc: enc,
          status: "connected",
          tools_count: 0,
          last_ping: new Date().toISOString(),
        })
        .select("id")
        .maybeSingle();

      if (error || !row) return { ok: false, error: error?.message ?? "Failed to add server" };
      return { ok: true, id: row.id };
    },
  );
