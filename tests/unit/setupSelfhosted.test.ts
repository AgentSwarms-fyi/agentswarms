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

/**
 * Runs the real scripts/setup-selfhosted.sh against stand-ins for docker, npx, git, curl,
 * uname and sleep, in a throwaway tree. What it asserts is what the script did: the files
 * it wrote and the commands it ran.
 */

const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
const BASH = process.platform === "win32" ? GIT_BASH : "bash";
const hasBash = process.platform !== "win32" || existsSync(GIT_BASH);

const STACK_ENV = [
  "COMPOSE_FILE=docker-compose.yml",
  "POSTGRES_PASSWORD=x",
  "JWT_SECRET=x",
  "ANON_KEY=x",
  "SERVICE_ROLE_KEY=x",
  "DASHBOARD_USERNAME=x",
  "DASHBOARD_PASSWORD=x",
  "POOLER_TENANT_ID=x",
  "SITE_URL=x",
  "",
].join("\n");

const STUBS: Record<string, string> = {
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_DIR/log"
case "$*" in
  "compose up -d")
    n=$(( $(cat "$STUB_DIR/ups" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/ups"
    [ "$n" -gt "\${UP_FAILS:-0}" ]; exit $? ;;
  "compose ps --format"*)
    n=$(( $(cat "$STUB_DIR/polls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/polls"
    if [ "$n" -le "\${STARTING_POLLS:-0}" ]; then echo starting; else echo healthy; fi ;;
  "compose ps --services --status running") printf '%s\\n' \${RUNNING:-db supavisor} ;;
  compose\\ exec*)
    case "$*" in
      *"storage wget"*)
        n=$(( $(cat "$STUB_DIR/storage" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/storage"
        [ "$n" -gt "\${STORAGE_POLLS:-0}" ]; exit $? ;;
      *schema_migrations*) echo "\${APPLIED:-0}" ;;
      *information_schema*) echo 1 ;;
    esac ;;
esac
exit 0
`,
  npx: `#!/usr/bin/env bash
echo "npx $*" >> "$STUB_DIR/log"
exit "\${NPX_EXIT:-0}"
`,
  git: `#!/usr/bin/env bash
echo "git $*" >> "$STUB_DIR/log"
case "$*" in
  *"remote get-url"*) exit 1 ;;
  *"checkout --quiet FETCH_HEAD")
    mkdir -p "$STUB_ROOT/supabase-docker"
    cp -r "$STUB_DIR/stack/docker" "$STUB_ROOT/supabase-docker/" ;;
esac
exit 0
`,
  curl: `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_DIR/log"
while [ $# -gt 0 ]; do
  if [ "$1" = "-d" ]; then printf '%s' "$2" > "$STUB_DIR/admin.json"; fi
  shift
done
exit 0
`,
  uname: `#!/usr/bin/env bash
echo "\${UNAME:-Linux}"
`,
  sleep: `#!/usr/bin/env bash
exit 0
`,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Options = {
  env?: Record<string, string>;
  args?: string[];
  fresh?: boolean;
  pgVersion?: boolean;
  composeFile?: string;
  /** Keys the stack's .env.example does not have (an older or newer stack). */
  stackEnvWithout?: string[];
};

function sandbox(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "setup-selfhosted-")).replace(/\\/g, "/");
  dirs.push(root);
  const stubDir = `${root}/stub`;
  const bin = `${stubDir}/bin`;
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(`${bin}/${name}`, body, { mode: 0o755 });
  }

  mkdirSync(`${root}/scripts`);
  copyFileSync("scripts/setup-selfhosted.sh", `${root}/scripts/setup-selfhosted.sh`);
  writeFileSync(`${root}/scripts/setup.sh`, `echo "setup.sh $*" >> "$STUB_DIR/log"\n`);
  writeFileSync(`${root}/.env.example`, "");
  mkdirSync(`${root}/supabase/migrations`, { recursive: true });
  writeFileSync(`${root}/supabase/migrations/001_a.sql`, "");
  writeFileSync(`${root}/supabase/migrations/002_b.sql`, "");

  const stack = options.fresh ? `${stubDir}/stack/docker` : `${root}/supabase-docker/docker`;
  mkdirSync(`${stack}/volumes/db/data`, { recursive: true });
  writeFileSync(`${stack}/docker-compose.yml`, "services: {}\n");
  const stackEnv = (
    options.composeFile ? STACK_ENV.replace("docker-compose.yml", options.composeFile) : STACK_ENV
  )
    .split("\n")
    .filter((l) => !(options.stackEnvWithout ?? []).some((k) => l.startsWith(`${k}=`)))
    .join("\n");
  writeFileSync(`${stack}/.env.example`, stackEnv);
  if (options.pgVersion) writeFileSync(`${stack}/volumes/db/data/PG_VERSION`, "17\n");

  const run = (extra: Options = {}) => {
    const env = { ...options.env, ...extra.env };
    const result = spawnSync(
      BASH,
      [
        "-c",
        'PATH="$(cd "$STUB_DIR/bin" && pwd):$PATH" exec bash "$0" "$@"',
        `${root}/scripts/setup-selfhosted.sh`,
        ...(extra.args ?? options.args ?? []),
      ],
      {
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          STUB_DIR: stubDir,
          STUB_ROOT: root,
          ADMIN_EMAIL: "admin@example.test",
          ADMIN_PASSWORD: "a-test-password",
          ...env,
        },
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  const log = () => (existsSync(`${stubDir}/log`) ? readFileSync(`${stubDir}/log`, "utf8") : "");
  return {
    run,
    log,
    calls: (prefix: string) =>
      log()
        .split("\n")
        .filter((l) => l.startsWith(prefix)),
    stackEnv: () => readFileSync(`${root}/supabase-docker/docker/.env`, "utf8"),
    override: `${root}/supabase-docker/docker/docker-compose.override.yml`,
    stubDir,
  };
}

const WINDOWS = { UNAME: "MINGW64_NT-10.0-19045" };
const NOTHING_PENDING = { APPLIED: "2" };

// Each case runs a whole shell script, which is slow to spawn on Windows.
describe.skipIf(!hasBash)("setup-selfhosted.sh", { timeout: 180_000 }, () => {
  describe("keeping Postgres off a Windows folder", () => {
    it("moves a new install's database to a Docker volume, and makes Compose read the override", () => {
      const s = sandbox({ env: { ...WINDOWS, ...NOTHING_PENDING } });
      expect(s.run().status).toBe(0);
      expect(readFileSync(s.override, "utf8")).toContain("db-data:/var/lib/postgresql/data");
      expect(s.stackEnv()).toMatch(
        /^COMPOSE_FILE=docker-compose\.yml:docker-compose\.override\.yml$/m,
      );
      expect(s.stackEnv()).toMatch(/^COMPOSE_PATH_SEPARATOR=:$/m);
    });

    it("says where the database went, and what deletes it", () => {
      const s = sandbox({ env: { ...WINDOWS, ...NOTHING_PENDING } });
      expect(s.run().output).toContain("docker compose down -v deletes it");
    });

    it("does not add the override twice when rerun", () => {
      const s = sandbox({ env: { ...WINDOWS, ...NOTHING_PENDING } });
      expect(s.run().status).toBe(0);
      expect(s.run().status).toBe(0);
      expect(s.stackEnv().match(/docker-compose\.override\.yml/g)).toHaveLength(1);
      expect(s.stackEnv().match(/^COMPOSE_PATH_SEPARATOR=/gm)).toHaveLength(1);
    });

    it("keeps any other Compose files already named", () => {
      const s = sandbox({
        env: { ...WINDOWS, ...NOTHING_PENDING },
        composeFile: "docker-compose.yml:docker-compose.pg17.yml",
      });
      expect(s.run().status).toBe(0);
      expect(s.stackEnv()).toMatch(
        /^COMPOSE_FILE=docker-compose\.yml:docker-compose\.pg17\.yml:docker-compose\.override\.yml$/m,
      );
    });

    it("leaves a Linux install's bind mount alone", () => {
      const s = sandbox({ env: NOTHING_PENDING });
      expect(s.run().status).toBe(0);
      expect(existsSync(s.override)).toBe(false);
      expect(s.stackEnv()).toMatch(/^COMPOSE_FILE=docker-compose\.yml$/m);
      expect(s.stackEnv()).not.toContain("COMPOSE_PATH_SEPARATOR");
    });

    it("never moves a database that already has data: that would swap it for an empty one", () => {
      const s = sandbox({ env: { ...WINDOWS, ...NOTHING_PENDING }, pgVersion: true });
      const { status, output } = s.run();
      expect(status).toBe(0);
      expect(existsSync(s.override)).toBe(false);
      expect(output).toContain("leaving it there");
    });
  });

  describe("a slow first start", () => {
    it("waits for what is running to settle, then starts what gave up", () => {
      const s = sandbox({ env: { ...NOTHING_PENDING, UP_FAILS: "1", STARTING_POLLS: "2" } });
      const { status, output } = s.run();
      expect(status).toBe(0);
      expect(s.calls("docker compose up -d")).toHaveLength(2);
      const lines = s.calls("docker compose");
      const firstUp = lines.indexOf("docker compose up -d");
      const secondUp = lines.lastIndexOf("docker compose up -d");
      const polls = lines
        .slice(firstUp, secondUp)
        .filter((l) => l.startsWith("docker compose ps --format"));
      expect(polls).toHaveLength(3);
      expect(output).toContain("normal on a first start");
    });

    it("gets there on the last attempt", () => {
      const s = sandbox({ env: { ...NOTHING_PENDING, UP_FAILS: "4" } });
      expect(s.run().status).toBe(0);
      expect(s.calls("docker compose up -d")).toHaveLength(5);
    });

    it("tries five times, then stops and says where to look", () => {
      const s = sandbox({ env: { ...NOTHING_PENDING, UP_FAILS: "9" } });
      const { status, output } = s.run();
      expect(status).not.toBe(0);
      expect(s.calls("docker compose up -d")).toHaveLength(5);
      expect(output).toContain("docker compose logs db");
      expect(s.calls("npx")).toHaveLength(0);
    });
  });

  describe("applying the schema", () => {
    // R468. The storage service's own migrations must FINISH first: waiting
    // for the buckets.public column (until R468) let ours start while storage
    // was still altering storage.buckets, and R467 measured a deadlock.
    it("pushes only once the storage service serves", () => {
      const s = sandbox({ env: { ...NOTHING_PENDING, STORAGE_POLLS: "3" } });
      expect(s.run().status).toBe(0);
      const log = s.log();
      const polls = s.calls(
        "docker compose exec -T storage wget -q -O /dev/null http://127.0.0.1:5000/status",
      );
      expect(polls).toHaveLength(4);
      expect(log.lastIndexOf("5000/status")).toBeLessThan(log.indexOf("npx --yes supabase@"));
      expect(log).not.toContain("column_name='public'");
    });

    it("stops and says where to look when storage never serves", () => {
      const s = sandbox({
        env: { ...NOTHING_PENDING, STORAGE_POLLS: "999999", SUPABASE_WAIT_SECS: "0" },
      });
      const { status, output } = s.run();
      expect(status).not.toBe(0);
      expect(output).toContain("The storage service never finished starting");
      expect(output).toContain("docker compose logs storage");
      expect(s.calls("npx")).toHaveLength(0);
    });

    it("stops before the push when migrations are pending and nobody can confirm them", () => {
      const s = sandbox();
      const { status, output } = s.run();
      expect(status).not.toBe(0);
      expect(output).toContain("2 migrations to apply and no terminal");
      expect(output).toContain("--yes");
      expect(s.calls("npx")).toHaveLength(0);
    });

    it("counts only what is still pending", () => {
      const s = sandbox({ env: { APPLIED: "1" } });
      expect(s.run().output).toContain("1 migrations to apply");
    });

    it("passes --yes to the CLI only when it was asked for, and not on to setup.sh", () => {
      const s = sandbox();
      expect(s.run({ args: ["--yes", "--all"] }).status).toBe(0);
      expect(s.calls("npx")[0]).toMatch(/ --yes$/);
      expect(s.calls("setup.sh")[0]).toBe("setup.sh --all --skip-migrations");
    });

    it("needs no answer when there is nothing to apply", () => {
      const s = sandbox({ env: NOTHING_PENDING });
      expect(s.run().status).toBe(0);
      expect(s.calls("npx")).toHaveLength(1);
      expect(s.calls("npx")[0]).not.toMatch(/ --yes$/);
    });

    it("uses the pinned CLI and its current flag", () => {
      const s = sandbox({ env: NOTHING_PENDING });
      s.run();
      expect(s.calls("npx")[0]).toContain("supabase@3.0.0 db push --remote=postgresql://");
      expect(s.log()).not.toContain("--db-url");
    });

    it("names the tenant when the pooler answers on 5432", () => {
      const s = sandbox({ env: NOTHING_PENDING });
      s.run();
      expect(s.calls("npx")[0]).toMatch(/\/\/postgres\.[a-z]+:/);
    });

    it("runs to the end on a stack whose .env has no pooler tenant at all", () => {
      // An older stack has no POOLER_TENANT_ID, so sb_set skips it and sb_get
      // finds nothing. Until R470 that "no match" ended the script silently
      // under pipefail, before the default tenant on the next line applied.
      const s = sandbox({
        env: { ...NOTHING_PENDING, RUNNING: "db" },
        stackEnvWithout: ["POOLER_TENANT_ID"],
      });
      const { status } = s.run();
      expect(status).toBe(0);
      expect(s.calls("npx")[0]).toMatch(/\/\/postgres:/);
      expect(s.calls("setup.sh")).toHaveLength(1);
    });

    it("uses the plain user on an older stack with no pooler", () => {
      const s = sandbox({ env: { ...NOTHING_PENDING, RUNNING: "db" } });
      s.run();
      expect(s.calls("npx")[0]).toMatch(/\/\/postgres:/);
    });

    it("does not push twice when the push fails, and points at --yes", () => {
      const s = sandbox({ env: { ...NOTHING_PENDING, NPX_EXIT: "1" } });
      const { status, output } = s.run();
      expect(status).not.toBe(0);
      expect(s.calls("npx")).toHaveLength(1);
      expect(output).toContain("rerun with --yes");
    });
  });

  describe("downloading the stack", () => {
    it("takes only the docker folder, at the proved commit, with line endings untouched", () => {
      const s = sandbox({ fresh: true, env: NOTHING_PENDING });
      expect(s.run().status).toBe(0);
      const git = s.calls("git").join("\n");
      expect(git).toContain("config core.autocrlf false");
      expect(git).toContain("sparse-checkout set docker");
      expect(git).toMatch(/fetch --quiet --depth 1 --filter=blob:none origin [0-9a-f]{40}/);
      expect(git).not.toContain(" clone ");
    });

    it("lets a newer stack be chosen", () => {
      const s = sandbox({
        fresh: true,
        env: { ...NOTHING_PENDING, SUPABASE_STACK_REF: "abc123" },
      });
      s.run();
      expect(s.calls("git").join("\n")).toContain("origin abc123");
    });
  });

  describe("the admin account", () => {
    it("keeps a quote and a backslash in the password as part of the password", () => {
      const password = 'pa"ss\\word';
      const s = sandbox({ env: { ...NOTHING_PENDING, ADMIN_PASSWORD: password } });
      expect(s.run().status).toBe(0);
      const sent = JSON.parse(readFileSync(`${s.stubDir}/admin.json`, "utf8")) as {
        email: string;
        password: string;
        email_confirm: boolean;
      };
      expect(sent).toEqual({
        email: "admin@example.test",
        password,
        email_confirm: true,
      });
    });
  });
});
