// Server functions for managing per-user provider credentials.
// IMPORTANT: This file is imported by client routes — only re-export createServerFn handlers.
// Server-only helpers (crypto, adapters, supabaseAdmin) are imported INSIDE handlers
// via dynamic import so they don't end up in the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { cloudRegion } from "@/utils/providers/cloudRegion";
import {
  networkPathFieldText,
  parseOrExplain,
  saveFieldText,
} from "@/utils/providers/credentialFieldErrors";
import {
  azureEndpointProblem,
  providerEndpoint,
  providerOrigin,
} from "@/utils/providers/privateEndpoint";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import type {
  AnthropicCreds,
  AzureConfig,
  AzureCreds,
  ClaudeAwsConfig,
  ClaudeAwsCreds,
  BedrockConfig,
  BedrockCreds,
  OCIConfig,
  OCICreds,
  QwenConfig,
  QwenCreds,
  VertexConfig,
  VertexCreds,
} from "./types";

const providerEnum = z.enum([
  "bedrock",
  "vertex",
  "anthropic",
  "azure_openai",
  "oci_genai",
  "qwen",
  "claude_aws",
]);

const SaveSchema = z.object({
  provider: providerEnum,
  label: z.string().max(80).optional(),
  defaultModel: z.string().max(200).optional(),
  bedrock: z
    .object({
      region: z.string().min(1).max(40),
      accessKeyId: z.string().min(4).max(128),
      secretAccessKey: z.string().min(4).max(256),
      sessionToken: z.string().max(4096).optional(),
      endpoint: z.string().max(300).optional(),
      requirePrivate: z.boolean().optional(),
    })
    .optional(),
  vertex: z
    .object({
      projectId: z.string().min(1).max(120),
      location: z.string().min(1).max(40),
      serviceAccountJson: z.string().min(20).max(20000),
      endpoint: z.string().max(300).optional(),
      requirePrivate: z.boolean().optional(),
    })
    .optional(),
  anthropic: z
    .object({
      apiKey: z.string().min(10).max(256),
    })
    .optional(),
  azure_openai: z
    .object({
      endpoint: z.string().url().max(300),
      apiKey: z.string().min(10).max(256),
      apiVersion: z.string().max(50).optional(),
      requirePrivate: z.boolean().optional(),
    })
    .optional(),
  oci_genai: z
    .object({
      region: z.string().min(1).max(60),
      compartmentId: z.string().min(10).max(300),
      tenancyOcid: z.string().min(10).max(300),
      userOcid: z.string().min(10).max(300),
      fingerprint: z.string().min(10).max(120),
      privateKeyPem: z.string().min(40).max(20000),
      style: z.enum(["GENERIC", "COHERE"]).optional(),
      endpoint: z.string().max(300).optional(),
      requirePrivate: z.boolean().optional(),
    })
    .optional(),
  qwen: z
    .object({
      apiKey: z.string().min(10).max(256),
      baseUrl: z.string().url().max(300).optional(),
    })
    .optional(),
  claude_aws: z
    .object({
      region: z.string().min(1).max(40),
      workspaceId: z
        .string()
        .regex(/^wrkspc_[A-Za-z0-9]+$/, "Workspace ID looks like wrkspc_01AbCdEf23GhIj"),
      apiKey: z.string().max(512).optional(),
      accessKeyId: z.string().max(128).optional(),
      secretAccessKey: z.string().max(256).optional(),
      sessionToken: z.string().max(4096).optional(),
      endpoint: z.string().max(300).optional(),
      requirePrivate: z.boolean().optional(),
    })
    .optional(),
});

/**
 * The operator's default for "require a private network path" on NEW
 * provider integrations (GENAI_REQUIRE_PRIVATE). Never applied to an
 * existing integration; read server-side only.
 */
function requirePrivateDefault(): boolean {
  return /^(1|true|yes)$/i.test(process.env.GENAI_REQUIRE_PRIVATE ?? "");
}

/** The defaults the provider dialog starts a new integration with. */
export const getPrivateConnectivityDefaults = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ requirePrivateDefault: requirePrivateDefault() }));

/**
 * Which network path a cloud provider's calls would take from this server —
 * via the proxy, or direct to a private or public address — for the
 * endpoint (or region) in the form. Needs no credentials and sends no
 * request to the provider: it resolves the name and reads the proxy settings,
 * so it can be checked before anything is saved.
 */
export const checkProviderNetworkPath = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    parseOrExplain(
      z.object({
        provider: z.enum(["bedrock", "vertex", "oci_genai", "azure_openai", "claude_aws"]),
        region: z.string().max(60).optional(),
        endpoint: z.string().max(300).optional(),
      }),
      input,
      networkPathFieldText,
    ),
  )
  .handler(async ({ data }) => {
    try {
      let origin: string;
      if (data.provider === "azure_openai") {
        const raw = (data.endpoint ?? "").trim();
        let u: URL;
        try {
          u = new URL(raw);
        } catch {
          throw new Error("Enter the Azure endpoint URL first");
        }
        if (u.protocol !== "https:") throw new Error("The Azure endpoint must use https");
        const problem = azureEndpointProblem(raw);
        if (problem) throw new Error(problem);
        origin = u.origin;
      } else {
        origin = providerOrigin(data.provider, { region: data.region, endpoint: data.endpoint });
      }
      const { describeConnectivity } = await import("./connectivityPath.server");
      return {
        ok: true as const,
        origin,
        path: await describeConnectivity(origin, { tls: true }),
      };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

// A schema failure reads as one sentence per field, named as the dialog names
// it — `SaveSchema.parse` put the ZodError's issue JSON in the toast.
export const saveProviderCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => parseOrExplain(SaveSchema, input, saveFieldText))
  .handler(async ({ data, context }) => {
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    let credsPayload: unknown = {};
    // Plain settings (URLs, regions, names): JSON, as the config column holds it.
    let configPayload: { [key: string]: Json | undefined } = {};

    switch (data.provider) {
      case "bedrock": {
        if (!data.bedrock) throw new Error("Bedrock fields required");
        credsPayload = {
          accessKeyId: data.bedrock.accessKeyId,
          secretAccessKey: data.bedrock.secretAccessKey,
          sessionToken: data.bedrock.sessionToken || undefined,
        } satisfies BedrockCreds;
        configPayload = {
          region: data.bedrock.region,
          endpoint: providerEndpoint("bedrock", data.bedrock.endpoint),
          requirePrivate: data.bedrock.requirePrivate ?? requirePrivateDefault(),
        } satisfies BedrockConfig;
        break;
      }
      case "vertex": {
        if (!data.vertex) throw new Error("Vertex fields required");
        try {
          JSON.parse(data.vertex.serviceAccountJson);
        } catch {
          throw new Error("Service account JSON is not valid JSON");
        }
        credsPayload = { serviceAccountJson: data.vertex.serviceAccountJson } satisfies VertexCreds;
        configPayload = {
          projectId: data.vertex.projectId,
          location: data.vertex.location,
          endpoint: providerEndpoint("vertex", data.vertex.endpoint),
          requirePrivate: data.vertex.requirePrivate ?? requirePrivateDefault(),
        } satisfies VertexConfig;
        break;
      }
      case "anthropic": {
        if (!data.anthropic) throw new Error("Anthropic fields required");
        credsPayload = { apiKey: data.anthropic.apiKey } satisfies AnthropicCreds;
        configPayload = {};
        break;
      }
      case "azure_openai": {
        if (!data.azure_openai) throw new Error("Azure fields required");
        const azureProblem = azureEndpointProblem(data.azure_openai.endpoint);
        if (azureProblem) throw new Error(azureProblem);
        credsPayload = { apiKey: data.azure_openai.apiKey } satisfies AzureCreds;
        configPayload = {
          endpoint: data.azure_openai.endpoint,
          apiVersion: data.azure_openai.apiVersion || undefined,
          requirePrivate: data.azure_openai.requirePrivate ?? requirePrivateDefault(),
        } satisfies AzureConfig;
        break;
      }
      case "oci_genai": {
        if (!data.oci_genai) throw new Error("OCI fields required");
        const o = data.oci_genai;
        if (!o.privateKeyPem.includes("BEGIN") || !o.privateKeyPem.includes("PRIVATE KEY")) {
          throw new Error("Private key must be a PEM-encoded RSA key");
        }
        credsPayload = {
          tenancyOcid: o.tenancyOcid,
          userOcid: o.userOcid,
          fingerprint: o.fingerprint,
          privateKeyPem: o.privateKeyPem,
        } satisfies OCICreds;
        configPayload = {
          region: o.region,
          compartmentId: o.compartmentId,
          style: o.style ?? "GENERIC",
          endpoint: providerEndpoint("oci_genai", o.endpoint),
          requirePrivate: o.requirePrivate ?? requirePrivateDefault(),
        } satisfies OCIConfig;
        break;
      }
      case "claude_aws": {
        if (!data.claude_aws) throw new Error("Claude Platform on AWS fields required");
        const c = data.claude_aws;
        const apiKey = c.apiKey?.trim();
        const keys = c.accessKeyId?.trim() && c.secretAccessKey?.trim();
        if (!apiKey && !keys) {
          throw new Error("Enter an API key, or an access key ID and secret access key");
        }
        credsPayload = apiKey
          ? ({ apiKey } satisfies ClaudeAwsCreds)
          : ({
              accessKeyId: c.accessKeyId!.trim(),
              secretAccessKey: c.secretAccessKey!.trim(),
              sessionToken: c.sessionToken?.trim() || undefined,
            } satisfies ClaudeAwsCreds);
        configPayload = {
          region: cloudRegion(c.region, "Claude Platform on AWS region"),
          workspaceId: c.workspaceId,
          endpoint: providerEndpoint("claude_aws", c.endpoint),
          requirePrivate: c.requirePrivate ?? requirePrivateDefault(),
        } satisfies ClaudeAwsConfig;
        break;
      }
      case "qwen": {
        if (!data.qwen) throw new Error("Qwen fields required");
        credsPayload = { apiKey: data.qwen.apiKey } satisfies QwenCreds;
        configPayload = {
          baseUrl: data.qwen.baseUrl || undefined,
        } satisfies QwenConfig;
        break;
      }
    }

    const enc = await encryptJson(credsPayload);

    const { error } = await supabaseAdmin.from("provider_credentials").upsert(
      {
        user_id: userId,
        provider: data.provider,
        label: data.label || "",
        default_model: data.defaultModel || null,
        credentials: enc,
        config: configPayload,
        last_test_status: null,
        last_test_error: null,
        last_tested_at: null,
      },
      { onConflict: "user_id,provider" },
    );
    if (error) throw new Error(error.message);
    // Service-role write — the client-write DB trigger skips it, so this path
    // must self-audit. Names and non-secret config only, never key material.
    const { auditEvent } = await import("@/utils/audit.server");
    auditEvent({
      userId,
      action: "provider_credential.save",
      resourceType: "provider_credential",
      resourceName: data.provider,
      detail: { provider: data.provider, label: data.label || "", ...configPayload },
    });
    return { ok: true };
  });

export const listProviderCredentials = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(() => ({}))
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    const { data, error } = await supabaseAdmin
      .from("provider_credentials")
      .select(
        "id, provider, label, default_model, config, last_test_status, last_test_error, last_tested_at, created_at, updated_at",
      )
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { credentials: data ?? [] };
  });

const DeleteSchema = z.object({ provider: providerEnum });
export const deleteProviderCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => parseOrExplain(DeleteSchema, input, saveFieldText))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    const { error } = await supabaseAdmin
      .from("provider_credentials")
      .delete()
      .eq("user_id", userId)
      .eq("provider", data.provider);
    if (error) throw new Error(error.message);
    const { auditEvent } = await import("@/utils/audit.server");
    auditEvent({
      userId,
      action: "provider_credential.delete",
      resourceType: "provider_credential",
      resourceName: data.provider,
      detail: { provider: data.provider },
    });
    return { ok: true };
  });

// A `testProviderCredential` server function used to live here. It was never
// called by anything, and it did not test a credential: it checked that the
// saved fields were non-empty and shaped plausibly — an OCID starting with
// "ocid1.tenancy.", a PEM containing "PRIVATE KEY" — and then wrote
// last_test_status = "ok" to provider_credentials.
//
// A wrong-but-well-formed API key passed. Wiring that to a "Test" button, which
// is the obvious next thing for someone to do with a function of that name,
// would have produced a green tick that means nothing. Removed rather than
// left as a trap.
//
// The integrations table has real tests (testIntegrationKey -> testAdapters
// .server.ts) that make an actual authenticated roundtrip before the
// "Connected" badge appears. Cloud provider credentials — bedrock, vertex,
// azure_openai, oci_genai, anthropic, qwen — have no equivalent. Building one
// means a minimal real call through each existing chat adapter; it is a
// feature, not a repair, so it is not being invented here.
