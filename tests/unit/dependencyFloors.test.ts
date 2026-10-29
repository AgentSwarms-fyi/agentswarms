// Transitive dependencies with a known advisory below a version (R403,
// VA-2026-10-25-36). They are not in package.json — TanStack Start brings
// seroval, duckdb-wasm brings qs — so `npm audit fix` or a careless lockfile
// regeneration could quietly put an affected version back. This reads the
// lockfile the Docker build installs from.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
  packages: Record<string, { version?: string }>;
};

/** Every installed copy of a package, nested ones included. */
function versionsOf(name: string): string[] {
  return Object.entries(lock.packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([, meta]) => meta.version ?? "");
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const FLOORS: [name: string, floor: string, why: string][] = [
  // Serializes server-function results for the client: script injection
  // through RegExp sources and a typed array's constructor property.
  ["seroval", "1.6.11", "GHSA-9wx9-5pv9-3349, GHSA-f86p-h4j2-7qgj"],
  ["seroval-plugins", "1.6.11", "ships with seroval; kept on the same release"],
  ["qs", "6.16.1", "GHSA-6pq8-jhm2-2vcw"],
];

describe("dependencies with a known advisory below a version", () => {
  for (const [name, floor, why] of FLOORS) {
    it(`${name} is at least ${floor} everywhere it is installed (${why})`, () => {
      const versions = versionsOf(name);
      expect(versions.length, `${name} is in the lockfile`).toBeGreaterThan(0);
      for (const v of versions) expect(atLeast(v, floor), `${name}@${v}`).toBe(true);
    });
  }

  it("keeps seroval and its plugins on the same release, as TanStack Start expects", () => {
    expect(versionsOf("seroval-plugins")).toEqual(versionsOf("seroval"));
  });

  it("compares versions numerically, not as text", () => {
    expect(atLeast("1.6.12", "1.6.11")).toBe(true);
    expect(atLeast("1.6.9", "1.6.11")).toBe(false);
    expect(atLeast("1.10.0", "1.6.11")).toBe(true);
    expect(atLeast("6.16.0", "6.16.1")).toBe(false);
  });
});
