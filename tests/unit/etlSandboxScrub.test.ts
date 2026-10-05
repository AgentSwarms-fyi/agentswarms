// A secret replaced mid-run was stored in clear; a node preview was never
// scrubbed at all.
//
// FOUND IN R292. The platform scrubs a run's output against the values that
// are current when the output ARRIVES. Driven: a code pipeline printed a
// secret, the secret was replaced from Secrets while the run slept, and the
// stored log read "token=<the old value>". A node preview's error, shown from
// its session row, carried the secret's current value - nothing scrubbed it.
//
// The sandbox now keeps the values it was handed (the env reply's `scrub`)
// and the batch runner scrubs everything it posts with them. These tests run
// the REAL prelude and the REAL runner under the local Python, with httpx
// replaced by a fake that serves the bundle and records every post.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { etlPrelude, scrubSecrets } from "@/utils/etl/service.server";

function pythonBin(): string | null {
  for (const bin of ["python", "python3", "py"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}
const PY = pythonBin();

const HARNESS = `
import importlib.util, json, os, sys, types

out_file, runner_file, code_file, bundle_file = sys.argv[1:5]
code = open(code_file, encoding="utf-8").read()
bundle = json.load(open(bundle_file, encoding="utf-8"))
posts = []


class _Resp:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _reply(url, body):
    if url.endswith("/api/notebook/runtime/source"):
        return _Resp(bundle if (body or {}).get("part") == "etl_env" else {"code": code})
    posts.append(body)
    return _Resp({})


class _Client:
    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None, headers=None, **k):
        return _reply(url, json)


fake = types.ModuleType("httpx")
fake.Client = _Client
fake.post = lambda url, json=None, headers=None, **k: _reply(url, json)
sys.modules["httpx"] = fake

os.environ.update({
    "AGENTSWARMS_ORIGIN": "http://app",
    "AGENTSWARMS_TOKEN": "session-token",
    "NB_RESULT_CALLBACK": "http://app/api/notebook/runtime/result",
    "NB_ENTRYPOINT": "entrypoint",
})
spec = importlib.util.spec_from_file_location("batch_runner", runner_file)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.STREAM_EVERY = 0.05
exit_code = 0
try:
    runner.main()
except SystemExit as e:
    exit_code = e.code
json.dump({"exit": exit_code, "posts": posts}, open(out_file, "w", encoding="utf-8"))
`;

type Post = { partial?: boolean; status?: string; logs?: string; error?: string | null };

function runSandbox(
  userCode: string,
  bundle: { env: Record<string, string>; scrub?: string[] },
): { exit: number; posts: Post[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "etl-scrub-"));
  try {
    writeFileSync(join(dir, "harness.py"), HARNESS, "utf8");
    writeFileSync(join(dir, "code.py"), etlPrelude() + userCode, "utf8");
    writeFileSync(
      join(dir, "bundle.json"),
      JSON.stringify({ requirements: [], ...bundle }),
      "utf8",
    );
    const res = spawnSync(
      PY as string,
      [
        join(dir, "harness.py"),
        join(dir, "out.json"),
        resolve("docker/notebook-runtime/batch_runner.py"),
        join(dir, "code.py"),
        join(dir, "bundle.json"),
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as {
      exit: number;
      posts: Post[];
    };
    return { ...out, stderr: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALUE = "r292-value-AAAA";

// Each case starts a Python process; a cold first start is seconds on its
// own, and a full parallel gate must not turn that into a timeout (R291).
describe.skipIf(!PY)(
  "the batch runner scrubs what it posts with the values it was handed",
  { timeout: 60_000 },
  () => {
    it("live and final logs, whatever the platform's list says by then", () => {
      const { exit, posts } = runSandbox(
        [
          "import os, time",
          "def entrypoint(inputs=None):",
          "    print('token=' + os.environ['R292_TOKEN'], flush=True)",
          "    print('bucket=' + os.environ['ETL_DEST_BUCKET_URL'], flush=True)",
          "    time.sleep(0.4)",
          "    return {'ok': 1}",
          "",
        ].join("\n"),
        {
          env: { R292_TOKEN: VALUE, ETL_DEST_BUCKET_URL: "s3://lake/raw" },
          // The shorter value first: scrubbed in list order it would leave
          // "***-AAAA" behind. "ake" is under four characters, so it is left
          // alone, as the platform's own scrub leaves it.
          scrub: ["r292-value", VALUE, "ake"],
        },
      );
      expect(exit).toBe(0);
      const partials = posts.filter((p) => p.partial);
      const final = posts.find((p) => p.status === "succeeded");
      expect(partials.length).toBeGreaterThan(0);
      expect(final).toBeDefined();
      expect(JSON.stringify(posts)).not.toContain("AAAA");
      expect(partials.at(-1)?.logs).toContain("token=***\n");
      expect(final?.logs).toContain("token=***\n");
      // Only the values it was handed: the rest of the output is left alone.
      expect(final?.logs).toContain("bucket=s3://lake/raw");
    });

    it("the error and the traceback written on the way out", () => {
      const { exit, posts, stderr } = runSandbox(
        [
          "import os",
          "def entrypoint(inputs=None):",
          "    print('token=' + os.environ['R292_TOKEN'])",
          "    raise RuntimeError('bad token ' + os.environ['R292_TOKEN'])",
          "",
        ].join("\n"),
        { env: { R292_TOKEN: VALUE }, scrub: [VALUE] },
      );
      const final = posts.find((p) => p.status === "error");
      expect(final?.error).toContain("RuntimeError: bad token ***");
      expect(final?.logs).toContain("token=***");
      expect(JSON.stringify(posts)).not.toContain(VALUE);
      expect(stderr).toContain("RuntimeError: bad token ***");
      expect(stderr).not.toContain(VALUE);
      // Same exit status the uncaught exception had.
      expect(exit).toBe(1);
    });

    it("scrubs before cutting a long live log, so no end of a value is left", () => {
      // The value sits just before the last 190,000 characters, so a cut taken
      // first lands inside it.
      const { posts } = runSandbox(
        [
          "import os, time",
          "def entrypoint(inputs=None):",
          "    print(os.environ['R292_TOKEN'] + '.' * 189_995, flush=True)",
          "    time.sleep(0.4)",
          "    return {}",
          "",
        ].join("\n"),
        { env: { R292_TOKEN: VALUE }, scrub: [VALUE] },
      );
      const partials = posts.filter((p) => p.partial);
      expect(partials.length).toBeGreaterThan(0);
      for (const p of partials) expect(p.logs).not.toContain("AAAA");
    });

    it("a reply without a scrub list changes nothing (the other sandboxes' env parts)", () => {
      const { posts } = runSandbox(
        [
          "import os",
          "def entrypoint(inputs=None):",
          "    print('token=' + os.environ['R292_TOKEN'])",
          "    return {}",
          "",
        ].join("\n"),
        { env: { R292_TOKEN: VALUE } },
      );
      expect(posts.find((p) => p.status === "succeeded")?.logs).toContain(`token=${VALUE}`);
    });
  },
);

describe("the platform's own scrub", () => {
  it("takes the longest value first", () => {
    expect(scrubSecrets(`k=${VALUE};`, ["r292-value", VALUE])).toBe("k=***;");
  });

  const SRC = readFileSync("src/utils/etl/service.server.ts", "utf8");
  function body(start: string): string {
    const from = SRC.indexOf(start);
    expect(from, `${start} not found`).toBeGreaterThan(-1);
    const fn = SRC.slice(from);
    return fn.slice(0, fn.indexOf("\n}\n"));
  }

  it("scrubs before it cuts, live and final", () => {
    expect(body("export async function appendPartialLogs")).toContain(
      "scrubSecrets(logs, secretValues).slice(-LOG_CAP)",
    );
    expect(body("export async function finalizeEtlRun")).toContain(
      'scrubSecrets(body.logs ?? "", secretValues).slice(0, LOG_CAP)',
    );
  });

  it("hands a run's and a preview's values to the sandbox", () => {
    for (const fn of [
      "export async function etlEnvFor",
      "export async function etlPreviewEnvFor",
    ]) {
      const f = body(fn);
      expect(f).toMatch(/const \{ env, secretValues, lake \} = await resolveRunEnv\(/);
      expect(f).toContain("scrub: secretValues");
    }
  });
});
