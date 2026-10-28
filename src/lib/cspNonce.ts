// The Content-Security-Policy nonce of the page being rendered (R397).
//
// server.mjs makes one per request (serverSecurityHeaders.mjs) and runs the
// request inside an AsyncLocalStorage it parks on globalThis under this
// symbol, so the router can stamp the nonce on the scripts it renders without
// the app importing the server entry. In the browser, the router writes the
// same nonce into <meta property="csp-nonce"> and reads it back from there;
// so does anything here that adds a script of its own after the page loads.
//
// No nonce (vite dev, SECURITY_HEADERS=off, a test) means no policy asked for
// one, and nothing needs it.

const STORE_KEY = Symbol.for("agentswarms.cspNonce");

type NonceStore = { getStore(): unknown };

export function cspNonce(): string | undefined {
  const store = (globalThis as unknown as Record<symbol, NonceStore | undefined>)[STORE_KEY];
  const current = store?.getStore();
  if (typeof current === "string" && current) return current;
  if (typeof document === "undefined") return undefined;
  return (
    document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content || undefined
  );
}

/** `script` carrying the page's nonce, so the policy lets it run. */
export function withCspNonce<T extends HTMLScriptElement>(script: T): T {
  const nonce = cspNonce();
  if (nonce) script.nonce = nonce;
  return script;
}
