"""Run the REAL cross-validation code from TRAIN_PY and check what it claims.

Compiling proves syntax. This proves the behaviour the interface asserts on its
behalf, and one claim in particular that is the whole point of the change:

  SELECTING ON THE HOLDOUT INFLATES THE REPORTED SCORE. The old trainer fitted
  every candidate on the training rows, scored each on the holdout, kept the
  best of those scores, and published it. That is the maximum of a dozen noisy
  estimates. Here that bias is MEASURED — by running both schemes over many
  seeds on data where the candidates are genuinely equivalent, so any gap is
  selection noise and nothing else — rather than asserted in a comment.

  node -e "const s=require('fs').readFileSync('src/utils/ml/pyTrain.ts','utf8');const a=s.indexOf('String.raw`')+11;require('fs').writeFileSync('/tmp/train_py.py',s.slice(a,s.indexOf('`;',a)))"
  docker run --rm -v /tmp:/work --entrypoint python \
    agentswarms/notebook-runtime:latest /work/crossValidationProbe.py
"""

import sys

import numpy as np
from sklearn.datasets import make_classification, make_regression
from sklearn.dummy import DummyClassifier
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.tree import DecisionTreeClassifier

ns = {"__name__": "trainpy"}
exec(open("/work/train_py.py", encoding="utf-8").read(), ns)  # noqa: S102
_cv_plan = ns["_cv_plan"]
_cv_splits = ns["_cv_splits"]
_cv_score = ns["_cv_score"]

ok = True


def check(label, cond, detail=""):
    global ok
    print(f"{'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not cond:
        ok = False


# ── the plan reacts to the size of the HOLDOUT, not the training set ───────
big = _cv_plan("classification", 40000, 10000, False, 5000, 2000)
check("a large holdout does not pay for k folds", big["strategy"] == "inner_split", big["strategy"])
small = _cv_plan("classification", 800, 200, False, 400, 2000)
check("a small holdout cross-validates", small["strategy"] == "stratified", small["strategy"])
check("and picks 5 folds when there are rows for it", small["folds"] == 5, str(small["folds"]))
tiny = _cv_plan("regression", 120, 30, False, 0, 2000)
check("a tiny training set drops to 3 folds", tiny["strategy"] == "kfold" and tiny["folds"] == 3,
      f"{tiny['strategy']}/{tiny['folds']}")
rare = _cv_plan("classification", 800, 200, False, 3, 2000)
check("folds cannot exceed the rarest class", rare["folds"] == 3, str(rare["folds"]))
single = _cv_plan("classification", 800, 200, False, 1, 2000)
check("a class with one example cannot be folded at all", single["strategy"] == "inner_split",
      single["strategy"])
ts = _cv_plan("regression", 5000, 100, True, 0, 2000)
check("ordered rows always split in time", ts["strategy"] == "timeseries", ts["strategy"])
ts_big = _cv_plan("regression", 5000, 99999, True, 0, 2000)
check("and time order beats a big holdout", ts_big["strategy"] == "timeseries", ts_big["strategy"])
check("every plan explains itself", all(p["reason"] for p in [big, small, tiny, rare, single, ts]))

# ── the splitter is something sklearn accepts, with the right fold count ───
y_cls = np.array([0] * 60 + [1] * 40)
for plan, want in [
    ({"strategy": "stratified", "folds": 5}, 5),
    ({"strategy": "kfold", "folds": 3}, 3),
    ({"strategy": "timeseries", "folds": 4}, 4),
    ({"strategy": "inner_split", "folds": 1}, 1),
]:
    sp = _cv_splits("classification", plan, y_cls)
    n = len(list(sp)) if isinstance(sp, list) else sp.get_n_splits()
    check(f"{plan['strategy']} yields {want} fold(s)", n == want, str(n))

# a single inner split must not overlap, and must cover held-out rows
sp = _cv_splits("classification", {"strategy": "inner_split", "folds": 1}, y_cls)
tr, te = list(sp)[0]
check("the inner split does not train on what it scores", len(set(tr) & set(te)) == 0)
check("and holds back a real slice", 0.15 < len(te) / len(y_cls) < 0.35, f"{len(te)/len(y_cls):.2f}")

# ── time-series folds never score the past with the future ────────────────
sp = _cv_splits("regression", {"strategy": "timeseries", "folds": 4}, np.arange(200.0))
# A splitter object is not itself iterable — sklearn calls .split() on it, and
# so must anything checking what it produces.
folds = list(sp.split(np.zeros((200, 1))))
check("time-series produces every fold it promised", len(folds) == 4, str(len(folds)))
check("every time fold trains strictly before it scores",
      all(max(tr) < min(te) for tr, te in folds),
      " | ".join(f"{max(tr)}<{min(te)}" for tr, te in folds))
check("and each fold trains on more history than the last",
      [len(tr) for tr, _ in folds] == sorted(len(tr) for tr, _ in folds),
      str([len(tr) for tr, _ in folds]))

# ── the score is an RMSE for regression, not a negative ───────────────────
Xr, yr = make_regression(n_samples=400, n_features=8, noise=12.0, random_state=0)
ridge = Pipeline([("model", Ridge())])
plan_r = {"strategy": "kfold", "folds": 5}
res = _cv_score(ridge, Xr, yr, _cv_splits("regression", plan_r, yr), "regression")
check("regression folds report positive RMSE", all(v > 0 for v in res["scores"]), str(res["scores"][:3]))
check("and a mean that matches the folds", abs(res["mean"] - float(np.mean(res["scores"]))) < 1e-4)
check("and a spread over more than one fold", res["std"] > 0, f"std {res['std']}")

Xc, yc = make_classification(n_samples=400, n_features=8, n_informative=4, random_state=0)
logit = Pipeline([("model", LogisticRegression(max_iter=500))])
res_c = _cv_score(logit, Xc, yc, _cv_splits("classification", {"strategy": "stratified", "folds": 5}, yc),
                  "classification")
check("classification folds report F1 in [0,1]", all(0 <= v <= 1 for v in res_c["scores"]), str(res_c["scores"][:3]))

# a single-fold plan reports no spread rather than a fake one
res_1 = _cv_score(logit, Xc, yc, _cv_splits("classification", {"strategy": "inner_split", "folds": 1}, yc),
                  "classification")
check("one fold reports zero spread, not a fabricated one", res_1["std"] == 0.0 and len(res_1["scores"]) == 1)

# ── THE POINT: selecting on the holdout inflates the published number ──────
# Candidates that are genuinely equivalent on this data, so the "best" of them
# differs from the rest only by noise. Whatever gap appears between the score
# a scheme PUBLISHES and the score the winner truly gets on fresh rows is
# selection bias, measured.
def one_trial(seed):
    X, y = make_classification(n_samples=400, n_features=10, n_informative=3,
                               flip_y=0.35, random_state=seed)
    Xd, Xtest, yd, ytest = train_test_split(X, y, test_size=0.5,
                                            random_state=seed, stratify=y)
    Xtr, Xva, ytr, yva = train_test_split(Xd, yd, test_size=0.2, random_state=seed, stratify=yd)
    cands = [
        ("logit", Pipeline([("model", LogisticRegression(max_iter=500))])),
        ("tree3", Pipeline([("model", DecisionTreeClassifier(max_depth=3, random_state=seed))])),
        ("tree5", Pipeline([("model", DecisionTreeClassifier(max_depth=5, random_state=seed))])),
        ("tree7", Pipeline([("model", DecisionTreeClassifier(max_depth=7, random_state=seed))])),
        ("dummy", Pipeline([("model", DummyClassifier(strategy="stratified", random_state=seed))])),
    ]
    from sklearn import metrics as M

    def truth(pipe):
        pipe.fit(Xtr, ytr)
        return float(M.f1_score(ytest, pipe.predict(Xtest), average="macro", zero_division=0))

    # OLD: score every candidate on the holdout, keep the best, publish it.
    old = []
    for _, pipe in cands:
        from sklearn.base import clone
        q = clone(pipe)
        q.fit(Xtr, ytr)
        old.append(float(M.f1_score(yva, q.predict(Xva), average="macro", zero_division=0)))
    i_old = int(np.argmax(old))
    old_published, old_real = old[i_old], truth(cands[i_old][1])

    # NEW: score by CV inside the training rows, publish the untouched holdout.
    splits = _cv_splits("classification", {"strategy": "stratified", "folds": 5}, ytr)
    new = [_cv_score(pipe, Xtr, ytr, splits, "classification")["mean"] for _, pipe in cands]
    i_new = int(np.argmax(new))
    from sklearn.base import clone
    w = clone(cands[i_new][1])
    w.fit(Xtr, ytr)
    new_published = float(M.f1_score(yva, w.predict(Xva), average="macro", zero_division=0))
    new_real = truth(cands[i_new][1])
    return old_published - old_real, new_published - new_real


gaps = [one_trial(s) for s in range(30)]
old_bias = float(np.mean([g[0] for g in gaps]))
new_bias = float(np.mean([g[1] for g in gaps]))
print(f"  published minus true, over 30 seeds:  selecting on the holdout {old_bias:+.4f}   "
      f"selecting by CV {new_bias:+.4f}")
check("selecting on the holdout publishes a number that is too high", old_bias > 0.01,
      f"{old_bias:+.4f}")
check("selecting by CV publishes a much less biased number", new_bias < old_bias,
      f"{new_bias:+.4f} vs {old_bias:+.4f}")

print("PROBE", "OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
