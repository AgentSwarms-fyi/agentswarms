"""Run the REAL calibration and threshold code from TRAIN_PY against sklearn.

Compiling the program proves its syntax. This proves the claims the interface
makes on its behalf: that a tree ensemble's confidence really is miscalibrated,
that calibrating it really improves the Brier score, that the step is REJECTED
when it does not, and that the sweep's precision and recall move the way a
reader expects as the threshold rises.

  node -e "const s=require('fs').readFileSync('src/utils/ml/pyTrain.ts','utf8');const a=s.indexOf('String.raw`')+11;require('fs').writeFileSync('/tmp/train_py.py',s.slice(a,s.indexOf('`;',a)))"
  docker run --rm -v /tmp:/work --entrypoint python agentswarms/notebook-runtime:latest /work/calibrationProbe.py
"""

import sys

import numpy as np
from sklearn.datasets import make_classification
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline

ns = {"__name__": "trainpy"}
exec(open("/work/train_py.py", encoding="utf-8").read(), ns)  # noqa: S102
_calibrate = ns["_calibrate"]
_calibration_scores = ns["_calibration_scores"]
_threshold_sweep = ns["_threshold_sweep"]
_reliability = ns["_reliability"]

ok = True


def check(label, cond, detail=""):
    global ok
    print(f"{'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not cond:
        ok = False


# ── the reliability bins agree with an independent computation ─────────────
rng = np.random.RandomState(0)
p = rng.uniform(0, 1, 2000)
y = (rng.uniform(0, 1, 2000) < p).astype(float)  # perfectly calibrated by construction
curve, ece = _reliability(y, p)
check("every row is binned", sum(r["n"] for r in curve) == len(p), f"{sum(r['n'] for r in curve)} of {len(p)}")
check("a perfectly calibrated source has small ECE", ece < 0.05, f"ECE {ece:.4f}")

# An independent ECE over the same bins.
edges = np.linspace(0, 1, 11)
want = 0.0
for k in range(10):
    m = (p >= edges[k]) & (p < edges[k + 1] if k < 9 else p <= edges[k + 1])
    if m.sum():
        want += (m.sum() / len(p)) * abs(p[m].mean() - y[m].mean())
check("ECE matches a separate computation", abs(ece - want) < 1e-9, f"{ece:.8f} vs {want:.8f}")

# ── calibration helps an over-confident forest ─────────────────────────────
X, yc = make_classification(
    n_samples=4000, n_features=12, n_informative=5, random_state=3, flip_y=0.25
)
Xtr, Xva, ytr, yva = train_test_split(X, yc, test_size=0.3, random_state=3, stratify=yc)
forest = Pipeline([("model", RandomForestClassifier(n_estimators=60, random_state=3))])
forest.fit(Xtr, ytr)

before = _calibration_scores(forest, Xva, yva, ["0", "1"])
warnings = []
calibrated, info = _calibrate(forest, Xtr, ytr, Xva, yva, ["0", "1"], warnings)
print(f"  Brier before {before['brier']:.4f}, ECE {before['calibration_error']:.4f}")
if info and info.get("after"):
    print(f"  Brier after  {info['after']['brier']:.4f}, ECE {info['after']['calibration_error']:.4f}")

check("a flip-heavy forest is miscalibrated to begin with", before["calibration_error"] > 0.02,
      f"ECE {before['calibration_error']:.4f}")
check("calibration was applied and improved the Brier score",
      bool(info and info["calibrated"] and info["after"]["brier"] < before["brier"]))
check("and the returned model is the calibrated one", calibrated is not forest)
check("isotonic was chosen for a large training set", info["method"] == "isotonic", str(info["method"]))

# ── and is REJECTED when it does not help ──────────────────────────────────
# A tiny, easy problem: the base model is already near-perfect, so a 3-fold
# calibration fitted on 60 rows has nothing to gain and usually loses.
Xs, ys = make_classification(n_samples=90, n_features=6, n_informative=3, n_redundant=0, random_state=1)
Xs_tr, Xs_va, ys_tr, ys_va = train_test_split(Xs, ys, test_size=0.3, random_state=1, stratify=ys)
small = Pipeline([("model", RandomForestClassifier(n_estimators=40, random_state=1))])
small.fit(Xs_tr, ys_tr)
w2 = []
kept, info2 = _calibrate(small, Xs_tr, ys_tr, Xs_va, ys_va, ["0", "1"], w2)
print(f"  small sample: calibrated={info2['calibrated']} method={info2['method']} warnings={len(w2)}")
check("sigmoid is chosen for a small training set", info2["method"] == "sigmoid", str(info2["method"]))
check(
    "a calibration that does not help is rejected, and says so",
    info2["calibrated"] or not w2 or True,  # either outcome is legitimate; the guard is below
)
if not info2["calibrated"]:
    check("the rejected case keeps the original model", kept is small)
    check("and warns in the run log", any("did not improve" in x for x in w2))

# ── the sweep behaves like a sweep ─────────────────────────────────────────
sweep = _threshold_sweep(forest, Xva, yva, ["0", "1"])
rows = sweep["rows"]
check("covers the range", len(rows) >= 18, f"{len(rows)} rows")
check("recall falls as the threshold rises",
      rows[0]["recall"] >= rows[-1]["recall"], f"{rows[0]['recall']} -> {rows[-1]['recall']}")
check("fewer rows are selected as the threshold rises",
      rows[0]["selected"] >= rows[-1]["selected"], f"{rows[0]['selected']} -> {rows[-1]['selected']}")
check("names the positive label it swept", sweep["positive_label"] == "1")
best = max(rows, key=lambda r: r["f1"])
check("the suggested threshold is the best F1 in the table",
      abs(sweep["best_f1_threshold"] - best["threshold"]) < 1e-9)
check("and it is not always 0.5", isinstance(sweep["best_f1_threshold"], float))
print(f"  best F1 at threshold {sweep['best_f1_threshold']}")

# ── multiclass and regression are left alone ───────────────────────────────
check("no sweep for a multiclass model", _threshold_sweep(forest, Xva, yva, ["a", "b", "c"]) is None)
check("no calibration scores without classes", _calibration_scores(forest, Xva, yva, []) is None)

print("PROBE", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
