// One lockfile (VA-2026-10-25-27). bun.lock sat beside package-lock.json from
// the first commit and was never updated: osv found 178 advisories in it
// against 1 in package-lock.json, and anyone running `bun install` got those
// versions. CI, the Docker build and the audits install from package-lock.json;
// Bun converts that file on its first install when there is no bun.lock.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OTHER_LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
];

function tracked(): string[] | null {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null; // not a git checkout (a source tarball): nothing to compare
  }
}

describe("the repository's lockfile", () => {
  it("is package-lock.json, and no other lockfile is committed", () => {
    expect(existsSync("package-lock.json")).toBe(true);
    const files = tracked();
    if (!files) return;
    expect(files).toContain("package-lock.json");
    expect(files.filter((f) => OTHER_LOCKFILES.includes(f))).toEqual([]);
  });

  it("keeps a Bun user's converted lockfile out of commits, and the install guide says why", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    expect(ignore).toMatch(/^bun\.lock$/m);
    expect(ignore).toMatch(/^bun\.lockb$/m);
    const install = readFileSync("docs/INSTALL.md", "utf8");
    expect(install).toContain("`package-lock.json` is the only lockfile in the repository.");
    expect(install).not.toContain("both `package-lock.json` and `bun.lock` are committed");
  });
});
