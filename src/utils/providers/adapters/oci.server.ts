// OCI Generative AI streaming adapter -> OpenAI-style SSE.
// Signed by the shared OCI request signer (utils/oci/signer, proved against
// the OCI Go SDK's vectors). Targets the Generative AI Inference `chat` action.
import { createPrivateKey, type KeyObject } from "node:crypto";

import type { ChatMessage, OCIConfig, OCICreds } from "../types";
import { providerFetch } from "@/utils/ssrfGuard.server";
import { signOciRequest } from "@/utils/oci/signer";
import { providerOrigin } from "../privateEndpoint";

function toOpenAIChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-oci",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;
}

// Endpoint host varies by region: https://inference.generativeai.<region>.oci.oraclecloud.com
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

  // providerOrigin validates the region before it becomes part of the host
  // (cloudRegion), or uses the endpoint override (e.g. a private endpoint's
  // *.pe.* name); the request is signed for the host it is sent to.
  const base = providerOrigin("oci_genai", { region, endpoint: config.endpoint });
  const url = new URL(`${base}/20231130/actions/chat`);

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
  let privateKey: KeyObject;
  try {
    // PKCS#8 or PKCS#1: the WebCrypto import this replaced took PKCS#8 only.
    privateKey = createPrivateKey(creds.privateKeyPem);
  } catch {
    throw new Error("OCI Generative AI: the saved private key is not a PEM private key");
  }
  const headers = signOciRequest({ method: "POST", url, body, key: { keyId, privateKey } });

  const upstream = await providerFetch(url.toString(), { method: "POST", headers, body });
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
