/**
 * R470: scripts/setup.sh runs a published release by its version, or builds
 * this checkout. Runs the real script against stand-ins for docker, node and
 * openssl, in a throwaway tree, and asserts on the commands it ran and the
 * .env it left.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
const BASH = process.platform === "win32" ? GIT_BASH : "bash";
const hasBash = process.platform !== "win32" || existsSync(GIT_BASH);

const STUBS: Record<string, string> = {
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
case "$*" in
  "compose version") exit 0 ;;
  "compose config") echo "name: stubproj" ;;
  "volume ls"*) ;;
  "compose pull") exit "\${PULL_EXIT:-0}" ;;
  "compose up"*) exit "\${UP_EXIT:-0}" ;;
  "compose exec"*) exit 1 ;;
esac
exit 0
`,
  node: `#!/usr/bin/env bash
echo "node $*" >> "$STUB_DIR/log"
exit 0
`,
  openssl: `#!/usr/bin/env bash
echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
`,
};

const REQUIRED = [
  'SUPABASE_URL="https://x.supabase.co"',
  'SUPABASE_PUBLISHABLE_KEY="anon"',
  'SUPABASE_SERVICE_ROLE_KEY="service"',
  'VITE_SUPABASE_URL="https://x.supabase.co"',
  'VITE_SUPABASE_PUBLISHABLE_KEY="anon"',
  'ADMIN_EMAIL="admin@example.test"',
  'VITE_ADMIN_EMAIL="admin@example.test"',
  'LAKEHOUSE_CATALOG_PASSWORD="already-set"',
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox(env: string[]) {
  const root = mkdtempSync(join(tmpdir(), "setup-release-")).replace(/\\/g, "/");
  dirs.push(root);
  const stubDir = `${root}/stub`;
  mkdirSync(`${stubDir}/bin`, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(`${stubDir}/bin/${name}`, body, { mode: 0o755 });
  }
  mkdirSync(`${root}/scripts`);
  copyFileSync("scripts/setup.sh", `${root}/scripts/setup.sh`);
  copyFileSync(".env.example", `${root}/.env.example`);
  mkdirSync(`${root}/deploy/notebooks/egress`, { recursive: true });
  for (const f of ["allowed_domains", "allowed_ips"]) {
    writeFileSync(`${root}/deploy/notebooks/egress/${f}`, "");
  }
  writeFileSync(`${root}/.env`, [...REQUIRED, ...env, ""].join("\n"));

  const run = (extra: Record<string, string> = {}) => {
    const r = spawnSync(
      BASH,
      [
        "-c",
        'PATH="$(cd "$STUB_DIR/bin" && pwd):$PATH" exec bash "$0" "$@"',
        `${root}/scripts/setup.sh`,
        "--skip-migrations",
      ],
      { encoding: "utf8", input: "", env: { ...process.env, STUB_DIR: stubDir, ...extra } },
    );
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const log = () => (existsSync(`${stubDir}/log`) ? readFileSync(`${stubDir}/log`, "utf8") : "");
  const compose = () =>
    log()
      .split("\n")
      .filter((l) => /^docker compose (pull|up)/.test(l));
  const envFile = () => readFileSync(`${root}/.env`, "utf8");
  return { run, compose, envFile };
}

describe.skipIf(!hasBash)("setup.sh: a release by its version", { timeout: 180_000 }, () => {
  it("an .env from before these keys existed still runs to the end", () => {
    // No AGENTSWARMS_VERSION, no QDRANT_API_KEY line at all. Until R470 the
    // first missing key ended the script silently (grep's "no match" under
    // pipefail), halfway through generating secrets.
    const s = sandbox([]);
    const { status, output } = s.run();
    expect(output).not.toMatch(/^\+/m);
    expect(status).toBe(0);
    expect(s.compose()).toEqual(["docker compose up -d --build"]);
    expect(s.envFile()).toMatch(/^QDRANT_API_KEY="[0-9a-f]+"$/m);
  });

  it("with no version, builds this checkout as it always has", () => {
    const s = sandbox(['AGENTSWARMS_VERSION=""']);
    expect(s.run().status).toBe(0);
    expect(s.compose()).toEqual(["docker compose up -d --build"]);
  });

  it("with a version, pulls the release's images and starts them without building", () => {
    const s = sandbox(['AGENTSWARMS_VERSION="1.7.0"']);
    const { status, output } = s.run();
    expect(status).toBe(0);
    expect(output).toContain(
      "Starting release 1.7.0: pulling its signed images from ghcr.io/agentswarms-fyi",
    );
    expect(s.compose()).toEqual(["docker compose pull", "docker compose up -d --no-build"]);
  });

  it("names the mirror it pulls from", () => {
    const s = sandbox([
      'AGENTSWARMS_VERSION="1.7.0"',
      'AGENTSWARMS_REGISTRY="registry.internal/as"',
    ]);
    expect(s.run().output).toContain("from registry.internal/as");
  });

  it("a release that cannot be pulled stops the install, and nothing is built", () => {
    const s = sandbox(['AGENTSWARMS_VERSION="1.7.9"']);
    const { status, output } = s.run({ PULL_EXIT: "1" });
    expect(status).not.toBe(0);
    expect(output).toContain("Could not pull release 1.7.9");
    expect(s.compose()).toEqual(["docker compose pull"]);
  });

  it("clears the old sandbox image name, a Docker Hub name nobody here owns", () => {
    const s = sandbox(['NOTEBOOK_RUNTIME_IMAGE="agentswarms/notebook-runtime:latest"']);
    expect(s.run().status).toBe(0);
    expect(s.envFile()).toMatch(/^NOTEBOOK_RUNTIME_IMAGE=""$/m);
  });

  it("leaves a sandbox image someone chose themselves", () => {
    const s = sandbox(['NOTEBOOK_RUNTIME_IMAGE="registry.internal/as/notebook-runtime:custom"']);
    expect(s.run().status).toBe(0);
    expect(s.envFile()).toContain(
      'NOTEBOOK_RUNTIME_IMAGE="registry.internal/as/notebook-runtime:custom"',
    );
  });
});
