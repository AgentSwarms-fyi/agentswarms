// Squid dstdomain allow-list rendering for notebook kernel egress.
//
// Pure module (no `.server` suffix, no imports) so the rendering and hostname
// rules can be unit-tested — `.server.ts` files are import-protected.

/** Hosts always permitted, whatever the operator configures. Without PyPI a
 *  kernel cannot `pip install` anything, which defeats the runtime's purpose;
 *  without the DuckDB extension registry an ETL lakehouse node cannot load
 *  `ducklake` and dies before it reads a single row. Both are platform
 *  requirements rather than operator preferences, which is why neither may be
 *  hand-written into the generated ACL file — a settings save regenerates that
 *  file and would silently drop them. */
export const EGRESS_BASELINE = ["pypi.org", "files.pythonhosted.org", "duckdb.org"];

/**
 * Normalise one operator-entered host into a squid `dstdomain` token.
 *
 * Squid treats a leading dot as "this domain and all subdomains", which is
 * almost always what someone means when they type `github.com` — package
 * installs routinely redirect to `codeload.github.com` or a CDN subdomain, and
 * an entry without the dot would silently fail to match those.
 *
 * Returns null for anything that isn't a usable hostname, so a typo is dropped
 * rather than written into the ACL where it would be inert.
 */
export function normalizeEgressHost(raw: string): string | null {
  let h = (raw ?? "").trim().toLowerCase();
  if (!h || h.startsWith("#")) return null;

  // Tolerate pasted URLs: strip scheme, path, port, credentials.
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split("/")[0];
  h = h.split("@").pop() ?? h;
  h = h.replace(/:\d+$/, "");
  // A leading dot is meaningful to squid; strip it here and re-add below so
  // "github.com" and ".github.com" normalise to the same token.
  h = h.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!h) return null;

  // Wildcards are written as a leading dot in squid, not as "*".
  h = h.replace(/^\*\./, "");

  // Reject anything that isn't a plausible hostname.
  //
  // The previous test was /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, which admits digits in
  // every label and so accepted IP ADDRESSES — `10.0.0.1` became the ACL entry
  // `.10.0.0.1`. squid matches dstdomain by DNS suffix, so that entry can never
  // match a request to 10.0.0.1 and sits there doing nothing. An operator who
  // allow-lists an internal address then believes egress to it is permitted
  // when it is not, which is exactly the "written into the ACL where it would
  // be inert" outcome this function's contract promises to prevent. It also
  // accepted `-lead.com` and `trail-.com`, which are not valid hostnames.
  if (h.length > 253) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  // RFC 1123: a label is alphanumeric, may contain inner hyphens, max 63.
  const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!labels.every((l) => l.length > 0 && l.length <= 63 && LABEL.test(l))) return null;
  // An all-numeric final label means this is an address, not a domain: no real
  // TLD is numeric. This is what rejects IPv4. (IPv6 never reaches here — the
  // colon-stripping above mangles it and the label test then fails.)
  if (/^\d+$/.test(labels[labels.length - 1])) return null;

  return "." + h;
}

/**
 * Render the full squid ACL file from the operator's list.
 *
 * The baseline is unioned in and the result de-duplicated, so an operator
 * cannot lock kernels out of PyPI by clearing the field.
 */
/** Raw IPv4 (optionally with port already stripped by normalize). */
/**
 * Does `host` match one allow-list pattern, the way squid matches dstdomain?
 *
 * A leading dot is a SUFFIX: `.github.com` matches `github.com` and every
 * subdomain of it. Anything else is exact.
 *
 * Deliberately NOT routed through `normalizeEgressHost`, which is for the ACL
 * FILE and so requires a real two-label domain. The hosts a sandbox reaches
 * without the proxy at all — `agentswarms`, `localhost`, a Kubernetes `.svc`
 * — are single-label or bare suffixes, and a checker that drops them reports
 * a reachable host as forbidden.
 */
export function hostMatchesPattern(pattern: string, host: string): boolean {
  const clean = (raw: string, keepDot: boolean) => {
    let h = (raw ?? "").trim().toLowerCase();
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    h = h.split("/")[0];
    h = h.split("@").pop() ?? h;
    h = h.replace(/:\d+$/, "");
    h = h.replace(/\.+$/, "");
    return keepDot ? h : h.replace(/^\.+/, "");
  };
  const p = clean(pattern, true);
  const h = clean(host, false);
  if (!p || !h) return false;
  if (p.startsWith(".")) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

/**
 * Is `host` reachable from a sandbox, given the allow-list and what bypasses
 * the proxy entirely?
 *
 * Both lists are consulted because both make a host reachable, and a refusal
 * that ignores the second sends the reader to add something that would change
 * nothing. Written after the exact-match version refused a subdomain of an
 * allow-listed domain — squid would have let it through, so the sentence
 * "not on the sandbox egress allow-list" was false.
 */
export function egressReaches(patterns: Iterable<string>, host: string): boolean {
  for (const p of patterns) if (hostMatchesPattern(p, host)) return true;
  return false;
}

/**
 * The host a URL will dial, when that is knowable without running anything.
 *
 * Returns nothing for a URL carrying a run parameter (`https://{{params.host}}/v1`)
 * or one that does not parse: those have no host until a run substitutes one,
 * and refusing on a guess would block a pipeline that is fine. Everything else
 * gives up its hostname, so a node pointing off this machine can be held to
 * the egress allow-list BEFORE a container starts — rather than coming back as
 * a urllib3 ProxyError that never mentions an allow-list.
 */
export function staticEgressHost(url: string | undefined | null): string[] {
  const raw = (url ?? "").trim();
  if (!raw || raw.includes("{{")) return [];
  try {
    return [new URL(raw).hostname];
  } catch {
    return [];
  }
}

export function isEgressIp(token: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(token.replace(/^\./, ""));
}

/**
 * Normalise one entry into a squid `dst` token, or null if it is not an
 * address.
 *
 * The counterpart to normalizeEgressHost, and the reason both exist: an entry
 * is only genuinely discarded when BOTH return null. Callers that ask only one
 * of them will conclude a valid LAN address is being ignored while the proxy is
 * in fact honouring it.
 */
export function normalizeEgressIp(raw: string): string | null {
  // normalizeEgressHost REJECTS addresses by design (they are inert as
  // dstdomain entries), so strip scheme/port here and keep only clean IPv4.
  let h = (raw ?? "").trim().toLowerCase();
  if (!h || h.startsWith("#")) return null;
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split("/")[0];
  h = h.split("@").pop() ?? h;
  h = h.replace(/:\d+$/, "");
  if (!isEgressIp(h)) return null;
  return h.split(".").every((o) => Number(o) <= 255) ? h : null;
}

/**
 * The squid `dst` file for raw-IP destinations. dstdomain never matches an
 * IP-form URL, so entries like a LAN MinIO (192.168.1.10) silently did
 * nothing in the domains file — the exact "field that looks like it works"
 * failure this module exists to prevent.
 */
export function renderEgressIpAllowlist(hosts: string[]): string {
  const ips = new Set<string>();
  for (const raw of hosts ?? []) {
    const ip = normalizeEgressIp(raw);
    if (ip) ips.add(ip);
  }
  return (
    "# Generated by AgentSwarms from notebook_runtime_settings.egress_allowlist.\n" +
    "# Raw-IP destinations (squid dst); domains live in allowed_domains.\n" +
    [...ips].join("\n") +
    "\n"
  );
}

export function renderEgressAllowlist(hosts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...EGRESS_BASELINE, ...(hosts ?? [])]) {
    const token = normalizeEgressHost(raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return (
    "# Generated by AgentSwarms from notebook_runtime_settings.egress_allowlist.\n" +
    "# Edits here are overwritten whenever an administrator saves runtime settings —\n" +
    "# change the list under Admin → Developer runtime instead.\n" +
    "#\n" +
    "# A leading dot matches the domain and all of its subdomains.\n" +
    out.join("\n") +
    "\n"
  );
}
