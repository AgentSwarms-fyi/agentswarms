# Generates tests/fixtures/trafficDriftParity.json by running the
# platform's OWN _drift (cut out of src/utils/ml/pyTrain.ts) on fixture rows,
# and since R549 its _missing_rates on the same rows and _feature_stats on a
# training frame, so the missing share is counted one way in all three places.
# Run inside the notebook-runtime image, which has the pandas/numpy the
# sandbox scores with:
#   docker run --rm --network none -v <repo>/src/utils/ml:/src:ro -v <repo>/tests/fixtures:/out
#     --entrypoint python ghcr.io/agentswarms-fyi/notebook-runtime:local /out/trafficDriftParity.gen.py
import json
import random

src = open("/src/pyTrain.ts", encoding="utf8").read()


def cut(head):
    start = src.index(head)
    end = src.index("\n\n\n", start)
    ns = {}
    exec(src[start:end], ns)
    return ns


_drift = cut("def _drift(stats, df):")["_drift"]
_missing_rates = cut("def _missing_rates(stats, df):")["_missing_rates"]
_feature_stats = cut("def _feature_stats(df, schema, features):")["_feature_stats"]

import pandas as pd  # noqa: E402

stats = {
    "amount": {
        "kind": "numeric",
        "edges": [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0],
        "props": [0.1] * 10,
        "n": 1000,
    },
    "tenure": {
        "kind": "numeric",
        "edges": [0.0, 1.0, 2.0, 5.0, 10.0, 20.0],
        "props": [0.15, 0.25, 0.3, 0.2, 0.1],
        "n": 1000,
    },
    "plan": {
        "kind": "categorical",
        "props": {"basic": 0.5, "pro": 0.3, "team": 0.15},
        "other": 0.05,
        "n": 1000,
    },
    "region": {"kind": "categorical", "props": {"eu": 0.6, "us": 0.4}, "other": 0.0, "n": 1000},
    # Never sent by any row: skipped, as the batch path skips a missing column.
    "absent": {"kind": "numeric", "edges": [0.0, 1.0, 2.0], "props": [0.5, 0.5], "n": 100},
    # Sent by a few rows only, so fewer than ten numbers: skipped.
    "sparse": {"kind": "numeric", "edges": [0.0, 1.0, 2.0], "props": [0.5, 0.5], "n": 100},
}

rng = random.Random(544)


def row(i):
    r = {}
    # Shifted upwards, with the awkward values: out of range, exact edges,
    # numeric strings, nulls, a missing key now and then.
    special = [-5, 0, 10, 100, 150, "42.5", " 7 ", None, "n/a"]
    if i % 17 == 0:
        r["amount"] = special[(i // 17) % len(special)]
    elif i % 23 != 0:
        r["amount"] = round(rng.uniform(30, 120), 2)
    r["tenure"] = rng.choice([0, 0.5, 1, 1.5, 3, 4, 6, 8, 12, 25, None])
    r["plan"] = rng.choice(["basic", "basic", "pro", "enterprise", "team", None, "free"])
    if i % 5 != 0:
        r["region"] = rng.choice(["eu", "us", "us", "apac"])
    if i < 6:
        r["sparse"] = i % 2
    return r


rows = [row(i) for i in range(260)]
# The batch path builds its frame exactly like this from the JSON rows.
df = pd.DataFrame(json.loads(json.dumps(rows)))
expected = _drift(stats, df)
expected_missing = _missing_rates(stats, df)

# A second case: booleans and whole numbers in a categorical column, and a
# boolean numeric column, to pin how text is made of them.
stats2 = {
    "flag": {"kind": "numeric", "edges": [0.0, 0.5, 1.0], "props": [0.5, 0.5], "n": 100},
    "code": {"kind": "categorical", "props": {"True": 0.5, "7": 0.25, "x": 0.25}, "other": 0.0, "n": 100},
}
rows2 = []
for i in range(40):
    rows2.append({"flag": bool(i % 3 == 0), "code": [True, 7, "x", False][i % 4]})
df2 = pd.DataFrame(json.loads(json.dumps(rows2)))
expected2 = _drift(stats2, df2)
expected_missing2 = _missing_rates(stats2, df2)

# R549: a category that arrived empty, or nearly, is not compared (fewer than
# ten values, the floor a number already had): it is a missing input, which
# _missing_rates names, not a distribution that moved.
stats3 = {
    "plan": {"kind": "categorical", "props": {"basic": 0.6, "pro": 0.4}, "other": 0.0, "n": 100},
    "region": {"kind": "categorical", "props": {"eu": 0.5, "us": 0.5}, "other": 0.0, "n": 100},
    "channel": {"kind": "categorical", "props": {"web": 0.7, "app": 0.3}, "other": 0.0, "n": 100},
}
rows3 = []
for i in range(30):
    r = {"plan": ["basic", "pro", "basic"][i % 3], "region": None}
    # Nine values: one short of the floor.
    if i < 9:
        r["channel"] = "web"
    rows3.append(r)
df3 = pd.DataFrame(json.loads(json.dumps(rows3)))
expected3 = _drift(stats3, df3)
expected_missing3 = _missing_rates(stats3, df3)

# Training (R549): the share of rows each feature was empty in, recorded with
# the distribution. The same rows counted the way an online request is must
# give the same shares.
train_rows = []
for i in range(120):
    r = {"income": None if i % 4 == 0 else ("n/a" if i % 15 == 1 else 1000 + 37 * i)}
    r["segment"] = None if i % 10 == 3 else ["a", "b", "c"][i % 3]
    r["age"] = 20 + i % 40
    train_rows.append(r)
train_df = pd.DataFrame(json.loads(json.dumps(train_rows)))
train_schema = [
    {"name": "income", "dtype": "numeric"},
    {"name": "segment", "dtype": "categorical"},
    {"name": "age", "dtype": "numeric"},
]
train_stats = _feature_stats(train_df, train_schema, ["income", "segment", "age"])

out = {
    "about": "Generated by running _drift from src/utils/ml/pyTrain.ts in the notebook-runtime image (R545). Do not edit by hand.",
    "pandas": pd.__version__,
    "cases": [
        {"stats": stats, "rows": rows, "expected": expected, "expected_missing": expected_missing},
        {"stats": stats2, "rows": rows2, "expected": expected2, "expected_missing": expected_missing2},
        {"stats": stats3, "rows": rows3, "expected": expected3, "expected_missing": expected_missing3},
    ],
    "training": {"rows": train_rows, "stats": train_stats},
}
open("/out/trafficDriftParity.json", "w", encoding="utf8", newline="").write(json.dumps(out, indent=1) + "\n")
print(json.dumps({"case1": expected, "case2": expected2, "missing1": expected_missing,
                  "missing2": expected_missing2, "case3": expected3, "missing3": expected_missing3,
                  "training": train_stats})[:3000])
