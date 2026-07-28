// Control plane for the server-side notebook runtime (user-authenticated).
//
// POST /api/notebook/runtime  { action, ... }
//   start   { notebookId? }               → launch an interactive kernel
//   run     { notebookId?, entrypoint?, inputs? } → launch a headless batch job
//   status  { sessionId }                 → poll/reconcile; returns gateway + token when ready
//   stop    { sessionId }                 → tear down
//   token   { sessionId }                 → refresh the short-lived session token
//
// Interactive kernels are driven over a websocket to the runtime gateway (the
// app does not proxy the socket); this route only manages lifecycle. Model/KB
// calls from inside a kernel come back to /api/python-chat|kb with the session
// token, so IAM rules, budgets, and Traces apply exactly as in the Lite runtime.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  canUseRuntime,
  countLiveSessions,
  countLiveSessionsTotal,
  getRuntimeSettings,
} from "@/utils/notebookRuntime/config.server";
import {
  gatewayUrl,
  getSession,
  listUserSessions,
  reconcileUserSessions,
  refreshSession,
  startSession,
  stopSession,
  touchSession,
} from "@/utils/notebookRuntime/service.server";
import { signSessionToken } from "@/utils/notebookRuntime/token.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TOKEN_TTL = 900;

async function handle(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token) return json(401, { error: "Sign in to use the server runtime" });
  const { data: userData } = await supabaseAdmin.auth.getUser(token);
  const userId = userData.user?.id;
  if (!userId) return json(401, { error: "Invalid session" });

  let body: {
    action?: string;
    sessionId?: string;
    notebookId?: string;
    entrypoint?: string;
    inputs?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const action = body.action;

  const settings = await getRuntimeSettings();
  if (!settings.enabled) {
    return json(403, {
      error: "runtime_disabled",
      message:
        "The server runtime is not enabled on this instance. An administrator can enable it in Admin settings.",
    });
  }

  if (action === "start" || action === "run") {
    if (!(await canUseRuntime(userId))) {
      return json(403, {
        error: "not_permitted",
        message: "Your administrator has not granted you access to the server runtime.",
      });
    }
    // Reconcile first: a kernel that died out-of-band must not hold a slot.
    await reconcileUserSessions(userId);
    if ((await countLiveSessions(userId)) >= settings.maxSessionsPerUser) {
      return json(429, {
        error: "user_limit",
        message:
          `You already have ${settings.maxSessionsPerUser} live runtime sessions (the per-user limit). ` +
          `Stop one under "Running kernels" in the Developer workspace, then try again.`,
      });
    }
    if ((await countLiveSessionsTotal()) >= settings.maxSessionsTotal) {
      return json(429, {
        error: "at_capacity",
        message: "The runtime is at capacity right now — try again shortly.",
      });
    }
    const kind = action === "run" ? "batch" : "interactive";
    try {
      const {
        session,
        token: sessionToken,
        gatewayUrl: gw,
      } = await startSession({
        userId,
        notebookId: body.notebookId ?? null,
        kind,
        entrypoint: body.entrypoint ?? null,
        inputs: body.inputs,
      });
      return json(200, {
        sessionId: session.id,
        status: session.status,
        kind,
        sessionToken,
        gatewayUrl: gw,
        cellTimeoutSeconds: settings.cellTimeoutSeconds,
      });
    } catch (e) {
      return json(500, {
        error: "launch_failed",
        message: e instanceof Error ? e.message : "Failed to launch the runtime",
      });
    }
  }

  if (action === "list") {
    await reconcileUserSessions(userId);
    return json(200, { sessions: await listUserSessions(userId) });
  }

  if (action === "status") {
    if (!body.sessionId) return json(400, { error: "sessionId is required" });
    const s = await getSession(userId, body.sessionId);
    if (!s) return json(404, { error: "Session not found" });
    const r = await refreshSession(s);
    const resp: Record<string, unknown> = { sessionId: r.id, status: r.status, kind: r.kind };
    if (r.status === "ready") {
      resp.gatewayUrl = gatewayUrl();
      resp.sessionToken = await signSessionToken({
        userId,
        sessionId: r.id,
        ttlSeconds: TOKEN_TTL,
      });
    }
    if (r.kind === "batch" && (r.status === "succeeded" || r.status === "error")) {
      resp.result = r.result;
      resp.logs = r.logs;
      resp.error = r.error;
    }
    return json(200, resp);
  }

  if (action === "stop") {
    if (!body.sessionId) return json(400, { error: "sessionId is required" });
    const s = await getSession(userId, body.sessionId);
    if (!s) return json(404, { error: "Session not found" });
    await stopSession(s);
    return json(200, { ok: true });
  }

  if (action === "token") {
    if (!body.sessionId) return json(400, { error: "sessionId is required" });
    const s = await getSession(userId, body.sessionId);
    if (!s) return json(404, { error: "Session not found" });
    if (["stopped", "error", "succeeded"].includes(s.status)) {
      return json(400, { error: "Session is no longer live" });
    }
    await touchSession(s.id);
    return json(200, {
      sessionToken: await signSessionToken({ userId, sessionId: s.id, ttlSeconds: TOKEN_TTL }),
      gatewayUrl: gatewayUrl(),
    });
  }

  return json(400, { error: `Unknown action "${action ?? ""}"` });
}

export const Route = createFileRoute("/api/notebook/runtime")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
