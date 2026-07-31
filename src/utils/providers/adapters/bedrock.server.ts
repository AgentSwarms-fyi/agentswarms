// AWS Bedrock SigV4 + Converse Stream adapter.
// Re-emits responses as OpenAI-style SSE chunks for client compatibility.
import type { BedrockConfig, BedrockCreds, ChatMessage } from "../types";

const SERVICE = "bedrock";

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array
      ? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer)
      : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signRequest(opts: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  method: string;
  host: string;
  path: string;
  body: string;
}): Promise<Record<string, string>> {
  const { region, accessKeyId, secretAccessKey, sessionToken, method, host, path, body } = opts;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const canonicalHeadersObj: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-amz-date": amzDate,
  };
  if (sessionToken) canonicalHeadersObj["x-amz-security-token"] = sessionToken;
  const sortedHeaderKeys = Object.keys(canonicalHeadersObj).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${canonicalHeadersObj[k].trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );

  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(new TextEncoder().encode("AWS4" + secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = [...(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-amz-date": amzDate,
    Authorization: authHeader,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;
  return headers;
}

// Bedrock event stream uses a binary framing; we parse JSON event payloads.
// Each frame: [4 bytes total len][4 bytes headers len][prelude crc][headers][payload][msg crc].
// We extract the payload bytes for each frame and JSON.parse them.
function parseEventStreamChunks(buffer: Uint8Array): { events: any[]; remaining: Uint8Array } {
  const events: any[] = [];
  let offset = 0;
  const dv = new DataView(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  while (offset + 12 <= buffer.length) {
    const totalLen = dv.getUint32(offset, false);
    if (totalLen < 16 || offset + totalLen > buffer.length) break;
    const headersLen = dv.getUint32(offset + 4, false);
    const payloadStart = offset + 12 + headersLen;
    const payloadEnd = offset + totalLen - 4; // strip msg crc
    if (payloadEnd > payloadStart) {
      const payloadBytes = buffer.slice(payloadStart, payloadEnd);
      try {
        const text = new TextDecoder().decode(payloadBytes);
        const json = JSON.parse(text);
        // Bedrock wraps the actual payload in { bytes: base64 } for some streams
        if (json && typeof json.bytes === "string") {
          const decoded = atob(json.bytes);
          const inner = JSON.parse(decoded);
          events.push(inner);
        } else {
          events.push(json);
        }
      } catch {
        // skip non-JSON frames (init, ping, etc.)
      }
    }
    offset += totalLen;
  }
  return { events, remaining: buffer.slice(offset) };
}

function toOpenAIChunk(content: string): string {
  const obj = {
    id: "chatcmpl-bedrock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content } }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function bedrockChatStream(args: {
  creds: BedrockCreds;
  config: BedrockConfig;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  const region = config.region || "us-east-1";
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/converse-stream`;

  const body = JSON.stringify({
    messages: messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ text: m.content }],
    })),
    ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
    inferenceConfig: {
      temperature: temperature ?? 0.7,
      maxTokens: maxTokens ?? 8192,
    },
  });

  const headers = await signRequest({
    region,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    method: "POST",
    host,
    path,
    body,
  });

  const upstream = await fetch(`https://${host}${path}`, { method: "POST", headers, body });
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Bedrock error [${upstream.status}]: ${t.slice(0, 300)}`);
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      let leftover: Uint8Array = new Uint8Array(0);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const merged = new Uint8Array(leftover.length + value.length);
          merged.set(leftover as unknown as Uint8Array<ArrayBuffer>, 0);
          merged.set(value as unknown as Uint8Array<ArrayBuffer>, leftover.length);
          const { events, remaining } = parseEventStreamChunks(merged);
          leftover = remaining;
          for (const ev of events) {
            const delta = ev?.delta?.text;
            if (typeof delta === "string" && delta.length > 0) {
              controller.enqueue(new TextEncoder().encode(toOpenAIChunk(delta)));
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
