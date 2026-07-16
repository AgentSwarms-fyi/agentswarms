// Shared types for external LLM providers (client + server safe).

export type ProviderId =
  | "bedrock"
  | "vertex"
  | "anthropic"
  | "azure_openai"
  | "oci_genai"
  | "qwen"
  | "grok"
  | "openai"
  | "gemini"
  | "ollama"
  | "openrouter"
  | "groq"
  | "vllm"
  | "nvidia";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ProviderModel = {
  id: string;
  label: string;
};

export const PROVIDER_MODELS: Record<ProviderId, ProviderModel[]> = {
  bedrock: [
    { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Claude 3.5 Sonnet" },
    { id: "anthropic.claude-3-5-haiku-20241022-v1:0", label: "Claude 3.5 Haiku" },
    { id: "anthropic.claude-3-opus-20240229-v1:0", label: "Claude 3 Opus" },
    { id: "meta.llama3-1-70b-instruct-v1:0", label: "Llama 3.1 70B" },
    { id: "mistral.mistral-large-2407-v1:0", label: "Mistral Large" },
  ],
  vertex: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "claude-3-5-sonnet-v2@20241022", label: "Claude 3.5 Sonnet (Vertex)" },
  ],
  anthropic: [
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus" },
  ],
  azure_openai: [
    { id: "gpt-4o", label: "GPT-4o (deployment name)" },
    { id: "gpt-4o-mini", label: "GPT-4o mini (deployment name)" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo (deployment name)" },
  ],
  oci_genai: [
    { id: "cohere.command-r-plus-08-2024", label: "Cohere Command R+ (08-2024)" },
    { id: "cohere.command-r-08-2024", label: "Cohere Command R (08-2024)" },
    { id: "meta.llama-3.1-70b-instruct", label: "Meta Llama 3.1 70B Instruct" },
    { id: "meta.llama-3.1-405b-instruct", label: "Meta Llama 3.1 405B Instruct" },
  ],
  grok: [
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-3", label: "Grok 3" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
    { id: "grok-2-1212", label: "Grok 2 (1212)" },
  ],
  qwen: [
    { id: "qwen-max", label: "Qwen Max" },
    { id: "qwen-plus", label: "Qwen Plus" },
    { id: "qwen-turbo", label: "Qwen Turbo" },
    { id: "qwen2.5-72b-instruct", label: "Qwen2.5 72B Instruct" },
    { id: "qwen2.5-32b-instruct", label: "Qwen2.5 32B Instruct" },
    { id: "qwen2.5-14b-instruct", label: "Qwen2.5 14B Instruct" },
    { id: "qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B" },
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-5-nano", label: "GPT-5 nano" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
    { id: "o3", label: "o3" },
    { id: "o3-mini", label: "o3 Mini" },
    { id: "o1", label: "o1" },
    { id: "o1-preview", label: "o1 Preview" },
    { id: "o1-mini", label: "o1 Mini" },
  ],
  gemini: [
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)" },
    { id: "gemini-3.1-flash-image-preview", label: "Gemini 3.1 Flash Image (preview)" },
    { id: "gemini-3-pro-image-preview", label: "Gemini 3 Pro Image (preview)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image (Nano Banana)" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
  ],
  ollama: [
    { id: "llama3.1", label: "Llama 3.1" },
    { id: "mistral", label: "Mistral" },
    { id: "codellama", label: "CodeLlama" },
    { id: "mixtral", label: "Mixtral" },
  ],
  vllm: [
    // vLLM serves whatever model the operator launched it with. The label
    // shown here is the served-model-name they configured. We surface a few
    // common open-weight models as suggestions; users override with whatever
    // their cluster actually serves.
    { id: "meta-llama/Meta-Llama-3.1-8B-Instruct", label: "Llama 3.1 8B Instruct" },
    { id: "meta-llama/Meta-Llama-3.1-70B-Instruct", label: "Llama 3.1 70B Instruct" },
    { id: "mistralai/Mistral-7B-Instruct-v0.3", label: "Mistral 7B Instruct v0.3" },
    { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen2.5 7B Instruct" },
    { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B Instruct" },
    { id: "deepseek-ai/DeepSeek-V2.5", label: "DeepSeek V2.5" },
  ],
  groq: [
    // Groq runs popular open-weight models on its LPU inference hardware at
    // very high tokens/sec. Slugs match Groq's /openai/v1/models response.
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant" },
    { id: "llama-3.1-70b-versatile", label: "Llama 3.1 70B Versatile" },
    { id: "llama3-70b-8192", label: "Llama 3 70B (8K)" },
    { id: "llama3-8b-8192", label: "Llama 3 8B (8K)" },
    { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B (32K)" },
    { id: "gemma2-9b-it", label: "Gemma 2 9B Instruct" },
    { id: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill Llama 70B" },
    { id: "qwen-2.5-32b", label: "Qwen 2.5 32B" },
    { id: "qwen-2.5-coder-32b", label: "Qwen 2.5 Coder 32B" },
  ],
  openrouter: [
    // OpenRouter exposes 200+ models — surface popular defaults; users can
    // type any slug from https://openrouter.ai/models in the agent builder.
    // openrouter/free is a smart router that picks a free model at random
    // matching the request's required features (tools, vision, JSON, etc.).
    // 200K context, no per-token cost — ideal for experimentation & learning.
    { id: "openrouter/free", label: "Free Models Router (200K ctx, $0)" },
    { id: "openai/gpt-5", label: "OpenAI GPT-5 (via OpenRouter)" },
    { id: "openai/gpt-4o", label: "OpenAI GPT-4o (via OpenRouter)" },
    { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini (via OpenRouter)" },
    { id: "anthropic/claude-3.5-sonnet", label: "Anthropic Claude 3.5 Sonnet" },
    { id: "anthropic/claude-3.5-haiku", label: "Anthropic Claude 3.5 Haiku" },
    { id: "google/gemini-2.5-pro", label: "Google Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Meta Llama 3.3 70B Instruct" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
    { id: "mistralai/mistral-large", label: "Mistral Large" },
    { id: "x-ai/grok-2-1212", label: "xAI Grok 2 (1212)" },
    { id: "qwen/qwen-2.5-72b-instruct", label: "Qwen 2.5 72B Instruct" },
  ],
  nvidia: [
    // Real model IDs from build.nvidia.com (NVIDIA NIM API catalog).
    // All routed via POST https://integrate.api.nvidia.com/v1/chat/completions.
    // Free tier with generous request quota for NVIDIA Developer Program members.
    {
      id: "nvidia/llama-3.3-nemotron-super-49b-v1",
      label: "Llama 3.3 Nemotron Super 49B (reasoning)",
    },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", label: "Llama 3.1 Nemotron 70B Instruct" },
    { id: "nvidia/llama-3.1-nemotron-nano-8b-v1", label: "Llama 3.1 Nemotron Nano 8B" },
    { id: "meta/llama-3.3-70b-instruct", label: "Meta Llama 3.3 70B Instruct" },
    { id: "meta/llama-3.1-405b-instruct", label: "Meta Llama 3.1 405B Instruct" },
    { id: "meta/llama-3.1-70b-instruct", label: "Meta Llama 3.1 70B Instruct" },
    { id: "meta/llama-3.1-8b-instruct", label: "Meta Llama 3.1 8B Instruct" },
    { id: "deepseek-ai/deepseek-r1", label: "DeepSeek R1 (reasoning)" },
    { id: "deepseek-ai/deepseek-r1-distill-llama-8b", label: "DeepSeek R1 Distill Llama 8B" },
    { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B Instruct" },
    { id: "qwen/qwq-32b", label: "Qwen QwQ 32B (reasoning)" },
    { id: "mistralai/mixtral-8x22b-instruct-v0.1", label: "Mixtral 8x22B Instruct" },
    { id: "mistralai/mistral-large-2-instruct", label: "Mistral Large 2 Instruct" },
    { id: "google/gemma-3-27b-it", label: "Google Gemma 3 27B Instruct" },
  ],
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex AI",
  anthropic: "Anthropic (direct)",
  azure_openai: "Azure OpenAI",
  oci_genai: "OCI Generative AI",
  qwen: "Qwen (Alibaba DashScope)",
  grok: "Grok (xAI)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama (self-hosted)",
  openrouter: "OpenRouter",
  groq: "Groq (LPU inference)",
  vllm: "vLLM (self-hosted)",
  nvidia: "NVIDIA NIM (build.nvidia.com)",
};

// NVIDIA Build (NIM) — OpenAI-compatible endpoint at integrate.api.nvidia.com.
// Free tier on NVIDIA Developer Program; key prefix is `nvapi-...`.
export type NvidiaCreds = { apiKey: string };
export type NvidiaConfig = {
  // Defaults to https://integrate.api.nvidia.com/v1
  baseUrl?: string;
};

// Shape of decrypted credential payloads per provider.
export type BedrockCreds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
export type VertexCreds = { serviceAccountJson: string }; // raw JSON string
export type AnthropicCreds = { apiKey: string };
export type AzureCreds = { apiKey: string };
export type OCICreds = {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKeyPem: string; // PEM-encoded RSA private key
};

// Non-secret config per provider.
export type BedrockConfig = { region: string };
export type VertexConfig = { projectId: string; location: string };
export type AnthropicConfig = Record<string, never>;
export type AzureConfig = { endpoint: string; apiVersion?: string };
export type OCIConfig = {
  region: string; // e.g. us-chicago-1, eu-frankfurt-1
  compartmentId: string; // OCID of the compartment
  style?: "GENERIC" | "COHERE"; // chat request shape; default GENERIC
};

// Qwen via Alibaba DashScope OpenAI-compatible endpoint.
export type QwenCreds = { apiKey: string };
export type QwenConfig = {
  // Defaults to international endpoint. Override for mainland China:
  // https://dashscope.aliyuncs.com/compatible-mode/v1
  baseUrl?: string;
};

// Grok (xAI) — OpenAI-compatible API.
export type GrokCreds = { apiKey: string };
export type GrokConfig = {
  // Defaults to https://api.x.ai/v1
  baseUrl?: string;
};

// Groq — OpenAI-compatible API on Groq's LPU inference hardware.
// Docs: https://console.groq.com/docs/openai
export type GroqCreds = { apiKey: string };
export type GroqConfig = {
  // Defaults to https://api.groq.com/openai/v1
  baseUrl?: string;
};

// vLLM — self-hosted high-throughput inference server with an
// OpenAI-compatible /v1 API. Docs: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
export type VLLMCreds = { apiKey?: string };
export type VLLMConfig = {
  baseUrl: string; // e.g. http://my-vllm:8000/v1
  servedModelName?: string; // optional alias; if set we pass it as `model`
};

// OpenRouter — OpenAI-compatible aggregator over 200+ models.
// Docs: https://openrouter.ai/docs/quickstart
export type OpenRouterCreds = { apiKey: string };
export type OpenRouterConfig = {
  // Defaults to https://openrouter.ai/api/v1
  baseUrl?: string;
  // OpenRouter recommends sending these for analytics / app attribution.
  // Both are optional; we forward them as HTTP-Referer / X-Title.
  httpReferer?: string;
  appTitle?: string;
};
