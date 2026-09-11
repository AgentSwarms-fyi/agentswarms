"""Generate f1_macro / accuracy / rmse / mae / r2 from sklearn itself.

The TypeScript in src/lib/mlEvaluation.ts has to agree with the library that
produced the baseline it will be compared against. Writing a test from my own
formula would only prove the formula matches itself.
"""

import json
import random

import numpy as np
from sklearn import metrics as M

random.seed(7)
out = {"classification": [], "regression": []}

# ── classification: emit the confusion matrix AND sklearn's verdict ─────────
cases = [
    (["a", "a", "b", "b", "c"], ["a", "b", "b", "b", "c"]),
    # a class the model NEVER predicts — the case macro averaging exists for
    (["a", "a", "a", "a"], ["a", "a", "b", "c"]),
    # perfect
    (["x", "y", "x"], ["x", "y", "x"]),
    # every prediction wrong
    (["a", "a"], ["b", "b"]),
    # binary, imbalanced
    (["0"] * 90 + ["1"] * 10, ["0"] * 85 + ["1"] * 5 + ["0"] * 5 + ["1"] * 5),
    # many classes, random
    (
        [random.choice("abcdef") for _ in range(300)],
        [random.choice("abcdef") for _ in range(300)],
    ),
]
for pred, act in cases:
    pairs = {}
    for p, a in zip(pred, act):
        pairs[(p, a)] = pairs.get((p, a), 0) + 1
    out["classification"].append(
        {
            "counts": [{"predicted": p, "actual": a, "n": n} for (p, a), n in sorted(pairs.items())],
            "f1_macro": float(M.f1_score(act, pred, average="macro", zero_division=0)),
            "accuracy": float(M.accuracy_score(act, pred)),
            "classes": len(set(pred) | set(act)),
        }
    )

# ── regression: emit the five sums AND sklearn's verdict ────────────────────
reg_cases = [
    ([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]),
    ([1.0, 2.0, 3.0], [1.5, 1.5, 4.0]),
    ([10.0] * 5, [10.0] * 5),  # zero variance in the actuals -> r2 undefined
    (list(np.random.RandomState(3).normal(50, 10, 200)), list(np.random.RandomState(4).normal(50, 10, 200))),
]
for pred, act in reg_cases:
    p = np.asarray(pred, dtype=float)
    a = np.asarray(act, dtype=float)
    sst = float(np.sum(a * a) - (np.sum(a) ** 2) / len(a))
    out["regression"].append(
        {
            "agg": {
                "n": int(len(a)),
                "sse": float(np.sum((p - a) ** 2)),
                "sae": float(np.sum(np.abs(p - a))),
                "sy": float(np.sum(a)),
                "syy": float(np.sum(a * a)),
            },
            "rmse": float(np.sqrt(M.mean_squared_error(a, p))),
            "mae": float(M.mean_absolute_error(a, p)),
            "r2": None if sst <= 0 else float(M.r2_score(a, p)),
        }
    )

print(json.dumps(out, indent=2))
