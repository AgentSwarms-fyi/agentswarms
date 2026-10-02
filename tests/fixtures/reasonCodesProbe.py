"""Run the REAL reason-code code from TRAIN_PY and check what it claims.

The claim that matters is AGREEMENT. Reason codes are the same ablation the
row-level explanation uses, run over every row instead of twenty, and the whole
argument for reusing _explain rather than writing something cheaper is that a
reason code must not disagree with the explanation shown on the row's own page.
So this checks them against each other on the same rows, not just that each is
internally plausible.

It also checks the bookkeeping the chunking introduces: that chunk boundaries
change nothing, that row order is preserved, and that a row with fewer moved
features than slots gets nulls rather than a fabricated reason.

  node -e "const s=require('fs').readFileSync('src/utils/ml/pyTrain.ts','utf8');const a=s.indexOf('String.raw`')+11;require('fs').writeFileSync('/tmp/train_py.py',s.slice(a,s.indexOf('`;',a)))"
  docker run --rm -v /tmp:/work --entrypoint python \
    agentswarms/notebook-runtime:latest /work/reasonCodesProbe.py
"""

import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LinearRegression
from sklearn.pipeline import Pipeline

ns = {"__name__": "trainpy"}
exec(open("/work/train_py.py", encoding="utf-8").read(), ns)  # noqa: S102
_explain = ns["_explain"]
_reason_codes = ns["_reason_codes"]
_reason_frame = ns["_reason_frame"]

ok = True


def check(label, cond, detail=""):
    global ok
    print(f"{'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not cond:
        ok = False


rng = np.random.RandomState(3)
N = 260
df = pd.DataFrame(
    {
        "tenure": rng.randint(0, 36, N).astype(float),
        "spend": rng.uniform(20, 200, N).round(2),
        "tickets": rng.randint(0, 40, N).astype(float),
        "logins": rng.randint(0, 30, N).astype(float),
    }
)
lin = -1.0 - 0.06 * df.tenure + 0.05 * df.tickets - 0.004 * df.spend
y = (rng.uniform(size=N) < 1 / (1 + np.exp(-lin))).astype(int)

FEATS = ["tenure", "spend", "tickets", "logins"]
STATS = {
    f: {"kind": "numeric", "edges": [float(df[f].min()), float(df[f].max())], "props": [1.0], "n": N}
    for f in FEATS
}
ART = {"features": FEATS, "feature_stats": STATS, "external": True, "task": "classification"}


def prep(frame):
    return frame[FEATS]


clf = Pipeline([("model", RandomForestClassifier(n_estimators=40, random_state=3))])
clf.fit(prep(df), y)
warnings_ = []

# ── the same answer as the row-level explanation ──────────────────────────
direct = _explain(ART, df, clf, prep, "classification", ["0", "1"], None, 40, 3)
chunked = _reason_codes(ART, df, clf, prep, "classification", ["0", "1"], 3, 25, warnings_)
check("reason codes were produced for every row", chunked is not None and len(chunked) == N,
      str(len(chunked) if chunked else None))

same_feature = same_effect = 0
for i in range(40):
    a, b = direct[i], chunked[i]
    if [p["feature"] for p in a] == [p["feature"] for p in b]:
        same_feature += 1
    if all(abs(p["contribution"] - q["contribution"]) < 1e-9 for p, q in zip(a, b)):
        same_effect += 1
check("reason codes name the same features the explanation does", same_feature == 40,
      f"{same_feature}/40")
check("and to the same number, not merely the same order", same_effect == 40, f"{same_effect}/40")

# ── chunk size changes nothing ────────────────────────────────────────────
one_chunk = _reason_codes(ART, df, clf, prep, "classification", ["0", "1"], 3, 10_000, warnings_)
many_chunks = _reason_codes(ART, df, clf, prep, "classification", ["0", "1"], 3, 7, warnings_)
def flat(rs):
    return [(p["feature"], round(p["contribution"], 9)) for r in rs for p in r]
check("one chunk and many chunks give identical results", flat(one_chunk) == flat(many_chunks))
check("and a chunk size that does not divide the rows still covers them all",
      len(many_chunks) == N, str(len(many_chunks)))

# ── row order survives chunking ───────────────────────────────────────────
# The reason for row 0 must belong to row 0. Ablating the whole frame and
# reading it back in the wrong order is the failure that would look perfectly
# reasonable in every aggregate.
tail = _reason_codes(ART, df.iloc[200:], clf, prep, "classification", ["0", "1"], 3, 13, warnings_)
check("a slice's reasons match the same rows in the full run",
      flat(tail) == flat(chunked[200:]), "tail of the full run")

# ── the flat columns ──────────────────────────────────────────────────────
cols = _reason_frame(chunked, 3)
check("two columns per slot, named for the slot",
      sorted(cols) == ["reason_1", "reason_1_effect", "reason_2", "reason_2_effect",
                       "reason_3", "reason_3_effect"], str(sorted(cols)))
check("every column is as long as the frame", all(len(v) == N for v in cols.values()))
check("slot 1 is the strongest effect on every row",
      all(abs(cols["reason_1_effect"][i]) >= abs(cols["reason_2_effect"][i])
          for i in range(N) if cols["reason_2_effect"][i] is not None))
check("the named feature is a real feature",
      set(x for x in cols["reason_1"] if x is not None) <= set(FEATS))

# ── fewer movers than slots leaves nulls, not inventions ──────────────────
wide = _reason_frame(chunked, 8)
slot8 = wide["reason_8"]
check("asking for more slots than features leaves None, not a blank string",
      all(v is None for v in slot8), str(slot8[:3]))
check("and its effect column is None too", all(v is None for v in wide["reason_8_effect"]))

# ── regression works the same way ─────────────────────────────────────────
yr = (50 + 2.5 * df.tenure - 0.8 * df.tickets + rng.normal(0, 8, N)).astype(float)
reg = Pipeline([("model", LinearRegression())])
reg.fit(prep(df), yr)
rr = _reason_codes(ART, df, reg, prep, "regression", None, 2, 50, warnings_)
check("regression rows get reason codes too", rr is not None and len(rr) == N)
rcols = _reason_frame(rr, 2)
top = [x for x in rcols["reason_1"] if x is not None]
check("and the strongest driver is one the model actually uses",
      set(top) <= set(FEATS) and len(set(top)) >= 1, str(sorted(set(top))))
# The data was generated with tenure the largest coefficient, so it should
# dominate — a weak check on the DIRECTION of the whole mechanism.
check("tenure dominates, as the generating process says it should",
      top.count("tenure") > len(top) * 0.5, f"{top.count('tenure')}/{len(top)}")

print("PROBE", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
