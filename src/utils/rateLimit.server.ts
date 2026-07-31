// Request limiting for public endpoints, in two flavours.
//
// The functions WITHOUT a "Global" suffix keep their state in this process's
// memory: behind a load balancer with N instances the effective ceiling is N x
// the configured limit. That is fine for cheap, high-frequency endpoints where
// the limit only needs to stop a runaway client, and it costs no round trip.
//
// The *Global* variants count in Postgres, so every instance shares one
// counter and the configured number is the number an operator actually gets.
// Use them wherever the limit is a GOVERNANCE claim rather than a guard — the
// documented per-key ceilings on swarm runs, for one, which silently became
// 4x their configured value on a four-instance deployment.
//
// They cost one round trip, so they are for expensive operations (a swarm run
// holds a worker for minutes), not for per-keystroke endpoints.

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

// ── Cross-instance limiting (Postgres-backed) ───────────────────────────────

/**
 * Sliding-window rate limit shared by every app instance.
 *
 * Returns true when the caller is over its allowance. On a database error it
 * FALLS BACK to the in-process limiter rather than failing the request: a
 * transient Postgres blip must not take down every run, and the fallback is
 * still the behaviour this endpoint had before. The failure is logged so a
 * persistent outage is visible rather than silently downgrading governance.
 */
export async function rateLimitedGlobal(bucket: string, maxPerMinute: number): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("rate_limit_take", {
      _bucket: bucket,
      _max: maxPerMinute,
      _window_seconds: 60,
    });
    if (error) throw new Error(error.message);
    return data === false;
  } catch (e) {
    console.warn(
      `[rate-limit] global limiter unavailable, falling back to per-instance: ${(e as Error).message}`,
    );
    return rateLimited(bucket, maxPerMinute);
  }
}

/** A held cross-instance slot. `release` is safe to call more than once. */
export type GlobalSlot = { release: () => Promise<void> };

/**
 * Take a concurrency slot shared by every app instance, or null when the bucket
 * is full.
 *
 * The lease carries a TTL so a crashed instance's slot frees itself; without
 * that, the effective cap would ratchet down to zero and never recover. The
 * caller must still release explicitly in a `finally` — the TTL is the backstop
 * for crashes, not the normal path.
 */
export async function acquireSlotGlobal(
  bucket: string,
  max: number,
  leaseSeconds: number,
): Promise<GlobalSlot | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("concurrency_acquire", {
      _bucket: bucket,
      _max: max,
      _lease_seconds: Math.max(60, Math.ceil(leaseSeconds)),
    });
    if (error) throw new Error(error.message);
    if (!data) return null; // bucket full
    const id = String(data);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await supabaseAdmin.rpc("concurrency_release", { _id: id });
        } catch {
          // The lease expires on its own; losing the release is not fatal.
        }
      },
    };
  } catch (e) {
    console.warn(
      `[rate-limit] global concurrency unavailable, falling back to per-instance: ${(e as Error).message}`,
    );
    if (!acquireSlot(bucket, max)) return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        releaseSlot(bucket);
      },
    };
  }
}

/** Read a positive integer env knob, falling back to `fallback`. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
