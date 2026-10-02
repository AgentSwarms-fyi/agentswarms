// GET /api/v1/metrics — the semantic models a gateway key may query,
// described for a client: names, labels, types, synonyms, sampled values,
// parameters and the grains and comparisons a time dimension accepts.
// Never the owner's SQL. A key needs the "metrics" scope; the list is the
// owner's own models plus the ones IAM shares with them, narrowed by the
// key's allow-list. See docs/AI_GATEWAY.md.
import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateGatewayKey,
  gatewayFail,
  gatewayJson,
  gatewayOptions,
} from "@/utils/gateway/api.server";
import { listGatewayMetrics, requireMetricsScope } from "@/utils/gateway/metrics.server";

export const Route = createFileRoute("/api/v1/metrics")({
  server: {
    handlers: {
      OPTIONS: async () => gatewayOptions(),
      GET: async ({ request }) => {
        const auth = await authenticateGatewayKey(request);
        if (!auth.ok) return gatewayFail(auth.status, auth.code, auth.error);
        const denied = requireMetricsScope(auth.key, request);
        if (denied) return denied;
        const data = await listGatewayMetrics(auth.key);
        return gatewayJson({ object: "list", data });
      },
    },
  },
});
