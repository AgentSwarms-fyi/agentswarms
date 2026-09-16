// The installers and deployment assets have a checker (scripts/check-infra.mjs)
// that runs in the gate and in CI. These pin that it does run, and the four
// things R13 found so a later edit cannot quietly undo them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(resolve(p), "utf8");

describe("the infra check is wired in", () => {
  it("is part of npm run check, next to the doc-command check", () => {
    const pkg = JSON.parse(rd("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:infra"]).toBe("node scripts/check-infra.mjs");
    expect(pkg.scripts.check).toContain("npm run check:doc-commands && npm run check:infra");
  });

  it("runs in CI", () => {
    const ci = rd(".github/workflows/ci.yml");
    expect(ci).toContain("run: npm run check:doc-commands && npm run check:infra");
  });
});

describe("the compose render check can actually run where CI runs it", () => {
  const check = readFileSync("scripts/check-infra.mjs", "utf8");

  it("supplies a .env, because the compose file requires one and .env is gitignored", () => {
    // FOUND IN CI, TWICE OVER. `docker-compose.yml` declares `env_file: .env`
    // and `.env` is gitignored, so on a fresh checkout compose refuses to
    // render at all — "env file … not found" — and the check failed on every
    // push while passing on every developer machine, where the file exists.
    expect(readFileSync("docker-compose.yml", "utf8")).toContain("env_file: .env");
    expect(execFileSync("git", ["check-ignore", ".env"], { encoding: "utf8" }).trim()).toBe(".env");
    expect(check).toContain(".env.example");
    expect(check).toMatch(/copyFileSync/);
  });

  it("never overwrites a real .env, and removes the one it borrowed", () => {
    // The file it would clobber holds the developer's keys. Borrow only when
    // absent, and put it back in a finally so a failing render still cleans up.
    // The whole assignment, not just the negation somewhere in it: an earlier
    // version of this test asserted only that `!existsSync(envPath)` appeared,
    // and a mutant that borrowed whether or not the file existed still
    // contained that substring and passed.
    expect(check).toMatch(/const borrowed = !existsSync\(envPath\) &&/);
    expect(check).toMatch(/finally \{[\s\S]{0,120}rmSync\(envPath/);
  });

  it("reports the line that says WHY, not the first line compose printed", () => {
    // Compose prints one warning per unset variable before the real reason, so
    // reporting stderr[0] reported "SUPABASE_SERVICE_ROLE_KEY is not set" for a
    // missing file: a true sentence about the wrong problem, which sent the
    // first diagnosis after the wrong bug.
    //
    // Scoped to this block on purpose. `bash -n` and the PowerShell parser
    // print their error as the first line with nothing before it, so taking
    // line 0 there is right and this must not drag them in.
    const block = check.slice(check.indexOf("// ── 6."), check.indexOf("// ── 7."));
    expect(block, "the compose section moved; re-anchor this test").toContain("docker");
    expect(block).not.toMatch(/stderr[^\n]*split\("\\n"\)\[0\]/);
    expect(block).toMatch(/level=warning/);
    expect(block).toMatch(/\.at\(-1\)/);
  });
});

describe("what R13 found stays fixed", () => {
  it("every tracked shell script is executable — ./scripts/setup.sh must work after a clone", () => {
    const lines = execFileSync("git", ["ls-files", "-s"], { encoding: "utf8" }).split(/\r?\n/);
    const scripts = lines.filter((l) => l.endsWith(".sh")).map((l) => l.split(/\s+/));
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    for (const [mode, , , file] of scripts) expect(mode, `${file} is ${mode}`).toBe("100755");
  });

  it("every installer's help prints its whole header, and says everything installs", () => {
    // --help prints from line 2 to `set -euo pipefail`, so the header must be
    // comments all the way down — a line range drifted every time it grew.
    for (const f of ["scripts/setup.sh", "scripts/setup-selfhosted.sh", "scripts/setup-k8s.sh"]) {
      const src = rd(f);
      expect(src, f).toContain(
        "-h|--help) sed -n '2,/^set -euo pipefail/p' \"$0\" | sed '$d'; exit 0 ;;",
      );
      const lines = src.split("\n");
      const before = lines.slice(1, lines.indexOf("set -euo pipefail"));
      expect(before.length, `${f} header`).toBeGreaterThan(3);
      for (const line of before) expect(line.startsWith("#"), `${f}: ${line}`).toBe(true);
    }
    // The claim a reader acts on: there is nothing to opt into.
    expect(rd("scripts/setup.sh")).toContain("EVERY SERVICE IS INSTALLED AND WIRED");
    expect(rd("scripts/setup.ps1")).toContain("EVERY SERVICE IS INSTALLED AND WIRED");
  });

  it("the runtime verifier reaches a containerised app by service name, like the product", () => {
    const v = rd("deploy/notebooks/test/verify-runtime.sh");
    expect(v).toContain(
      'elif [ -n "$APP_IN_DOCKER" ]; then ORIGIN="http://agentswarms:${APP_URL##*:}"',
    );
    expect(v).toContain("NOTEBOOK_APP_INTERNAL_URL");
    expect(rd("src/utils/notebookRuntime/service.server.ts")).toContain(
      "`http://agentswarms:${port}`",
    );
  });

  it("the app image skips the one Dockerfile check with its reason, and no server secret is an ARG", () => {
    const df = rd("Dockerfile");
    expect(df.startsWith("# check=skip=SecretsUsedInArgOrEnv\n")).toBe(true);
    expect(df).toMatch(/anon \(publishable\) key/);
    expect(df).not.toMatch(/ARG .*SERVICE_ROLE/);
    expect(df).not.toMatch(/ARG .*OPENROUTER/);
  });

  it("the in-app install page runs the installer the way every other doc does", () => {
    const page = rd("src/routes/docs.self-hosting.tsx");
    expect(page).not.toContain("./scripts/setup.sh");
    expect(page).toContain("bash scripts/setup.sh");
  });

  it("the Kubernetes installer and the PowerShell installer answer --help / -Help", () => {
    expect(rd("scripts/setup-k8s.sh")).toContain("-h|--help) sed -n '2,/^set -euo pipefail/p'");
    expect(rd("scripts/setup.ps1")).toContain("[switch]$Help");
  });
});
