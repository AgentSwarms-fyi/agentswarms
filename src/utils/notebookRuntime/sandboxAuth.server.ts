// Every sandbox's port answers only to the platform (R466).
//
// A sandbox serves on :8888: Jupyter Kernel Gateway for a notebook, an MCP
// server, or a warm model scorer. Before R466 none of them asked who was
// calling. Every sandbox shares one network (Compose's nb-internal; one
// namespace on Kubernetes), so code in one user's notebook could open
// another user's kernel, run code in it and read its environment, that
// user's session token included. Measured: sandbox A created a kernel on
// sandbox B and printed B's AGENTSWARMS_TOKEN. The MCP and score servers
// trusted "the app never exposes this port", and a neighbour is not the app.
//
// Now each sandbox gets its own token: an HMAC of its session id under the
// runtime signing secret, the one the gateway already shares with the app
// for session tokens. The app puts it in that sandbox's environment as
// KG_AUTH_TOKEN, which Kernel Gateway enforces itself (401 without it), and
// which the MCP and score runners check. The gateway and the app derive the
// same value from the session id when they connect. Nothing is stored, and no
// other sandbox can compute it: it needs the secret, which no sandbox holds.
//
// services/notebook-gateway/index.mjs derives it the same way; a test pins
// that the two agree.
import { createHmac } from "node:crypto";

import { getRuntimeSecret } from "./token.server";

/** Never change without changing the gateway's copy: they must agree. */
export const SANDBOX_TOKEN_LABEL = "agentswarms/sandbox-port/v1";

/** The token for one session's sandbox, from the shared signing secret. */
export function deriveSandboxToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(`${SANDBOX_TOKEN_LABEL}:${sessionId}`).digest("hex");
}

/** This deployment's token for a session's sandbox. Fails closed without a secret. */
export async function sandboxToken(sessionId: string): Promise<string> {
  const secret = await getRuntimeSecret();
  if (!secret) {
    throw new Error(
      "The developer runtime has no signing secret yet, so no sandbox can be reached. " +
        "An admin enables the runtime under Admin -> Developer runtime, which creates it.",
    );
  }
  return deriveSandboxToken(secret, sessionId);
}

/**
 * The header every request to a sandbox's port carries. Kernel Gateway's own
 * form (`token`), which the MCP and score runners accept too.
 */
export async function sandboxAuthHeaders(sessionId: string): Promise<{ Authorization: string }> {
  return { Authorization: `token ${await sandboxToken(sessionId)}` };
}
