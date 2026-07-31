// OCI Generative AI streaming adapter -> OpenAI-style SSE.
// Uses OCI Request Signing v1 (https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm)
// with RSA-SHA256. Targets the Generative AI Inference `chat` action.

import type { ChatMessage, OCIConfig, OCICreds } from "../types";

function toOpenAIChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-oci",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;
}

// ---- PEM -> CryptoKey for RSA-SHA256 signing ----
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(stripped);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const buf = pemToArrayBuffer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    buf,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function sha256B64(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return bytesToB64(new Uint8Array(digest));
}

async function signString(key: CryptoKey, str: string): Promise<string> {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(str));
  return bytesToB64(new Uint8Array(sig));
}

async function buildSignedHeaders(args: {
  method: "POST";
  url: URL;
  body: string;
  keyId: string; // tenancy/user/fingerprint
  privateKeyPem: string;
}): Promise<Record<string, string>> {
  const { method, url, body, keyId, privateKeyPem } = args;
  const date = new Date().toUTCString();
  const contentSha256 = await sha256B64(body);
  const contentLength = String(new TextEncoder().encode(body).byteLength);
  const headersToSign = [
    "(request-target)",
    "date",
    "host",
    "x-content-sha256",
    "content-type",
    "content-length",
  ];
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const signingString = [
    `(request-target): ${requestTarget}`,
    `date: ${date}`,
    `host: ${url.host}`,
    `x-content-sha256: ${contentSha256}`,
    `content-type: application/json`,
    `content-length: ${contentLength}`,
  ].join("\n");

  const key = await importPrivateKey(privateKeyPem);
  const signature = await signString(key, signingString);

  const authHeader =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${headersToSign.join(" ")}",signature="${signature}"`;

  return {
    date,
    host: url.host,
    "x-content-sha256": contentSha256,
    "content-type": "application/json",
    "content-length": contentLength,
    authorization: authHeader,
  };
}

// Endpoint host varies by region: https://inference.generativeai.<region>.oci.oraclecloud.com
function endpointForRegion(region: string): string {
  return `https://inference.generativeai.${region}.oci.oraclecloud.com`;
}

export async function ociChatStream(args: {
  creds: OCICreds;
  config: OCIConfig;
  modelId: string; // OCID of the model OR an on-demand serving mode model id
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  const region = config.region;
  const compartmentId = config.compartmentId;
  if (!region) throw new Error("OCI region is required");
  if (!compartmentId) throw new Error("OCI compartmentId is required");

  const url = new URL(`${endpointForRegion(region)}/20231130/actions/chat`);

  // Build a generic Cohere/Llama-style chat payload. OCI auto-routes based on
  // the servingMode model. Users can pick GENERIC vs COHERE in config.style.
  const style = config.style ?? "GENERIC";
  const allMessages: { role: string; content: { type: "TEXT"; text: string }[] }[] = [];
  if (systemPrompt) {
    allMessages.push({ role: "SYSTEM", content: [{ type: "TEXT", text: systemPrompt }] });
  }
  for (const m of messages) {
    allMessages.push({
      role: m.role === "assistant" ? "ASSISTANT" : "USER",
      content: [{ type: "TEXT", text: m.content }],
    });
  }

  const chatRequest =
    style === "COHERE"
      ? {
          apiFormat: "COHERE",
          message: messages[messages.length - 1]?.content ?? "",
          chatHistory: allMessages.slice(0, -1).map((m) => ({
            role: m.role,
            message: m.content[0].text,
          })),
          maxTokens: maxTokens ?? 8192,
          temperature: temperature ?? 0.7,
          isStream: true,
          ...(systemPrompt ? { preambleOverride: systemPrompt } : {}),
        }
      : {
          apiFormat: "GENERIC",
          messages: allMessages,
          maxTokens: maxTokens ?? 8192,
          temperature: temperature ?? 0.7,
          isStream: true,
        };

  const body = JSON.stringify({
    compartmentId,
    servingMode: { modelId, servingType: "ON_DEMAND" },
    chatRequest,
  });

  const keyId = `${creds.tenancyOcid}/${creds.userOcid}/${creds.fingerprint}`;
  const headers = await buildSignedHeaders({
    method: "POST",
    url,
    body,
    keyId,
    privateKeyPem: creds.privateKeyPem,
  });

  const upstream = await fetch(url.toString(), { method: "POST", headers, body });
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`OCI Generative AI error [${upstream.status}]: ${t.slice(0, 400)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async pull(controller) {
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // OCI streams JSON lines (sometimes "data: " prefixed)
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            let line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            if (line.startsWith("data:")) line = line.slice(5).trim();
            if (!line || line === "[DONE]") continue;
            try {
              const ev = JSON.parse(line);
              // GENERIC format: { message: { content: [{ text }] } } per chunk
              // COHERE format: { text: "...", finishReason?: "..." }
              const text: string | undefined =
                ev.message?.content?.[0]?.text ?? ev.text ?? ev.delta?.content ?? undefined;
              if (text) controller.enqueue(new TextEncoder().encode(toOpenAIChunk(text)));
            } catch {
              /* skip non-JSON keepalives */
            }
          }
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
