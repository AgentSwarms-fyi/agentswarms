// POST /api/v1/chat/completions — the OpenAI-compatible front door.
//
// Any OpenAI SDK pointed at <origin>/api/v1 with a gateway key can talk to a
// saved agent (model = "agent:<id or name>") or a connected model
// (model = "<provider>/<model>"). The turn runs through /api/chat's internal
// channel as the key's owner, so IAM model rules, budgets, guardrails, tools,
// knowledge, traces and audit apply exactly as they do in the app; the
// gateway adds per-key scopes, rate limits, a fallback chain and the OpenAI
// response shape. See docs/AI_GATEWAY.md.
import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateGatewayKey,
  gatewayFail,
  gatewayOptions,
  runGatewayCompletion,
  type OpenAiChatRequest,
} from "@/utils/gateway/api.server";

export const Route = createFileRoute("/api/v1/chat/completions")({
  server: {
    handlers: {
      OPTIONS: async () => gatewayOptions(),
      POST: async ({ request }) => {
        const auth = await authenticateGatewayKey(request);
        if (!auth.ok) return gatewayFail(auth.status, auth.code, auth.error);
        let body: OpenAiChatRequest;
        try {
          body = (await request.json()) as OpenAiChatRequest;
        } catch {
          return gatewayFail(400, "invalid_request_error", "Invalid JSON body");
        }
        return runGatewayCompletion({ request, key: auth.key, body });
      },
    },
  },
});
