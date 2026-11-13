// Transitive dependencies with a known advisory below a version (R403,
// VA-2026-10-25-36; msal-node, minimatch and glob since R462). They are not
// in package.json — TanStack Start brings seroval, duckdb-wasm brings qs,
// tedious brings msal-node, ESLint's parser and react-email bring minimatch
// and glob — so `npm audit fix` or a careless lockfile regeneration could
// quietly put an affected version back. This reads the lockfile the Docker
// build installs from.
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
  // tedious brings it in through @azure/identity (R462): the authorization-code
  // flow could send its parameters to an endpoint the caller did not choose.
  ["@azure/msal-node", "7.1.0", "GHSA-xcx6-jx8p-x3h5"],
  // The first identity release that asks for msal-node 7 itself (^7.1.0), so
  // no override forces the pair.
  ["@azure/identity", "4.14.1", "the first release on msal-node 7"],
];

/**
 * Advisories that affect a RANGE of releases, where older lines are fine:
 * minimatch 3.x and 5.x (ESLint, archiver) predate the affected code, so a
 * floor would be wrong. No installed copy may sit inside the range.
 */
const AFFECTED: [name: string, from: string, fixedIn: string, why: string][] = [
  // >= 7.0.0, < 11.0.1: a pattern that grows its own expansion. Fixed copies
  // come from overrides under @typescript-eslint/typescript-estree and
  // react-email (via glob 14), until those packages ask for them.
  ["minimatch", "7.0.0", "11.0.1", "GHSA-g3hv-75wg-m249"],
  // >= 9.0.0, < 14.0.2: an aborted walk keeps reading directories.
  ["glob", "9.0.0", "14.0.2", "GHSA-3g3m-2fjr-6pw4"],
];

describe("dependencies with a known advisory below a version", () => {
  for (const [name, floor, why] of FLOORS) {
    it(`${name} is at least ${floor} everywhere it is installed (${why})`, () => {
      const versions = versionsOf(name);
      expect(versions.length, `${name} is in the lockfile`).toBeGreaterThan(0);
      for (const v of versions) expect(atLeast(v, floor), `${name}@${v}`).toBe(true);
    });
  }

  for (const [name, from, fixedIn, why] of AFFECTED) {
    it(`no copy of ${name} is at or above ${from} and below ${fixedIn} (${why})`, () => {
      const versions = versionsOf(name);
      expect(versions.length, `${name} is in the lockfile`).toBeGreaterThan(0);
      for (const v of versions) {
        const affected = atLeast(v, from) && !atLeast(v, fixedIn);
        expect(affected, `${name}@${v}`).toBe(false);
      }
    });
  }

  it("tells an affected copy from an older line and a fixed one", () => {
    const affected = (v: string) => atLeast(v, "7.0.0") && !atLeast(v, "11.0.1");
    expect(affected("10.2.6")).toBe(true);
    expect(affected("11.0.0")).toBe(true);
    expect(affected("11.0.3")).toBe(false);
    expect(affected("3.1.5")).toBe(false);
    expect(affected("5.1.9")).toBe(false);
  });

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
