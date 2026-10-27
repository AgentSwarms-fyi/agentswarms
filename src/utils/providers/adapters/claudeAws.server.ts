// Claude Platform on AWS — Anthropic's Claude API, operated by Anthropic and
// billed through your AWS account — streamed back as OpenAI-style SSE.
//
// The wire format is the first-party Messages API at
// https://aws-external-anthropic.<region>.api.aws/v1/messages, with the
// workspace named in `anthropic-workspace-id`. Two ways to authenticate: an API
// key generated in the AWS console (sent as a Bearer token), or AWS access keys
// signed with SigV4 for the service `aws-external-anthropic` in the workspace's
// region. PrivateLink is supported, so the endpoint can be overridden with a
// private endpoint (privateEndpoint.ts), and it goes through providerFetch like
// every other provider call.
import type { ChatMessage, ClaudeAwsConfig, ClaudeAwsCreds } from "../types";
import { cloudRegion } from "../cloudRegion";
import { providerOrigin } from "../privateEndpoint";
import { anthropicSseResponse } from "./anthropic.server";
import { signRequest } from "./bedrock.server";
import { providerFetch } from "@/utils/ssrfGuard.server";

const SIGV4_SERVICE = "aws-external-anthropic";
const ANTHROPIC_VERSION = "2023-06-01";
const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]+$/;

/** The workspace id, or an error naming the expected shape. */
export function claudeAwsWorkspace(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!WORKSPACE_ID.test(v)) {
    throw new Error(
      `Workspace ID "${value ?? ""}" is not a Claude Platform on AWS workspace — expected something like wrkspc_01AbCdEf23GhIj`,
    );
  }
  return v;
}

export async function claudeAwsChatStream(args: {
  creds: ClaudeAwsCreds;
  config: ClaudeAwsConfig;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  // The workspace's region signs the request and names the default host;
  // there is no default region.
  const region = cloudRegion(config.region ?? "", "Claude Platform on AWS region");
  const workspaceId = claudeAwsWorkspace(config.workspaceId);
  const url = new URL(
    `${providerOrigin("claude_aws", { region, endpoint: config.endpoint })}/v1/messages`,
  );

  const body = JSON.stringify({
    model: modelId,
    max_tokens: maxTokens ?? 8192,
    temperature: temperature ?? 0.7,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
    stream: true,
  });

  let auth: Record<string, string>;
  if (creds.apiKey?.trim()) {
    auth = {
      "content-type": "application/json",
      authorization: `Bearer ${creds.apiKey.trim()}`,
    };
  } else if (creds.accessKeyId && creds.secretAccessKey) {
    // Signed for the host the request is sent to (the override, when set).
    auth = await signRequest({
      service: SIGV4_SERVICE,
      region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      method: "POST",
      host: url.host,
      path: url.pathname,
      body,
    });
  } else {
    throw new Error("Claude Platform on AWS needs an API key or AWS access keys.");
  }

  const upstream = await providerFetch(url.toString(), {
    method: "POST",
    headers: {
      ...auth,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-workspace-id": workspaceId,
    },
    body,
  });
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Claude Platform on AWS error [${upstream.status}]: ${t.slice(0, 300)}`);
  }
  return anthropicSseResponse(upstream);
}
