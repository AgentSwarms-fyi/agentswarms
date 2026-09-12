"""Emit a REAL metrics block from the real trainer, for the reader to be held to.

src/lib/mlCalibration.ts does not compute anything — it reads what the training
program wrote. So the thing that can actually break is the SHAPE: a key renamed
in Python, a number that arrives as a string, a curve that is empty for a
reason nobody anticipated. A hand-written fixture would test the reader against
my own idea of the shape and would keep passing through exactly that break.

So this runs the genuine _calibrate / _calibration_scores / _threshold_sweep
out of TRAIN_PY on real sklearn models and emits the metrics block the trainer
would store, plus the figures a reader is entitled to see recomputed a
different way (numpy, over the raw probabilities) so the TypeScript's
"effective scores" and band cannot silently disagree with the source.

  node -e "const s=require('fs').readFileSync('src/utils/ml/pyTrain.ts','utf8');const a=s.indexOf('String.raw`')+11;require('fs').writeFileSync('/tmp/train_py.py',s.slice(a,s.indexOf('`;',a)))"
  docker run --rm -v /tmp:/work --entrypoint python \
    agentswarms/notebook-runtime:latest /work/calibrationMetrics.gen.py

The JSON is WRITTEN to /work/calibrationMetrics.json rather than printed:
the trainer's own _log goes to stdout and would land in the middle of the
fixture. Copy it next to this file.
"""

import json

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
_cv_splits = ns["_cv_splits"]


def build(name, n_samples, flip_y, seed):
    """Train, calibrate and sweep exactly as _train_tabular does."""
    X, y = make_classification(
        n_samples=n_samples, n_features=12, n_informative=5, random_state=seed, flip_y=flip_y
    )
    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=0.3, random_state=seed, stratify=y)
    pipe = Pipeline([("model", RandomForestClassifier(n_estimators=60, random_state=seed))])
    pipe.fit(Xtr, ytr)

    warnings_ = []
    # _calibrate decides on a slice of the TRAINING rows and reports on the
    # holdout it is handed, so it needs the same splits the trainer builds.
    splits = _cv_splits("classification", {"strategy": "stratified", "folds": 3}, ytr)
    best, calibration = _calibrate(pipe, Xtr, ytr, splits, Xva, yva, ["0", "1"], warnings_)
    sweep = _threshold_sweep(best, Xva, yva, ["0", "1"])

    metrics = {"accuracy": 0.0, "tuning_trials": 1.0}
    if calibration:
        metrics["calibrated"] = bool(calibration["calibrated"])
        metrics["calibration_method"] = calibration["method"]
        metrics["calibration"] = calibration
    if sweep:
        metrics["threshold_sweep"] = sweep

    # The figures the reader is entitled to derive, computed HERE by a separate
    # route: straight from the probabilities of whichever model was kept.
    proba = best.predict_proba(Xva)[:, 1]
    onehot = np.zeros((len(yva), 2))
    onehot[np.arange(len(yva)), np.asarray(yva).astype(int)] = 1.0
    brier = float(np.mean(np.sum((best.predict_proba(Xva) - onehot) ** 2, axis=1)))

    edges = np.linspace(0, 1, 11)
    yb = (np.asarray(yva).astype(int) == 1).astype(float)
    ece = 0.0
    for k in range(10):
        m = (proba >= edges[k]) & (proba < edges[k + 1] if k < 9 else proba <= edges[k + 1])
        if m.sum():
            ece += (m.sum() / len(proba)) * abs(proba[m].mean() - yb[m].mean())

    # And what the operating point at 0.70 really costs, counted by hand.
    at70 = (proba >= 0.70).astype(int)
    tp = int(((at70 == 1) & (yb == 1)).sum())
    fp = int(((at70 == 1) & (yb == 0)).sum())
    fn = int(((at70 == 0) & (yb == 1)).sum())

    return {
        "name": name,
        "metrics": metrics,
        "expected": {
            "calibrated": bool(calibration["calibrated"]) if calibration else False,
            "method": calibration["method"] if calibration else None,
            # What the model that was actually KEPT scores.
            "effective_brier": round(brier, 6),
            "effective_calibration_error": round(float(ece), 6),
            "at_070": {
                "selected": int(at70.sum()),
                "precision": round(tp / (tp + fp), 4) if (tp + fp) else 0.0,
                "recall": round(tp / (tp + fn), 4) if (tp + fn) else 0.0,
            },
            "best_f1_threshold": sweep["best_f1_threshold"] if sweep else None,
            "positive_label": sweep["positive_label"] if sweep else None,
        },
    }


cases = [
    # Noisy and large: calibration has something to fix and enough rows for
    # isotonic, so this is the "calibrated" branch.
    build("noisy_forest", 4000, 0.25, 3),
    # Small and clean: the base model is already sharp and 3-fold calibration
    # on a few dozen rows has nothing to win, so this exercises the branch
    # where the attempt is measured and DISCARDED.
    build("small_clean", 300, 0.02, 7),
]

with open("/work/calibrationMetrics.json", "w", encoding="utf-8") as fh:
    json.dump({"cases": cases}, fh, indent=2)
print("wrote calibrationMetrics.json")
