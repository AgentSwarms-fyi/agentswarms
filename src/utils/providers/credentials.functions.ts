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

const providerEnum = z.enum(["bedrock", "vertex", "anthropic", "azure_openai", "oci_genai", "qwen"]);

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
        try { JSON.parse(data.vertex.serviceAccountJson); }
        catch { throw new Error("Service account JSON is not valid JSON"); }
        credsPayload = { serviceAccountJson: data.vertex.serviceAccountJson } satisfies VertexCreds;
        configPayload = { projectId: data.vertex.projectId, location: data.vertex.location } satisfies VertexConfig;
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

    const { error } = await (supabaseAdmin.from("provider_credentials") as any)
      .upsert(
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
      .select("id, provider, label, default_model, config, last_test_status, last_test_error, last_tested_at, created_at, updated_at")
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
    return { ok: true };
  });

const TestSchema = z.object({ provider: providerEnum });
export const testProviderCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TestSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { decryptJson } = await import("./crypto.server");
    const { loadCredentialRow } = await import("./credentials.server");
    const { userId } = context;
    const row = await loadCredentialRow(userId, data.provider);
    if (!row) throw new Error("No credentials saved for this provider");

    const decrypted = await decryptJson<Record<string, unknown>>(
      (row.credentials as any).ciphertext,
      (row.credentials as any).iv,
    );
    const config = row.config as Record<string, unknown>;

    let status: "ok" | "error" = "ok";
    let errorMessage: string | null = null;
    try {
      switch (data.provider) {
        case "bedrock":
          if (!(decrypted as BedrockCreds).accessKeyId || !(decrypted as BedrockCreds).secretAccessKey)
            throw new Error("Missing access key id / secret");
          if (!(config as BedrockConfig).region) throw new Error("Missing region");
          break;
        case "vertex": {
          const sa = JSON.parse((decrypted as VertexCreds).serviceAccountJson);
          if (!sa.client_email || !sa.private_key)
            throw new Error("Service account JSON missing client_email/private_key");
          if (!(config as VertexConfig).projectId) throw new Error("Missing projectId");
          break;
        }
        case "anthropic":
          if (!(decrypted as AnthropicCreds).apiKey) throw new Error("Missing API key");
          break;
        case "azure_openai":
          if (!(decrypted as AzureCreds).apiKey) throw new Error("Missing API key");
          if (!(config as AzureConfig).endpoint) throw new Error("Missing endpoint URL");
          break;
        case "oci_genai": {
          const c = decrypted as OCICreds;
          if (!c.tenancyOcid?.startsWith("ocid1.tenancy.")) throw new Error("Invalid tenancyOcid");
          if (!c.userOcid?.startsWith("ocid1.user.")) throw new Error("Invalid userOcid");
          if (!c.fingerprint?.includes(":")) throw new Error("Invalid fingerprint");
          if (!c.privateKeyPem?.includes("PRIVATE KEY")) throw new Error("Missing PEM private key");
          const cfg = config as OCIConfig;
          if (!cfg.region) throw new Error("Missing region");
          if (!cfg.compartmentId?.startsWith("ocid1.compartment.") && !cfg.compartmentId?.startsWith("ocid1.tenancy."))
            throw new Error("Invalid compartmentId");
          break;
        }
        case "qwen":
          if (!(decrypted as QwenCreds).apiKey) throw new Error("Missing API key");
          break;
      }
    } catch (e) {
      status = "error";
      errorMessage = e instanceof Error ? e.message : "Unknown error";
    }

    await supabaseAdmin
      .from("provider_credentials")
      .update({
        last_test_status: status,
        last_test_error: errorMessage,
        last_tested_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("provider", data.provider);

    return { status, error: errorMessage };
  });
