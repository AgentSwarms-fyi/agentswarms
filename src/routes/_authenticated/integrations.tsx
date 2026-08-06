import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WarehousesTab } from "@/components/integrations/WarehousesTab";
import { SaasSourcesTab } from "@/components/integrations/SaasSourcesTab";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Zap,
  Cloud,
  Brain,
  Server,
  Globe,
  Shield,
  Check,
  X,
  Settings2,
  Loader2,
  Boxes,
  Sparkles,
  HardDrive,
  Bell,
  Users,
} from "lucide-react";
import {
  testIntegrationKey,
  testN8nInstance,
  testFirecrawlKey,
  testLlmGateway,
  testNotificationChannel,
  listSharedProviders,
  saveIntegration,
} from "@/utils/integrations.functions";
import { saveProviderCredential } from "@/utils/providers/credentials.functions";
import { detectOllama } from "@/utils/providers/ollama.functions";
import { invalidateOllamaModels } from "@/hooks/use-ollama-models";

// Providers we can live-test against the real upstream API.
// bedrock/azure/vertex/oci use signed requests and live in the encrypted
// provider_credentials table — they go through saveProviderCredential which
// writes to that encrypted table.
const TESTABLE_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "openrouter",
  "groq",
  "qwen",
  "vllm",
  "nvidia",
  "ollama",
]);

// Providers whose credentials must be encrypted server-side (signed-request
// auth like SigV4/IAM/OAuth/SigV1). These never go to the plaintext
// `integrations` table — they route through saveProviderCredential and the
// encrypted `provider_credentials` table that the chat API reads from.
const ENCRYPTED_PROVIDERS = new Set(["bedrock", "azure_openai", "vertex_ai", "oci_genai"]);

// The chat API uses "vertex" as the provider id internally; the UI uses
// "vertex_ai" for legacy compatibility. Map between them.
function toEncryptedProviderId(
  uiId: string,
): "bedrock" | "vertex" | "azure_openai" | "oci_genai" | null {
  if (uiId === "bedrock") return "bedrock";
  if (uiId === "azure_openai") return "azure_openai";
  if (uiId === "vertex_ai") return "vertex";
  if (uiId === "oci_genai") return "oci_genai";
  return null;
}

// Map the snake_case form values to the camelCase shape expected by
// saveProviderCredential's zod SaveSchema. Returns either `{ data }` ready
// to pass to the server function, or `{ error }` with a user-facing message
// for missing required fields. The data shape mirrors SaveSchema in
// src/utils/providers/credentials.functions.ts — keep them in sync.
type EncryptedSaveData =
  | {
      provider: "bedrock";
      label?: string;
      defaultModel?: string;
      bedrock: {
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    }
  | {
      provider: "azure_openai";
      label?: string;
      defaultModel?: string;
      azure_openai: { endpoint: string; apiKey: string; apiVersion?: string };
    }
  | {
      provider: "vertex";
      label?: string;
      defaultModel?: string;
      vertex: { projectId: string; location: string; serviceAccountJson: string };
    }
  | {
      provider: "oci_genai";
      label?: string;
      defaultModel?: string;
      oci_genai: {
        region: string;
        compartmentId: string;
        tenancyOcid: string;
        userOcid: string;
        fingerprint: string;
        privateKeyPem: string;
        style?: "GENERIC" | "COHERE";
      };
    };
type EncryptedSavePayload = { data: EncryptedSaveData } | { error: string };
function buildEncryptedPayload(
  encId: "bedrock" | "vertex" | "azure_openai" | "oci_genai",
  uiId: string,
  config: Record<string, string>,
): EncryptedSavePayload {
  const trim = (s?: string) => (s ?? "").trim();
  switch (encId) {
    case "bedrock": {
      const region = trim(config.region);
      const accessKeyId = trim(config.access_key_id);
      const secretAccessKey = trim(config.secret_access_key);
      if (!region) return { error: "AWS region is required" };
      if (!accessKeyId) return { error: "Access Key ID is required" };
      if (!secretAccessKey) return { error: "Secret Access Key is required" };
      return {
        data: {
          provider: "bedrock",
          label: uiId,
          bedrock: {
            region,
            accessKeyId,
            secretAccessKey,
            sessionToken: trim(config.session_token) || undefined,
          },
        },
      };
    }
    case "azure_openai": {
      const endpoint = trim(config.endpoint);
      const apiKey = trim(config.api_key);
      if (!endpoint) return { error: "Azure endpoint URL is required" };
      if (!apiKey) return { error: "API Key is required" };
      // deployment_name is stored as defaultModel so the agent picker can
      // use it as the default — the Azure adapter takes the model id as
      // the deployment name directly.
      const deploymentName = trim(config.deployment_name);
      return {
        data: {
          provider: "azure_openai",
          label: uiId,
          defaultModel: deploymentName || undefined,
          azure_openai: {
            endpoint,
            apiKey,
            apiVersion: trim(config.api_version) || undefined,
          },
        },
      };
    }
    case "vertex": {
      const projectId = trim(config.project_id);
      const location = trim(config.region);
      const serviceAccountJson = trim(config.service_account_json);
      if (!projectId) return { error: "GCP Project ID is required" };
      if (!location) return { error: "Region is required" };
      if (!serviceAccountJson) return { error: "Service Account JSON is required" };
      return {
        data: {
          provider: "vertex",
          label: uiId,
          vertex: { projectId, location, serviceAccountJson },
        },
      };
    }
    case "oci_genai": {
      const region = trim(config.region);
      const compartmentId = trim(config.compartment_ocid);
      const tenancyOcid = trim(config.tenancy_ocid);
      const userOcid = trim(config.user_ocid);
      const fingerprint = trim(config.fingerprint);
      const privateKeyPem = trim(config.private_key);
      if (!region) return { error: "OCI region is required" };
      if (!compartmentId) return { error: "Compartment OCID is required" };
      if (!tenancyOcid) return { error: "Tenancy OCID is required" };
      if (!userOcid) return { error: "User OCID is required" };
      if (!fingerprint) return { error: "API Key Fingerprint is required" };
      if (!privateKeyPem) return { error: "Private Key (PEM) is required" };
      return {
        data: {
          provider: "oci_genai",
          label: uiId,
          oci_genai: {
            region,
            compartmentId,
            tenancyOcid,
            userOcid,
            fingerprint,
            privateKeyPem,
            style: "GENERIC",
          },
        },
      };
    }
  }
}

export const Route = createFileRoute("/_authenticated/integrations")({
  component: IntegrationsPage,
});

// Real provider logos (Simple Icons via jsdelivr — open-source SVGs).
// Keys are the LLM_PROVIDERS ids below. Anything not listed falls back to
// the lucide `icon` set on each provider entry. Mirrors the LOGO map on the
// Model Registry page so the two screens feel consistent.
// Provider logos are also colour-treated below: monochrome SVGs from Simple
// Icons get `dark:invert` so they read on dark backgrounds, while full-colour
// or raster logos (OpenRouter PNG) skip the invert.
const PROVIDER_LOGO: Record<string, string> = {
  // Local asset — OpenRouter's own /Logo.svg path 404s.
  openrouter: "/provider-logos/openrouter.png",
  // Simple Icons (monochrome, will be inverted in dark mode).
  openai: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/openai.svg",
  anthropic: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/anthropic.svg",
  gemini: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/googlegemini.svg",
  vertex_ai: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/googlecloud.svg",
  grok: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/x.svg",
  qwen: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/alibabacloud.svg",
  nvidia: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/nvidia.svg",
  bedrock: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/amazon.svg",
  azure_openai: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/microsoftazure.svg",
  oci_genai: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/oracle.svg",
  vllm: "https://huggingface.co/front/assets/huggingface_logo-noborder.svg",
  groq: "https://groq.com/favicon.ico",
};

// Logos that are full-colour or raster (favicons / coloured marks) — these
// must NOT receive the dark:invert treatment used for monochrome Simple Icons.
const PROVIDER_LOGO_COLOR = new Set(["openrouter", "groq", "vllm"]);

const LLM_PROVIDERS = [
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    icon: Sparkles,
    freeHighlight: true,
    description:
      "⭐ Generous free tier from NVIDIA — sign up at build.nvidia.com to get an `nvapi-...` key with thousands of free monthly requests. OpenAI-compatible endpoint serving Meta Llama 3.3, NVIDIA Nemotron 49B/70B, DeepSeek R1, Qwen QwQ, Mixtral, Gemma 3 and more. Perfect for learning agentic AI without burning credits.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "nvapi-..." },
      {
        key: "base_url",
        label: "Custom Base URL (optional)",
        type: "text",
        placeholder: "https://integrate.api.nvidia.com/v1",
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: Globe,
    recommended: true,
    freeHighlight: true,
    description:
      "One key, 200+ models from OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek, xAI and more. If your admin has configured a shared OpenRouter key, agents already work without connecting your own — add a key here to use your own account/billing instead. ⭐ Includes openrouter/free — a smart router that picks a free model at random with 200K context, perfect for experimentation and learning at zero cost.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "sk-or-v1-..." },
      {
        key: "base_url",
        label: "Custom Base URL (optional)",
        type: "text",
        placeholder: "https://openrouter.ai/api/v1",
      },
      {
        key: "http_referer",
        label: "HTTP-Referer (optional, for app attribution)",
        type: "text",
        placeholder: "https://your-app.com",
      },
      {
        key: "app_title",
        label: "App Title (optional, shown in OpenRouter analytics)",
        type: "text",
        placeholder: "AgentSwarms",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    icon: Brain,
    description: "The GPT-5 and GPT-4o families, o-series reasoning, Whisper and image models.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "sk-..." },
      {
        key: "organization_id",
        label: "Organization ID (optional)",
        type: "text",
        placeholder: "org-...",
      },
      {
        key: "base_url",
        label: "Custom Base URL (optional)",
        type: "text",
        placeholder: "https://api.openai.com/v1",
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    icon: Brain,
    description: "The Claude Opus, Sonnet and Haiku families via your Anthropic API key.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "sk-ant-..." },
      {
        key: "base_url",
        label: "Custom Base URL (optional)",
        type: "text",
        placeholder: "https://api.anthropic.com/v1/",
      },
      { key: "anthropic_version", label: "API Version", type: "text", placeholder: "2023-06-01" },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    icon: Globe,
    description: "Gemini via Google AI Studio native API.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "AQ... or AIza..." },
      {
        key: "project_id",
        label: "GCP Project ID (optional)",
        type: "text",
        placeholder: "my-project-id",
      },
    ],
  },
  {
    id: "grok",
    name: "Grok (xAI)",
    icon: Brain,
    description: "The Grok family from xAI, full-size and Mini.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "xai-..." },
      { key: "base_url", label: "API Base URL", type: "text", placeholder: "https://api.x.ai/v1" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    icon: Zap,
    description:
      "Ultra-fast LPU inference for Llama 3.3, Mixtral, Gemma 2, DeepSeek R1, Qwen 2.5 and more — often 500+ tokens/sec.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "gsk_..." },
      {
        key: "base_url",
        label: "Custom Base URL (optional)",
        type: "text",
        placeholder: "https://api.groq.com/openai/v1",
      },
    ],
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba DashScope)",
    icon: Brain,
    description:
      "Qwen Max, Plus, Turbo and Qwen2.5 family (incl. Coder 32B) via Alibaba DashScope's OpenAI-compatible endpoint. Get a key at bailian.console.aliyun.com.",
    fields: [
      { key: "api_key", label: "API Key", type: "password", placeholder: "sk-..." },
      {
        key: "base_url",
        label: "Custom Base URL (optional)",
        type: "text",
        placeholder:
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1 (use dashscope.aliyuncs.com for mainland China)",
      },
    ],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    icon: HardDrive,
    freeHighlight: true,
    description:
      "⭐ Run models fully locally, for free. If Ollama is running on this server we auto-detect it — connecting is one click. Otherwise point us at any reachable Ollama instance (IP + port). Installed models show up in every model picker automatically.",
    fields: [
      {
        key: "endpoint",
        label: "Server address (auto-detected when local)",
        type: "text",
        placeholder: "http://localhost:11434",
      },
    ],
  },
  {
    id: "vllm",
    name: "vLLM (self-hosted)",
    icon: Boxes,
    description:
      "Connect to your own vLLM server. High-throughput serving for any HuggingFace model with an OpenAI-compatible /v1 API. We probe /v1/models to validate.",
    fields: [
      {
        key: "base_url",
        label: "Server Base URL",
        type: "text",
        placeholder: "http://my-vllm:8000/v1",
      },
      {
        key: "api_key",
        label: "API Key (only if vLLM was started with --api-key)",
        type: "password",
        placeholder: "",
      },
      {
        key: "served_model_name",
        label: "Served Model Name (optional alias)",
        type: "text",
        placeholder: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      },
    ],
  },
  {
    id: "bedrock",
    name: "AWS Bedrock",
    icon: Cloud,
    description: "Access Claude, Titan, Llama, and more through AWS.",
    fields: [
      { key: "region", label: "AWS Region", type: "text", placeholder: "us-east-1" },
      { key: "access_key_id", label: "Access Key ID", type: "password", placeholder: "AKIA..." },
      { key: "secret_access_key", label: "Secret Access Key", type: "password", placeholder: "" },
      {
        key: "session_token",
        label: "Session Token (optional)",
        type: "password",
        placeholder: "",
      },
      { key: "profile", label: "AWS Profile (optional)", type: "text", placeholder: "default" },
    ],
  },
  {
    id: "azure_openai",
    name: "Azure OpenAI",
    icon: Cloud,
    description: "Azure-hosted OpenAI models with enterprise SLAs.",
    fields: [
      {
        key: "endpoint",
        label: "Azure Endpoint URL",
        type: "text",
        placeholder: "https://myresource.openai.azure.com",
      },
      { key: "api_key", label: "API Key", type: "password", placeholder: "" },
      { key: "deployment_name", label: "Deployment Name", type: "text", placeholder: "gpt-4o" },
      { key: "api_version", label: "API Version", type: "text", placeholder: "2024-02-15-preview" },
    ],
  },
  {
    id: "vertex_ai",
    name: "Google Vertex AI",
    icon: Cloud,
    description: "Enterprise Google AI with VPC, IAM, and Gemini models.",
    fields: [
      { key: "project_id", label: "GCP Project ID", type: "text", placeholder: "my-project-123" },
      { key: "region", label: "Region", type: "text", placeholder: "us-central1" },
      {
        key: "service_account_json",
        label: "Service Account Key (JSON)",
        type: "password",
        placeholder: '{"type": "service_account", ...}',
      },
      { key: "endpoint", label: "Custom Endpoint (optional)", type: "text", placeholder: "" },
    ],
  },
  {
    id: "oci_genai",
    name: "OCI Generative AI",
    icon: Shield,
    description: "Oracle Cloud generative AI with Cohere and Llama models.",
    fields: [
      {
        key: "compartment_ocid",
        label: "Compartment OCID",
        type: "text",
        placeholder: "ocid1.compartment.oc1..",
      },
      {
        key: "endpoint",
        label: "Service Endpoint",
        type: "text",
        placeholder: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com",
      },
      {
        key: "tenancy_ocid",
        label: "Tenancy OCID",
        type: "text",
        placeholder: "ocid1.tenancy.oc1..",
      },
      { key: "user_ocid", label: "User OCID", type: "text", placeholder: "ocid1.user.oc1.." },
      {
        key: "fingerprint",
        label: "API Key Fingerprint",
        type: "text",
        placeholder: "aa:bb:cc:...",
      },
      {
        key: "private_key",
        label: "Private Key (PEM)",
        type: "password",
        placeholder: "-----BEGIN PRIVATE KEY-----",
      },
      { key: "region", label: "Region", type: "text", placeholder: "us-chicago-1" },
    ],
  },
];

const GATEWAY_PROVIDERS = [
  { value: "litellm", label: "LiteLLM" },
  { value: "portkey", label: "Portkey" },
  { value: "helicone", label: "Helicone" },
  { value: "custom", label: "Custom Gateway" },
];

type Integration = {
  id: string;
  type: string;
  name: string;
  provider: string | null;
  config: Record<string, any>;
  is_active: boolean;
};

function IntegrationsPage() {
  const { user, session } = useAuth();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [gatewayProvider, setGatewayProvider] = useState("litellm");
  const [gatewayRoute, setGatewayRoute] = useState(false);
  const [gatewayRouteAll, setGatewayRouteAll] = useState(false);
  const [gatewayHasKey, setGatewayHasKey] = useState(false);
  const [gatewayTesting, setGatewayTesting] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [n8nUrl, setN8nUrl] = useState("");
  const [n8nToken, setN8nToken] = useState("");
  const [n8nAuthType, setN8nAuthType] = useState("header");
  const [n8nTesting, setN8nTesting] = useState(false);
  const [n8nStatus, setN8nStatus] = useState<{
    ok: boolean;
    detail: string;
    workflowCount?: number;
  } | null>(null);
  const [firecrawlKey, setFirecrawlKey] = useState("");
  const [firecrawlTesting, setFirecrawlTesting] = useState(false);
  const [firecrawlStatus, setFirecrawlStatus] = useState<{ ok: boolean; detail: string } | null>(
    null,
  );
  // Notification channels: per-kind URL drafts + test state.
  const [notifUrls, setNotifUrls] = useState<Record<string, string>>({});
  const [notifTesting, setNotifTesting] = useState<string | null>(null);
  const [notifStatus, setNotifStatus] = useState<
    Record<string, { ok: boolean; detail: string } | undefined>
  >({});
  // LLM credentials shared with this user via IAM grants (usable, not readable).
  const [sharedProviders, setSharedProviders] = useState<
    { provider: string; owner_email: string | null }[]
  >([]);

  useEffect(() => {
    loadIntegrations();
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      try {
        const res = await listSharedProviders({ data: { access_token: token } });
        if (res.ok) setSharedProviders(res.shared);
      } catch {
        /* non-critical */
      }
    })();
  }, []);

  async function loadIntegrations() {
    // Pull from both tables — encrypted providers live in provider_credentials
    // while OpenAI-compat providers live in integrations. We synthesize a
    // single Integration[] so the UI's `isProviderActive` / `isProviderSaved`
    // checks work uniformly across both storage paths.
    const [{ data: integ }, { data: creds }] = await Promise.all([
      supabase.from("integrations").select("*"),
      supabase
        .from("provider_credentials")
        .select("provider, last_test_status, default_model, config")
        .returns<
          Array<{
            provider: string;
            last_test_status: string | null;
            default_model: string | null;
            config: Record<string, unknown> | null;
          }>
        >(),
    ]);
    const merged: Integration[] = [];
    if (integ) merged.push(...(integ as Integration[]));
    if (creds) {
      for (const c of creds) {
        // Map back from internal "vertex" to UI's "vertex_ai".
        const uiId = c.provider === "vertex" ? "vertex_ai" : c.provider;
        merged.push({
          id: `enc-${uiId}`,
          type: "llm_provider",
          name: uiId,
          provider: uiId,
          config: { ...(c.config ?? {}), default_model: c.default_model ?? undefined },
          // Treat the credential as active unless an explicit failed test is on file.
          is_active: c.last_test_status !== "error",
        });
      }
    }
    setIntegrations(merged);
    const gw = merged.find((i) => i.type === "llm_gateway");
    if (gw) {
      const c = gw.config as Record<string, any>;
      setGatewayUrl(c?.base_url || "");
      // The key is write-only: encrypted rows never ship it back, and legacy
      // plaintext rows are no longer pre-filled into the form either.
      setGatewayKey("");
      setGatewayHasKey(Boolean(c?.api_key_enc || c?.api_key));
      setGatewayProvider(c?.provider || "litellm");
      setGatewayRoute(gw.is_active);
      setGatewayRouteAll(c?.route_all === true);
    }
    const n8n = merged.find((i) => i.type === "n8n");
    if (n8n) {
      const c = n8n.config as Record<string, any>;
      setN8nUrl(c?.instance_url || "");
      setN8nToken(c?.webhook_token || "");
      setN8nAuthType(c?.auth_type || "header");
    }
  }

  async function saveProvider(
    providerId: string,
    config: Record<string, string>,
  ): Promise<{ ok: boolean; detail?: string }> {
    if (!user) return { ok: false, detail: "Not signed in" };
    if (!session?.access_token)
      return { ok: false, detail: "Your session expired. Please sign in again." };

    // Encrypted providers (Bedrock/Azure/Vertex/OCI) route through the
    // dedicated server function that writes to the encrypted
    // provider_credentials table. The chat API reads from that table, so this
    // is the only path that makes them actually usable.
    if (ENCRYPTED_PROVIDERS.has(providerId)) {
      const encId = toEncryptedProviderId(providerId);
      if (!encId) return { ok: false, detail: `Unknown encrypted provider: ${providerId}` };
      try {
        const payload = buildEncryptedPayload(encId, providerId, config);
        if ("error" in payload) return { ok: false, detail: payload.error };
        await saveProviderCredential({ data: payload.data });
        toast.success(`${providerId} credentials saved (encrypted).`);
        loadIntegrations();
        return { ok: true, detail: "Saved to encrypted provider_credentials table." };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`Could not save: ${msg}`);
        return { ok: false, detail: msg };
      }
    }

    const normalizedConfig = Object.fromEntries(
      Object.entries(config).map(([key, value]) => {
        if (key !== "api_key") return [key, value];
        const normalized = value
          .trim()
          .replace(/^Bearer\s+/i, "")
          .replace(/^key=/i, "")
          .replace(/^["']+|["']+$/g, "");
        return [key, normalized];
      }),
    );

    // Live-test the credentials against the real upstream BEFORE marking
    // the integration as active. This is what makes the "Connected" badge
    // honest — it appears only when a real auth roundtrip succeeded.
    let testResult: { ok: boolean; detail: string } = {
      ok: true,
      detail: "Saved without live test",
    };
    if (TESTABLE_PROVIDERS.has(providerId)) {
      try {
        const raw = await testIntegrationKey({
          data: {
            provider: providerId as
              | "openai"
              | "anthropic"
              | "gemini"
              | "grok"
              | "openrouter"
              | "groq"
              | "qwen"
              | "vllm"
              | "nvidia"
              | "ollama",
            access_token: session.access_token,
            config: normalizedConfig,
          },
        });
        // Defensive: server should always return a TestResult, but if a future
        // change accidentally returns undefined, we don't want to render
        // "No response detail returned" — surface that fact explicitly.
        if (!raw || typeof raw !== "object") {
          testResult = { ok: false, detail: `Server returned no payload (${typeof raw})` };
        } else {
          // Log full raw response so we can inspect the exact server reply
          // when the surfaced detail is empty / unexpected.
          console.log("[saveProvider] testIntegrationKey raw response:", raw);
          testResult = {
            ok: !!raw.ok,
            detail:
              raw.detail ||
              (raw.ok
                ? "Saved"
                : `Server returned ok=false with empty detail. Full response: ${JSON.stringify(raw)}`),
          };
        }
      } catch (e) {
        const err = e as Error;
        // Log full error to the browser console so the user (and we) can see
        // exactly what failed when the surfaced message is unhelpful.
        console.error("[saveProvider] testIntegrationKey threw:", err);
        const name = err?.name || "Error";
        const msg = err?.message || String(e);
        testResult = { ok: false, detail: `${name}: ${msg}` };
      }
      if (!testResult.ok) {
        toast.error(`Could not connect: ${testResult.detail}`);
        // Save the config (encrypted server-side) but mark inactive so the user
        // can fix without retyping.
        const existingFail = integrations.find((i) => i.provider === providerId);
        await saveIntegration({
          data: {
            access_token: session.access_token,
            id: existingFail && !existingFail.id.startsWith("enc-") ? existingFail.id : undefined,
            type: "llm_provider",
            provider: providerId,
            name: LLM_PROVIDERS.find((p) => p.id === providerId)?.name || providerId,
            config: normalizedConfig,
            is_active: false,
          },
        });
        loadIntegrations();
        return { ok: false, detail: testResult.detail };
      }
    }

    const existing = integrations.find((i) => i.provider === providerId);
    const saveRes = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing && !existing.id.startsWith("enc-") ? existing.id : undefined,
        type: "llm_provider",
        provider: providerId,
        name: LLM_PROVIDERS.find((p) => p.id === providerId)?.name || providerId,
        config: normalizedConfig,
        is_active: true,
      },
    });
    // A passing live test is worthless if the row didn't persist — surface
    // save failures instead of showing a "Connected" toast over nothing.
    if (!saveRes.ok) {
      toast.error(`Could not save: ${saveRes.error}`);
      return { ok: false, detail: saveRes.error };
    }
    toast.success(`Connected — ${testResult.detail}`);
    loadIntegrations();
    return { ok: true, detail: testResult.detail };
  }

  async function disconnectProvider(providerId: string) {
    if (ENCRYPTED_PROVIDERS.has(providerId)) {
      const encId = toEncryptedProviderId(providerId);
      if (!encId) return;
      // Delete the encrypted credential row entirely — there is no "is_active"
      // flag in provider_credentials, only presence/absence.
      await supabase.from("provider_credentials").delete().eq("provider", encId);
      toast.success("Provider disconnected");
      loadIntegrations();
      return;
    }
    const existing = integrations.find((i) => i.provider === providerId);
    if (existing) {
      await supabase
        .from("integrations")
        .update({ is_active: false, config: {} })
        .eq("id", existing.id);
      toast.success("Provider disconnected");
      loadIntegrations();
    }
  }

  async function saveGateway() {
    if (!user) return;
    if (!session?.access_token) {
      toast.error("Your session expired. Please sign in again.");
      return;
    }
    if (!gatewayUrl.trim()) {
      toast.error("Gateway base URL is required");
      return;
    }
    setGatewayTesting(true);
    setGatewayStatus(null);

    // Activating a gateway (especially route-all) can redirect every LLM call
    // on this account, so ENABLING requires a passing live test — the same
    // honesty bar as every other connector. A disabled gateway saves untested
    // (parked config). Blank key = server tests against the saved key.
    let activate = gatewayRoute;
    let testResult: { ok: boolean; detail: string } | null = null;
    if (gatewayRoute) {
      try {
        testResult = await testLlmGateway({
          data: {
            access_token: session.access_token,
            base_url: gatewayUrl,
            api_key: gatewayKey,
            provider: gatewayProvider,
          },
        });
      } catch (e) {
        testResult = { ok: false, detail: e instanceof Error ? e.message : "Test request failed" };
      }
      setGatewayStatus(testResult);
      if (!testResult.ok) activate = false;
    }

    const existing = integrations.find((i) => i.type === "llm_gateway");
    // api_key is encrypted server-side; leaving the key field blank on an
    // existing gateway keeps the previously-saved key.
    const res = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing?.id,
        type: "llm_gateway",
        provider: gatewayProvider,
        name: "LLM Gateway",
        config: {
          base_url: gatewayUrl,
          api_key: gatewayKey,
          provider: gatewayProvider,
          route_all: gatewayRouteAll,
        },
        is_active: activate,
      },
    });
    setGatewayTesting(false);
    if (!res.ok) {
      toast.error(`Could not save gateway: ${res.error}`);
      return;
    }
    if (gatewayRoute && testResult && !testResult.ok) {
      setGatewayRoute(false);
      toast.error(`Gateway saved but left disabled — validation failed: ${testResult.detail}`);
    } else if (activate) {
      toast.success(`Gateway connected — ${testResult?.detail ?? "saved"}`);
    } else {
      toast.success("Gateway saved (disabled)");
    }
    if (gatewayKey.trim()) setGatewayHasKey(true);
    setGatewayKey("");
    loadIntegrations();
  }

  async function saveN8n() {
    if (!user) return;
    if (!session?.access_token) {
      toast.error("Please sign in again before testing n8n");
      return;
    }
    setN8nTesting(true);
    setN8nStatus(null);

    // Live-validate against /api/v1/workflows before persisting active=true,
    // so the "Connected" state on the n8n card reflects a real auth roundtrip.
    let testResult: { ok: boolean; detail: string; workflowCount?: number };
    try {
      testResult = await testN8nInstance({
        data: {
          access_token: session.access_token,
          instance_url: n8nUrl,
          webhook_token: n8nToken,
          auth_type: n8nAuthType as "header" | "basic" | "none",
        },
      });
    } catch (e) {
      testResult = { ok: false, detail: e instanceof Error ? e.message : "Test request failed" };
    }
    setN8nStatus(testResult);
    setN8nTesting(false);

    const existing = integrations.find((i) => i.type === "n8n");
    // webhook_token is encrypted server-side; a blank token on an existing n8n
    // integration keeps the previously-saved token.
    const n8nSave = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing?.id,
        type: "n8n",
        provider: "n8n",
        name: "n8n",
        config: {
          instance_url: n8nUrl,
          webhook_token: n8nToken,
          auth_type: n8nAuthType,
          last_test_status: testResult.ok ? "success" : "error",
          last_test_detail: testResult.detail,
          last_tested_at: new Date().toISOString(),
          workflow_count: testResult.workflowCount ?? null,
        },
        is_active: testResult.ok,
      },
    });
    if (!n8nSave.ok) {
      toast.error(`Could not save n8n: ${n8nSave.error}`);
    } else if (testResult.ok) {
      toast.success(`n8n connected — ${testResult.detail}`);
    } else {
      toast.error(`Could not connect to n8n: ${testResult.detail}`);
    }
    loadIntegrations();
  }

  async function saveFirecrawl() {
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) {
      toast.error("Please sign in again before saving Firecrawl");
      return;
    }
    const existing = integrations.find((i) => i.type === "firecrawl");
    const key = firecrawlKey.trim();
    // No new key + already connected ⇒ nothing to do (key is write-only).
    if (!key && !existing) {
      toast.error("Paste your Firecrawl API key first");
      return;
    }
    setFirecrawlTesting(true);
    setFirecrawlStatus(null);
    // Only live-test when a new key was entered (we can't read the stored one back).
    const testResult: { ok: boolean; detail: string } = key
      ? await testFirecrawlKey({ data: { access_token: session.access_token, api_key: key } })
      : { ok: true, detail: "Kept the saved key." };
    setFirecrawlStatus(testResult);
    if (key && !testResult.ok) {
      setFirecrawlTesting(false);
      toast.error(`Firecrawl: ${testResult.detail}`);
      return;
    }
    // api_key is encrypted server-side; a blank key on an existing row keeps
    // the previously-saved key.
    const fcSave = await saveIntegration({
      data: {
        access_token: session.access_token,
        id: existing?.id,
        type: "firecrawl",
        provider: "firecrawl",
        name: "Firecrawl",
        config: {
          api_key: key,
          last_test_status: testResult.ok ? "success" : "error",
          last_test_detail: testResult.detail,
          last_tested_at: new Date().toISOString(),
        },
        is_active: true,
      },
    });
    setFirecrawlKey("");
    setFirecrawlTesting(false);
    if (!fcSave.ok) {
      toast.error(`Could not save Firecrawl: ${fcSave.error}`);
      return;
    }
    toast.success("Firecrawl connected — web_search and web_browse are ready.");
    loadIntegrations();
  }

  async function saveNotifChannel(kind: "slack" | "teams" | "discord" | "webhook", label: string) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      toast.error("Please sign in again.");
      return;
    }
    const url = (notifUrls[kind] || "").trim();
    const existing = integrations.find((i) => i.type === "notification" && i.provider === kind);
    if (!url && !existing) {
      toast.error("Paste the webhook URL first.");
      return;
    }
    setNotifTesting(kind);
    setNotifStatus((s) => ({ ...s, [kind]: undefined }));
    // Always live-test before (re)activating — the test posts a visible
    // message with the exact payload real sends use. Blank URL re-tests the
    // saved (encrypted) one.
    let result: { ok: boolean; detail: string };
    try {
      result = await testNotificationChannel({
        data: { access_token: token, provider: kind, webhook_url: url },
      });
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : "Test failed" };
    }
    setNotifStatus((s) => ({ ...s, [kind]: result }));
    const res = await saveIntegration({
      data: {
        access_token: token,
        id: existing?.id,
        type: "notification",
        provider: kind,
        name: label,
        config: { webhook_url: url },
        is_active: result.ok,
      },
    });
    setNotifTesting(null);
    if (!res.ok) {
      toast.error(`Could not save: ${res.error}`);
      return;
    }
    if (result.ok) {
      toast.success(`${label} connected — check the channel for the test message.`);
      setNotifUrls((u) => ({ ...u, [kind]: "" }));
    } else {
      toast.error(`${label}: ${result.detail}`);
    }
    loadIntegrations();
  }

  async function disconnectNotifChannel(kind: string) {
    const existing = integrations.find((i) => i.type === "notification" && i.provider === kind);
    if (!existing) return;
    await supabase.from("integrations").update({ is_active: false }).eq("id", existing.id);
    toast.success("Channel disconnected");
    loadIntegrations();
  }

  const sharedFor = (id: string) => sharedProviders.find((s) => s.provider === id) ?? null;

  const isProviderActive = (id: string) =>
    integrations.some((i) => i.provider === id && i.is_active);
  const isProviderSaved = (id: string) => integrations.some((i) => i.provider === id);
  // Scheduled health checks stamp health_status/health_detail into config
  // (see utils/integrations/health.server.ts). Non-null = last check FAILED.
  const healthErrorFor = (match: (i: Integration) => boolean): string | null => {
    const i = integrations.find((x) => match(x) && x.is_active);
    if (!i || i.config?.health_status !== "error") return null;
    return String(i.config?.health_detail || "The last scheduled credential check failed.");
  };
  const providerHealthError = (id: string) =>
    healthErrorFor((i) => i.provider === id && i.type === "llm_provider");

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Integrations
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Integration Hub</h1>
          <p className="text-muted-foreground mt-1">
            Connect your LLM providers, gateways, and workflow tools.
          </p>
        </div>

        <Tabs defaultValue="llm" className="space-y-4">
          <TabsList>
            <TabsTrigger value="llm">LLM Providers</TabsTrigger>
            <TabsTrigger value="warehouses">Data Sources</TabsTrigger>
            <TabsTrigger value="apps">Apps</TabsTrigger>
            <TabsTrigger value="gateway">LLM Gateway</TabsTrigger>
            <TabsTrigger value="websearch">Web Search</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="n8n">n8n Workflows</TabsTrigger>
          </TabsList>

          <TabsContent value="warehouses" className="space-y-4">
            <WarehousesTab />
          </TabsContent>

          {/* Apps are SaaS sources pulled into datasets, as opposed to the
              Data Sources tab's databases, which are queried live. */}
          <TabsContent value="apps" className="space-y-4">
            <SaasSourcesTab />
          </TabsContent>

          <TabsContent value="llm" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {LLM_PROVIDERS.map((provider) => (
                <Card
                  key={provider.id}
                  className={`glow-card relative flex flex-col ${
                    (provider as any).freeHighlight
                      ? "border-primary/60 bg-primary/5 shadow-[0_0_0_1px_hsl(var(--primary)/0.2)]"
                      : "border-border/50"
                  }`}
                >
                  {provider.recommended && !(provider as any).freeHighlight && (
                    <Badge className="absolute -top-2.5 right-3 h-5 bg-primary px-1.5 text-[10px] text-primary-foreground shadow-sm">
                      Recommended
                    </Badge>
                  )}
                  {(provider as any).freeHighlight && (
                    <Badge className="absolute -top-2.5 right-3 h-5 bg-primary px-1.5 text-[10px] text-primary-foreground shadow-sm">
                      Free tier
                    </Badge>
                  )}
                  <CardHeader className="p-4 pb-2.5">
                    <div className="flex items-center gap-2">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-inset ring-border/50">
                        {PROVIDER_LOGO[provider.id] ? (
                          <img
                            src={PROVIDER_LOGO[provider.id]}
                            alt={provider.name}
                            className={`h-6 w-6 opacity-90 ${PROVIDER_LOGO_COLOR.has(provider.id) ? "" : "dark:invert"}`}
                            loading="lazy"
                            onError={(e) => {
                              // If the CDN logo fails, hide the img so the
                              // surrounding muted square still reads as an icon slot.
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <provider.icon className="h-4 w-4 text-primary" />
                        )}
                      </div>
                      <CardTitle className="text-base">{provider.name}</CardTitle>
                    </div>
                    <p
                      className="text-xs text-muted-foreground line-clamp-3"
                      title={provider.description}
                    >
                      {provider.description}
                    </p>
                    {isProviderActive(provider.id) ? (
                      providerHealthError(provider.id) ? (
                        <Badge
                          variant="outline"
                          className="w-fit text-warning border-warning/40"
                          title={providerHealthError(provider.id) ?? undefined}
                        >
                          <X className="h-3 w-3 mr-1" /> Connected — key failing health checks
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="w-fit text-primary border-primary/30">
                          <Check className="h-3 w-3 mr-1" /> Connected
                        </Badge>
                      )
                    ) : isProviderSaved(provider.id) ? (
                      <Badge variant="outline" className="w-fit text-warning border-warning/40">
                        <X className="h-3 w-3 mr-1" /> Saved — last test failed
                      </Badge>
                    ) : sharedFor(provider.id) ? (
                      <Badge
                        variant="outline"
                        className="w-fit text-primary border-primary/30"
                        title="An admin granted you use of this credential. Your agents can use it now; connecting your own key overrides it."
                      >
                        <Users className="h-3 w-3 mr-1" /> Shared with you
                        {sharedFor(provider.id)?.owner_email
                          ? ` by ${sharedFor(provider.id)!.owner_email}`
                          : ""}
                      </Badge>
                    ) : null}
                  </CardHeader>
                  <CardContent className="mt-auto p-4 pt-0">
                    {provider.fields.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No configuration needed. Ready to use.
                      </p>
                    ) : (
                      <div className="flex gap-2">
                        <ProviderConfigDialog provider={provider} onSave={saveProvider} />
                        {isProviderActive(provider.id) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={() => disconnectProvider(provider.id)}
                          >
                            <X className="h-3 w-3 mr-1" /> Disconnect
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="gateway" className="space-y-4">
            <Card className="border-border/50 max-w-lg">
              <CardHeader>
                <CardTitle>LLM Gateway</CardTitle>
                <CardDescription>
                  Route LLM traffic through a centralized gateway (LiteLLM, Portkey, Helicone, or
                  any OpenAI-compatible proxy) for logging, caching, and rate limiting. Two modes:
                  agents can opt in individually (agent editor → &ldquo;Route through
                  gateway&rdquo;), or flip the switch below to route <em>every</em> LLM call from
                  every surface.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Gateway Provider</Label>
                  <Select value={gatewayProvider} onValueChange={setGatewayProvider}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GATEWAY_PROVIDERS.map((gp) => (
                        <SelectItem key={gp.value} value={gp.value}>
                          {gp.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Gateway Base URL</Label>
                  <Input
                    placeholder="https://gateway.example.com"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Gateway API Key</Label>
                  <Input
                    type="password"
                    placeholder={
                      gatewayHasKey ? "(a key is saved — leave blank to keep it)" : "gw-key-..."
                    }
                    value={gatewayKey}
                    onChange={(e) => setGatewayKey(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted, never shown again. Leave blank to keep the saved key.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable gateway</Label>
                    <p className="text-xs text-muted-foreground">
                      Agents with &ldquo;Route through gateway&rdquo; in their tool settings will
                      use it. Enabling runs a live validation first.
                    </p>
                  </div>
                  <Switch checked={gatewayRoute} onCheckedChange={setGatewayRoute} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Route ALL LLM traffic</Label>
                    <p className="text-xs text-muted-foreground">
                      Every LLM call on this account — chat, swarms, BI answers, embeds, skill
                      generation, notebooks, model listings and embeddings — goes through the
                      gateway. Your gateway must be able to route every model you use.
                    </p>
                  </div>
                  <Switch
                    checked={gatewayRouteAll}
                    onCheckedChange={setGatewayRouteAll}
                    disabled={!gatewayRoute}
                  />
                </div>
                {gatewayStatus && (
                  <div
                    className={`rounded-md border p-2.5 ${gatewayStatus.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                  >
                    <p
                      className={`text-xs font-semibold flex items-center gap-1.5 ${gatewayStatus.ok ? "text-primary" : "text-destructive"}`}
                    >
                      {gatewayStatus.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {gatewayStatus.ok ? "Gateway validated" : "Validation failed"}
                    </p>
                    <p
                      className={`text-xs mt-0.5 ${gatewayStatus.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                    >
                      {gatewayStatus.detail}
                    </p>
                  </div>
                )}
                {!gatewayStatus && healthErrorFor((i) => i.type === "llm_gateway") && (
                  <Badge
                    variant="outline"
                    className="w-fit text-warning border-warning/40"
                    title={healthErrorFor((i) => i.type === "llm_gateway") ?? undefined}
                  >
                    <X className="h-3 w-3 mr-1" /> Gateway failing health checks
                  </Badge>
                )}
                <Button onClick={saveGateway} disabled={gatewayTesting}>
                  {gatewayTesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Validating…
                    </>
                  ) : gatewayRoute ? (
                    "Validate & Save"
                  ) : (
                    "Save (disabled)"
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="websearch" className="space-y-4">
            <Card className="border-border/50 max-w-lg">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                    <Globe className="h-4 w-4 text-primary" />
                  </div>
                  <CardTitle>Firecrawl (web search &amp; browsing)</CardTitle>
                </div>
                <CardDescription>
                  Powers the agent <code>web_search</code> and <code>web_browse</code> tools for
                  every agent on this instance. Get a key at{" "}
                  <a
                    href="https://firecrawl.dev"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    firecrawl.dev
                  </a>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  Without a key, <code>web_search</code> still works but falls back to DuckDuckGo
                  (limited results) and <code>web_browse</code> is unavailable. A key set here is
                  the workspace default; the <code>FIRECRAWL_API_KEY</code> env var, or a per-agent
                  key in the agent editor, override it.
                </div>
                <div className="space-y-2">
                  <Label>Firecrawl API Key</Label>
                  <Input
                    type="password"
                    placeholder="fc-..."
                    value={firecrawlKey}
                    onChange={(e) => setFirecrawlKey(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted, never shown again. Leave blank to keep the saved key.
                  </p>
                </div>
                {firecrawlStatus && (
                  <div
                    className={`rounded-md border p-2.5 ${firecrawlStatus.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                  >
                    <p
                      className={`text-xs font-semibold flex items-center gap-1.5 ${firecrawlStatus.ok ? "text-primary" : "text-destructive"}`}
                    >
                      {firecrawlStatus.ok ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                      {firecrawlStatus.ok ? "Connected" : "Connection failed"}
                    </p>
                    <p
                      className={`text-xs mt-0.5 ${firecrawlStatus.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                    >
                      {firecrawlStatus.detail}
                    </p>
                  </div>
                )}
                {integrations.find((i) => i.type === "firecrawl" && i.is_active) &&
                  !firecrawlStatus &&
                  (healthErrorFor((i) => i.type === "firecrawl") ? (
                    <Badge
                      variant="outline"
                      className="w-fit text-warning border-warning/40"
                      title={healthErrorFor((i) => i.type === "firecrawl") ?? undefined}
                    >
                      <X className="h-3 w-3 mr-1" /> Connected — key failing health checks
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="w-fit text-primary border-primary/30">
                      <Check className="h-3 w-3 mr-1" /> Currently connected
                    </Badge>
                  ))}
                <Button onClick={saveFirecrawl} disabled={firecrawlTesting}>
                  {firecrawlTesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Validating…
                    </>
                  ) : (
                    "Validate & Save"
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4">
            <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground max-w-2xl">
              Connected channels receive <strong>system alerts</strong> (failing credentials,
              scheduled-refresh errors, BI data alerts) and power the <code>send_notification</code>{" "}
              agent tool (enable it per agent in the Agent Builder). Webhook URLs are stored
              encrypted — treat them like passwords.
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  {
                    kind: "slack" as const,
                    label: "Slack",
                    hint: "Incoming webhook from api.slack.com/messaging/webhooks",
                    placeholder: "https://hooks.slack.com/services/T…/B…/…",
                  },
                  {
                    kind: "teams" as const,
                    label: "Microsoft Teams",
                    hint: "Channel → Connectors → Incoming Webhook",
                    placeholder: "https://outlook.office.com/webhook/…",
                  },
                  {
                    kind: "discord" as const,
                    label: "Discord",
                    hint: "Channel settings → Integrations → Webhooks",
                    placeholder: "https://discord.com/api/webhooks/…",
                  },
                  {
                    kind: "webhook" as const,
                    label: "Custom webhook",
                    hint: "Any HTTPS endpoint accepting a JSON POST",
                    placeholder: "https://example.com/hooks/agentswarms",
                  },
                ] as const
              ).map((ch) => {
                const connected = integrations.find(
                  (i) => i.type === "notification" && i.provider === ch.kind && i.is_active,
                );
                const status = notifStatus[ch.kind];
                const health = healthErrorFor(
                  (i) => i.type === "notification" && i.provider === ch.kind,
                );
                return (
                  <Card key={ch.kind} className="border-border/50">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                          <Bell className="h-4 w-4 text-primary" />
                        </div>
                        <CardTitle className="text-base">{ch.label}</CardTitle>
                      </div>
                      <p className="text-xs text-muted-foreground">{ch.hint}</p>
                      {connected && !status && (
                        <Badge
                          variant="outline"
                          className={
                            health
                              ? "w-fit text-warning border-warning/40"
                              : "w-fit text-primary border-primary/30"
                          }
                          title={health ?? undefined}
                        >
                          {health ? (
                            <>
                              <X className="h-3 w-3 mr-1" /> Connected — delivery failing
                            </>
                          ) : (
                            <>
                              <Check className="h-3 w-3 mr-1" /> Connected
                            </>
                          )}
                        </Badge>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <Label>Webhook URL</Label>
                        <Input
                          type="password"
                          placeholder={
                            connected ? "(saved — leave blank to keep it)" : ch.placeholder
                          }
                          value={notifUrls[ch.kind] || ""}
                          onChange={(e) =>
                            setNotifUrls((u) => ({ ...u, [ch.kind]: e.target.value }))
                          }
                        />
                        <p className="text-[11px] text-muted-foreground">
                          Stored encrypted, never shown again.
                        </p>
                      </div>
                      {status && (
                        <div
                          className={`rounded-md border p-2.5 ${status.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                        >
                          <p
                            className={`text-xs font-semibold flex items-center gap-1.5 ${status.ok ? "text-primary" : "text-destructive"}`}
                          >
                            {status.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                            {status.ok ? "Test message delivered" : "Delivery failed"}
                          </p>
                          <p
                            className={`text-xs mt-0.5 ${status.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                          >
                            {status.detail}
                          </p>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => saveNotifChannel(ch.kind, ch.label)}
                          disabled={notifTesting !== null}
                        >
                          {notifTesting === ch.kind ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Testing…
                            </>
                          ) : (
                            "Send test & Save"
                          )}
                        </Button>
                        {connected && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={() => disconnectNotifChannel(ch.kind)}
                          >
                            <X className="h-3 w-3 mr-1" /> Disconnect
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="n8n" className="space-y-4">
            <Card className="border-border/50 max-w-lg">
              <CardHeader>
                <CardTitle>n8n Workflow Automation</CardTitle>
                <CardDescription>
                  Connect your n8n instance for workflow triggers and tool actions.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>n8n Instance URL</Label>
                  <Input
                    placeholder="https://n8n.example.com"
                    value={n8nUrl}
                    onChange={(e) => setN8nUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Authentication Type</Label>
                  <Select value={n8nAuthType} onValueChange={setN8nAuthType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="header">Header Auth Token</SelectItem>
                      <SelectItem value="basic">Basic Auth</SelectItem>
                      <SelectItem value="none">No Authentication</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {n8nAuthType === "header" && (
                  <p className="text-xs text-muted-foreground -mt-2">
                    Use an n8n API key (Settings → API). Validation hits{" "}
                    <code>GET /api/v1/workflows</code>.
                  </p>
                )}
                {n8nAuthType !== "none" && (
                  <div className="space-y-2">
                    <Label>{n8nAuthType === "basic" ? "Credentials (user:pass)" : "API Key"}</Label>
                    <Input
                      type="password"
                      placeholder={n8nAuthType === "basic" ? "admin:password" : "n8n_api_..."}
                      value={n8nToken}
                      onChange={(e) => setN8nToken(e.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Stored encrypted, never shown again. Leave blank to keep the saved token.
                    </p>
                  </div>
                )}
                {n8nStatus && (
                  <div
                    className={`rounded-md border p-2.5 ${n8nStatus.ok ? "border-primary/30 bg-primary/5" : "border-destructive/40 bg-destructive/10"}`}
                  >
                    <p
                      className={`text-xs font-semibold flex items-center gap-1.5 ${n8nStatus.ok ? "text-primary" : "text-destructive"}`}
                    >
                      {n8nStatus.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {n8nStatus.ok ? "Connected" : "Connection failed"}
                    </p>
                    <p
                      className={`text-xs mt-0.5 ${n8nStatus.ok ? "text-muted-foreground" : "text-destructive/90 font-mono break-words"}`}
                    >
                      {n8nStatus.detail}
                    </p>
                  </div>
                )}
                {integrations.find((i) => i.type === "n8n" && i.is_active) &&
                  !n8nStatus &&
                  (healthErrorFor((i) => i.type === "n8n") ? (
                    <Badge
                      variant="outline"
                      className="w-fit text-warning border-warning/40"
                      title={healthErrorFor((i) => i.type === "n8n") ?? undefined}
                    >
                      <X className="h-3 w-3 mr-1" /> Connected — instance failing health checks
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="w-fit text-primary border-primary/30">
                      <Check className="h-3 w-3 mr-1" /> Currently connected
                    </Badge>
                  ))}
                <Button onClick={saveN8n} disabled={n8nTesting || !n8nUrl}>
                  {n8nTesting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Validating…
                    </>
                  ) : (
                    "Validate & Save"
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function ProviderConfigDialog({
  provider,
  onSave,
}: {
  provider: (typeof LLM_PROVIDERS)[0];
  onSave: (id: string, config: Record<string, string>) => Promise<{ ok: boolean; detail?: string }>;
}) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // Ollama auto-detection: when the dialog opens we probe the default
  // localhost:11434 FROM THE SERVER; a hit turns connecting into one click.
  const [ollamaProbe, setOllamaProbe] = useState<null | {
    running: boolean;
    endpoint: string;
    models: string[];
    detail: string;
  }>(null);

  useEffect(() => {
    if (!open || provider.id !== "ollama") return;
    setOllamaProbe(null);
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      try {
        const probe = await detectOllama({ data: { access_token: token } });
        if (cancelled) return;
        setOllamaProbe(probe);
        if (probe.running) {
          setConfig((c) => ({ ...c, endpoint: c.endpoint || probe.endpoint }));
        }
      } catch {
        if (!cancelled) {
          setOllamaProbe({
            running: false,
            endpoint: "",
            models: [],
            detail: "Detection failed — enter the address manually.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, provider.id]);

  const willTest = TESTABLE_PROVIDERS.has(provider.id);

  async function handleSubmit() {
    setTesting(true);
    setLastError(null);
    // Ollama: an empty address means "use the auto-detected local daemon".
    const effectiveConfig =
      provider.id === "ollama" && !config.endpoint?.trim()
        ? { ...config, endpoint: ollamaProbe?.endpoint || "http://localhost:11434" }
        : config;
    const res = await onSave(provider.id, effectiveConfig);
    setTesting(false);
    if (res.ok) {
      if (provider.id === "ollama") invalidateOllamaModels();
      setOpen(false);
      setConfig({});
    } else {
      // Always surface the EXACT upstream message — never swallow it behind a
      // generic "Could not connect to provider". If the server returned no
      // detail at all (rare), say so explicitly so the user knows the form
      // didn't get a real response back.
      setLastError(
        (res.detail && res.detail.trim()) ||
          "No response detail returned from the provider — the request may have been blocked before reaching it.",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setLastError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="flex-1">
          <Settings2 className="h-3 w-3 mr-1" /> Configure
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {provider.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{provider.description}</p>
        {willTest && provider.id !== "ollama" && (
          <p className="text-xs text-muted-foreground border-l-2 border-primary/40 pl-2">
            We'll make a real authenticated call to verify your credentials before saving.
          </p>
        )}
        {provider.id === "ollama" && (
          <div
            className={
              ollamaProbe === null
                ? "rounded-md border border-border/60 bg-muted/40 p-2.5"
                : ollamaProbe.running
                  ? "rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2.5"
                  : "rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5"
            }
          >
            {ollamaProbe === null ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking for Ollama on this server…
              </p>
            ) : ollamaProbe.running ? (
              <>
                <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3 w-3" /> {ollamaProbe.detail}
                </p>
                {ollamaProbe.models.length > 0 && (
                  <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                    {ollamaProbe.models.slice(0, 8).join(" · ")}
                    {ollamaProbe.models.length > 8 ? " · …" : ""}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Just click Connect — or point the address at a different instance below.
                </p>
              </>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                No Ollama detected on this server ({ollamaProbe.detail}). Enter the IP address and
                port of a reachable Ollama instance below, e.g.{" "}
                <code className="text-[11px]">http://192.168.1.20:11434</code>.
              </p>
            )}
          </div>
        )}
        <div className="space-y-4">
          {provider.fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label>{field.label}</Label>
              <Input
                type={field.type}
                placeholder={field.placeholder}
                value={config[field.key] || ""}
                onChange={(e) => setConfig({ ...config, [field.key]: e.target.value })}
                disabled={testing}
              />
            </div>
          ))}
          {lastError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5">
              <p className="text-xs font-semibold text-destructive flex items-center gap-1.5 mb-1">
                <X className="h-3 w-3" /> Connection failed
              </p>
              <p className="text-xs text-destructive/90 font-mono break-words">{lastError}</p>
            </div>
          )}
          <Button onClick={handleSubmit} className="w-full" disabled={testing}>
            {testing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Testing connection…
              </>
            ) : provider.id === "ollama" ? (
              "Connect"
            ) : willTest ? (
              "Test & Connect"
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
