"""Generate fairness fixtures with pandas, independently of src/lib/mlFairness.ts.

The arithmetic here is small enough that testing it against my own arithmetic
would prove nothing, so the rates, ratios and gaps are computed a completely
different way — pandas groupby over a frame of rows — and the TypeScript is
held to the answers. The MIN_GROUP policy is mirrored on purpose: it is a
policy choice this file does not get a vote on, while the rates it applies to
are what is actually being checked.

  docker run --rm -v /tmp:/work --entrypoint python \
    agentswarms/notebook-runtime:latest /work/fairnessMetrics.gen.py > fairnessMetrics.json
"""

import json
import random

import pandas as pd

MIN_GROUP = 30
FAVOURABLE = "approved"

random.seed(11)


def case(name, rows, favourable=FAVOURABLE):
    df = pd.DataFrame(rows, columns=["group", "prediction", "actual"])

    counts = (
        df.groupby("group")
        .apply(lambda g: pd.Series({"n": len(g), "selected": int((g.prediction == favourable).sum())}), include_groups=False)
        .reset_index()
    )
    outcomes = (
        df.dropna(subset=["actual"])
        .groupby("group")
        .apply(
            lambda g: pd.Series(
                {
                    "tp": int(((g.prediction == favourable) & (g.actual == favourable)).sum()),
                    "fp": int(((g.prediction == favourable) & (g.actual != favourable)).sum()),
                    "fn": int(((g.prediction != favourable) & (g.actual == favourable)).sum()),
                    "tn": int(((g.prediction != favourable) & (g.actual != favourable)).sum()),
                }
            ),
            include_groups=False,
        )
        .reset_index()
    )

    merged = counts.merge(outcomes, on="group", how="left").fillna(0)
    groups = []
    for _, r in merged.iterrows():
        matched = r.tp + r.fp + r.fn + r.tn
        groups.append(
            {
                "group": r.group,
                "n": int(r.n),
                "selection_rate": (r.selected / r.n) if r.n else None,
                "true_positive_rate": (r.tp / (r.tp + r.fn)) if (r.tp + r.fn) else None,
                "false_positive_rate": (r.fp / (r.fp + r.tn)) if (r.fp + r.tn) else None,
                "accuracy": ((r.tp + r.tn) / matched) if matched else None,
            }
        )

    judged = [g for g in groups if g["n"] >= MIN_GROUP]
    rates = [g["selection_rate"] for g in judged if g["selection_rate"] is not None]
    tprs = [g["true_positive_rate"] for g in judged if g["true_positive_rate"] is not None]
    di = (min(rates) / max(rates)) if len(rates) > 1 and max(rates) > 0 else None
    gap = (max(tprs) - min(tprs)) if len(tprs) > 1 else None
    lowest = None
    if len(rates) > 1:
        lowest = next(g["group"] for g in judged if g["selection_rate"] == min(rates))

    return {
        "name": name,
        "favourable": favourable,
        "counts": [{"group": g["group"], "n": g["n"], "selected": int(c)} for g, c in zip(groups, merged.selected)],
        "outcomes": [
            {"group": r.group, "tp": int(r.tp), "fp": int(r.fp), "fn": int(r.fn), "tn": int(r.tn)}
            for _, r in outcomes.iterrows()
        ],
        "expected": {
            "groups": groups,
            "disparate_impact": di,
            "equal_opportunity_gap": gap,
            "lowest_group": lowest,
        },
    }


def make(group, n, approve_rate, correct_rate):
    out = []
    for _ in range(n):
        approved = random.random() < approve_rate
        pred = FAVOURABLE if approved else "declined"
        actual = pred if random.random() < correct_rate else ("declined" if approved else FAVOURABLE)
        out.append((group, pred, actual))
    return out


cases = [
    # Plainly uneven: one group approved far less often.
    case("uneven", make("A", 200, 0.70, 0.9) + make("B", 200, 0.35, 0.9)),
    # Even rates but the model is much WORSE for one group — the case selection
    # rate alone cannot see.
    case("equal rates, unequal errors", make("A", 200, 0.5, 0.95) + make("B", 200, 0.5, 0.6)),
    # A tiny group with an extreme rate: reported, never judged.
    case("tiny group", make("A", 200, 0.6, 0.9) + make("B", 5, 0.0, 0.9)),
    # One group only: nothing to compare against.
    case("single group", make("A", 120, 0.6, 0.9)),
    # A group nobody recorded.
    case(
        "missing group",
        make("A", 100, 0.6, 0.9) + [("(not recorded)", "approved", "approved")] * 40,
    ),
]

print(json.dumps({"cases": cases}, indent=2, default=float))
