// GET /api/v1/models — what a gateway key may name in `model`.
//
// Agents are listed one per row as agent:<id>, with the name alias and the
// model behind them under `agentswarms`. Connected models cannot be
// enumerated (a provider catalogue runs to hundreds), so a "models" key sees
// its allow-list patterns as the hint of what it may call.
import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateGatewayKey,
  gatewayFail,
  gatewayJson,
  gatewayOptions,
  listGatewayModels,
} from "@/utils/gateway/api.server";

export const Route = createFileRoute("/api/v1/models")({
  server: {
    handlers: {
      OPTIONS: async () => gatewayOptions(),
      GET: async ({ request }) => {
        const auth = await authenticateGatewayKey(request);
        if (!auth.ok) return gatewayFail(auth.status, auth.code, auth.error);
        const data = await listGatewayModels(auth.key);
        return gatewayJson({ object: "list", data });
      },
    },
  },
});
