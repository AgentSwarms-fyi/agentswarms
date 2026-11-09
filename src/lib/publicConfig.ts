// The settings the browser needs, read when the server starts rather than
// when the image is built (R464).
//
// Until R464 the browser's Supabase URL, its publishable key and five other
// settings existed only as `import.meta.env.VITE_*`, which Vite replaces with
// literal text at build time. An image therefore carried ONE environment's
// values: a second environment (staging, another region, another customer's
// install) needed its own build, and a published image could not be
// configured at all.
//
// Now every one has a runtime name, PUBLIC_<NAME>, read from the server's
// environment. The server renders the values it has into the page as a JSON
// data block (`<script type="application/json" id="as-public-config">`,
// RootShell in routes/__root.tsx), and the browser reads that block. A data
// block is never executed, so the page's script policy (R397 nonce) does not
// apply to it and nothing in it can run.
//
// Precedence, per setting: PUBLIC_<NAME> from the server's environment, then
// VITE_<NAME> from the server's environment, then the build-time VITE_<NAME>.
// The middle step lets an environment made from an existing .env (a
// Kubernetes Secret) configure an image built without VITE_ values. Where the
// server's environment and the build saw the same .env (Compose), the block
// repeats what the bundle already has and nothing changes; `npm run dev`
// keeps working unchanged.
//
// This file is the ONE place in src/ that reads `import.meta.env.VITE_*`
// (tests/unit/publicConfig pins that), so no setting can be added that only
// a rebuild can change. Keep the reads in the canonical literal form: Vite
// substitutes them by text match (envDefine in vite.config.ts), and any other
// spelling is silently never replaced.
//
// Everything here is public by definition: it is sent to every visitor. That
// is why the publishable key is checked: a service-role key set here would
// hand the database to anyone who opens the page.

export const PUBLIC_CONFIG_ELEMENT_ID = "as-public-config";

export type PublicConfig = {
  /** The Supabase URL as the BROWSER reaches it (may differ from the server's SUPABASE_URL). */
  supabaseUrl?: string;
  /** Supabase's anon (publishable) key. RLS guards the data, not this key. */
  supabasePublishableKey?: string;
  /** Bootstrap admin address for the admin UI before IAM roles exist. */
  adminEmail?: string;
  /** Row cap for BI widget snapshots; the browser and the scheduled refresh must agree. */
  biSnapshotRowsCap?: string;
  /** The operator's own Google Analytics ID. Unset (default): no banner, no request. */
  gaId?: string;
  /** The operator's own Google Tag Manager ID. */
  gtmId?: string;
  /** Port of the notebook gateway when the browser derives its URL from the page. */
  notebookGatewayPort?: string;
};

export type PublicConfigKey = keyof PublicConfig;

/** The runtime variable behind each setting, and the build-time one it falls back to. */
export const PUBLIC_CONFIG_VARS: Record<PublicConfigKey, { runtime: string; build: string }> = {
  supabaseUrl: { runtime: "PUBLIC_SUPABASE_URL", build: "VITE_SUPABASE_URL" },
  supabasePublishableKey: {
    runtime: "PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    build: "VITE_SUPABASE_PUBLISHABLE_KEY",
  },
  adminEmail: { runtime: "PUBLIC_ADMIN_EMAIL", build: "VITE_ADMIN_EMAIL" },
  biSnapshotRowsCap: { runtime: "PUBLIC_BI_SNAPSHOT_ROWS_CAP", build: "VITE_BI_SNAPSHOT_ROWS_CAP" },
  gaId: { runtime: "PUBLIC_GA_ID", build: "VITE_GA_ID" },
  gtmId: { runtime: "PUBLIC_GTM_ID", build: "VITE_GTM_ID" },
  notebookGatewayPort: {
    runtime: "PUBLIC_NOTEBOOK_GATEWAY_PORT",
    build: "VITE_NOTEBOOK_GATEWAY_PORT",
  },
};

const KEYS = Object.keys(PUBLIC_CONFIG_VARS) as PublicConfigKey[];

/** What the build inlined. Literal forms on purpose; see the header. */
export function buildTimePublicConfig(): PublicConfig {
  return clean({
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabasePublishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    adminEmail: import.meta.env.VITE_ADMIN_EMAIL,
    biSnapshotRowsCap: import.meta.env.VITE_BI_SNAPSHOT_ROWS_CAP,
    gaId: import.meta.env.VITE_GA_ID,
    gtmId: import.meta.env.VITE_GTM_ID,
    notebookGatewayPort: import.meta.env.VITE_NOTEBOOK_GATEWAY_PORT,
  });
}

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Why a value cannot be used for this setting, or null when it can. */
export function rejectPublicValue(
  key: PublicConfigKey,
  value: string,
  env: Env = {},
): string | null {
  switch (key) {
    case "supabaseUrl": {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return "is not a URL";
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return "must be http(s)";
      return null;
    }
    case "supabasePublishableKey":
      if (/\s/.test(value) || value.length > 4096) return "is not a key";
      if (env.SUPABASE_SERVICE_ROLE_KEY && value === env.SUPABASE_SERVICE_ROLE_KEY) {
        return "is the service-role key, which must never reach a browser";
      }
      if (value.startsWith("sb_secret_"))
        return "is a secret key, which must never reach a browser";
      if (jwtRole(value) === "service_role") {
        return "is a service_role key, which must never reach a browser";
      }
      return null;
    case "adminEmail":
      return /^[^\s@]+@[^\s@]+$/.test(value) && value.length <= 320
        ? null
        : "is not an e-mail address";
    case "biSnapshotRowsCap":
      // widgetRowCap truncates and clamps; this only keeps out what is not a number.
      return /^\d{1,9}(\.\d+)?$/.test(value) ? null : "must be a number";
    case "gaId":
    case "gtmId":
      return ID_RE.test(value) ? null : "must be letters, digits and dashes";
    case "notebookGatewayPort": {
      const n = Number(value);
      return /^\d{1,5}$/.test(value) && n >= 1 && n <= 65535 ? null : "must be a port number";
    }
  }
}

/**
 * The browser settings in a server environment. Per setting: PUBLIC_<NAME>,
 * else VITE_<NAME> if the server's environment has it. The second is there so
 * an environment made from an existing .env (a Kubernetes Secret, a
 * `docker run --env-file`) works with an image built without VITE_ values,
 * with nothing renamed. In Compose the two VITE_ copies are the same .env, so
 * nothing changes there.
 *
 * A value that fails its check is left out, so the next source applies, and
 * `warn` names the variable (never the value). Literal reads, so the docs
 * checks can see each variable is used.
 */
export function runtimePublicConfig(env: Env, warn: Warn = () => {}): PublicConfig {
  const named: PublicConfig = {
    supabaseUrl: env.PUBLIC_SUPABASE_URL,
    supabasePublishableKey: env.PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    adminEmail: env.PUBLIC_ADMIN_EMAIL,
    biSnapshotRowsCap: env.PUBLIC_BI_SNAPSHOT_ROWS_CAP,
    gaId: env.PUBLIC_GA_ID,
    gtmId: env.PUBLIC_GTM_ID,
    notebookGatewayPort: env.PUBLIC_NOTEBOOK_GATEWAY_PORT,
  };
  const legacy: PublicConfig = {
    supabaseUrl: env.VITE_SUPABASE_URL,
    supabasePublishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    adminEmail: env.VITE_ADMIN_EMAIL,
    biSnapshotRowsCap: env.VITE_BI_SNAPSHOT_ROWS_CAP,
    gaId: env.VITE_GA_ID,
    gtmId: env.VITE_GTM_ID,
    notebookGatewayPort: env.VITE_NOTEBOOK_GATEWAY_PORT,
  };
  const out: PublicConfig = {};
  for (const key of KEYS) {
    const sources: Array<[string, string | undefined]> = [
      [PUBLIC_CONFIG_VARS[key].runtime, named[key]],
      [PUBLIC_CONFIG_VARS[key].build, legacy[key]],
    ];
    for (const [name, raw] of sources) {
      const value = raw?.trim();
      if (!value) continue;
      const why = rejectPublicValue(key, value, env);
      if (why) {
        warn(`${name} ${why}; ignoring it`);
        continue;
      }
      out[key] = value;
      break;
    }
  }
  return out;
}

/**
 * Refuses to build a bundle that would carry a key the database trusts.
 * vite.config.ts calls it with the environment it builds from: a
 * VITE_SUPABASE_PUBLISHABLE_KEY that is the service-role key (or any
 * service_role or sb_secret_ key) would be inlined into code every visitor
 * downloads, and no runtime check can take it back out.
 */
export function assertSafeBuildEnv(env: Env): void {
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!key) return;
  const why = rejectPublicValue("supabasePublishableKey", key, env);
  if (why && /service|secret/.test(why)) {
    throw new Error(
      `VITE_SUPABASE_PUBLISHABLE_KEY ${why}. Refusing to build: it would be inlined into the ` +
        "browser bundle every visitor downloads. Use the anon (publishable) key.",
    );
  }
}

/** Per setting: the runtime value when there is one, else the build-time one. */
export function mergePublicConfig(runtime: PublicConfig, build: PublicConfig): PublicConfig {
  return clean({ ...build, ...clean(runtime) });
}

/**
 * JSON for the data block. `<` is escaped so no value can close the element
 * (`</script>`) or open a comment; JSON.parse reads `<` back as `<`.
 */
export function serializePublicConfig(config: PublicConfig): string {
  const ordered: PublicConfig = {};
  for (const key of KEYS) if (config[key]) ordered[key] = config[key];
  return JSON.stringify(ordered).replace(/</g, "\\u003c");
}

/** Reads a data block back. Anything that is not a known string setting is dropped. */
export function parsePublicConfig(text: string | null | undefined): PublicConfig {
  if (!text) return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: PublicConfig = {};
  for (const key of KEYS) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

const isBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";

function serverEnv(): Env {
  return typeof process !== "undefined" && process.env ? (process.env as Env) : {};
}

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[agentswarms] ${message}`);
}

let browserCache: PublicConfig | undefined;

/**
 * The settings in effect here. In the browser: the page's data block over the
 * build-time values, read once. On the server: PUBLIC_* from the environment
 * over the build-time values, read per call (cheap, and tests change env).
 */
export function publicConfig(): PublicConfig {
  if (isBrowser()) {
    if (!browserCache) {
      const el = document.getElementById(PUBLIC_CONFIG_ELEMENT_ID);
      browserCache = mergePublicConfig(parsePublicConfig(el?.textContent), buildTimePublicConfig());
    }
    return browserCache;
  }
  return mergePublicConfig(runtimePublicConfig(serverEnv(), warnOnce), buildTimePublicConfig());
}

/**
 * The text of the data block. The server renders its runtime values only:
 * the build-time ones are already in the bundle. The browser, hydrating the
 * same element, returns the text the server sent, so the two always match.
 */
export function publicConfigScriptText(): string {
  if (isBrowser()) {
    return document.getElementById(PUBLIC_CONFIG_ELEMENT_ID)?.textContent ?? "{}";
  }
  return serializePublicConfig(runtimePublicConfig(serverEnv(), warnOnce));
}

/** Test hook: forget what the browser read. */
export function resetPublicConfigForTests() {
  browserCache = undefined;
  warned.clear();
}

function clean(config: PublicConfig): PublicConfig {
  const out: PublicConfig = {};
  for (const key of KEYS) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** The `role` claim of a JWT-shaped key, without verifying it. */
function jwtRole(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    // atob exists in every browser and in Node 16+, so this file stays free
    // of Node-only APIs (it ships in the client bundle).
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as {
      role?: unknown;
    };
    return typeof payload.role === "string" ? payload.role : undefined;
  } catch {
    return undefined;
  }
}
