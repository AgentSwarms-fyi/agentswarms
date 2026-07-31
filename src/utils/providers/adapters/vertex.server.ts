// Google Vertex AI streaming adapter using a service account JSON to mint OAuth tokens.
import type { ChatMessage, VertexConfig, VertexCreds } from "../types";

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array | string): string {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encClaim = base64UrlEncode(JSON.stringify(claim));
  const toSign = `${encHeader}.${encClaim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(toSign)),
  );
  const jwt = `${toSign}.${base64UrlEncode(sig)}`;
  const resp = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Vertex auth failed [${resp.status}]: ${t.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Vertex auth: no access_token returned");
  return data.access_token;
}

function toOpenAIChunk(content: string): string {
  const obj = {
    id: "chatcmpl-vertex",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content } }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function vertexChatStream(args: {
  creds: VertexCreds;
  config: VertexConfig;
  modelId: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<Response> {
  const { creds, config, modelId, systemPrompt, messages, temperature, maxTokens } = args;
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(creds.serviceAccountJson) as ServiceAccount;
  } catch {
    throw new Error("Invalid Vertex service account JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Vertex service account missing client_email/private_key");
  }
  const token = await getAccessToken(sa);
  const projectId = config.projectId;
  const location = config.location || "us-central1";

  // Use Vertex Gemini streamGenerateContent endpoint.
  // For Anthropic-on-Vertex (claude-* models), endpoint differs; we surface a clear error.
  if (modelId.startsWith("claude-")) {
    throw new Error("Claude-on-Vertex routing is not yet implemented. Please pick a Gemini model.");
  }

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    ...(systemPrompt
      ? { systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } }
      : {}),
    generationConfig: {
      temperature: temperature ?? 0.7,
      maxOutputTokens: maxTokens ?? 8192,
    },
  };

  const upstream = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text();
    throw new Error(`Vertex error [${upstream.status}]: ${t.slice(0, 300)}`);
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
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            try {
              const ev = JSON.parse(json);
              const parts = ev?.candidates?.[0]?.content?.parts;
              if (Array.isArray(parts)) {
                for (const p of parts) {
                  if (typeof p?.text === "string" && p.text.length > 0) {
                    controller.enqueue(new TextEncoder().encode(toOpenAIChunk(p.text)));
                  }
                }
              }
            } catch {
              /* skip */
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
