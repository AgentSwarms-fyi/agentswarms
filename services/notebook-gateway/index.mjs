// AgentSwarms notebook runtime gateway.
//
// A small, stateless websocket bridge: the browser speaks a simple JSON
// protocol ({type:'run', id, code} → stream/result/error/done), and the gateway
// translates that to the Jupyter Kernel Gateway websocket protocol against the
// per-session kernel. Auth is the session token (same HMAC secret as the app);
// the kernel endpoint is looked up from the DB and ownership is enforced. Cell
// execution is bounded by a timeout (kernel interrupt on overrun).
//
// Stateless + horizontally scalable: no session state is held beyond a live
// connection, so run as many replicas as needed behind the ingress.
import http from "node:http";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8090);
const SECRET = process.env.NOTEBOOK_RUNTIME_SECRET || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CELL_TIMEOUT = Number(process.env.NOTEBOOK_CELL_TIMEOUT_SECONDS || 120);

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Verify the app's HMAC session token (mirrors token.server.ts).
function verifyToken(token) {
  if (!SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims;
  try {
    claims = b64urlJson(payload);
  } catch {
    return null;
  }
  if (claims.scope !== "notebook-runtime") return null;
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof claims.sub !== "string" || typeof claims.sid !== "string") return null;
  return claims;
}

async function lookupSession(sid) {
  const url =
    `${SUPABASE_URL}/rest/v1/notebook_runtime_sessions` +
    `?select=endpoint,user_id,status&id=eq.${encodeURIComponent(sid)}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function executeRequest(msgId, sessionId, code) {
  const now = new Date().toISOString();
  return JSON.stringify({
    header: {
      msg_id: msgId,
      username: "agentswarms",
      session: sessionId,
      date: now,
      msg_type: "execute_request",
      version: "5.3",
    },
    parent_header: {},
    metadata: {},
    content: {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    },
    channel: "shell",
    buffers: [],
  });
}

const server = http.createServer((req, res) => {
  // Health check for load balancers.
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("agentswarms-notebook-gateway");
});
const wss = new WebSocketServer({ server });

wss.on("connection", async (browser, req) => {
  const send = (obj) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(obj));
  };
  const url = new URL(req.url, "http://localhost");
  const claims = verifyToken(url.searchParams.get("token"));
  if (!claims) return browser.close(4001, "invalid token");

  const session = await lookupSession(claims.sid).catch(() => null);
  if (!session || session.user_id !== claims.sub || !session.endpoint || session.status !== "ready") {
    return browser.close(4004, "session not ready");
  }
  const endpoint = session.endpoint.replace(/\/$/, "");

  // Create a kernel on the session's Jupyter Kernel Gateway.
  let kernelId;
  try {
    const r = await fetch(`${endpoint}/api/kernels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`kernel create ${r.status}`);
    kernelId = (await r.json()).id;
  } catch {
    return browser.close(4500, "kernel unavailable");
  }

  const jsession = randomUUID();
  const pending = new Map(); // jupyter msg_id -> { browserId, timer }
  const kernel = new WebSocket(
    `${endpoint.replace(/^http/, "ws")}/api/kernels/${kernelId}/channels?session_id=${jsession}`,
  );

  kernel.on("open", () => send({ type: "ready" }));

  browser.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === "run" && typeof m.code === "string") {
      const msgId = randomUUID();
      const timer = setTimeout(() => {
        fetch(`${endpoint}/api/kernels/${kernelId}/interrupt`, { method: "POST" }).catch(() => {});
        send({ type: "error", id: m.id, text: `Cell timed out after ${CELL_TIMEOUT}s` });
        send({ type: "done", id: m.id });
        pending.delete(msgId);
      }, CELL_TIMEOUT * 1000);
      pending.set(msgId, { browserId: m.id, timer });
      if (kernel.readyState === WebSocket.OPEN) kernel.send(executeRequest(msgId, jsession, m.code));
    }
  });

  kernel.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const parent = m.parent_header && m.parent_header.msg_id;
    const p = parent && pending.get(parent);
    if (!p) return;
    const t = m.header && m.header.msg_type;
    const c = m.content || {};
    if (t === "stream") {
      send({ type: "stream", id: p.browserId, text: c.text || "" });
    } else if (t === "execute_result" || t === "display_data") {
      send({ type: "result", id: p.browserId, text: (c.data && c.data["text/plain"]) || "" });
    } else if (t === "error") {
      send({
        type: "error",
        id: p.browserId,
        text: (c.traceback || []).join("\n") || `${c.ename}: ${c.evalue}`,
      });
    } else if (t === "status" && c.execution_state === "idle") {
      clearTimeout(p.timer);
      pending.delete(parent);
      send({ type: "done", id: p.browserId });
    }
  });

  const cleanup = () => {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    try {
      kernel.close();
    } catch {
      /* noop */
    }
    fetch(`${endpoint}/api/kernels/${kernelId}`, { method: "DELETE" }).catch(() => {});
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);
  kernel.on("close", () => {
    try {
      browser.close();
    } catch {
      /* noop */
    }
  });
  kernel.on("error", () => {
    try {
      browser.close(4500, "kernel error");
    } catch {
      /* noop */
    }
  });
});

server.listen(PORT, () => {
  console.log(`[notebook-gateway] listening on :${PORT}`);
});
