// Server functions for managing per-user provider credentials.
// IMPORTANT: This file is imported by client routes — only re-export createServerFn handlers.
// Server-only helpers (crypto, adapters, supabaseAdmin) are imported INSIDE handlers
// via dynamic import so they don't end up in the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  AnthropicCreds,
  AzureConfig,
  AzureCreds,
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
    })
    .optional(),
  vertex: z
    .object({
      projectId: z.string().min(1).max(120),
      location: z.string().min(1).max(40),
      serviceAccountJson: z.string().min(20).max(20000),
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
    })
    .optional(),
  qwen: z
    .object({
      apiKey: z.string().min(10).max(256),
      baseUrl: z.string().url().max(300).optional(),
    })
    .optional(),
});

export const saveProviderCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    let credsPayload: unknown = {};
    let configPayload: Record<string, unknown> = {};

    switch (data.provider) {
      case "bedrock": {
        if (!data.bedrock) throw new Error("Bedrock fields required");
        credsPayload = {
          accessKeyId: data.bedrock.accessKeyId,
          secretAccessKey: data.bedrock.secretAccessKey,
          sessionToken: data.bedrock.sessionToken || undefined,
        } satisfies BedrockCreds;
        configPayload = { region: data.bedrock.region } satisfies BedrockConfig;
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
        credsPayload = { apiKey: data.azure_openai.apiKey } satisfies AzureCreds;
        configPayload = {
          endpoint: data.azure_openai.endpoint,
          apiVersion: data.azure_openai.apiVersion || undefined,
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
        } satisfies OCIConfig;
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

    const { error } = await (supabaseAdmin.from("provider_credentials") as any).upsert(
      {
        user_id: userId,
        provider: data.provider,
        label: data.label || "",
        default_model: data.defaultModel || null,
        credentials: enc as unknown as Record<string, unknown>,
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
  .inputValidator(() => ({}))
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
  .inputValidator((input: unknown) => DeleteSchema.parse(input))
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
