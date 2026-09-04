// The program that trains AND predicts inside a batch sandbox.
//
// One Python module, kept here as a string so the server can pin it into a
// session bundle exactly like an ETL script: prelude (env + pip) + the
// lakehouse attach helper + this program + the job configuration. The
// configuration arrives as a base64 JSON literal appended by the server, never
// as interpolated code, so a column called `'); import os` is just a column.
// `entrypoint(inputs)` dispatches on `_ML_CONFIG['mode']`: "train" (default)
// or "predict". Both live in one module on purpose: the feature preparation a
// prediction applies must be byte-for-byte the one training used.
//
// Design rules the program follows, and why:
//   - No custom classes end up inside the artifact. joblib pickles a class
//     defined in an exec'd namespace by reference to a module that does not
//     exist at load time. Datetime expansion is therefore a plain function
//     applied to the frame before the sklearn pipeline, re-run at prediction.
//   - The model is chosen by a holdout score under a wall-clock budget: each
//     candidate is skipped, not aborted, once the budget is spent, so a slow
//     machine still returns the best model it managed rather than nothing.
//     Tuning (RandomizedSearchCV on the best candidates) runs only while at
//     least 40% of the budget remains.
//   - Data preparation is declarative (a WHERE clause or a SELECT, imputation
//     and encoding choices, class weighting, target clipping) and is pinned
//     into the version, so what the model learned from can be stated later.
//   - Feature importance is permutation importance on the raw input columns,
//     so it names the columns a person recognises, not one-hot fragments.
//   - The artifact goes to object storage under ml-artifacts/, OUTSIDE the
//     lakehouse data path, so DuckLake's orphan-file cleanup can never delete
//     a model. Only the URI, SHA-256 and metrics travel back as JSON.
//   - Prediction refuses an artifact whose bytes do not hash to the digest
//     the registry recorded: a swapped file cannot serve as the model.
//
// String.raw: backslashes in the Python survive; the program must not contain
// a backtick or the two characters "$" + "{".
export const TRAIN_PY = String.raw`
# ── AgentSwarms ML trainer / predictor ───────────────────────────────────────
import os, io, sys, json, time, math, base64, hashlib, warnings, traceback, subprocess
import re as _re

warnings.filterwarnings('ignore')
_T0 = time.time()
_MAX_CATEGORIES = 200
_ID_NAME = _re.compile(r'(^|_)(id|uuid|guid|key|code)$|^id$', _re.I)
_DT_PARTS = ('__year', '__month', '__day', '__dow', '__hour')
_ML_PACKAGES = ['scikit-learn>=1.4', 'lightgbm>=4.0', 'statsmodels>=0.14', 'duckdb>=1.4',
                'pyarrow>=15', 's3fs>=2024.2', 'joblib>=1.3', 'scipy>=1.11']


def _log(msg):
    print('[ml] ' + str(msg), flush=True)


def _elapsed():
    return time.time() - _T0


def _ensure_packages():
    # The runtime image bakes the ML stack; an older image installs it here.
    # Checking imports first keeps a baked image from spending 15s asking pip.
    missing = []
    for mod in ('sklearn', 'lightgbm', 'statsmodels', 'duckdb', 'pyarrow', 's3fs', 'joblib', 'scipy'):
        try:
            __import__(mod)
        except Exception:
            missing.append(mod)
    if not missing:
        return
    _log('installing the ML stack (%s missing)' % ', '.join(missing))
    p = subprocess.run([sys.executable, '-m', 'pip', 'install', '--user', '--no-input', '-q', *_ML_PACKAGES],
                       capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stdout[-2000:], p.stderr[-2000:])
        raise RuntimeError('pip install of the ML stack failed - see the output above')
    import site as _site
    _site.addsitedir(_site.getusersitepackages())
    import importlib as _il
    _il.invalidate_caches()


def _q(ident):
    return '"' + str(ident).replace('"', '""') + '"'


def _safe_float(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except Exception:
        return None


def _jsonable_cell(v):
    try:
        import numpy as np
        import pandas as pd
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            return _safe_float(v)
        if isinstance(v, (np.bool_,)):
            return bool(v)
        if isinstance(v, (pd.Timestamp,)):
            return v.isoformat()
        if pd.isna(v):
            return None
    except Exception:
        pass
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


# ── Reading the training frame ───────────────────────────────────────────────
def _source_sql(cfg):
    src = cfg['source']
    rel = _q(src['schema']) + '.' + _q(src['table'])
    prep = cfg.get('prep') or {}
    if prep.get('sql'):
        return '(' + prep['sql'].strip().rstrip(';') + ') AS _prep'
    if prep.get('where'):
        return rel + ' WHERE (' + prep['where'].strip() + ')'
    return rel


def _read_frame(con, cfg):
    import pandas as pd
    body = _source_sql(cfg)
    total = int(con.execute('SELECT count(*) FROM ' + body).fetchone()[0])
    max_rows = int(cfg.get('max_rows') or 0)
    sql = 'SELECT * FROM ' + body
    sampled = False
    if max_rows and total > max_rows:
        if cfg['task'] == 'forecast':
            raise RuntimeError(
                'The series has %d rows, above the %d-row training limit. Aggregate it to one row '
                'per period first, or raise the ML training row limit under Admin -> Developer runtime.'
                % (total, max_rows)
            )
        sql += ' USING SAMPLE reservoir(%d ROWS) REPEATABLE (42)' % max_rows
        sampled = True
    _log('reading %s (%d rows%s)' % (body[:120], total, ', sampled to %d' % max_rows if sampled else ''))
    df = con.execute(sql).df()
    for c in (cfg.get('prep') or {}).get('drop_columns') or []:
        if c in df.columns and c != cfg['target_column']:
            df = df.drop(columns=[c])
    return df, total, sampled


# ── Column planning ──────────────────────────────────────────────────────────
def _dtype_of(s):
    import pandas as pd
    if pd.api.types.is_bool_dtype(s):
        return 'boolean'
    if pd.api.types.is_datetime64_any_dtype(s):
        return 'datetime'
    if pd.api.types.is_numeric_dtype(s):
        return 'numeric'
    nun = s.nunique(dropna=True)
    return 'categorical' if nun <= _MAX_CATEGORIES else 'text'


def _plan_columns(df, cfg):
    import pandas as pd
    target = cfg['target_column']
    tcol = cfg.get('time_column')
    wanted = cfg.get('feature_columns') or None
    schema, features = [], []
    n = max(1, len(df))
    for c in df.columns:
        s = df[c]
        if c == target:
            schema.append({'name': c, 'dtype': _dtype_of(s), 'role': 'target'})
            continue
        if tcol and c == tcol:
            schema.append({'name': c, 'dtype': 'datetime', 'role': 'time'})
            continue
        if wanted is not None and c not in wanted:
            schema.append({'name': c, 'dtype': _dtype_of(s), 'role': 'dropped', 'reason': 'not selected'})
            continue
        if s.isna().all():
            schema.append({'name': c, 'dtype': 'text', 'role': 'dropped', 'reason': 'every value is missing'})
            continue
        d = _dtype_of(s)
        entry = {'name': c, 'dtype': d, 'role': 'feature'}
        if d in ('categorical', 'text'):
            nun = int(s.nunique(dropna=True))
            if d == 'text' or (nun > 20 and (nun >= 0.9 * n or _ID_NAME.search(str(c)))):
                entry['role'] = 'dropped'
                entry['reason'] = 'identifier-like: %d distinct values in %d rows' % (nun, n)
            else:
                entry['categories'] = [str(v) for v in s.dropna().astype(str).value_counts().index[:_MAX_CATEGORIES]]
        elif d == 'numeric':
            nun = int(s.nunique(dropna=True))
            is_int = pd.api.types.is_integer_dtype(s)
            if nun > 20 and (_ID_NAME.search(str(c)) or (is_int and nun >= 0.9 * n)):
                entry['role'] = 'dropped'
                entry['reason'] = 'identifier-like: %d distinct values in %d rows' % (nun, n)
                schema.append(entry)
                continue
            entry['min'] = _safe_float(s.min())
            entry['max'] = _safe_float(s.max())
            entry['median'] = _safe_float(s.median())
            if s.nunique(dropna=True) <= 1:
                entry['role'] = 'dropped'
                entry['reason'] = 'constant'
        schema.append(entry)
        if entry['role'] == 'feature':
            features.append(c)
    if not features:
        raise RuntimeError('No usable feature columns: every column is the target, an identifier, constant or empty.')
    return schema, features


def _expand_datetimes(X, dt_cols):
    import pandas as pd
    for c in dt_cols:
        d = pd.to_datetime(X[c], errors='coerce')
        X[c + '__year'] = d.dt.year
        X[c + '__month'] = d.dt.month
        X[c + '__day'] = d.dt.day
        X[c + '__dow'] = d.dt.dayofweek
        X[c + '__hour'] = d.dt.hour
        X = X.drop(columns=[c])
    return X


def _prepare_x(df, features, dt_cols, num_all, cat):
    import numpy as np
    import pandas as pd
    X = df.copy()
    for f in features:
        if f not in X.columns:
            X[f] = np.nan
    X = X[features]
    if dt_cols:
        X = _expand_datetimes(X, dt_cols)
    for c in num_all:
        X[c] = pd.to_numeric(X[c], errors='coerce').astype('float64')
    for c in cat:
        X[c] = X[c].astype('string').fillna('missing').astype(str)
    return X[num_all + cat]


def _build_preprocessor(schema, features, prep):
    from sklearn.compose import ColumnTransformer
    from sklearn.pipeline import Pipeline
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler
    by = {e['name']: e for e in schema}
    dt_cols = [f for f in features if by[f]['dtype'] == 'datetime']
    num = [f for f in features if by[f]['dtype'] in ('numeric', 'boolean')]
    cat = [f for f in features if by[f]['dtype'] == 'categorical']
    num_all = num + [c + suf for c in dt_cols for suf in _DT_PARTS]
    impute = (prep or {}).get('impute') or {}
    num_strategy = impute.get('numeric', 'median')
    cat_strategy = impute.get('categorical', 'most_frequent')
    transformers = []
    if num_all:
        steps = []
        if num_strategy == 'constant':
            steps.append(('impute', SimpleImputer(strategy='constant', fill_value=0.0)))
        else:
            steps.append(('impute', SimpleImputer(strategy=num_strategy if num_strategy in ('median', 'mean') else 'median')))
        if (prep or {}).get('scale', True):
            steps.append(('scale', StandardScaler()))
        transformers.append(('num', Pipeline(steps), num_all))
    if cat:
        enc = ((prep or {}).get('encoding') or 'onehot')
        encoder = (OrdinalEncoder(handle_unknown='use_encoded_value', unknown_value=-1)
                   if enc == 'ordinal'
                   else OneHotEncoder(handle_unknown='ignore', min_frequency=5, sparse_output=False))
        imp = (SimpleImputer(strategy='constant', fill_value='missing') if cat_strategy == 'constant'
               else SimpleImputer(strategy='most_frequent'))
        transformers.append(('cat', Pipeline([('impute', imp), ('encode', encoder)]), cat))
    prepro = ColumnTransformer(transformers, remainder='drop', sparse_threshold=0)
    return prepro, dt_cols, num_all, cat


# ── Candidates and tuning ────────────────────────────────────────────────────
def _candidates(task, prep):
    balanced = (prep or {}).get('class_weight') == 'balanced' and task == 'classification'
    cw = 'balanced' if balanced else None
    cands = []
    if task == 'classification':
        from sklearn.linear_model import LogisticRegression
        from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
        cands.append(('logistic_regression', lambda: LogisticRegression(max_iter=2000, class_weight=cw)))
        cands.append(('random_forest', lambda: RandomForestClassifier(n_estimators=200, n_jobs=-1, random_state=42, class_weight=cw)))
        cands.append(('hist_gradient_boosting', lambda: HistGradientBoostingClassifier(random_state=42, class_weight=cw)))
        try:
            from lightgbm import LGBMClassifier
            cands.append(('lightgbm', lambda: LGBMClassifier(n_estimators=400, learning_rate=0.05, random_state=42, verbose=-1, class_weight=cw)))
        except Exception as e:
            _log('lightgbm unavailable (%s); continuing without it' % str(e)[:120])
    else:
        from sklearn.linear_model import Ridge
        from sklearn.ensemble import RandomForestRegressor, HistGradientBoostingRegressor
        cands.append(('ridge', lambda: Ridge(alpha=1.0)))
        cands.append(('random_forest', lambda: RandomForestRegressor(n_estimators=200, n_jobs=-1, random_state=42)))
        cands.append(('hist_gradient_boosting', lambda: HistGradientBoostingRegressor(random_state=42)))
        try:
            from lightgbm import LGBMRegressor
            cands.append(('lightgbm', lambda: LGBMRegressor(n_estimators=400, learning_rate=0.05, random_state=42, verbose=-1)))
        except Exception as e:
            _log('lightgbm unavailable (%s); continuing without it' % str(e)[:120])
    return cands


def _search_space(name):
    if name == 'random_forest':
        return {'model__n_estimators': [100, 200, 400], 'model__max_depth': [None, 6, 12, 20],
                'model__min_samples_leaf': [1, 2, 5, 10], 'model__max_features': ['sqrt', 0.5, None]}
    if name == 'hist_gradient_boosting':
        return {'model__learning_rate': [0.03, 0.06, 0.1, 0.2], 'model__max_leaf_nodes': [15, 31, 63],
                'model__l2_regularization': [0.0, 0.1, 1.0], 'model__max_iter': [100, 200, 400]}
    if name == 'lightgbm':
        return {'model__n_estimators': [200, 400, 800], 'model__num_leaves': [15, 31, 63],
                'model__learning_rate': [0.02, 0.05, 0.1], 'model__min_child_samples': [10, 20, 40],
                'model__subsample': [0.7, 1.0], 'model__colsample_bytree': [0.7, 1.0]}
    if name == 'logistic_regression':
        return {'model__C': [0.1, 0.3, 1.0, 3.0, 10.0]}
    if name == 'ridge':
        return {'model__alpha': [0.1, 0.3, 1.0, 3.0, 10.0, 30.0]}
    return None


def _tune(task, ranked, prep, Xtr, ytr, Xva, yva, budget, mode, leaderboard, warnings_):
    # ranked: [(name, pipeline, score)] best first. Tune the top two while
    # at least 40% of the budget remains; each search is capped so one slow
    # estimator cannot eat the rest.
    from sklearn.model_selection import RandomizedSearchCV
    n_iter, cv = (6, 3) if mode == 'quick' else (20, 5)
    higher = task == 'classification'
    metric = 'f1_macro' if higher else 'rmse'
    scoring = 'f1_macro' if higher else 'neg_root_mean_squared_error'
    best_tuned = None
    trials = 0
    for name, pipe, base_score in ranked[:2]:
        space = _search_space(name)
        if not space:
            continue
        if _elapsed() > budget * 0.6:
            warnings_.append('Skipped tuning %s: the time budget was spent.' % name)
            leaderboard.append({'algorithm': name + ' (tuned)', 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            continue
        t0 = time.time()
        try:
            search = RandomizedSearchCV(pipe, space, n_iter=n_iter, cv=cv, scoring=scoring, random_state=42, n_jobs=1, refit=True)
            search.fit(Xtr, ytr)
            trials += len(search.cv_results_['mean_test_score'])
            tuned = search.best_estimator_
            score = _primary(task, tuned, Xva, yva)
            params = {k.replace('model__', ''): (v if isinstance(v, (int, float, str, bool)) or v is None else str(v))
                      for k, v in search.best_params_.items()}
            leaderboard.append({'algorithm': name + ' (tuned)', 'metric': metric, 'value': _safe_float(score), 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'ok',
                                'note': 'best of %d trials: %s' % (n_iter, json.dumps(params, sort_keys=True))})
            _log('%s tuned: %s=%.4f in %.1fs (%d trials)' % (name, metric, score, time.time() - t0, n_iter))
            better_than_base = score > base_score if higher else score < base_score
            if better_than_base and (best_tuned is None or (score > best_tuned[2] if higher else score < best_tuned[2])):
                best_tuned = (name + ' (tuned)', tuned, score, params)
        except Exception as e:
            leaderboard.append({'algorithm': name + ' (tuned)', 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('tuning %s failed: %s' % (name, str(e)[:200]))
    return best_tuned, trials


def _primary(task, model, Xva, yva):
    import numpy as np
    from sklearn import metrics as M
    pred = model.predict(Xva)
    if task == 'classification':
        return float(M.f1_score(yva, pred, average='macro', zero_division=0))
    return float(np.sqrt(M.mean_squared_error(yva, pred)))


def _full_metrics(task, model, Xva, yva, classes):
    import numpy as np
    from sklearn import metrics as M
    pred = model.predict(Xva)
    out = {}
    if task == 'classification':
        out['accuracy'] = M.accuracy_score(yva, pred)
        out['f1_macro'] = M.f1_score(yva, pred, average='macro', zero_division=0)
        out['precision_macro'] = M.precision_score(yva, pred, average='macro', zero_division=0)
        out['recall_macro'] = M.recall_score(yva, pred, average='macro', zero_division=0)
        proba = model.predict_proba(Xva) if hasattr(model, 'predict_proba') else None
        if proba is not None:
            try:
                if len(classes) == 2:
                    out['roc_auc'] = M.roc_auc_score(yva, proba[:, 1])
                else:
                    out['roc_auc'] = M.roc_auc_score(yva, proba, multi_class='ovr', average='macro')
                out['log_loss'] = M.log_loss(yva, proba, labels=list(range(len(classes))))
            except Exception:
                pass
        if len(classes) <= 20:
            cm = M.confusion_matrix(yva, pred, labels=list(range(len(classes))))
            out['confusion_matrix'] = {'labels': list(classes), 'matrix': cm.tolist()}
    else:
        yva = np.asarray(yva, dtype='float64')
        out['rmse'] = float(np.sqrt(M.mean_squared_error(yva, pred)))
        out['mae'] = M.mean_absolute_error(yva, pred)
        out['median_ae'] = M.median_absolute_error(yva, pred)
        out['r2'] = M.r2_score(yva, pred) if len(yva) > 1 else None
        mask = yva != 0
        out['mape'] = float(np.mean(np.abs((yva[mask] - pred[mask]) / yva[mask])) * 100) if mask.any() else None
    return {k: (v if isinstance(v, dict) else _safe_float(v)) for k, v in out.items()}


def _importance(model, Xva, yva, task, dt_cols):
    import numpy as np
    from sklearn.inspection import permutation_importance
    n = min(len(Xva), 3000)
    Xs = Xva.iloc[:n]
    ys = np.asarray(yva)[:n]
    scoring = 'f1_macro' if task == 'classification' else 'neg_root_mean_squared_error'
    r = permutation_importance(model, Xs, ys, n_repeats=3, random_state=42, scoring=scoring, n_jobs=1)
    cols = list(Xs.columns)
    merged = {}
    for i, c in enumerate(cols):
        name = c
        for d in dt_cols:
            if c.startswith(d + '__'):
                name = d
        m = merged.setdefault(name, [0.0, 0.0])
        m[0] += float(r.importances_mean[i])
        m[1] = max(m[1], float(r.importances_std[i]))
    out = [{'feature': k, 'importance': _safe_float(v[0]) or 0.0, 'std': _safe_float(v[1]) or 0.0} for k, v in merged.items()]
    out.sort(key=lambda d: -d['importance'])
    return out[:40]


# ── Tabular training ─────────────────────────────────────────────────────────
def _train_tabular(df, cfg, warnings_):
    import numpy as np
    import pandas as pd
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    import joblib
    task = cfg['task']
    target = cfg['target_column']
    prep = cfg.get('prep') or {}
    tuning = cfg.get('tuning') or 'none'
    budget = float(cfg.get('time_budget_minutes') or 30) * 60.0
    frac = float(cfg.get('validation_fraction') or 0.2)

    df = df[df[target].notna()].copy()
    if len(df) < 20:
        raise RuntimeError('Only %d rows have a value in %s; at least 20 are needed to train.' % (len(df), target))
    schema, features = _plan_columns(df, cfg)
    for e in [e for e in schema if e['role'] == 'dropped' and e.get('reason') != 'not selected']:
        warnings_.append('Dropped column %s: %s' % (e['name'], e['reason']))
    prepro, dt_cols, num_all, cat = _build_preprocessor(schema, features, prep)
    X = _prepare_x(df, features, dt_cols, num_all, cat)

    classes = None
    if task == 'classification':
        y_raw = df[target].astype(str)
        classes = sorted(y_raw.unique().tolist())
        if len(classes) < 2:
            raise RuntimeError('The target %s has a single class; classification needs at least two.' % target)
        if len(classes) > 100:
            raise RuntimeError('The target %s has %d distinct values; that is a regression target or an identifier, not a class label.' % (target, len(classes)))
        index = {c: i for i, c in enumerate(classes)}
        y = y_raw.map(index).to_numpy()
        counts = pd.Series(y).value_counts()
        stratify = y if counts.min() >= 2 else None
        if stratify is None:
            warnings_.append('Some classes have a single example; the holdout could not be stratified.')
        if prep.get('class_weight') == 'balanced':
            warnings_.append('Classes were weighted inversely to their frequency (balanced).')
    else:
        y = pd.to_numeric(df[target], errors='coerce').to_numpy(dtype='float64')
        keep = ~np.isnan(y)
        if keep.sum() < len(y):
            warnings_.append('%d rows had a non-numeric target and were dropped.' % int((~keep).sum()))
            X, y = X[keep], y[keep]
        clip = prep.get('target_clip')
        if clip and len(clip) == 2:
            lo, hi = np.percentile(y, [float(clip[0]), float(clip[1])])
            n_clipped = int(((y < lo) | (y > hi)).sum())
            y = np.clip(y, lo, hi)
            warnings_.append('Target clipped to the %s-%s percentile range [%.4g, %.4g]; %d rows affected.' % (clip[0], clip[1], lo, hi, n_clipped))
        stratify = None

    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=frac, random_state=42, stratify=stratify)
    _log('training on %d rows, validating on %d (%d features)' % (len(Xtr), len(Xva), len(features)))

    leaderboard, ranked = [], []
    higher = task == 'classification'
    metric = 'f1_macro' if higher else 'rmse'
    for name, make in _candidates(task, prep):
        if leaderboard and _elapsed() > budget * 0.85:
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            warnings_.append('Skipped %s: the time budget was spent.' % name)
            continue
        t0 = time.time()
        try:
            pipe = Pipeline([('prep', prepro), ('model', make())])
            pipe.fit(Xtr, ytr)
            score = _primary(task, pipe, Xva, yva)
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': _safe_float(score), 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'ok'})
            _log('%s: %s=%.4f in %.1fs' % (name, metric, score, time.time() - t0))
            ranked.append((name, pipe, score))
        except Exception as e:
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('%s failed: %s' % (name, str(e)[:200]))
    if not ranked:
        raise RuntimeError('Every candidate failed to train. First error: ' + str(leaderboard[0].get('note', 'unknown')))
    ranked.sort(key=lambda r: -r[2] if higher else r[2])
    best_name, best, best_score = ranked[0]
    tuning_info = {'mode': tuning, 'trials': 0}
    if tuning in ('quick', 'thorough'):
        tuned, trials = _tune(task, ranked, prep, Xtr, ytr, Xva, yva, budget, tuning, leaderboard, warnings_)
        tuning_info['trials'] = trials
        if tuned:
            best_name, best, best_score, params = tuned
            tuning_info['best_params'] = params
    leaderboard.sort(key=lambda r: (r['status'] != 'ok', -(r['value'] or -1e18) if higher else (r['value'] if r['value'] is not None else 1e18)))

    metrics = _full_metrics(task, best, Xva, yva, classes or [])
    metrics['tuning_trials'] = float(tuning_info['trials'])
    try:
        importance = _importance(best, Xva, yva, task, dt_cols)
    except Exception as e:
        importance = []
        warnings_.append('Feature importance unavailable: ' + str(e)[:160])

    payload = {
        'task': task, 'algorithm': best_name, 'pipeline': best, 'target': target,
        'features': features, 'dt_cols': dt_cols, 'num_all': num_all, 'cat': cat,
        'classes': classes, 'schema': schema, 'prep': prep, 'trainer_version': 2,
    }
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    return {
        'task': task, 'algorithm': best_name, 'metrics': metrics, 'primary_metric': metric,
        'leaderboard': leaderboard, 'feature_importance': importance, 'feature_schema': schema,
        'classes': classes, 'training_rows': int(len(Xtr)), 'holdout_rows': int(len(Xva)),
        'tuning': tuning_info, '_artifact': buf.getvalue(),
    }


# ── Forecasting ──────────────────────────────────────────────────────────────
_SEASON = {'h': 24, 'D': 7, 'W': 52, 'MS': 12, 'QS': 4, 'YS': 1}


def _infer_freq(ts):
    d = ts.sort_values().drop_duplicates().diff().dropna()
    if d.empty:
        return 'D'
    days = d.median().total_seconds() / 86400.0
    if days < 0.9:
        return 'h'
    if days < 1.5:
        return 'D'
    if days < 10:
        return 'W'
    if days < 45:
        return 'MS'
    if days < 120:
        return 'QS'
    return 'YS'


def _period_label(ts, freq):
    return ts.strftime('%Y-%m-%dT%H:00') if freq == 'h' else ts.strftime('%Y-%m-%d')


def _lag_frame(y, lags):
    import numpy as np
    import pandas as pd
    X = pd.DataFrame({'lag_%d' % k: y.shift(k).to_numpy() for k in range(1, lags + 1)})
    X['t'] = np.arange(len(y), dtype='float64')
    return X


def _lag_forecast(model, history, lags, steps, t_start):
    import numpy as np
    import pandas as pd
    hist = list(history)
    out = []
    for i in range(steps):
        row = {'lag_%d' % k: hist[-k] for k in range(1, lags + 1)}
        row['t'] = float(t_start + i)
        yhat = float(model.predict(pd.DataFrame([row]))[0])
        out.append(yhat)
        hist.append(yhat)
    return np.array(out)


def _train_forecast(df, cfg, warnings_):
    import numpy as np
    import pandas as pd
    import joblib
    tcol, target = cfg['time_column'], cfg['target_column']
    horizon = int(cfg.get('horizon') or 12)
    agg = cfg.get('aggregation') or 'sum'
    budget = float(cfg.get('time_budget_minutes') or 30) * 60.0
    s = df[[tcol, target]].copy()
    s[tcol] = pd.to_datetime(s[tcol], errors='coerce')
    s[target] = pd.to_numeric(s[target], errors='coerce')
    s = s.dropna()
    if len(s) < 8:
        raise RuntimeError('Forecasting needs at least 8 dated rows with a numeric target; found %d.' % len(s))
    freq = _infer_freq(s[tcol])
    g = s.groupby(pd.Grouper(key=tcol, freq=freq))[target]
    y = (g.sum() if agg == 'sum' else g.mean()).astype('float64').asfreq(freq)
    gaps = int(y.isna().sum())
    if gaps:
        warnings_.append('%d empty period(s) were filled by interpolation.' % gaps)
        y = y.interpolate(limit_direction='both')
    if len(y) < 8:
        raise RuntimeError('After aggregating to one value per %s period only %d periods remain; at least 8 are needed.' % (freq, len(y)))
    season = _SEASON.get(freq)
    if season and season > 1 and len(y) < 2 * season + 2:
        warnings_.append('Not enough history for a %d-period season; seasonality was not modelled.' % season)
        season = None
    if season == 1:
        season = None
    holdout = max(1, min(horizon, len(y) // 5))
    train, test = y.iloc[:-holdout], y.iloc[-holdout:]
    _log('series: %d periods at %s, season=%s, holdout=%d, horizon=%d' % (len(y), freq, season, holdout, horizon))

    leaderboard, best = [], None
    lags = int(max(1, min(season or 7, max(1, len(train) // 3))))

    def rmse(a, b):
        return float(np.sqrt(np.mean((np.asarray(a, dtype='float64') - np.asarray(b, dtype='float64')) ** 2)))

    def consider(name, fit):
        nonlocal best
        if leaderboard and _elapsed() > budget * 0.85:
            leaderboard.append({'algorithm': name, 'metric': 'rmse', 'value': None, 'higher_is_better': False, 'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            return
        t0 = time.time()
        try:
            pred = fit(train, len(test))
            score = rmse(test.to_numpy(), pred)
            leaderboard.append({'algorithm': name, 'metric': 'rmse', 'value': _safe_float(score), 'higher_is_better': False, 'fit_seconds': round(time.time() - t0, 2), 'status': 'ok'})
            _log('%s: rmse=%.4f' % (name, score))
            if best is None or score < best[1]:
                best = (name, score, fit)
        except Exception as e:
            leaderboard.append({'algorithm': name, 'metric': 'rmse', 'value': None, 'higher_is_better': False, 'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('%s failed: %s' % (name, str(e)[:200]))

    def naive(tr, steps):
        return np.repeat(float(tr.iloc[-1]), steps)

    def seasonal_naive(tr, steps):
        base = tr.to_numpy()[-season:]
        return np.array([base[i % season] for i in range(steps)])

    def holt_winters(tr, steps):
        from statsmodels.tsa.holtwinters import ExponentialSmoothing
        kw = {'trend': 'add', 'damped_trend': True}
        if season:
            kw['seasonal'] = 'add'
            kw['seasonal_periods'] = season
        fit = ExponentialSmoothing(tr, **kw).fit(optimized=True)
        return np.asarray(fit.forecast(steps), dtype='float64')

    def lag_model(tr, steps):
        from sklearn.ensemble import HistGradientBoostingRegressor
        X = _lag_frame(tr, lags).iloc[lags:]
        m = HistGradientBoostingRegressor(random_state=42, max_iter=300)
        m.fit(X, tr.to_numpy()[lags:])
        return _lag_forecast(m, tr.to_numpy(), lags, steps, len(tr))

    consider('naive_last_value', naive)
    if season:
        consider('seasonal_naive', seasonal_naive)
    consider('holt_winters', holt_winters)
    if len(train) > lags + 10:
        consider('gradient_boosting_lags', lag_model)
    if best is None:
        raise RuntimeError('Every forecasting candidate failed. First error: ' + str(leaderboard[0].get('note', 'unknown')))
    leaderboard.sort(key=lambda r: (r['status'] != 'ok', r['value'] if r['value'] is not None else 1e18))
    name, score, fit = best

    # Refit the winner on the whole series and project the horizon. The band
    # is the holdout residual spread widened by sqrt(k): an honest, simple
    # interval that says less the further out it goes.
    test_pred = fit(train, len(test))
    resid = test.to_numpy() - np.asarray(test_pred, dtype='float64')
    sigma = float(np.std(resid)) if len(resid) > 1 else float(abs(resid[0])) if len(resid) else 0.0
    yhat = np.asarray(fit(y, horizon), dtype='float64')
    idx = pd.date_range(y.index[-1], periods=horizon + 1, freq=freq)[1:]
    forecast = []
    for k in range(horizon):
        w = 1.96 * sigma * math.sqrt(k + 1)
        forecast.append({'period': _period_label(idx[k], freq), 'yhat': _safe_float(yhat[k]) or 0.0,
                         'lo': _safe_float(yhat[k] - w) or 0.0, 'hi': _safe_float(yhat[k] + w) or 0.0})
    history = [{'period': _period_label(t, freq), 'y': _safe_float(v) or 0.0} for t, v in y.tail(240).items()]
    mask = test.to_numpy() != 0
    metrics = {
        'rmse': _safe_float(score),
        'mae': _safe_float(np.mean(np.abs(resid))),
        'mape': _safe_float(np.mean(np.abs(resid[mask] / test.to_numpy()[mask])) * 100) if mask.any() else None,
        'holdout_periods': float(len(test)),
    }
    warnings_.append('Prediction intervals are residual-based (holdout spread x 1.96 x sqrt(steps ahead)), not model-derived.')

    payload = {'task': 'forecast', 'algorithm': name, 'freq': freq, 'season': season, 'lags': lags,
               'aggregation': agg, 'time_column': tcol, 'target': target, 'sigma': sigma,
               'y_tail': y.tail(max(lags, season or 0, 1) + 1).to_numpy().tolist(),
               'last_period': _period_label(y.index[-1], freq), 'trainer_version': 2}
    if name == 'gradient_boosting_lags':
        from sklearn.ensemble import HistGradientBoostingRegressor
        X = _lag_frame(y, lags).iloc[lags:]
        m = HistGradientBoostingRegressor(random_state=42, max_iter=300)
        m.fit(X, y.to_numpy()[lags:])
        payload['model'] = m
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    schema = [
        {'name': tcol, 'dtype': 'datetime', 'role': 'time'},
        {'name': target, 'dtype': 'numeric', 'role': 'target'},
    ]
    return {
        'task': 'forecast', 'algorithm': name, 'metrics': metrics, 'primary_metric': 'rmse',
        'leaderboard': leaderboard, 'feature_importance': [], 'feature_schema': schema,
        'training_rows': int(len(train)), 'holdout_rows': int(len(test)), 'forecast': forecast,
        'history': history,
        'series_meta': {'freq': freq, 'season_length': season, 'aggregation': agg, 'last_period': _period_label(y.index[-1], freq)},
        'tuning': {'mode': 'none', 'trials': 0}, '_artifact': buf.getvalue(),
    }


# ── Object storage ───────────────────────────────────────────────────────────
def _s3fs():
    import fsspec
    ep = os.environ.get('ETL_LAKEHOUSE_S3_ENDPOINT') or ''
    use_ssl = os.environ.get('ETL_LAKEHOUSE_S3_USE_SSL', 'true').lower() != 'false'
    endpoint_url = None
    if ep:
        endpoint_url = ep if (ep.startswith('http://') or ep.startswith('https://')) else (('https://' if use_ssl else 'http://') + ep)
    style = os.environ.get('ETL_LAKEHOUSE_S3_URL_STYLE', 'path')
    client_kwargs = {'region_name': os.environ.get('ETL_LAKEHOUSE_S3_REGION') or 'us-east-1'}
    if endpoint_url:
        client_kwargs['endpoint_url'] = endpoint_url
    return fsspec.filesystem(
        's3',
        key=os.environ.get('ETL_LAKEHOUSE_S3_KEY_ID', ''),
        secret=os.environ.get('ETL_LAKEHOUSE_S3_SECRET', ''),
        client_kwargs=client_kwargs,
        config_kwargs={'s3': {'addressing_style': 'path' if style == 'path' else 'virtual'}},
    )


def _upload(blob):
    fs = _s3fs()
    uri = os.environ['ML_ARTIFACT_URI']
    with fs.open(uri, 'wb') as f:
        f.write(blob)
    return uri


def _download_artifact(cfg):
    import joblib
    fs = _s3fs()
    with fs.open(cfg['artifact_uri'], 'rb') as f:
        blob = f.read()
    sha = hashlib.sha256(blob).hexdigest()
    if sha != cfg['artifact_sha256']:
        raise RuntimeError('Artifact digest mismatch: the registry recorded %s but the stored file hashes to %s. Refusing to predict with it.'
                           % (cfg['artifact_sha256'][:12], sha[:12]))
    return joblib.load(io.BytesIO(blob))


# ── Prediction ───────────────────────────────────────────────────────────────
def _predict(cfg, warnings_):
    import numpy as np
    import pandas as pd
    art = _download_artifact(cfg)
    if art.get('task') == 'forecast':
        raise RuntimeError('Forecast models are served from their training forecast; retrain with a different horizon to change it.')
    inp = cfg['input']
    con = None
    if inp['kind'] == 'rows':
        df = pd.DataFrame(inp['rows'])
        total = len(df)
    else:
        con = _lakehouse_con()
        rel = _q(inp['schema']) + '.' + _q(inp['table'])
        body = rel + (' WHERE (' + inp['where'].strip() + ')' if inp.get('where') else '')
        total = int(con.execute('SELECT count(*) FROM ' + body).fetchone()[0])
        max_rows = int(cfg.get('max_rows') or 0)
        if max_rows and total > max_rows:
            raise RuntimeError('%d rows to score, above the %d-row prediction limit. Add a WHERE filter, or raise the limit under Admin -> Developer runtime.' % (total, max_rows))
        _log('reading %s (%d rows)' % (body[:120], total))
        df = con.execute('SELECT * FROM ' + body).df()
    if len(df) == 0:
        raise RuntimeError('No rows to score.')
    missing = [f for f in art['features'] if f not in df.columns]
    if missing:
        warnings_.append('Input is missing %d feature column(s), treated as empty: %s' % (len(missing), ', '.join(missing[:8])))
    X = _prepare_x(df, art['features'], art['dt_cols'], art['num_all'], art['cat'])
    pipe = art['pipeline']
    pred = pipe.predict(X)
    out = df.copy()
    classes = art.get('classes')
    if classes:
        out['prediction'] = [classes[int(i)] if 0 <= int(i) < len(classes) else str(i) for i in pred]
        if hasattr(pipe, 'predict_proba'):
            proba = pipe.predict_proba(X)
            out['probability'] = np.max(proba, axis=1)
            if len(classes) <= 20:
                for j, c in enumerate(classes):
                    out['proba_' + _re.sub(r'[^0-9A-Za-z_]+', '_', str(c))[:40]] = proba[:, j]
    else:
        out['prediction'] = np.asarray(pred, dtype='float64')
    out['_model_version'] = int(cfg['version'])
    out['_predicted_at'] = pd.Timestamp.utcnow().isoformat()
    _log('scored %d rows with %s v%d' % (len(out), art.get('algorithm'), int(cfg['version'])))

    output = cfg.get('output')
    written = None
    if output:
        con = con or _lakehouse_con()
        fq = _q(output['schema']) + '.' + _q(output['table'])
        con.register('_pred', out)
        con.execute('CREATE OR REPLACE TABLE ' + fq + ' AS SELECT * FROM _pred')
        written = {'schema': output['schema'], 'table': output['table']}
        _log('wrote %s (%d rows)' % (fq, len(out)))
    sample_n = len(out) if inp['kind'] == 'rows' else min(len(out), 50)
    cols = [c for c in out.columns]
    sample = [[_jsonable_cell(v) for v in row] for row in out.head(sample_n).itertuples(index=False, name=None)]
    digest_cols = ['prediction'] + (['probability'] if 'probability' in out.columns else [])
    digest_rows = [[_jsonable_cell(v) for v in row] for row in out[digest_cols].head(1000).itertuples(index=False, name=None)]
    return {'mode': 'predict', 'row_count': int(len(out)), 'total_input_rows': int(total), 'output': written,
            'columns': cols, 'sample': sample, 'digest_columns': digest_cols, 'digest_rows': digest_rows,
            'algorithm': art.get('algorithm')}


# ── Entry point ──────────────────────────────────────────────────────────────
def entrypoint(inputs):
    cfg = _ML_CONFIG
    warnings_ = []
    _ensure_packages()
    if cfg.get('mode') == 'predict':
        _log('prediction %s: %s v%d' % (cfg['prediction_id'][:8], cfg['task'], int(cfg['version'])))
        result = _predict(cfg, warnings_)
        result.update({'ok': True, 'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_})
        _log('done in %.1fs' % _elapsed())
        return result
    _log('job %s: %s on %s.%s -> %s' % (cfg['job_id'][:8], cfg['task'], cfg['source']['schema'], cfg['source']['table'], cfg['target_column']))
    con = _lakehouse_con()
    df, total, sampled = _read_frame(con, cfg)
    if sampled:
        warnings_.append('Trained on a %d-row sample of %d rows.' % (len(df), total))
    if cfg['task'] == 'forecast':
        result = _train_forecast(df, cfg, warnings_)
    else:
        result = _train_tabular(df, cfg, warnings_)
    blob = result.pop('_artifact')
    sha = hashlib.sha256(blob).hexdigest()
    _log('uploading artifact (%d bytes)' % len(blob))
    uri = _upload(blob)
    result.update({
        'ok': True, 'mode': 'train', 'artifact_uri': uri, 'artifact_sha256': sha, 'artifact_bytes': len(blob),
        'training_total_rows': int(total), 'training_sampled': bool(sampled),
        'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_,
    })
    _log('done in %.1fs: %s, %s=%s' % (_elapsed(), result['algorithm'], result['primary_metric'], result['metrics'].get(result['primary_metric'])))
    return result
`;
