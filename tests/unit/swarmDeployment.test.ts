// The "deployed" badge has to track whether traffic can actually arrive.
//
// It read `swarms.is_deployed` — a column that exists in the migrations only as
// `DEFAULT false`, is written by nothing anywhere in the application, and is
// read in exactly one place: that badge. So it could never be true. A swarm
// with a live API key, reachable from outside the app right now, showed no
// badge at all, and the gallery — the one screen listing every swarm — could
// not answer "which of these are live".
//
// /api/swarm.run authorises on the API KEY and never consults the column, so a
// key that has not been revoked is the deployment. These tests pin the badge to
// that same fact, in both directions.
import { describe, expect, it } from "vitest";

import { liveSwarmIds, type SwarmKeyRow } from "@/lib/swarmDeployment";

describe("a swarm is deployed when a key can still reach it", () => {
  it("counts a key with no revoked_at", () => {
    expect(liveSwarmIds([{ swarm_id: "a", revoked_at: null }])).toEqual(new Set(["a"]));
  });

  it("counts a key whose revoked_at is absent entirely", () => {
    expect(liveSwarmIds([{ swarm_id: "a" }])).toEqual(new Set(["a"]));
  });

  it("DOES NOT count a revoked key", () => {
    // A badge that survives revocation tells the operator the opposite of the
    // truth, at the moment they are trying to confirm they closed access.
    expect(liveSwarmIds([{ swarm_id: "a", revoked_at: "2026-08-01T00:00:00Z" }])).toEqual(
      new Set(),
    );
  });

  it("keeps a swarm live while any one of its keys survives", () => {
    const keys: SwarmKeyRow[] = [
      { swarm_id: "a", revoked_at: "2026-08-01T00:00:00Z" },
      { swarm_id: "a", revoked_at: null },
    ];
    expect(liveSwarmIds(keys)).toEqual(new Set(["a"]));
  });

  it("drops a swarm once its last key is revoked", () => {
    const keys: SwarmKeyRow[] = [
      { swarm_id: "a", revoked_at: "2026-08-01T00:00:00Z" },
      { swarm_id: "a", revoked_at: "2026-08-02T00:00:00Z" },
    ];
    expect(liveSwarmIds(keys)).toEqual(new Set());
  });

  it("separates swarms rather than marking them all live", () => {
    const keys: SwarmKeyRow[] = [
      { swarm_id: "a", revoked_at: null },
      { swarm_id: "b", revoked_at: "2026-08-01T00:00:00Z" },
      { swarm_id: "c", revoked_at: null },
    ];
    expect(liveSwarmIds(keys)).toEqual(new Set(["a", "c"]));
  });
});

describe("junk cannot vouch for a deployment", () => {
  it("ignores a key row with no swarm", () => {
    expect(liveSwarmIds([{ swarm_id: null, revoked_at: null }])).toEqual(new Set());
  });

  it("ignores an empty swarm id", () => {
    expect(liveSwarmIds([{ swarm_id: "", revoked_at: null }])).toEqual(new Set());
  });

  it("treats no keys and a failed fetch alike — nothing is claimed live", () => {
    expect(liveSwarmIds([])).toEqual(new Set());
    expect(liveSwarmIds(null)).toEqual(new Set());
    expect(liveSwarmIds(undefined)).toEqual(new Set());
  });
});
