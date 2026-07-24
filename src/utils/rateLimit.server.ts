// Lightweight in-process request limiting for public endpoints.
//
// SCOPE / LIMITATION: state lives in this process's memory. Behind a load
// balancer with N app instances the effective ceiling is N x the configured
// limit, because each instance counts independently. That is deliberate — it
// keeps the OSS build dependency-free — but it means these limits are a guard
// against runaway/abusive clients, NOT a billing or quota mechanism. For a hard
// global limit, enforce it at the ingress/CDN or move this state to Redis.

// ── Sliding-window request rate limiting ────────────────────────────────────
const hits = new Map<string, number[]>();

/**
 * Returns true when `bucket` has already used its allowance for the last 60s.
 * Call once per request; a false return records the hit.
 */
export function rateLimited(bucket: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const arr = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= maxPerMinute) {
    hits.set(bucket, arr);
    return true;
  }
  arr.push(now);
  hits.set(bucket, arr);
  // Opportunistic cleanup so the map cannot grow unboundedly.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.length === 0 || now - v[v.length - 1] > 60_000) hits.delete(k);
    }
  }
  return false;
}

// ── Concurrency gating ──────────────────────────────────────────────────────
// Rate limiting alone doesn't bound *simultaneous* work: a swarm run can hold a
// worker for minutes, so a client well under the per-minute limit can still pile
// up long-running requests. This caps how many may be in flight per bucket.
const inFlight = new Map<string, number>();

/** Try to take a slot. Returns false when the bucket is already at its cap. */
export function acquireSlot(bucket: string, max: number): boolean {
  const n = inFlight.get(bucket) ?? 0;
  if (n >= max) return false;
  inFlight.set(bucket, n + 1);
  return true;
}

/** Release a slot taken by acquireSlot. Always call this in a `finally`. */
export function releaseSlot(bucket: string): void {
  const n = (inFlight.get(bucket) ?? 1) - 1;
  if (n <= 0) inFlight.delete(bucket);
  else inFlight.set(bucket, n);
}

/** Read a positive integer env knob, falling back to `fallback`. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
