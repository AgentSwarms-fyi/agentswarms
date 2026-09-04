// The training program that runs inside a batch sandbox.
//
// It is one Python module, kept here as a string so the server can pin it
// into a session bundle exactly like an ETL script: prelude (env + pip) +
// the lakehouse attach helper + this program + the job configuration. The
// configuration arrives as a base64 JSON literal appended by the server, never
// as interpolated code, so a column called `'); import os` is just a column.
//
// Design rules the program follows, and why:
//   - No custom classes end up inside the artifact. joblib pickles a class
//     defined in an exec'd namespace by reference to a module that does not
//     exist at load time. Datetime expansion is therefore a plain function
//     applied to the frame before the sklearn pipeline, and the same function
//     re-runs at prediction time.
//   - The model is chosen by a holdout score under a wall-clock budget: each
//     candidate is skipped, not aborted, once the budget is spent, so a slow
//     machine still returns the best model it managed rather than nothing.
//   - Feature importance is permutation importance on the raw input columns,
//     so it names the columns a person recognises, not one-hot fragments.
//   - The artifact goes to object storage under ml-artifacts/, OUTSIDE the
//     lakehouse data path, so DuckLake's orphan-file cleanup can never delete
//     a model. Only the URI, SHA-256 and metrics travel back as JSON.
//
// String.raw: backslashes in the Python survive; the program must not contain
// a backtick or the two characters "$" + "{".
export const TRAIN_PY = String.raw`
# ── AgentSwarms ML trainer ────────────────────────────────────────────────────
import os, io, json, time, math, base64, hashlib, warnings, traceback
import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
_T0 = time.time()
_MAX_CATEGORIES = 200
import re as _re
_ID_NAME = _re.compile(r'(^|_)(id|uuid|guid|key|code)$|^id$', _re.I)
_DT_PARTS = ('__year', '__month', '__day', '__dow', '__hour')


def _log(msg):
    print('[ml] ' + str(msg), flush=True)


def _elapsed():
    return time.time() - _T0


def _q(ident):
    return '"' + str(ident).replace('"', '""') + '"'


def _safe_float(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except Exception:
        return None


# ── Reading the training frame ───────────────────────────────────────────────
def _read_frame(con, cfg):
    src = cfg['source']
    rel = _q(src['schema']) + '.' + _q(src['table'])
    total = int(con.execute('SELECT count(*) FROM ' + rel).fetchone()[0])
    max_rows = int(cfg.get('max_rows') or 0)
    sql = 'SELECT * FROM ' + rel
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
    _log('reading %s (%d rows%s)' % (rel, total, ', sampled to %d' % max_rows if sampled else ''))
    df = con.execute(sql).df()
    return df, total, sampled


# ── Column planning ──────────────────────────────────────────────────────────
def _dtype_of(s):
    if pd.api.types.is_bool_dtype(s):
        return 'boolean'
    if pd.api.types.is_datetime64_any_dtype(s):
        return 'datetime'
    if pd.api.types.is_numeric_dtype(s):
        return 'numeric'
    nun = s.nunique(dropna=True)
    return 'categorical' if nun <= _MAX_CATEGORIES else 'text'


def _plan_columns(df, cfg):
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
    X = df[features].copy()
    if dt_cols:
        X = _expand_datetimes(X, dt_cols)
    for c in num_all:
        X[c] = pd.to_numeric(X[c], errors='coerce').astype('float64')
    for c in cat:
        X[c] = X[c].astype('string').fillna('missing').astype(str)
    return X[num_all + cat]


def _build_preprocessor(schema, features):
    from sklearn.compose import ColumnTransformer
    from sklearn.pipeline import Pipeline
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    by = {e['name']: e for e in schema}
    dt_cols = [f for f in features if by[f]['dtype'] == 'datetime']
    num = [f for f in features if by[f]['dtype'] in ('numeric', 'boolean')]
    cat = [f for f in features if by[f]['dtype'] == 'categorical']
    num_all = num + [c + suf for c in dt_cols for suf in _DT_PARTS]
    transformers = []
    if num_all:
        transformers.append(('num', Pipeline([
            ('impute', SimpleImputer(strategy='median')),
            ('scale', StandardScaler()),
        ]), num_all))
    if cat:
        transformers.append(('cat', Pipeline([
            ('impute', SimpleImputer(strategy='most_frequent')),
            ('onehot', OneHotEncoder(handle_unknown='ignore', min_frequency=5, sparse_output=False)),
        ]), cat))
    prep = ColumnTransformer(transformers, remainder='drop', sparse_threshold=0)
    return prep, dt_cols, num_all, cat


# ── Candidates ───────────────────────────────────────────────────────────────
def _candidates(task):
    cands = []
    if task == 'classification':
        from sklearn.linear_model import LogisticRegression
        from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
        cands.append(('logistic_regression', lambda: LogisticRegression(max_iter=2000)))
        cands.append(('random_forest', lambda: RandomForestClassifier(n_estimators=200, n_jobs=-1, random_state=42)))
        cands.append(('hist_gradient_boosting', lambda: HistGradientBoostingClassifier(random_state=42)))
        try:
            from lightgbm import LGBMClassifier
            cands.append(('lightgbm', lambda: LGBMClassifier(n_estimators=400, learning_rate=0.05, random_state=42, verbose=-1)))
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


def _primary(task, model, Xva, yva):
    from sklearn import metrics as M
    pred = model.predict(Xva)
    if task == 'classification':
        return float(M.f1_score(yva, pred, average='macro', zero_division=0))
    return float(np.sqrt(M.mean_squared_error(yva, pred)))


def _full_metrics(task, model, Xva, yva, classes):
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
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    import joblib
    task = cfg['task']
    target = cfg['target_column']
    budget = float(cfg.get('time_budget_minutes') or 30) * 60.0
    frac = float(cfg.get('validation_fraction') or 0.2)

    df = df[df[target].notna()].copy()
    if len(df) < 20:
        raise RuntimeError('Only %d rows have a value in %s; at least 20 are needed to train.' % (len(df), target))
    schema, features = _plan_columns(df, cfg)
    dropped = [e for e in schema if e['role'] == 'dropped' and e.get('reason') != 'not selected']
    for e in dropped:
        warnings_.append('Dropped column %s: %s' % (e['name'], e['reason']))
    prep, dt_cols, num_all, cat = _build_preprocessor(schema, features)
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
    else:
        y = pd.to_numeric(df[target], errors='coerce').to_numpy(dtype='float64')
        keep = ~np.isnan(y)
        if keep.sum() < len(y):
            warnings_.append('%d rows had a non-numeric target and were dropped.' % int((~keep).sum()))
            X, y = X[keep], y[keep]
        stratify = None

    Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=frac, random_state=42, stratify=stratify)
    _log('training on %d rows, validating on %d (%d features)' % (len(Xtr), len(Xva), len(features)))

    leaderboard, best, best_score, best_name = [], None, None, None
    higher = task == 'classification'
    metric = 'f1_macro' if higher else 'rmse'
    for name, make in _candidates(task):
        if leaderboard and _elapsed() > budget * 0.85:
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            warnings_.append('Skipped %s: the time budget was spent.' % name)
            continue
        t0 = time.time()
        try:
            pipe = Pipeline([('prep', prep), ('model', make())])
            pipe.fit(Xtr, ytr)
            score = _primary(task, pipe, Xva, yva)
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': _safe_float(score), 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'ok'})
            _log('%s: %s=%.4f in %.1fs' % (name, metric, score, time.time() - t0))
            better = best is None or (score > best_score if higher else score < best_score)
            if better:
                best, best_score, best_name = pipe, score, name
        except Exception as e:
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('%s failed: %s' % (name, str(e)[:200]))
    if best is None:
        raise RuntimeError('Every candidate failed to train. First error: ' + str(leaderboard[0].get('note', 'unknown')))
    leaderboard.sort(key=lambda r: (r['status'] != 'ok', -(r['value'] or -1e18) if higher else (r['value'] if r['value'] is not None else 1e18)))

    metrics = _full_metrics(task, best, Xva, yva, classes or [])
    try:
        importance = _importance(best, Xva, yva, task, dt_cols)
    except Exception as e:
        importance = []
        warnings_.append('Feature importance unavailable: ' + str(e)[:160])

    payload = {
        'task': task, 'algorithm': best_name, 'pipeline': best, 'target': target,
        'features': features, 'dt_cols': dt_cols, 'num_all': num_all, 'cat': cat,
        'classes': classes, 'schema': schema, 'trainer_version': 1,
    }
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    return {
        'task': task, 'algorithm': best_name, 'metrics': metrics, 'primary_metric': metric,
        'leaderboard': leaderboard, 'feature_importance': importance, 'feature_schema': schema,
        'classes': classes, 'training_rows': int(len(Xtr)), 'holdout_rows': int(len(Xva)),
        '_artifact': buf.getvalue(),
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
    X = pd.DataFrame({'lag_%d' % k: y.shift(k).to_numpy() for k in range(1, lags + 1)})
    X['t'] = np.arange(len(y), dtype='float64')
    return X


def _lag_forecast(model, history, lags, steps, t_start):
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

    # The artifact stores what a later re-forecast needs; statsmodels results
    # and sklearn estimators both pickle by reference to importable modules.
    payload = {'task': 'forecast', 'algorithm': name, 'freq': freq, 'season': season, 'lags': lags,
               'aggregation': agg, 'time_column': tcol, 'target': target, 'sigma': sigma,
               'y_tail': y.tail(max(lags, season or 0, 1) + 1).to_numpy().tolist(),
               'last_period': _period_label(y.index[-1], freq), 'trainer_version': 1}
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
        '_artifact': buf.getvalue(),
    }


# ── Artifact upload ──────────────────────────────────────────────────────────
def _upload(blob):
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
    fs = fsspec.filesystem(
        's3',
        key=os.environ.get('ETL_LAKEHOUSE_S3_KEY_ID', ''),
        secret=os.environ.get('ETL_LAKEHOUSE_S3_SECRET', ''),
        client_kwargs=client_kwargs,
        config_kwargs={'s3': {'addressing_style': 'path' if style == 'path' else 'virtual'}},
    )
    uri = os.environ['ML_ARTIFACT_URI']
    with fs.open(uri, 'wb') as f:
        f.write(blob)
    return uri


# ── Entry point ──────────────────────────────────────────────────────────────
def entrypoint(inputs):
    cfg = _ML_CONFIG
    warnings_ = []
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
        'ok': True, 'artifact_uri': uri, 'artifact_sha256': sha, 'artifact_bytes': len(blob),
        'training_total_rows': int(total), 'training_sampled': bool(sampled),
        'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_,
    })
    _log('done in %.1fs: %s, %s=%s' % (_elapsed(), result['algorithm'], result['primary_metric'], result['metrics'].get(result['primary_metric'])))
    return result
`;
