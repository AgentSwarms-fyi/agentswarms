"""Run the REAL _explain from TRAIN_PY against REAL fitted sklearn pipelines.

Compiling the program proves its syntax; this proves its arithmetic, which is
why it exists as a script rather than a unit test: the function only runs where
scikit-learn does, and asserting properties of a mocked model would assert
nothing. The properties checked are the ones a reader of the panel assumes:
a feature the model ignores contributes nothing, the feature it keys on comes
first, and for a linear model the contribution equals the closed form exactly.

  node -e "const s=require('fs').readFileSync('src/utils/ml/pyTrain.ts','utf8');const a=s.indexOf('String.raw`')+11;require('fs').writeFileSync('/tmp/train_py.py',s.slice(a,s.indexOf('`;',a)))"
  docker run --rm -v /tmp:/work --entrypoint python agentswarms/notebook-runtime:latest /work/explainProbe.py
"""
import json
import sys

import numpy as np
import pandas as pd

ns = {"__name__": "trainpy"}
# TRAIN_PY, extracted from src/utils/ml/pyTrain.ts by the runner below.
exec(open("/work/train_py.py", encoding="utf-8").read(), ns)  # noqa: S102
_explain = ns["_explain"]
_baseline_row = ns["_baseline_row"]
_feature_stats = ns["_feature_stats"]

from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline

rng = np.random.RandomState(0)
n = 400
# `signal` decides the label. `noise` is pure noise. `region` is categorical
# and irrelevant. A correct explanation ranks signal first and noise near zero.
df = pd.DataFrame(
    {
        "signal": rng.normal(0, 1, n),
        "noise": rng.normal(0, 1, n),
        "region": rng.choice(["EMEA", "AMER", "APAC"], n),
    }
)
y = (df["signal"] > 0).astype(int)

feats = ["signal", "noise", "region"]
schema = [
    {"name": "signal", "dtype": "numeric"},
    {"name": "noise", "dtype": "numeric"},
    {"name": "region", "dtype": "categorical"},
]
stats = _feature_stats(df, schema, feats)

# One-hot the categorical by hand so the pipeline is plain sklearn and the
# probe does not depend on _prepare_x's internals.
def prep(frame):
    out = frame[["signal", "noise"]].copy()
    for r in ("EMEA", "AMER", "APAC"):
        out["region_" + r] = (frame["region"] == r).astype(float)
    return out


clf = Pipeline([("model", RandomForestClassifier(n_estimators=60, random_state=0))])
clf.fit(prep(df), y)

art = {"features": feats, "feature_stats": stats}
head = df.head(5)
pred = clf.predict(prep(head))
rows = _explain(art, head, clf, prep, "classification", ["0", "1"], pred, 5, 8)

print("baseline row:", json.dumps(_baseline_row(stats, feats)))
ok = True
for i, parts in enumerate(rows):
    names = [p["feature"] for p in parts]
    by = {p["feature"]: p["contribution"] for p in parts}
    print(f"row {i} signal={head.iloc[i]['signal']:+.3f} -> {names} {json.dumps(by)}")
    if names and names[0] != "signal":
        print("  !! signal is not the top contributor")
        ok = False
    if abs(by.get("noise", 0.0)) > abs(by.get("signal", 0.0)):
        print("  !! noise outweighs signal")
        ok = False

# Regression: the contribution must be in the units of the prediction.
rdf = pd.DataFrame({"signal": rng.normal(0, 1, n), "noise": rng.normal(0, 1, n),
                    "region": rng.choice(["EMEA", "AMER"], n)})
ry = 10 * rdf["signal"] + 0.0 * rdf["noise"]
rschema = [{"name": "signal", "dtype": "numeric"}, {"name": "noise", "dtype": "numeric"},
           {"name": "region", "dtype": "categorical"}]
rstats = _feature_stats(rdf, rschema, feats)


def rprep(frame):
    out = frame[["signal", "noise"]].copy()
    for r in ("EMEA", "AMER"):
        out["region_" + r] = (frame["region"] == r).astype(float)
    return out


reg = Pipeline([("model", Ridge())])
reg.fit(rprep(rdf), ry)
rart = {"features": feats, "feature_stats": rstats}
rhead = rdf.head(3)
rrows = _explain(rart, rhead, reg, rprep, "regression", None, reg.predict(rprep(rhead)), 3, 8)
for i, parts in enumerate(rrows):
    by = {p["feature"]: p["contribution"] for p in parts}
    got = by.get("signal", 0.0)
    # The FITTED coefficient, not the data-generating 10: Ridge shrinks, and
    # comparing against the number I generated the data with would be checking
    # sklearn rather than this function.
    coef = reg.named_steps["model"].coef_[0]
    want = coef * (rhead.iloc[i]["signal"] - rstats["signal"]["edges"][len(rstats["signal"]["edges"]) // 2])
    print(f"reg row {i}: signal contribution {got:+.3f}, expected ~{want:+.3f}")
    if abs(got - want) > 1e-6:
        print("  !! linear contribution does not match the closed form")
        ok = False

print("PROBE", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
