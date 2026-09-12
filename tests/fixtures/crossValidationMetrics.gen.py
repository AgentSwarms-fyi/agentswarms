"""Emit REAL cross_validation blocks from the real trainer, for the reader.

src/lib/mlCrossValidation.ts computes nothing — it reads what _train_tabular
wrote. So the thing that breaks is the SHAPE: a strategy renamed, a fold list
that arrives empty, a mean that turns up as a string. A hand-written fixture
would encode my idea of the shape and keep passing straight through that break.

So this drives the genuine _train_tabular over four configurations that reach
four different branches of _cv_plan, and records alongside each block the
figures a reader is entitled to derive — recomputed here with numpy, from the
fold scores, by a different route than the TypeScript takes.

  node -e "const s=require('fs').readFileSync('src/utils/ml/pyTrain.ts','utf8');const a=s.indexOf('String.raw`')+11;require('fs').writeFileSync('/tmp/train_py.py',s.slice(a,s.indexOf('`;',a)))"
  docker run --rm -v /tmp:/work --entrypoint python \
    agentswarms/notebook-runtime:latest /work/crossValidationMetrics.gen.py

The JSON is WRITTEN to /work/crossValidationMetrics.json rather than printed:
the trainer's own _log goes to stdout and would land inside the fixture.
Copy it next to this file.
"""

import json

import numpy as np
import pandas as pd

ns = {"__name__": "trainpy"}
exec(open("/work/train_py.py", encoding="utf-8").read(), ns)  # noqa: S102
_train_tabular = ns["_train_tabular"]

rng = np.random.RandomState(7)
N = 900
df = pd.DataFrame(
    {
        "tenure": rng.randint(0, 36, N),
        "spend": rng.uniform(20, 200, N).round(2),
        "tickets": rng.randint(0, 40, N),
        "region": rng.choice(["EU", "US", "APAC"], N),
        "day": pd.date_range("2024-01-01", periods=N, freq="D"),
    }
)
lin = -1.0 - 0.05 * df.tenure + 0.06 * df.tickets - 0.004 * df.spend
df["churned"] = np.where(rng.uniform(size=N) < 1 / (1 + np.exp(-lin)), "yes", "no")
df["value"] = (50 + 2.5 * df.tenure - 0.8 * df.tickets + rng.normal(0, 12, N)).round(2)

BASE = {
    "prep": {},
    "tuning": "none",
    "time_budget_minutes": 30,
    "validation_fraction": 0.2,
    "feature_columns": ["tenure", "spend", "tickets", "region"],
}


def build(name, extra):
    warnings_ = []
    r = _train_tabular(df, {**BASE, **extra}, warnings_)
    cv = r["metrics"]["cross_validation"]
    scores = list(cv["scores"])
    # Recomputed here, from the folds, by a different route.
    mean = float(np.mean(scores)) if scores else None
    std = float(np.std(scores, ddof=1)) if len(scores) > 1 else 0.0
    rel = (std / abs(mean)) if (mean and abs(mean) > 1e-12 and len(scores) > 1) else None
    gap = None
    if mean is not None and cv["holdout_value"] is not None:
        raw = cv["holdout_value"] - mean
        gap = raw if cv["higher_is_better"] else -raw
    return {
        "name": name,
        "metrics": r["metrics"],
        "expected": {
            "strategy": cv["strategy"],
            "folds": int(cv["folds"]),
            "n_scores": len(scores),
            "mean": None if mean is None else round(mean, 6),
            "std": round(std, 6),
            "relative_spread": None if rel is None else round(rel, 6),
            "holdout_gap": None if gap is None else round(gap, 6),
            "higher_is_better": bool(cv["higher_is_better"]),
            "holdout_rows": int(cv["holdout_rows"]),
        },
        "algorithm": r["algorithm"],
    }


cases = [
    # A 180-row holdout: too small to trust one split, so k folds.
    build("classification_folds", {"task": "classification", "target_column": "churned"}),
    # Regression over the same rows: unstratified folds, RMSE, lower is better.
    build("regression_folds", {"task": "regression", "target_column": "value"}),
    # A holdout declared big enough: one inner split, one score, no spread.
    build(
        "inner_split",
        {"task": "classification", "target_column": "churned", "cv_min_holdout_rows": 50},
    ),
    # Ordered rows: time-series folds and the most recent rows kept back.
    build("temporal", {"task": "regression", "target_column": "value", "time_column": "day"}),
]

with open("/work/crossValidationMetrics.json", "w", encoding="utf-8") as fh:
    json.dump({"cases": cases}, fh, indent=2)
print("wrote crossValidationMetrics.json")
