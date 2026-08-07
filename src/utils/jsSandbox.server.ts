// Client for the JS sandbox service (services/js-sandbox).
//
// Headless swarm runs — deployed API keys and schedules — reach user-authored
// Function and custom-component code through here. The app process never
// executes that code itself: it holds the service-role key, provider
// credentials and the database connection, which is exactly why the executor
// refused custom code before this service existed.
//
// The service is OPTIONAL. When JS_SANDBOX_URL is unset the executor keeps
// refusing custom code with a message that says how to enable it, rather than
// pretending the node ran.
import { internalRunSecret } from "@/utils/internalOrigin.server";

export type ServerSandboxResult =
  | { ok: true; value: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

/**
 * Addresses tried when JS_SANDBOX_URL is not set, mirroring how the document
 * renderer is discovered: the Compose service name first, then the published
 * loopback port for an app running on the host with `npm run dev`.
 *
 * This is what makes "no address to configure" true rather than a claim in the
 * docs — a doc fact-check caught that sentence being false when the fallback
 * did not exist.
 */
const DEFAULT_CANDIDATES = ["http://js-sandbox:8091", "http://127.0.0.1:8091"];
const PROBE_TTL_MS = 60_000;
let probeCache: { at: number; url: string | null } | null = null;

/** Explicitly configured endpoint, if any. */
export function jsSandboxUrl(): string | null {
  const raw = (process.env.JS_SANDBOX_URL ?? "").trim();
  if (!raw) return null;
  if (!/^https?:\/\/\S+$/i.test(raw)) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * The endpoint to use: the configured one, or the first default that answers
 * /health. Probing (rather than assuming) keeps the difference between "not
 * deployed" and "deployed but broken" real — the deploy dialog says something
 * different for each, and a blind default would make every instance claim the
 * sandbox exists.
 */
export async function resolveJsSandboxUrl(): Promise<string | null> {
  const explicit = jsSandboxUrl();
  if (explicit) return explicit;
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.url;
  let found: string | null = null;
  for (const candidate of DEFAULT_CANDIDATES) {
    try {
      const res = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        found = candidate;
        break;
      }
    } catch {
      /* not this one */
    }
  }
  probeCache = { at: Date.now(), url: found };
  return found;
}

export async function jsSandboxConfigured(): Promise<boolean> {
  if (!internalRunSecret()) return false;
  return (await resolveJsSandboxUrl()) !== null;
}

/**
 * The message shown wherever custom code cannot run server-side. Kept in one
 * place so the executor, the deploy pre-flight and the docs cannot drift into
 * three different explanations of the same limitation.
 */
export const JS_SANDBOX_UNAVAILABLE =
  "Custom code (Function and component nodes) needs the JS sandbox service for headless runs. " +
  "Start it with `docker compose --profile sandbox up -d --build` (no further configuration inside Compose), " +
  "or run this swarm from the canvas.";

export async function runSandboxedServer(
  code: string,
  ctx: { input: unknown; vars: Record<string, unknown>; params?: Record<string, unknown> },
  timeoutMs = 2000,
  signal?: AbortSignal,
): Promise<ServerSandboxResult> {
  const base = await resolveJsSandboxUrl();
  const secret = internalRunSecret();
  if (!base || !secret) return { ok: false, error: JS_SANDBOX_UNAVAILABLE, logs: [] };

  // The sandbox enforces its own ceiling; this bound is about not holding the
  // run's worker while a wedged service never answers.
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), timeoutMs + 2000);
  try {
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-run-secret": secret },
      body: JSON.stringify({
        code,
        ctx: { input: ctx.input, vars: ctx.vars ?? {}, params: ctx.params ?? {} },
        timeoutMs,
      }),
      signal: abort.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401)
        return {
          ok: false,
          error:
            "The JS sandbox rejected this server's credentials — INTERNAL_RUN_SECRET must match on both.",
          logs: [],
        };
      if (res.status === 503)
        return { ok: false, error: "The JS sandbox is busy — try again shortly.", logs: [] };
      return {
        ok: false,
        error: `JS sandbox error [${res.status}]: ${text.slice(0, 200)}`,
        logs: [],
      };
    }
    const body = (await res.json()) as ServerSandboxResult;
    if (typeof body?.ok !== "boolean")
      return { ok: false, error: "JS sandbox returned an unexpected response.", logs: [] };
    return body;
  } catch (e) {
    const msg =
      (e as Error).name === "AbortError"
        ? "the sandbox did not respond in time"
        : (e as Error).message;
    return { ok: false, error: `Could not reach the JS sandbox (${msg}).`, logs: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
