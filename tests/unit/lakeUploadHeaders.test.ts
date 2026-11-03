// R442: the code the app sends a sandbox puts each upload under the key the app
// signed, and the Spark cluster stages under the owner's key.
//
// A URL whose signature names the customer key's headers is refused by the
// store unless the upload sends them, so the generated Python is held to
// sending exactly what the app answered, for a model and for a staged load,
// and to saying it will (`'headers': True`), which is what makes the app sign
// them at all. These run the emitted functions themselves, in a Python with
// stand-ins for requests and duckdb, and read back what was sent.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lakeGatewayFn } from "@/utils/etl/codegen";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";
import { TRAIN_PY } from "@/utils/ml/pyTrain";

const PYTHON: string | null = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "import json, os, sys, types"], { stdio: "ignore" });
      return c;
    } catch {
      /* next */
    }
  }
  return null;
})();
if (!PYTHON) {
  console.warn(
    "\n[lakeUploadHeaders] no Python on this machine: the emitted upload code is NOT run, these tests are SKIPPED.\n",
  );
}

/** A top-level Python function's source, up to the next top-level statement. */
function pyFn(code: string, name: string): string {
  const start = code.indexOf(`def ${name}(`);
  expect(start, `${name} is emitted`).toBeGreaterThan(-1);
  const rest = code.slice(start);
  const end = rest.slice(1).search(/\n(?=\S)/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

function runPython(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(PYTHON!, ["-"], (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
    );
    child.stdin?.end(code);
  });
}

const ARN = "arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const SIGNED = {
  "x-amz-server-side-encryption": "aws:kms",
  "x-amz-server-side-encryption-aws-kms-key-id": ARN,
};

/** Stand-ins for requests and duckdb, and an app that answers each lake call. */
const HARNESS = (answers: Record<string, unknown>) => `
import io, json, os, sys, types
sent = {'calls': [], 'puts': [], 'gets': []}
class _Resp:
    status_code = 200
    content = b'model-bytes'
    def raise_for_status(self):
        pass
requests = types.ModuleType('requests')
def _put(url, data=None, headers=None, timeout=None):
    body = data.read() if hasattr(data, 'read') else data
    sent['puts'].append({'url': url, 'headers': headers, 'bytes': len(body or b'')})
    return _Resp()
def _get(url, timeout=None, **kw):
    sent['gets'].append({'url': url, 'headers': kw.get('headers')})
    return _Resp()
requests.put = _put
requests.get = _get
requests.delete = lambda *a, **k: _Resp()
sys.modules['requests'] = requests
duckdb = types.ModuleType('duckdb')
class _Con:
    def register(self, name, df):
        pass
    def execute(self, sql):
        path = sql.split(" TO '", 1)[1].split("' (FORMAT", 1)[0].replace("''", "'")
        with open(path, 'wb') as fh:
            fh.write(b'PAR1')
        return self
    def close(self):
        pass
duckdb.connect = lambda *a, **k: _Con()
sys.modules['duckdb'] = duckdb
ANSWERS = json.loads(${JSON.stringify(JSON.stringify(answers))})
def _lake_call(part, body):
    sent['calls'].append({'part': part, 'body': body})
    return ANSWERS[part + ':' + body.get('which', '')] if part == 'lake_artifact' else ANSWERS[part]
os.environ['ML_ARTIFACT_URI'] = 's3://lake/ml-artifacts/m1/v1/model.joblib'
`;

describe("a model the trainer uploads", () => {
  const fns = ["_lake_artifact", "_upload", "_fetch_artifact"].map((n) => pyFn(TRAIN_PY, n));

  it.skipIf(!PYTHON)(
    "is put with the headers the app signed, and read with none",
    async () => {
      const out = await runPython(
        HARNESS({
          "lake_artifact:put": { url: "https://store/put", headers: SIGNED },
          "lake_artifact:get": { url: "https://store/get" },
        }) +
          fns.join("\n") +
          `
_upload(b'abcdef')
_fetch_artifact('s3://lake/ml-artifacts/m1/v0/model.joblib')
print(json.dumps(sent))
`,
      );
      const sent = JSON.parse(out) as {
        calls: { part: string; body: Record<string, unknown> }[];
        puts: { url: string; headers: Record<string, string>; bytes: number }[];
        gets: { url: string; headers: unknown }[];
      };
      expect(sent.calls.map((c) => c.body.which)).toEqual(["put", "get"]);
      expect(sent.puts).toEqual([{ url: "https://store/put", headers: SIGNED, bytes: 6 }]);
      expect(sent.gets).toEqual([{ url: "https://store/get", headers: null }]);
    },
    60_000,
  );

  it.skipIf(!PYTHON)(
    "is put with no header when the app signed none",
    async () => {
      const out = await runPython(
        HARNESS({ "lake_artifact:put": { url: "https://store/put" } }) +
          fns.join("\n") +
          `
_upload(b'abc')
print(json.dumps(sent))
`,
      );
      expect((JSON.parse(out) as { puts: { headers: unknown }[] }).puts[0]!.headers).toEqual({});
    },
    60_000,
  );
});

describe("a load the sandbox stages", () => {
  const gateway = lakeGatewayFn();
  const stage = pyFn(gateway, "_lake_stage");

  it.skipIf(!PYTHON)(
    "says it sends headers, and sends the ones the app signed",
    async () => {
      const out = await runPython(
        HARNESS({ lake_stage: { batch: "b1", puts: ["https://store/p0"], headers: SIGNED } }) +
          stage +
          `
r = _lake_stage('t1', object())
print(json.dumps({'sent': sent, 'r': r}))
`,
      );
      const { sent, r } = JSON.parse(out) as {
        sent: {
          calls: { part: string; body: Record<string, unknown> }[];
          puts: { url: string; headers: Record<string, string> }[];
        };
        r: unknown;
      };
      expect(sent.calls).toEqual([
        { part: "lake_stage", body: { id: "t1", parts: 1, headers: true } },
      ]);
      expect(sent.puts).toEqual([{ url: "https://store/p0", headers: SIGNED, bytes: 4 }]);
      expect(r).toEqual({ id: "t1", batch: "b1", parts: 1 });
    },
    60_000,
  );
});

describe("what the Spark cluster stages", () => {
  const LAKE_TGT = {
    id: "t2",
    kind: "target" as const,
    config: { type: "lakehouse", schema: "analytics", table: "orders", write_mode: "append" },
  };
  const SRC = {
    id: "s1",
    kind: "source" as const,
    config: { type: "object_storage", path: "raw/*.csv", format: "csv" },
  };
  const code = compileSparkGraph({
    nodes: [SRC, LAKE_TGT] as never,
    edges: [{ id: "e0", from: "s1", to: "t2" }],
  });
  const opts = pyFn(code, "_lake_s3_options");

  it.skipIf(!PYTHON)(
    "is written under the owner's key when the run names one, and the S3A way",
    async () => {
      const run = (env: Record<string, string>) =>
        runPython(
          `import json, os\nos.environ.update(${JSON.stringify(env)})\n${opts}\nprint(json.dumps(_lake_s3_options()))\n`,
        ).then((o) => JSON.parse(o) as Record<string, string>);
      const covered = await run({ ETL_LAKEHOUSE_S3_KEY_ID: "k", ETL_LAKEHOUSE_S3_KMS_KEY_ID: ARN });
      // Hadoop 3.4's names (Spark 4.2 ships it); the older
      // fs.s3a.server-side-encryption-* spellings are deprecated aliases.
      expect(covered["fs.s3a.encryption.algorithm"]).toBe("SSE-KMS");
      expect(covered["fs.s3a.encryption.key"]).toBe(ARN);
      const bare = await run({ ETL_LAKEHOUSE_S3_KEY_ID: "k" });
      expect(Object.keys(bare).filter((k) => k.includes("encryption"))).toEqual([]);
    },
    60_000,
  );

  it("is told the owner's key by the run's environment, beside its staging prefix", () => {
    const svc = readFileSync("src/utils/etl/service.server.ts", "utf8");
    const at = svc.indexOf("env.ETL_LAKEHOUSE_STAGE_URL =");
    expect(at).toBeGreaterThan(-1);
    const block = svc.slice(at, svc.indexOf("env.ETL_LAKEHOUSE_S3_URL_STYLE", at));
    expect(block).toContain("await lakeObjectKmsKey(pipeline.user_id)");
    expect(block).toContain("if (kms) env.ETL_LAKEHOUSE_S3_KMS_KEY_ID = kms;");
  });
});
