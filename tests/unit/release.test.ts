// R469: releases. scripts/release.mjs prepares one (version + CHANGELOG),
// plans the workflow's run from the tag, and writes the GitHub Release's
// notes; scripts/check-runtime-imports.mjs keeps the app image's pruned
// node_modules honest. docs/RELEASING.md is the guide.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bareSpecifiers, packageOf } from "../../scripts/check-runtime-imports.mjs";
import {
  SUMMARY_MARKER,
  changelogSection,
  compareVersions,
  contractsIn,
  imageTags,
  parseVersion,
  planRelease,
  prepareChangelog,
  RELEASE_BODY_LIMIT,
  releaseNotes,
  setPackageVersion,
} from "../../scripts/release.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "---",
  "",
  "## Unreleased",
  "",
  "### Added",
  "",
  "- **A thing (R469).** It works.",
  "",
  "## 1.6.0 — 2026-10-06",
  "",
  "**1.6 summary.**",
  "",
  "### Fixed",
  "",
  "- Old fix.",
  "",
].join("\n");

const MANIFEST = {
  registry: "ghcr.io/agentswarms-fyi",
  source: "https://github.com/AgentSwarms-fyi/agentswarms",
  platforms: ["linux/amd64", "linux/arm64"],
  images: [
    { name: "agentswarms", title: "App", context: ".", dockerfile: "Dockerfile", smoke: "a.sh" },
    {
      name: "db-migrate",
      title: "DB",
      context: ".",
      dockerfile: "docker/db-migrate/Dockerfile",
      smoke: "d.sh",
    },
  ],
};

describe("versions", () => {
  it("reads MAJOR.MINOR.PATCH with an optional prerelease, and nothing else", () => {
    expect(parseVersion("1.7.0")).toEqual({ major: 1, minor: 7, patch: 0, pre: null });
    expect(parseVersion("1.7.0-rc.1").pre).toBe("rc.1");
    for (const bad of ["v1.7.0", "1.7", "1.7.0.1", "latest", ""])
      expect(() => parseVersion(bad)).toThrow();
  });

  it("orders them as semver does", () => {
    expect(compareVersions("1.7.0", "1.6.0")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.7.0-rc.1", "1.7.0")).toBeLessThan(0);
    expect(compareVersions("1.7.0", "1.7.0")).toBe(0);
  });

  it("publishes a release as itself, its minor line and latest; a prerelease only as itself", () => {
    expect(imageTags("1.7.0", ["1.6.0", "1.7.0"])).toEqual(["1.7.0", "1.7", "latest"]);
    expect(imageTags("1.7.0-rc.1", ["1.6.0"])).toEqual(["1.7.0-rc.1"]);
  });

  it("a patch on an older line moves neither latest nor a newer patch's minor tag back", () => {
    const released = ["1.6.0", "1.7.0", "1.8.0", "1.8.0-rc.1"];
    expect(imageTags("1.7.1", released)).toEqual(["1.7.1", "1.7"]);
    expect(imageTags("1.7.1", [...released, "1.7.2"])).toEqual(["1.7.1"]);
    // A prerelease of a newer version does not hold latest back.
    expect(imageTags("1.8.1", [...released, "1.9.0-rc.1"])).toEqual(["1.8.1", "1.8", "latest"]);
  });
});

describe("preparing a release", () => {
  it("moves Unreleased under the version, with a summary still to write", () => {
    const out = prepareChangelog(CHANGELOG, "1.7.0", "2026-12-01");
    expect(out).toContain(
      "## Unreleased\n\nNothing yet.\n\n## 1.7.0 — 2026-12-01\n\n" + SUMMARY_MARKER,
    );
    expect(changelogSection(out, "1.7.0")).toContain("- **A thing (R469).** It works.");
    expect(changelogSection(out, "1.6.0")).toContain("- Old fix.");
    expect(out.startsWith("# Changelog\n\nIntro.\n\n---\n\n")).toBe(true);
  });

  it("refuses an empty Unreleased, or a version already there", () => {
    const once = prepareChangelog(CHANGELOG, "1.7.0", "2026-12-01");
    expect(() => prepareChangelog(once, "1.7.1", "2026-12-02")).toThrow(/nothing under Unreleased/);
    expect(() => prepareChangelog(CHANGELOG, "1.6.0", "2026-12-01")).toThrow(/already has 1.6.0/);
  });

  it("sets the version in package.json and both places in package-lock.json", () => {
    const { pkg, lock } = setPackageVersion(
      JSON.stringify({ name: "agentswarms", version: "1.6.0", private: true }, null, 2),
      JSON.stringify(
        { name: "agentswarms", version: "1.6.0", packages: { "": { version: "1.6.0" } } },
        null,
        2,
      ),
      "1.7.0",
    );
    expect(JSON.parse(pkg)).toEqual({ name: "agentswarms", version: "1.7.0", private: true });
    expect(JSON.parse(lock).version).toBe("1.7.0");
    expect(JSON.parse(lock).packages[""].version).toBe("1.7.0");
    expect(pkg.endsWith("}\n")).toBe(true);
  });
});

describe("planning the workflow's run", () => {
  const prepared = prepareChangelog(CHANGELOG, "1.7.0", "2026-12-01");
  const written = prepared.replace(SUMMARY_MARKER, "**1.7 is the release that ships images.**");
  const plan = (o: Record<string, unknown>) =>
    planRelease({
      sha: "abcdef1234",
      pkgVersion: "1.7.0",
      changelog: written,
      manifest: MANIFEST,
      ...o,
    });

  it("a tag publishes, with every image on both architectures, each on its own runner", () => {
    const p = plan({ refType: "tag", refName: "v1.7.0" });
    expect(p.publish).toBe(true);
    expect(p.tags).toEqual(["1.7.0", "1.7", "latest"]);
    expect(p.matrix.include).toHaveLength(4);
    expect(
      p.matrix.include.map((m: { runner: string; arch: string }) => `${m.arch}:${m.runner}`).sort(),
    ).toEqual([
      "amd64:ubuntu-24.04",
      "amd64:ubuntu-24.04",
      "arm64:ubuntu-24.04-arm",
      "arm64:ubuntu-24.04-arm",
    ]);
    expect(p.images).toEqual(["agentswarms", "db-migrate"]);
  });

  it("refuses a tag that is not v<package.json version>", () => {
    expect(() => plan({ refType: "tag", refName: "v1.7.1" })).toThrow(
      /does not match package.json/,
    );
  });

  it("refuses a version with no CHANGELOG section, or one whose summary was never written", () => {
    expect(() => plan({ refType: "tag", refName: "v1.7.0", changelog: CHANGELOG })).toThrow(
      /no "## 1.7.0/,
    );
    expect(() => plan({ refType: "tag", refName: "v1.7.0", changelog: prepared })).toThrow(
      /write the 1.7.0 summary/,
    );
  });

  it("anything but a tag is a rehearsal: it builds and tests, and publishes nothing", () => {
    const p = plan({ refType: "branch", refName: "main" });
    expect(p.publish).toBe(false);
    expect(p.version).toBe("1.7.0-dev.abcdef1");
    expect(p.tags).toEqual([]);
    expect(p.matrix.include).toHaveLength(4);
  });
});

describe("the release notes", () => {
  const changelog = prepareChangelog(CHANGELOG, "1.7.0", "2026-12-01").replace(
    SUMMARY_MARKER,
    "**Summary.**",
  );
  const released = [
    {
      image: "agentswarms",
      repository: "ghcr.io/agentswarms-fyi/agentswarms",
      digest: "sha256:" + "a".repeat(64),
      tags: ["1.7.0", "1.7", "latest"],
      mirrors: ["public.ecr.aws/x/agentswarms@sha256:" + "a".repeat(64)],
    },
  ];

  it("carry the CHANGELOG section, every digest, and how to check a signature", () => {
    const notes = releaseNotes({
      version: "1.7.0",
      changelog,
      released,
      repo: "AgentSwarms-fyi/agentswarms",
      previous: "v1.6.0",
      migrations: [
        { name: "20261114000000_add.sql", contracts: [] },
        { name: "20261115000000_drop.sql", contracts: ["public.old_table"] },
      ],
    });
    expect(notes).toContain("**Summary.**");
    expect(notes).toContain("- **A thing (R469).** It works.");
    expect(notes).not.toContain("Old fix.");
    expect(notes).toContain(
      "| `ghcr.io/agentswarms-fyi/agentswarms` | `1.7.0` `1.7` `latest` | `sha256:aaaa",
    );
    expect(notes).toContain("public.ecr.aws/x/agentswarms@sha256:");
    expect(notes).toContain(
      "--certificate-identity-regexp '^https://github\\.com/AgentSwarms-fyi/agentswarms/\\.github/workflows/release\\.yml@refs/tags/v'",
    );
    expect(notes).toContain("2 new migrations since v1.6.0");
    expect(notes).toContain("**Removed on purpose**");
    expect(notes).toContain("`public.old_table` (20261115000000_drop.sql)");
  });

  it("fit a GitHub release when the section does not: summary, Upgrading, and a link (R483)", () => {
    const huge = [
      "# Changelog",
      "",
      "## 1.7.0 — 2026-11-14",
      "",
      "**Summary.** What it is for.",
      "",
      "### Added",
      "",
      ...Array.from({ length: 2000 }, (_, i) => `- **Item ${i}.** ${"words ".repeat(20)}`),
      "",
      "### Upgrading",
      "",
      "- **Apply 20261114000000 first.** It only adds.",
      "",
      "## 1.6.0 — 2026-10-06",
      "",
      "Old.",
    ].join("\n");
    const notes = releaseNotes({
      version: "1.7.0",
      changelog: huge,
      released,
      repo: "AgentSwarms-fyi/agentswarms",
      previous: "v1.6.0",
      migrations: [{ name: "20261114000000_add.sql", contracts: [] }],
    });
    expect(notes.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
    expect(notes).toContain("**Summary.** What it is for.");
    expect(notes).toContain("- **Apply 20261114000000 first.** It only adds.");
    expect(notes).toContain(
      "[CHANGELOG.md](https://github.com/AgentSwarms-fyi/agentswarms/blob/v1.7.0/CHANGELOG.md)",
    );
    expect(notes).not.toContain("**Item 1999.**");
    // The images and the database, whatever was cut.
    expect(notes).toContain("| `ghcr.io/agentswarms-fyi/agentswarms` | `1.7.0` `1.7` `latest`");
    expect(notes).toContain("1 new migration since v1.6.0");
  });

  it("fit for the real 1.7.0 section, which did not (R483)", () => {
    const notes = releaseNotes({
      version: "1.7.0",
      changelog: readFileSync("CHANGELOG.md", "utf8"),
      released,
      repo: "AgentSwarms-fyi/agentswarms",
      previous: "v1.6.0",
      migrations: [],
    });
    expect(notes.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
    expect(notes).toContain("AgentSwarms 1.7.0 is the first release published as images");
    expect(notes).toContain("### Upgrading");
  });

  it("say so when there is no migration", () => {
    const notes = releaseNotes({
      version: "1.7.0",
      changelog,
      released,
      repo: "o/r",
      previous: "v1.6.0",
      migrations: [],
    });
    expect(notes).toContain("No new migrations since v1.6.0.");
  });

  it("read contract lines the way the upgrade check does", () => {
    expect(
      contractsIn(
        "-- contract: public.a.b\n  --contract:public.c\nselect 1; -- contract: public.no",
      ),
    ).toEqual(["public.a.b", "public.c"]);
  });
});

describe("what the server imports, read from the bundle", () => {
  it("finds static, dynamic, re-exported and required packages, and not relative or built-in ones", () => {
    const src = [
      'import { a } from "pkg-a";',
      'import "side-effect";',
      'import * as ns from "@scope/b/sub";',
      'export { c } from "pkg-c";',
      'const d = await import("pkg-d");',
      'const e = require("pkg-e");',
      'import f from "./local.js";',
      'import g from "node:fs";',
      'import h from "path";',
      'const u = await import("https://x.example/y.js");',
      // How the bundle loads an optional driver (nodemailer, tedious).
      'const n = await import(/* @vite-ignore */\n      "pkg-n");',
    ].join("\n");
    expect(bareSpecifiers(src).sort()).toEqual([
      "@scope/b/sub",
      "pkg-a",
      "pkg-c",
      "pkg-d",
      "pkg-e",
      "pkg-n",
      "side-effect",
    ]);
    expect(packageOf("@scope/b/sub")).toBe("@scope/b");
    expect(packageOf("lodash/fp")).toBe("lodash");
  });

  it("is run in the image build, before and after the prune", () => {
    const df = readFileSync("Dockerfile", "utf8");
    const record = df.indexOf("check-runtime-imports.mjs --record");
    const prune = df.indexOf("npm prune --omit=dev");
    const verify = df.indexOf("check-runtime-imports.mjs --verify");
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(prune);
    expect(prune).toBeLessThan(verify);
  });
});
