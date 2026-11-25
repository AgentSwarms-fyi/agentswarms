// The trainer's GPU side (R537), run by a real Python.
//
// What a sandbox decides about its GPU: what nvidia-smi lists, whether
// XGBoost can actually train there (it falls back to the CPU with only a
// warning, so a fit that succeeds proves nothing), which candidates join the
// search, and that a model trained on a GPU is saved for the CPU. nvidia-smi
// and XGBoost are stood in for, so this runs on any machine; the real
// libraries run in the runtime image (docs/UI_TEST_RESULTS.md, R537), and a
// real GPU only on AWS (docs/deploy/AWS.md, "GPU training").
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TRAIN_PY } from "@/utils/ml/pyTrain";

const python = ["python3", "python", "py"].find(
  (c) => spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0,
);

// XGBoost as far as the trainer touches it. FALLBACK makes a fit warn the way
// the real one does when it cannot use the GPU it was asked for.
const STUB_XGBOOST = `
import warnings
__version__ = "3.4.1"
CUDA = True
FALLBACK = False
def build_info():
    return {"USE_CUDA": CUDA, "CUDA_VERSION": [12, 9]}
class _Model:
    def __init__(self, **kw):
        self.kw = dict(kw)
    def get_params(self, deep=True):
        return dict(self.kw)
    def set_params(self, **kw):
        self.kw.update(kw)
        return self
    def fit(self, X, y):
        if FALLBACK and self.kw.get("device") == "cuda":
            warnings.warn("WARNING: src/context.cc:218: Device is changed from GPU to CPU as we couldn't find any available GPU on the system.")
        return self
class XGBRegressor(_Model):
    pass
class XGBClassifier(_Model):
    pass
`;

const STUB_NUMPY = `
class _RS:
    def __init__(self, seed):
        pass
    def rand(self, n, k):
        return _Arr([[0.5] * k for _ in range(n)])
class _Arr(list):
    def __getitem__(self, key):
        if isinstance(key, tuple):
            rows, col = key
            return [r[col] for r in self]
        return list.__getitem__(self, key)
class random:
    RandomState = _RS
`;

function run(dir: string, script: string) {
  writeFileSync(path.join(dir, "driver.py"), script);
  const r = spawnSync(python!, [path.join(dir, "driver.py")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: dir, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

function setup(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ml-gpu-"));
  writeFileSync(path.join(dir, "xgboost.py"), STUB_XGBOOST);
  writeFileSync(path.join(dir, "numpy.py"), STUB_NUMPY);
  writeFileSync(path.join(dir, "prog.py"), TRAIN_PY);
  return dir;
}

// A stand-in for subprocess.run that plays nvidia-smi.
const FAKE_SMI = `
import types
class Done:
    def __init__(self, rc, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err
def smi(answer):
    def run(cmd, **kw):
        assert cmd[0] == "nvidia-smi", cmd
        if answer == "missing":
            raise FileNotFoundError(cmd[0])
        return answer
    return types.SimpleNamespace(run=run)
`;

describe.skipIf(!python)("what a sandbox makes of its GPU (R537)", () => {
  it("reads nvidia-smi, and believes a GPU only when XGBoost trained on it", () => {
    const dir = setup();
    const out = run(
      dir,
      `${FAKE_SMI}
import json
import prog, xgboost
prog._log = lambda m: None
L4 = Done(0, "NVIDIA L4, 23034, 580.95.05\\nNVIDIA L4, 23034, 580.95.05\\n")
def ctx(answer, asked=1, fallback=False, cuda=True):
    prog.subprocess = smi(answer)
    xgboost.FALLBACK, xgboost.CUDA = fallback, cuda
    c = prog._gpu_context({"gpus_requested": asked})
    return {k: c.get(k) for k in ("requested", "seen", "device", "note", "cuda")}
print(json.dumps({
    "missing": ctx("missing"),
    "missing_unasked": ctx("missing", asked=0),
    "driver_down": ctx(Done(9, "", "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")),
    "none_listed": ctx(Done(0, "")),
    "works": ctx(L4),
    "fell_back": ctx(L4, fallback=True),
    "cpu_build": ctx(L4, cuda=False),
    "summary": prog._gpu_summary(ctx(L4)),
    "summary_none": prog._gpu_summary({"seen": []}),
}))
`,
    );
    // No driver mounted: the plainest "no GPU here", said only when one was asked for.
    expect(out.missing).toMatchObject({ requested: 1, seen: [], device: null });
    expect(out.missing.note).toContain("nvidia-smi is not in the sandbox");
    expect(out.missing_unasked.note).toBeNull();
    expect(out.driver_down.device).toBeNull();
    expect(out.driver_down.note).toContain("couldn't communicate with the NVIDIA driver");
    expect(out.none_listed.note).toBe("nvidia-smi listed no GPUs");
    // Listed, and a fit that did not fall back: usable.
    expect(out.works.device).toBe("cuda");
    expect(out.works.cuda).toBe("12.9");
    expect(out.works.seen).toEqual([
      { name: "NVIDIA L4", memory_mb: 23034, driver: "580.95.05" },
      { name: "NVIDIA L4", memory_mb: 23034, driver: "580.95.05" },
    ]);
    // Listed, but XGBoost moved itself to the CPU: NOT usable, whatever the fit returned.
    expect(out.fell_back.device).toBeNull();
    expect(out.fell_back.note).toContain("Device is changed from GPU to CPU");
    expect(out.cpu_build.device).toBeNull();
    expect(out.cpu_build.note).toContain("built without CUDA");
    expect(out.summary).toBe("2x NVIDIA L4 (22 GiB each, driver 580.95.05)");
    expect(out.summary_none).toBe("none visible");
  });

  it("adds XGBoost only when the sandbox has a GPU to use, was asked for one, or was dealt it", () => {
    const dir = setup();
    const out = run(
      dir,
      `
import json
import prog
logs = []
prog._log = logs.append
def cand(task="classification", gpu=None, only=None, balanced=False, pos_weight=None):
    got = prog._gpu_candidate(task, gpu, only, balanced, pos_weight)
    return [{"name": n, "kw": m().kw} for n, m in got]
print(json.dumps({
    "cpu_search": cand(),
    "asked_unusable": cand(gpu={"requested": 1, "device": None}),
    "usable": cand(gpu={"requested": 1, "device": "cuda"}),
    "regression": cand(task="regression", gpu={"requested": 1, "device": "cuda"}),
    "dealt_without_gpu": cand(only=["xgboost"]),
    "forecast": cand(task="forecast", gpu={"requested": 1, "device": "cuda"}),
    "balanced_binary": cand(gpu={"requested": 1, "device": "cuda"}, balanced=True, pos_weight=3.0),
    "balanced_multiclass": cand(gpu={"requested": 1, "device": "cuda"}, balanced=True, pos_weight=None),
    "logs": logs,
}))
`,
    );
    expect(out.cpu_search).toEqual([]);
    expect(out.asked_unusable).toHaveLength(1);
    expect(out.asked_unusable[0].kw.device).toBe("cpu");
    expect(out.usable[0]).toMatchObject({
      name: "xgboost",
      kw: { device: "cuda", tree_method: "hist" },
    });
    expect(out.regression[0].kw.device).toBe("cuda");
    // A worker dealt it trains it, on the CPU if it must: its slot never just vanishes.
    expect(out.dealt_without_gpu[0].kw.device).toBe("cpu");
    expect(out.forecast).toEqual([]);
    expect(out.balanced_binary[0].kw.scale_pos_weight).toBe(3.0);
    expect(out.balanced_multiclass).toEqual([]);
    expect(out.logs.join(" ")).toContain("balanced weights over more than two classes");
  });

  it("saves a model trained on a GPU for the CPU, through pipelines and calibration", () => {
    const dir = setup();
    const out = run(
      dir,
      `
import json
import prog, xgboost
prog._log = lambda m: None
class Step:
    pass
class Pipe:
    def __init__(self, model):
        self.steps = [("prep", Step()), ("model", model)]
class Calibrated:
    def __init__(self, est):
        self.estimator = est
class CalibratedCV:
    def __init__(self, pipes):
        self.estimator = Pipe(xgboost.XGBClassifier(device="cuda"))
        self.calibrated_classifiers_ = [Calibrated(p) for p in pipes]
gpu = Pipe(xgboost.XGBClassifier(device="cuda"))
cpu = Pipe(xgboost.XGBClassifier(device="cpu"))
other = Pipe(Step())
cal = CalibratedCV([Pipe(xgboost.XGBClassifier(device="cuda")), Pipe(xgboost.XGBClassifier(device="cuda:1"))])
moved = {"gpu": prog._xgb_to_cpu(gpu), "cpu": prog._xgb_to_cpu(cpu), "other": prog._xgb_to_cpu(other),
         "calibrated": prog._xgb_to_cpu(cal), "again": prog._xgb_to_cpu(gpu)}
print(json.dumps({"moved": moved,
                  "device": gpu.steps[1][1].kw["device"],
                  "calibrated": [c.estimator.steps[1][1].kw["device"] for c in cal.calibrated_classifiers_]}))
`,
    );
    expect(out.moved).toEqual({ gpu: 1, cpu: 0, other: 0, calibrated: 3, again: 0 });
    expect(out.device).toBe("cpu");
    expect(out.calibrated).toEqual(["cpu", "cpu"]);
  });

  it("records XGBoost's version only when the search loaded it", () => {
    const dir = setup();
    const out = run(
      dir,
      `
import json, sys
import prog
before = "xgboost" in prog._runtime()
import xgboost
print(json.dumps({"before": before, "after": prog._runtime().get("xgboost")}))
`,
    );
    expect(out).toEqual({ before: false, after: "3.4.1" });
  });
});

describe("the GPU wiring in the trainer", () => {
  it("measures the saved model on the CPU it will be served on", () => {
    const tab = TRAIN_PY.slice(TRAIN_PY.indexOf("def _train_tabular("));
    const moved = tab.indexOf("if _xgb_to_cpu(best):");
    expect(moved).toBeGreaterThan(0);
    // After calibration (which may refit on the GPU), before every metric.
    expect(moved).toBeGreaterThan(tab.indexOf("best, calibration = _calibrate("));
    expect(moved).toBeLessThan(tab.indexOf("metrics = _full_metrics("));
  });

  it("pins the same XGBoost the image bakes", async () => {
    const { readFileSync } = await import("node:fs");
    const baked = readFileSync("docker/notebook-runtime/requirements-nodeps.txt", "utf8");
    const pin = /^_XGB_PIN = '([^']+)'$/m.exec(TRAIN_PY)?.[1];
    expect(pin).toBe("xgboost-cu12==3.4.1");
    expect(baked.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual([pin]);
    const dockerfile = readFileSync("docker/notebook-runtime/Dockerfile", "utf8");
    expect(dockerfile).toContain("pip install --no-cache-dir --no-deps -r requirements-nodeps.txt");
  });

  it("never sets NVIDIA_VISIBLE_DEVICES in the image", async () => {
    // Set in an image, and the node's default runtime is NVIDIA's, it hands
    // every GPU on the node to a container that asked for none.
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync("docker/notebook-runtime/Dockerfile", "utf8");
    const code = dockerfile
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("NVIDIA_VISIBLE_DEVICES");
    expect(code).toContain("NVIDIA_DRIVER_CAPABILITIES=compute,utility");
  });
});
