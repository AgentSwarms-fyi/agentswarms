// Client-callable RPC wrappers for the deterministic swarm nodes. The browser
// runtime imports this module for the executeHttpNode / executeToolNode stubs;
// the actual logic lives in swarmNodes.server.ts (server-only). The .server
// imports below are used only inside createServerFn handlers, so they are
// stripped from the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  runHttpNodeCore,
  runToolNodeCore,
  userScopedClient,
  TOOL_NODE_IDS,
} from "@/utils/swarmNodes.server";

async function userFromToken(accessToken: string | undefined): Promise<string | null> {
  if (!accessToken) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user.id;
}

export const executeHttpNode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        url: z.string().min(1),
        headers: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .max(40)
          .optional(),
        body: z.string().max(200_000).optional(),
        timeout_ms: z.number().int().min(1000).max(120_000).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: false; error: string } | { ok: true; status: number; body: string }> => {
      const userId = await userFromToken(data.access_token);
      if (!userId) return { ok: false, error: "Invalid session" };
      return runHttpNodeCore(userId, data);
    },
  );

export const executeToolNode = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        tool_id: z.enum(TOOL_NODE_IDS),
        args: z.record(z.string(), z.string()).default({}),
        knowledge_base_id: z.string().uuid().nullish(),
        sql_tables: z.array(z.string()).optional(),
        mcp_servers: z.array(z.string()).optional(),
        web_config: z.object({ provider: z.string(), api_key: z.string() }).partial().optional(),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: false; error: string } | { ok: true; result: string }> => {
      const userId = await userFromToken(data.access_token);
      if (!userId) return { ok: false, error: "Invalid session" };
      const sb = userScopedClient(data.access_token);
      if (!sb) return { ok: false, error: "Server is missing Supabase configuration" };
      return runToolNodeCore({ userId, authToken: data.access_token, sb }, data);
    },
  );
