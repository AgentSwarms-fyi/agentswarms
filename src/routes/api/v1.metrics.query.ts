// POST /api/v1/metrics/query — one governed metric query over HTTP.
//
// The body names a semantic model and the metrics, dimensions, filters,
// grains, ordering, comparison and parameters to apply; the answer is the
// rows, the compiled SQL and whether the result was cut at the cap. The
// query runs through the semantic layer's own chokepoint as the key's
// owner, so the definitions, the share policies and the audit row are the
// ones a dashboard tile or the metric_query agent tool would produce.
import { createFileRoute } from "@tanstack/react-router";
import { authenticateGatewayKey, gatewayFail, gatewayOptions } from "@/utils/gateway/api.server";
import { requireMetricsScope, runGatewayMetricsQuery } from "@/utils/gateway/metrics.server";

export const Route = createFileRoute("/api/v1/metrics/query")({
  server: {
    handlers: {
      OPTIONS: async () => gatewayOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateGatewayKey(request);
        if (!auth.ok) return gatewayFail(auth.status, auth.code, auth.error);
        const denied = requireMetricsScope(auth.key, request);
        if (denied) return denied;
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return gatewayFail(400, "invalid_request_error", "Invalid JSON body");
        }
        return runGatewayMetricsQuery({ request, key: auth.key, body });
      },
    },
  },
});
