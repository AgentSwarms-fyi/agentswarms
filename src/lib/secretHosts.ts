// Where a shared secret may be sent (R419, VA-2026-10-25-30).
//
// Sharing a secret is meant to let a colleague USE it without ever seeing it.
// That holds only while they cannot choose where the value goes, and in every
// config they write they do choose: a provider's base URL, a connection's host,
// an HTTP node's URL. So the secret's owner names the hosts it may be sent to,
// and a shared secret resolves only toward those. The owner's own use is never
// restricted.
//
// PURE module (no node APIs): the Secrets editor validates as you type with the
// same rules the server enforces when it saves and when it resolves.

/** How many hosts one secret may list. */
export const MAX_ALLOWED_HOSTS = 50;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The host name in a URL, a `host:port` or a bare host: lower-case, no port,
 * no brackets, no trailing dot, an international name as punycode. Null when
 * the input is not one.
 */
export function hostOf(input: string): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(SCHEME_RE.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  let h = url.hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.+$/, "");
  if (!h) return null;
  // An IPv6 literal, or labels of letters, digits and hyphens.
  if (h.includes(":")) return /^[0-9a-f:.]+$/.test(h) ? h : null;
  if (h.length > 253) return null;
  const labels = h.split(".");
  if (labels.some((l) => !/^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return null;
  return h;
}

const isIp = (h: string) => h.includes(":") || /^\d+(\.\d+){3}$/.test(h);

/**
 * One entry of an owner's list: a host (`api.openai.com`, `10.0.0.5`), or
 * `*.` followed by a domain of at least two labels (`*.snowflakecomputing.com`),
 * which matches every name under it but not the domain itself. A URL is
 * accepted and kept as its host.
 */
export function parseAllowedHost(
  entry: string,
): { ok: true; host: string } | { ok: false; error: string } {
  const raw = (entry ?? "").trim();
  if (!raw) return { ok: false, error: "Enter a host name" };
  const wildcard = raw.startsWith("*.");
  const rest = wildcard ? raw.slice(2) : raw;
  if (rest.includes("*")) {
    return {
      ok: false,
      error: `"${raw}": a wildcard can only stand for the first part, as in *.example.com`,
    };
  }
  const host = hostOf(rest);
  if (!host) return { ok: false, error: `"${raw}" is not a host name` };
  if (wildcard) {
    if (isIp(host)) return { ok: false, error: `"${raw}": an IP address cannot take a wildcard` };
    if (host.split(".").length < 2) {
      return {
        ok: false,
        error: `"${raw}" would match every ${host} name: name a domain, as in *.example.com`,
      };
    }
    return { ok: true, host: `*.${host}` };
  }
  return { ok: true, host };
}

/** A whole list, deduplicated, in the order given. The first bad entry is the error. */
export function parseAllowedHosts(
  entries: readonly string[],
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const hosts: string[] = [];
  for (const e of entries) {
    if (!e.trim()) continue;
    const p = parseAllowedHost(e);
    if (!p.ok) return p;
    if (!hosts.includes(p.host)) hosts.push(p.host);
  }
  if (hosts.length > MAX_ALLOWED_HOSTS) {
    return { ok: false, error: `List at most ${MAX_ALLOWED_HOSTS} hosts` };
  }
  return { ok: true, hosts };
}

/**
 * Where a shared secret may go, in the words the Secrets page and the IAM
 * share dialog both show next to it.
 */
export function sharedUseNote(hosts: readonly string[] | null | undefined): string {
  return hosts && hosts.length > 0
    ? `May be sent to ${hosts.join(", ")}`
    : "Allows no host yet, so people it is shared with cannot use it";
}

/** Whether `host` (a URL or a host) is on the list. Unparseable input never is. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = hostOf(host);
  if (!h) return false;
  for (const entry of allowed) {
    if (typeof entry !== "string") continue;
    const p = entry.trim().toLowerCase();
    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (p === h) {
      return true;
    }
  }
  return false;
}
