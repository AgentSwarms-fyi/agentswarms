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
# Distance-based tasks: above this many categories a column names groups instead of describing rows.
_MAX_DISTANCE_CATEGORIES = 20
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
def _read_frame(cfg):
    # R231: the app reads the source, as the model's owner, through the same
    # checks the SQL editor applies — a prep step's own SQL included, which it
    # never went through while this ran on an engine connection here.
    #
    # The app also decides the sampling and the limit, because what this
    # container may read has to be a thing the app chose: it counts the rows
    # the owner may see, samples with the repeatable reservoir a re-run needs,
    # and refuses a forecast's series that is over the limit rather than
    # sampling a series, which would not mean anything.
    #
    # A DATA-PARALLEL worker's share of the rows is in the declared SELECT for
    # the same reason — hashed, not windowed: without an ORDER BY there is no
    # stable order, and two containers issuing the same windowed query can
    # overlap on some rows and miss others, which nothing downstream would
    # notice because the fit would simply be on the wrong rows.
    out = _lake_read_meta('source')
    df, total, sampled = out['frame'], out['total'], out['sampled']
    part = cfg.get('partition') or {}
    if part.get('sql'):
        _log('worker %s of %s: %d rows hashed to this container'
             % (part.get('index'), part.get('workers'), total))
    _log('read %d row(s)%s' % (total, ', sampled to %d' % len(df) if sampled else ''))
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
    target = cfg.get('target_column')
    tcol = cfg.get('time_column')
    reserved = set([c for c in (cfg.get('user_column'), cfg.get('item_column'), cfg.get('rating_column')) if c])
    wanted = cfg.get('feature_columns') or None
    schema, features = [], []
    n = max(1, len(df))
    for c in df.columns:
        s = df[c]
        if target is not None and c == target:
            schema.append({'name': c, 'dtype': _dtype_of(s), 'role': 'target'})
            continue
        if tcol and c == tcol:
            schema.append({'name': c, 'dtype': 'datetime', 'role': 'time'})
            continue
        if c in reserved:
            schema.append({'name': c, 'dtype': _dtype_of(s), 'role': 'dropped', 'reason': 'recommendation key column'})
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
            avg_len = float(s.dropna().astype(str).str.len().mean() or 0.0)
            if d == 'text' and avg_len >= 20 and not _ID_NAME.search(str(c)):
                # Free text becomes TF-IDF features instead of a dropped column.
                entry['dtype'] = 'text'
                entry['avg_length'] = round(avg_len, 1)
            elif d == 'text' or (nun > 20 and (nun >= 0.9 * n or _ID_NAME.search(str(c)))):
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


def _prepare_x(df, features, dt_cols, num_all, cat, text=None):
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
    text = text or []
    for c in text:
        X[c] = X[c].astype('string').fillna('').astype(str)
    return X[num_all + cat + text]


def _build_preprocessor(schema, features, prep, df=None, compact=False):
    from sklearn.compose import ColumnTransformer
    from sklearn.pipeline import Pipeline
    from sklearn.impute import SimpleImputer
    from sklearn.preprocessing import OneHotEncoder, OrdinalEncoder, StandardScaler
    by = {e['name']: e for e in schema}
    dt_cols = [f for f in features if by[f]['dtype'] == 'datetime']
    num = [f for f in features if by[f]['dtype'] in ('numeric', 'boolean')]
    cat = [f for f in features if by[f]['dtype'] == 'categorical']
    text = [f for f in features if by[f]['dtype'] == 'text']
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
    for i, c in enumerate(text):
        from sklearn.feature_extraction.text import TfidfVectorizer
        # Word and bigram TF-IDF, capped so a text column cannot swamp the rest.
        tfidf = TfidfVectorizer(max_features=1000, ngram_range=(1, 2), min_df=2, sublinear_tf=True)
        if compact and df is not None:
            # Distance-based tasks: a thousand sparse term columns would swamp every
            # other feature, so the text is compressed to a few dense components.
            from sklearn.decomposition import TruncatedSVD
            probe = TfidfVectorizer(max_features=1000, ngram_range=(1, 2), min_df=2)
            vocab = len(probe.fit(df[c].astype('string').fillna('').astype(str)).vocabulary_)
            if vocab < 3:
                continue
            transformers.append(('text%d' % i, Pipeline([('tfidf', tfidf), ('svd', TruncatedSVD(n_components=min(20, vocab - 1), random_state=42))]), c))
        else:
            transformers.append(('text%d' % i, tfidf, c))
    prepro = ColumnTransformer(transformers, remainder='drop', sparse_threshold=0)
    return prepro, dt_cols, num_all, cat, text


# ── GPUs (R537) ──────────────────────────────────────────────────────────────
# XGBoost's CUDA 12 build, installed without its NCCL dependency: NCCL is
# loaded only for training across several GPUs, which this trainer never does,
# and it would add 336 MB to every sandbox. The runtime image bakes the same
# pin (docker/notebook-runtime/requirements-nodeps.txt); an older image
# installs it the first time a sandbox with a GPU needs it.
_XGB_PIN = 'xgboost-cu12==3.4.1'
# The candidates that run on a GPU. mlShards.ts lists them too
# (ML_GPU_CANDIDATES), and a test holds the two to the same names.
_GPU_NAMES = ('xgboost',)


def _nvidia_smi():
    # The GPUs this container can see, as the NVIDIA driver reports them. The
    # NVIDIA container runtime mounts nvidia-smi only into a container that
    # was given a GPU, so "not found" is the plainest "no GPU here" there is.
    try:
        p = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,driver_version',
                            '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return [], 'nvidia-smi is not in the sandbox, so no NVIDIA driver was mounted into it'
    except Exception as e:
        return [], 'nvidia-smi did not answer (%s)' % str(e)[:160]
    if p.returncode != 0:
        said = (p.stderr or p.stdout or '').strip()[:240]
        return [], 'nvidia-smi failed: %s' % (said or 'exit code %d' % p.returncode)
    seen = []
    for line in (p.stdout or '').strip().splitlines():
        parts = [x.strip() for x in line.split(',')]
        if len(parts) < 3 or not parts[0]:
            continue
        try:
            mem = int(float(parts[1]))
        except Exception:
            mem = None
        seen.append({'name': parts[0][:80], 'memory_mb': mem, 'driver': parts[2][:40]})
    return seen, (None if seen else 'nvidia-smi listed no GPUs')


def _xgboost():
    try:
        import xgboost
        return xgboost
    except Exception:
        pass
    _log('installing XGBoost (this runtime image predates it)')
    p = subprocess.run([sys.executable, '-m', 'pip', 'install', '--user', '--no-input', '-q', '--no-deps', _XGB_PIN],
                       capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stdout[-1000:], p.stderr[-1000:])
        raise RuntimeError('installing %s failed (see the output above)' % _XGB_PIN)
    import site as _site
    _site.addsitedir(_site.getusersitepackages())
    import importlib as _il
    _il.invalidate_caches()
    import xgboost
    return xgboost


def _gpu_context(cfg):
    """What this sandbox was given, and whether training can use it.

    Asked: the GPUs the app requested for this sandbox (0 when none). Seen:
    what the driver lists. Usable: XGBoost fitted a tiny model on the GPU
    without falling back. XGBoost does fall back to the CPU on its own, with
    only a warning, so the check reads its warnings rather than trusting a
    fit that succeeded: a fit that quietly ran on the CPU succeeds too.
    """
    asked = int(cfg.get('gpus_requested') or 0)
    seen, why = _nvidia_smi()
    ctx = {'requested': asked, 'seen': seen, 'device': None}
    if not seen:
        if asked:
            ctx['note'] = why
        return ctx
    try:
        xgboost = _xgboost()
        info = xgboost.build_info()
        ctx['xgboost'] = str(xgboost.__version__)
        if info.get('CUDA_VERSION'):
            ctx['cuda'] = '.'.join(str(x) for x in info['CUDA_VERSION'])
        if not info.get('USE_CUDA'):
            ctx['note'] = 'XGBoost %s in this image was built without CUDA' % xgboost.__version__
            return ctx
        import numpy as np
        X = np.random.RandomState(0).rand(256, 4)
        t0 = time.time()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            xgboost.XGBRegressor(n_estimators=2, device='cuda', tree_method='hist').fit(X, X[:, 0])
        fell_back = [str(w.message) for w in caught if 'to CPU' in str(w.message)]
        if fell_back:
            ctx['note'] = 'XGBoost could not use the GPU: %s' % fell_back[0].strip()[-200:]
            return ctx
        ctx['device'] = 'cuda'
        ctx['probe_seconds'] = round(time.time() - t0, 2)
    except Exception as e:
        ctx['note'] = 'XGBoost could not use the GPU: %s' % str(e).strip()[:240]
    return ctx


def _gpu_summary(ctx):
    seen = ctx.get('seen') or []
    if not seen:
        return 'none visible'
    names = {}
    for g in seen:
        names[g['name']] = names.get(g['name'], 0) + 1
    out = ', '.join('%dx %s' % (n, name) for name, n in names.items())
    mem = seen[0].get('memory_mb')
    return out + (' (%.0f GiB each, driver %s)' % (mem / 1024.0, seen[0].get('driver')) if mem else '')


def _gpu_candidate(task, gpu, only, balanced, pos_weight):
    # The candidate that runs on a GPU (R537). It joins the search when the
    # app asked for a GPU for this sandbox, or found one, or dealt it to this
    # worker by name. Device: the GPU when the check above could use one,
    # otherwise the CPU, with the reason on the version: a sandbox that asked
    # for a GPU and could not use one still trains, but it must say so.
    gpu = gpu or {}
    if not (gpu.get('requested') or gpu.get('device') or (only and 'xgboost' in only)):
        return []
    if task not in ('classification', 'regression'):
        return []
    if task == 'classification' and balanced and pos_weight is None:
        _log('xgboost skipped: balanced weights over more than two classes need a weight per row, '
             'which this search does not pass to its candidates')
        return []
    device = gpu.get('device') or 'cpu'
    try:
        if not gpu.get('device'):
            import xgboost  # no install just to run on the CPU
        else:
            _xgboost()
        out = []
        if task == 'classification':
            from xgboost import XGBClassifier
            extra = {'scale_pos_weight': pos_weight} if pos_weight else {}
            out.append(('xgboost', lambda: XGBClassifier(n_estimators=400, learning_rate=0.05, max_depth=6, tree_method='hist',
                                                         device=device, random_state=42, verbosity=0, **extra)))
        else:
            from xgboost import XGBRegressor
            out.append(('xgboost', lambda: XGBRegressor(n_estimators=400, learning_rate=0.05, max_depth=6, tree_method='hist',
                                                        device=device, random_state=42, verbosity=0)))
        return out
    except Exception as e:
        _log('xgboost unavailable (%s); continuing without it' % str(e)[:120])
        return []


def _xgb_to_cpu(obj, _depth=0):
    # A model trained on a GPU is SAVED for the CPU (R537). Warm endpoints,
    # batch predictions and exports have no GPU, and XGBoost keeps the device
    # it was fitted on in its parameters: a model left on 'cuda' answers on a
    # CPU only by falling back, with a warning on every call. Every XGBoost
    # estimator inside the saved object is moved back, through pipelines and
    # calibration wrappers alike. Returns how many were moved.
    if obj is None or _depth > 6:
        return 0
    if (type(obj).__module__ or '').startswith('xgboost') and hasattr(obj, 'set_params'):
        try:
            if obj.get_params().get('device') not in (None, 'cpu'):
                obj.set_params(device='cpu')
                return 1
        except Exception as e:
            _log('could not move %s to the CPU: %s' % (type(obj).__name__, str(e)[:120]))
        return 0
    if isinstance(obj, (list, tuple)):
        return sum(_xgb_to_cpu(x, _depth + 1) for x in obj)
    moved = 0
    for attr in ('steps', 'estimator', 'calibrated_classifiers_', 'estimators_', 'final_estimator_'):
        v = getattr(obj, attr, None)
        if v is None or v is obj:
            continue
        if attr == 'steps':
            moved += sum(_xgb_to_cpu(s[1], _depth + 1) for s in v if isinstance(s, tuple) and len(s) > 1)
        else:
            moved += _xgb_to_cpu(v, _depth + 1)
    return moved


# ── Candidates and tuning ────────────────────────────────────────────────────
def _candidates(task, prep, only=None, gpu=None, pos_weight=None):
    # 'only' is this worker's slice of a distributed search: the server deals
    # the candidate names round-robin and each sandbox trains just its own.
    # Absent (the single-container case) every candidate is tried, exactly as
    # before.
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
    # Last, so a search on a CPU deals and orders its candidates exactly as
    # it did before GPUs (R537).
    cands.extend(_gpu_candidate(task, gpu, only, balanced, pos_weight))
    if only:
        wanted = set(only)
        cands = [c for c in cands if c[0] in wanted]
        missing = wanted - set(n for n, _ in cands)
        if missing:
            # Named rather than silently dropped: a worker asked to train
            # something this image cannot import must say so, or its slice
            # just disappears from the leaderboard with no explanation.
            _log('this worker was asked for %s but they are unavailable here' % ', '.join(sorted(missing)))
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
    if name == 'xgboost':
        return {'model__n_estimators': [200, 400, 800], 'model__max_depth': [4, 6, 8],
                'model__learning_rate': [0.02, 0.05, 0.1], 'model__min_child_weight': [1, 5, 10],
                'model__subsample': [0.7, 1.0], 'model__colsample_bytree': [0.7, 1.0]}
    if name == 'logistic_regression':
        return {'model__C': [0.1, 0.3, 1.0, 3.0, 10.0]}
    if name == 'ridge':
        return {'model__alpha': [0.1, 0.3, 1.0, 3.0, 10.0, 30.0]}
    return None


def _fold_detail(search, higher):
    # The per-fold scores of the trial that won, pulled out of cv_results_ so a
    # tuned model reports the same shape as an untuned one. Without this the
    # spread would simply vanish the moment tuning was switched on.
    import numpy as np
    i = int(search.best_index_)
    vals = []
    for key in search.cv_results_:
        if key.startswith('split') and key.endswith('_test_score'):
            v = float(search.cv_results_[key][i])
            vals.append(v if higher else -v)
    if not vals:
        return {'scores': [], 'mean': 0.0, 'std': 0.0}
    return {'scores': [round(v, 6) for v in vals],
            'mean': round(float(np.mean(vals)), 6),
            'std': round(float(np.std(vals, ddof=1)), 6) if len(vals) > 1 else 0.0}


def _tune(task, ranked, prep, Xtr, ytr, splits, budget, mode, leaderboard, warnings_):
    # ranked: [(name, pipeline, score, cv)] best first. Tune the top two while
    # at least 40% of the budget remains; each search is capped so one slow
    # estimator cannot eat the rest.
    #
    # THE SEARCH GETS THE SAME SPLITTER the untuned candidates were scored
    # with, and the holdout is not passed in at all. Two reasons, and both were
    # real: the tuned model used to be judged on the holdout, which is the set
    # the version's metric is reported from, so tuning quietly optimised the
    # published number; and it used to be compared against a score measured a
    # different way, so a tuned model could win by being measured over 3 folds
    # while its untuned self was measured over one split. Same splits, same
    # currency, neither of them the holdout.
    from sklearn.model_selection import RandomizedSearchCV
    n_iter = 6 if mode == 'quick' else 20
    higher = task == 'classification'
    metric = 'f1_macro' if higher else 'rmse'
    scoring = 'f1_macro' if higher else 'neg_root_mean_squared_error'
    best_tuned = None
    trials = 0
    for name, pipe, base_score, base_cv in ranked[:2]:
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
            search = RandomizedSearchCV(pipe, space, n_iter=n_iter, cv=splits, scoring=scoring, random_state=42, n_jobs=1, refit=True)
            search.fit(Xtr, ytr)
            trials += len(search.cv_results_['mean_test_score'])
            tuned = search.best_estimator_
            # best_score_ is the mean over the SAME folds the untuned candidate
            # was scored on, in sklearn's higher-is-better convention. Flip it
            # back for regression so the number means RMSE everywhere.
            score = float(search.best_score_) if higher else -float(search.best_score_)
            tuned_cv = _fold_detail(search, higher)
            params = {k.replace('model__', ''): (v if isinstance(v, (int, float, str, bool)) or v is None else str(v))
                      for k, v in search.best_params_.items()}
            trow = {'algorithm': name + ' (tuned)', 'metric': metric, 'value': _safe_float(score), 'higher_is_better': higher,
                    'fit_seconds': round(time.time() - t0, 2), 'status': 'ok',
                    'note': 'best of %d trials: %s' % (n_iter, json.dumps(params, sort_keys=True))}
            if len(tuned_cv['scores']) > 1:
                trow['spread'] = tuned_cv['std']
                trow['folds'] = len(tuned_cv['scores'])
            leaderboard.append(trow)
            _log('%s tuned: %s=%.4f in %.1fs (%d trials)' % (name, metric, score, time.time() - t0, n_iter))
            better_than_base = score > base_score if higher else score < base_score
            if better_than_base and (best_tuned is None or (score > best_tuned[2] if higher else score < best_tuned[2])):
                best_tuned = (name + ' (tuned)', tuned, score, params, tuned_cv)
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


def _cv_plan(task, n_dev, n_holdout, temporal, min_class, min_holdout_rows):
    # How selection gets a score, and why it is never the holdout's.
    #
    # THE BUG THIS EXISTS TO FIX: every candidate used to be fitted on the
    # training rows and scored on the HOLDOUT, the best of those scores picked
    # the winner, the tuner then optimised against the same holdout, and that
    # very number was published as the version's metric. Taking the maximum of
    # a dozen noisy estimates and reporting the maximum is the winner's curse:
    # it is biased high by exactly the amount of noise the search could
    # exploit. It then became the baseline a decay alert compares against, so a
    # model could be flagged as degraded in production purely because its
    # training number had been inflated by the act of choosing it.
    #
    # So selection happens INSIDE the training rows and the holdout is read
    # once, at the end, by code that is only reporting.
    #
    # Whether that inner score is worth k fits is a question about the SIZE OF
    # THE HOLDOUT, not the size of the training set. A few thousand held-out
    # rows already pin a proportion to well under a point, far below the 10%
    # a decay alert cares about, and k-fold would multiply every fit by k to
    # buy almost nothing. A few dozen rows pin nothing at all, and there
    # k-fold is the difference between a number and a guess.
    if temporal:
        return {'strategy': 'timeseries', 'folds': 5 if n_dev >= 1000 else 3,
                'reason': 'rows are ordered in time, so every fold trains on the past and scores the future'}
    if n_holdout >= int(min_holdout_rows):
        return {'strategy': 'inner_split', 'folds': 1,
                'reason': '%d held-out rows already give a stable estimate, so selection uses one split inside the training rows rather than paying for k folds' % n_holdout}
    folds = 5 if n_dev >= 250 else 3
    if task == 'classification':
        if min_class < 2:
            return {'strategy': 'inner_split', 'folds': 1,
                    'reason': 'the rarest class has a single example, so no set of folds can each contain one'}
        if min_class < folds:
            folds = int(min_class)
            return {'strategy': 'stratified', 'folds': folds,
                    'reason': 'a small holdout, so selection cross-validates; folds limited to %d by the rarest class' % folds}
        return {'strategy': 'stratified', 'folds': folds,
                'reason': 'only %d held-out rows, so selection cross-validates over %d folds instead of trusting one split' % (n_holdout, folds)}
    return {'strategy': 'kfold', 'folds': folds,
            'reason': 'only %d held-out rows, so selection cross-validates over %d folds instead of trusting one split' % (n_holdout, folds)}


def _cv_splits(task, plan, y):
    # ONE object handed to both cross_val_score and RandomizedSearchCV, so the
    # untuned and tuned scores are the same currency. Comparing a k-fold mean
    # against a single-split score is how a tuned model gets adopted for being
    # measured differently rather than for being better.
    import numpy as np
    from sklearn.model_selection import KFold, StratifiedKFold, TimeSeriesSplit, train_test_split
    k = int(plan['folds'])
    if plan['strategy'] == 'timeseries':
        return TimeSeriesSplit(n_splits=k)
    if plan['strategy'] == 'stratified':
        return StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
    if plan['strategy'] == 'kfold':
        return KFold(n_splits=k, shuffle=True, random_state=42)
    # inner_split: a single fold, expressed as the same [(train, test)] shape
    # every sklearn cv argument accepts.
    idx = np.arange(len(y))
    strat = None
    if task == 'classification':
        import pandas as pd
        counts = pd.Series(y).value_counts()
        if len(counts) and int(counts.min()) >= 2:
            strat = y
    tr, te = train_test_split(idx, test_size=0.25, random_state=42, stratify=strat)
    return [(tr, te)]


def _rows(X, idx):
    # Take rows by position from either shape a caller might hold. The trainer
    # always has a DataFrame; a probe driving these functions directly has a
    # numpy array, and a helper that only knew about one of them would work in
    # production and fail the moment anything tried to check it.
    return X.iloc[idx] if hasattr(X, 'iloc') else X[idx]


def _first_fold(splits, X, y):
    # The first (train, score) pair out of whatever _cv_splits returned: a
    # splitter object has to be asked, a list of one already is the answer.
    if hasattr(splits, 'split'):
        return next(iter(splits.split(X, y)))
    return splits[0]


def _cv_score(pipe, X, y, splits, task):
    # The score selection is allowed to see. Every fold refits the WHOLE
    # pipeline, preprocessing included, so nothing a fold learns about its own
    # validation rows can leak into the estimate.
    import numpy as np
    from sklearn.base import clone
    from sklearn.model_selection import cross_val_score
    scoring = 'f1_macro' if task == 'classification' else 'neg_root_mean_squared_error'
    raw = cross_val_score(clone(pipe), X, y, cv=splits, scoring=scoring, n_jobs=1, error_score='raise')
    vals = [float(v) for v in raw]
    if task != 'classification':
        # Back to RMSE, which is the name the rest of the program uses and the
        # direction a reader expects.
        vals = [-v for v in vals]
    return {'scores': [round(v, 6) for v in vals],
            'mean': round(float(np.mean(vals)), 6),
            'std': round(float(np.std(vals, ddof=1)), 6) if len(vals) > 1 else 0.0}


def _reliability(y_true, p_pos, bins=10):
    # How often something the model called 70% likely actually happened.
    #
    # Equal-width bins over the predicted probability, each reporting what the
    # model said and what the world did. The gap between those two columns IS
    # the calibration error, and showing both is what lets a reader see that
    # rather than take a single number on trust.
    import numpy as np
    edges = np.linspace(0.0, 1.0, bins + 1)
    out = []
    ece = 0.0
    n = len(y_true)
    for k in range(bins):
        lo, hi = edges[k], edges[k + 1]
        m = (p_pos >= lo) & (p_pos < hi if k < bins - 1 else p_pos <= hi)
        c = int(m.sum())
        if c == 0:
            continue
        said = float(np.mean(p_pos[m]))
        happened = float(np.mean(y_true[m]))
        out.append({'from': float(lo), 'to': float(hi), 'n': c,
                    'predicted': round(said, 4), 'observed': round(happened, 4)})
        ece += (c / max(1, n)) * abs(said - happened)
    return out, float(ece)


def _calibration_scores(model, Xva, yva, classes):
    # Brier and expected calibration error on the holdout, plus the curve.
    #
    # Brier is the mean squared error of the probabilities themselves, so it
    # moves when a model is confidently wrong in a way accuracy never sees.
    import numpy as np
    if not hasattr(model, 'predict_proba') or not classes:
        return None
    proba = model.predict_proba(Xva)
    y = np.asarray(yva)
    k = len(classes)
    onehot = np.zeros((len(y), k), dtype='float64')
    onehot[np.arange(len(y)), y.astype(int)] = 1.0
    brier = float(np.mean(np.sum((proba - onehot) ** 2, axis=1)))
    if k == 2:
        curve, ece = _reliability((y == 1).astype(float), proba[:, 1])
    else:
        # One curve over the CONFIDENCE of whatever was predicted, which is the
        # quantity a reader sees in the interface.
        conf = np.max(proba, axis=1)
        hit = (np.argmax(proba, axis=1) == y.astype(int)).astype(float)
        curve, ece = _reliability(hit, conf)
    return {'brier': round(brier, 6), 'calibration_error': round(ece, 6), 'curve': curve}


def _calibrate(best, Xtr, ytr, splits, Xrep, yrep, classes, warnings_):
    # Turn a ranking score into a probability, and KEEP IT ONLY IF IT HELPED.
    #
    # Tree ensembles are systematically over-confident: a forest that votes 9-1
    # reports 0.9 whatever the real frequency is. The interface has always
    # printed that number next to the word "confidence", so somebody setting a
    # business rule at 80% was reading a rank, not a probability.
    #
    # Isotonic needs data to fit its step function and overfits badly without
    # it; Platt scaling is one parameter and holds up on small samples. The
    # crossover in sklearn's own guidance is around a thousand rows.
    #
    # AND IT IS CHECKED. Calibration can make things worse — on a small or
    # skewed holdout it regularly does — so the calibrated model is scored on
    # the same holdout and kept only when the Brier score improves. A step that
    # cannot fail is a step nobody can trust.
    from sklearn.base import clone
    from sklearn.calibration import CalibratedClassifierCV
    if not classes or not hasattr(best, 'predict_proba'):
        return best, None
    method = 'isotonic' if len(Xtr) >= 1000 else 'sigmoid'

    # DECIDE INSIDE THE TRAINING ROWS, REPORT ON THE HOLDOUT.
    #
    # Keeping or discarding a calibration is a choice, and a choice made by
    # looking at the holdout is selection on the set the version reports from —
    # the same mistake the candidate search used to make, one decision wide
    # instead of a dozen. It also meant the Brier and calibration figures
    # printed on the version were the better of two numbers measured on the
    # rows that chose between them.
    #
    # So the decision is made on a slice of the training rows, and once it is
    # made the figures are measured again on the holdout, which nothing in this
    # function was allowed to consult.
    fit_idx, sel_idx = _first_fold(splits, Xtr, ytr)
    Xfit, yfit = _rows(Xtr, fit_idx), ytr[fit_idx]
    Xsel, ysel = _rows(Xtr, sel_idx), ytr[sel_idx]
    inner_before = _calibration_scores(clone(best).fit(Xfit, yfit), Xsel, ysel, classes)
    if inner_before is None:
        return best, None
    try:
        probe = CalibratedClassifierCV(clone(best), method=method, cv=3)
        probe.fit(Xfit, yfit)
    except Exception as e:
        warnings_.append('Probabilities left uncalibrated: ' + str(e)[:160])
        before = _calibration_scores(best, Xrep, yrep, classes)
        return best, {'calibrated': False, 'method': None, 'before': before, 'after': None}
    inner_after = _calibration_scores(probe, Xsel, ysel, classes)

    # The figure a reader sees for the model as it stands, on the untouched
    # holdout. Its calibrated twin is only fitted if the decision below keeps
    # it — a CalibratedClassifierCV over every training row is not a cheap
    # thing to build for a model about to be thrown away.
    before = _calibration_scores(best, Xrep, yrep, classes)
    after_d, before_d = inner_after, inner_before
    # BOTH have to improve, and that rule came out of running this.
    #
    # Brier is a proper scoring rule, but it is calibration AND sharpness added
    # together, so a model can win on Brier by getting more confident while
    # drifting further from the truth. A 90-row probe did exactly that: Brier
    # 0.1701 -> 0.1572 while the calibration error went 0.1917 -> 0.2220. Kept
    # on Brier alone, that would have shipped a model whose probabilities were
    # WORSE at the one job this step exists to do, under a metric that said it
    # had improved.
    if after_d is None or after_d['brier'] >= before_d['brier'] or (
            after_d['calibration_error'] > before_d['calibration_error']):
        why = 'the Brier score' if (after_d is None or after_d['brier'] >= before_d['brier']) \
            else 'the calibration error'
        warnings_.append(
            'Calibration did not improve %s on held-back training rows (Brier %.4f against %.4f, '
            'calibration error %.4f against %.4f), so the uncalibrated model was kept.' % (
                why, (after_d or before_d)['brier'], before_d['brier'],
                (after_d or before_d)['calibration_error'], before_d['calibration_error']))
        return best, {'calibrated': False, 'method': method, 'before': before, 'after': None}

    # Kept. Refit over every training row — the inner slice existed to decide,
    # and the model that ships should have seen everything it was entitled to.
    try:
        cal = CalibratedClassifierCV(clone(best), method=method, cv=3)
        cal.fit(Xtr, ytr)
    except Exception as e:
        warnings_.append('Probabilities left uncalibrated: ' + str(e)[:160])
        return best, {'calibrated': False, 'method': None, 'before': before, 'after': None}
    after = _calibration_scores(cal, Xrep, yrep, classes)
    if after is None:
        return best, {'calibrated': False, 'method': method, 'before': before, 'after': None}
    _log('calibrated with %s: on the holdout Brier %.4f -> %.4f, ECE %.4f -> %.4f' % (
        method, before['brier'], after['brier'], before['calibration_error'], after['calibration_error']))
    return cal, {'calibrated': True, 'method': method, 'before': before, 'after': after}


def _threshold_sweep(model, Xva, yva, classes):
    # What the decision would cost at every operating point.
    #
    # A classifier here decides by argmax, which is a threshold of 0.5 nobody
    # chose. That is the right default and the wrong one for most real
    # decisions: catching fraud and approving a loan are not symmetric, and the
    # person who knows the ratio is the operator, not the trainer.
    #
    # So the sweep is MEASURED and reported, and the choice is left to them.
    import numpy as np
    from sklearn import metrics as M
    if not classes or len(classes) != 2 or not hasattr(model, 'predict_proba'):
        return None
    p = model.predict_proba(Xva)[:, 1]
    y = (np.asarray(yva).astype(int) == 1).astype(int)
    rows = []
    for raw_t in np.arange(0.05, 0.96, 0.05):
        # MEASURE AT THE VALUE WE REPORT. np.arange lands on 0.7000000000000001
        # rather than 0.7, and rounding only the reported number meant the row
        # labelled 0.70 was measured at a hair above it. Two holdout rows sat at
        # exactly 42/60 votes, so the table promised 30 rows while _predict —
        # which compares against the stored 0.70 exactly — would have acted on
        # 32. A table that does not describe what production will do is worse
        # than no table.
        t = round(float(raw_t), 2)
        pred = (p >= t).astype(int)
        rows.append({
            'threshold': t,
            'precision': round(float(M.precision_score(y, pred, zero_division=0)), 4),
            'recall': round(float(M.recall_score(y, pred, zero_division=0)), 4),
            'f1': round(float(M.f1_score(y, pred, zero_division=0)), 4),
            'selected': int(pred.sum()),
        })
    best = max(rows, key=lambda r: r['f1'])
    return {'positive_label': str(classes[1]), 'rows': rows, 'best_f1_threshold': best['threshold']}


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
def _leakage_warnings(df, schema, features, target, task, warnings_):
    # A feature that predicts the target on its own is usually the target in
    # disguise - a code for it, a column filled in after the fact - or a key
    # the model memorises. The score would look superb and mean nothing, so
    # the version says so and lets the person decide.
    import numpy as np
    import pandas as pd
    from sklearn.metrics import balanced_accuracy_score
    from sklearn.tree import DecisionTreeClassifier
    by = {e['name']: e for e in schema}
    n = max(1, len(df))
    cls = df[target].astype(str) if task == 'classification' else None
    num = pd.to_numeric(df[target], errors='coerce') if task != 'classification' else None
    tail = ' If it is derived from the target, or not known when you predict, leave it out of the features.'
    for f in features:
        d = by[f]['dtype']
        s = df[f]
        if d in ('text', 'datetime'):
            continue
        few = d in ('categorical', 'boolean') or (d == 'numeric' and s.nunique(dropna=True) <= 50)
        if few:
            key = s.astype(str)
            sizes = key.value_counts()
            big = sizes[sizes >= 3]
            if len(big) < 2 or big.sum() < 0.5 * n:
                continue
            keep = key.isin(big.index)
            if cls is not None:
                ct = pd.crosstab(key[keep], cls[keep])
                pred = key[keep].map(ct.idxmax(axis=1))
                score = float(balanced_accuracy_score(cls[keep], pred))
                if score >= 0.98:
                    warnings_.append('Possible leakage: %s on its own predicts %s for %.0f%% of rows (balanced accuracy).%s' % (f, target, score * 100, tail))
            else:
                yv = num[keep]
                ok = yv.notna()
                if ok.sum() < 10:
                    continue
                yv = yv[ok]
                total = float(((yv - yv.mean()) ** 2).sum())
                if total <= 0:
                    continue
                within = float(sum(((v - v.mean()) ** 2).sum() for _k, v in yv.groupby(key[keep][ok])))
                explained = 1.0 - within / total
                if explained >= 0.98:
                    warnings_.append('Possible leakage: %s on its own explains %.0f%% of the variation in %s.%s' % (f, explained * 100, target, tail))
        elif d == 'numeric':
            v = pd.to_numeric(s, errors='coerce')
            if cls is not None:
                ok = v.notna()
                if ok.sum() < 20:
                    continue
                frame = v[ok].to_frame()
                tree = DecisionTreeClassifier(max_depth=2, random_state=42).fit(frame, cls[ok])
                score = float(balanced_accuracy_score(cls[ok], tree.predict(frame)))
                if score >= 0.98:
                    warnings_.append('Possible leakage: %s on its own predicts %s for %.0f%% of rows (balanced accuracy).%s' % (f, target, score * 100, tail))
            else:
                ok = v.notna() & num.notna()
                if ok.sum() < 10 or float(v[ok].std()) == 0.0 or float(num[ok].std()) == 0.0:
                    continue
                r = float(np.corrcoef(v[ok].to_numpy(dtype='float64'), num[ok].to_numpy(dtype='float64'))[0, 1])
                if abs(r) >= 0.98:
                    warnings_.append('Possible leakage: %s moves with %s almost exactly (correlation %.3f).%s' % (f, target, r, tail))


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
    try:
        _leakage_warnings(df, schema, features, target, task, warnings_)
    except Exception as e:
        _log('leakage check skipped: %s' % str(e)[:160])
    prepro, dt_cols, num_all, cat, text = _build_preprocessor(schema, features, prep)
    X = _prepare_x(df, features, dt_cols, num_all, cat, text)

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
        share = float(counts.max()) / float(len(y))
        if share >= 0.9:
            warnings_.append('%.0f%% of rows are %s, so %.0f%% accuracy is the do-nothing baseline; judge the model by F1 (macro), the primary metric, and the confusion matrix.' % (share * 100, classes[int(counts.idxmax())], share * 100))
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

    # A time-ordered table must not be split at random. Shuffling rows that
    # have an order puts next month in the training set and last month in the
    # holdout, and the score that comes back is the score for predicting the
    # past from the future — reliably flattering, and reliably wrong the first
    # time the model runs for real.
    tcol = cfg.get('time_column')
    temporal = bool(tcol) and tcol in df.columns
    if temporal:
        tvals = pd.to_datetime(df.loc[X.index, tcol], errors='coerce')
        if tvals.isna().all():
            temporal = False
            warnings_.append('%s holds no readable dates, so rows were split at random rather than in time order.' % tcol)
        else:
            order = np.argsort(tvals.to_numpy(), kind='stable')
            X, y = X.iloc[order], y[order]
            cut = max(1, int(round(len(X) * (1.0 - frac))))
            Xtr, Xva, ytr, yva = X.iloc[:cut], X.iloc[cut:], y[:cut], y[cut:]
            warnings_.append('Rows were ordered by %s and the most recent %d kept back, so the score describes predicting forward.' % (tcol, len(Xva)))
    if not temporal:
        Xtr, Xva, ytr, yva = train_test_split(X, y, test_size=frac, random_state=42, stratify=stratify)

    # WHAT SELECTION IS ALLOWED TO SEE. Never yva: the holdout is read once, at
    # the end, by code that only reports.
    min_class = 0
    if task == 'classification':
        min_class = int(pd.Series(ytr).value_counts().min())
    cv_plan = _cv_plan(task, len(Xtr), len(Xva), temporal, min_class,
                       cfg.get('cv_min_holdout_rows') or 2000)
    splits = _cv_splits(task, cv_plan, ytr)
    _log('training on %d rows, holding back %d (%d features); selecting by %s' % (
        len(Xtr), len(Xva), len(features), cv_plan['strategy']))

    leaderboard, ranked = [], []
    higher = task == 'classification'
    metric = 'f1_macro' if higher else 'rmse'
    gpu = cfg.get('_gpu') or {}
    # XGBoost has no class_weight: two classes are balanced by weighting the
    # positive one, the same inverse-frequency ratio 'balanced' means.
    pos_weight = None
    if task == 'classification' and prep.get('class_weight') == 'balanced' and len(classes or []) == 2:
        n_pos = int((ytr == 1).sum())
        pos_weight = float(len(ytr) - n_pos) / n_pos if n_pos else None
    for name, make in _candidates(task, prep, cfg.get('candidates'), gpu=gpu, pos_weight=pos_weight):
        if leaderboard and _elapsed() > budget * 0.85:
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            warnings_.append('Skipped %s: the time budget was spent.' % name)
            continue
        t0 = time.time()
        try:
            pipe = Pipeline([('prep', prepro), ('model', make())])
            cvres = _cv_score(pipe, Xtr, ytr, splits, task)
            score = cvres['mean']
            # Refit on every training row once the score is settled: the folds
            # existed to measure, and the model that ships should have seen all
            # the data selection was entitled to use.
            pipe.fit(Xtr, ytr)
            row = {'algorithm': name, 'metric': metric, 'value': _safe_float(score), 'higher_is_better': higher,
                   'fit_seconds': round(time.time() - t0, 2), 'status': 'ok'}
            if name in _GPU_NAMES:
                # Where it trained, so its fit time reads against the others'.
                row['device'] = 'gpu' if gpu.get('device') else 'cpu'
            if len(cvres['scores']) > 1:
                row['spread'] = cvres['std']
                row['folds'] = len(cvres['scores'])
            leaderboard.append(row)
            _log('%s: %s=%.4f (+/-%.4f over %d) in %.1fs' % (
                name, metric, score, cvres['std'], len(cvres['scores']), time.time() - t0))
            ranked.append((name, pipe, score, cvres))
        except Exception as e:
            leaderboard.append({'algorithm': name, 'metric': metric, 'value': None, 'higher_is_better': higher,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('%s failed: %s' % (name, str(e)[:200]))
    if not ranked:
        raise RuntimeError('Every candidate failed to train. First error: ' + str(leaderboard[0].get('note', 'unknown')))
    ranked.sort(key=lambda r: -r[2] if higher else r[2])
    best_name, best, best_score, best_cv = ranked[0]
    tuning_info = {'mode': tuning, 'trials': 0}
    if tuning in ('quick', 'thorough'):
        tuned, trials = _tune(task, ranked, prep, Xtr, ytr, splits, budget, tuning, leaderboard, warnings_)
        tuning_info['trials'] = trials
        if tuned:
            best_name, best, best_score, params, best_cv = tuned
            tuning_info['best_params'] = params
    leaderboard.sort(key=lambda r: (r['status'] != 'ok', -(r['value'] or -1e18) if higher else (r['value'] if r['value'] is not None else 1e18)))

    # Calibrate BEFORE measuring, so every metric on the version describes the
    # model that is actually saved rather than the one that was selected.
    calibration = None
    if task == 'classification':
        best, calibration = _calibrate(best, Xtr, ytr, splits, Xva, yva, classes or [], warnings_)
    # Saved for the CPU it will be served on, and measured there too (R537).
    if _xgb_to_cpu(best):
        _log('%s trained on the GPU; saved to answer on the CPU' % best_name)
    # Reported from the holdout, which nothing above was allowed to read.
    metrics = _full_metrics(task, best, Xva, yva, classes or [])
    metrics['tuning_trials'] = float(tuning_info['trials'])
    metrics['cross_validation'] = {
        'strategy': cv_plan['strategy'], 'folds': int(cv_plan['folds']), 'reason': cv_plan['reason'],
        'metric': metric, 'higher_is_better': higher,
        'scores': (best_cv or {}).get('scores') or [],
        'mean': (best_cv or {}).get('mean'), 'std': (best_cv or {}).get('std'),
        'holdout_rows': int(len(Xva)), 'training_rows': int(len(Xtr)),
        'holdout_value': _safe_float(metrics.get(metric)),
    }
    if calibration:
        metrics['calibrated'] = bool(calibration['calibrated'])
        metrics['calibration_method'] = calibration['method']
        metrics['calibration'] = calibration
    sweep = _threshold_sweep(best, Xva, yva, classes or []) if task == 'classification' else None
    if sweep:
        metrics['threshold_sweep'] = sweep
    if task != 'classification' and metrics.get('r2') is not None and metrics['r2'] <= 0.05:
        warnings_.append('The model explains only %.0f%% of the variation in %s (R2 %.3f): predicting the mean would do about as well. The features carry little signal for this target.' % (max(0.0, metrics['r2']) * 100, target, metrics['r2']))
    try:
        importance = _importance(best, Xva, yva, task, dt_cols)
    except Exception as e:
        importance = []
        warnings_.append('Feature importance unavailable: ' + str(e)[:160])

    stats = _feature_stats(df, schema, features)
    payload = {
        'task': task, 'algorithm': best_name, 'pipeline': best, 'target': target,
        'features': features, 'dt_cols': dt_cols, 'num_all': num_all, 'cat': cat, 'text': text,
        'classes': classes, 'schema': schema, 'prep': prep, 'feature_stats': stats, 'trainer_version': 3,
    }
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    return {
        'task': task, 'algorithm': best_name, 'metrics': metrics, 'primary_metric': metric,
        'leaderboard': leaderboard, 'feature_importance': importance, 'feature_schema': schema, 'feature_stats': stats,
        'classes': classes, 'training_rows': int(len(Xtr)), 'holdout_rows': int(len(Xva)),
        'tuning': tuning_info, '_artifact': buf.getvalue(),
    }


# ── Forecasting ──────────────────────────────────────────────────────────────
# ── Drift: the training distribution of every feature ───────────────────────
def _feature_stats(df, schema, features):
    import numpy as np
    import pandas as pd
    by = {e['name']: e for e in schema}
    stats = {}
    for f in features:
        d = by[f]['dtype']
        s = df[f]
        if d in ('numeric', 'boolean'):
            v = pd.to_numeric(s, errors='coerce').dropna().astype(float)
            if len(v) < 10 or v.nunique() < 2:
                continue
            edges = np.unique(np.quantile(v, np.linspace(0, 1, 11)))
            if len(edges) < 3:
                continue
            counts, _ = np.histogram(v, bins=edges)
            stats[f] = {'kind': 'numeric', 'edges': [float(x) for x in edges],
                        'props': (counts / max(1, counts.sum())).tolist(), 'n': int(len(v))}
        elif d == 'categorical':
            vc = s.dropna().astype(str).value_counts(normalize=True)
            if len(vc) == 0:
                continue
            top = vc.iloc[:20]
            stats[f] = {'kind': 'categorical', 'props': {str(k): float(x) for k, x in top.items()},
                        'other': float(max(0.0, 1.0 - float(top.sum()))), 'n': int(s.notna().sum())}
    return stats


def _baseline_row(stats, features):
    # The row a typical training example looked like, recovered from the same
    # distribution drift already records: the middle quantile edge for a
    # number, the commonest value for a category. A feature with no recorded
    # distribution gets None, which the pipeline imputes exactly as it imputes
    # a missing value - that IS the honest baseline for a column we know
    # nothing about.
    base = {}
    for f in features:
        st = (stats or {}).get(f)
        if not st:
            base[f] = None
        elif st.get('kind') == 'numeric':
            edges = st.get('edges') or []
            base[f] = float(edges[len(edges) // 2]) if edges else None
        else:
            props = st.get('props') or {}
            base[f] = max(props, key=props.get) if props else None
    return base


def _explain(art, df, pipe, prep, task, classes, pred, max_rows, top_k):
    # Why THIS row got THIS answer.
    #
    # NOT Shapley values, and the docs say so. For each feature the value is
    # replaced with the one a typical training row carried, the model is asked
    # again, and the contribution is how far the answer moved. Positive means
    # the actual value pushed the answer up relative to typical.
    #
    # It is the LOCAL twin of the permutation importance already reported for
    # the model as a whole - that shuffles a column across rows, this replaces
    # one cell - which is why the two can be read side by side. It also works
    # on any pipeline at all, including one registered from a notebook, because
    # it only ever calls predict.
    #
    # One stacked frame and ONE predict call rather than a call per feature:
    # rows x features is small at these limits and a loop would spend its life
    # in sklearn's per-call overhead.
    import numpy as np
    import pandas as pd
    feats = [f for f in art['features'] if f in df.columns]
    if not feats:
        return None
    n = int(min(len(df), max_rows))
    if n <= 0:
        return None
    is_class = bool(classes) and task not in ('clustering', 'anomaly')
    has_proba = hasattr(pipe, 'predict_proba')
    if is_class and not has_proba:
        # Without probabilities the only measurable move is "the label flipped",
        # which is a yes/no rather than a contribution. Saying nothing beats
        # dressing a coin flip as a number.
        return None
    base = _baseline_row(art.get('feature_stats'), feats)

    head = df.iloc[:n]
    blocks = []
    for f in feats:
        b = head.copy()
        b[f] = base.get(f)
        blocks.append(b)
    stacked = pd.concat(blocks, ignore_index=True)

    if is_class:
        base_proba = pipe.predict_proba(prep(head))
        idx = [int(np.argmax(base_proba[i])) for i in range(n)]
        base_score = np.array([float(base_proba[i][idx[i]]) for i in range(n)])
        ab = pipe.predict_proba(prep(stacked))
        moved = np.empty((len(feats), n), dtype=float)
        for j in range(len(feats)):
            for i in range(n):
                moved[j][i] = float(ab[j * n + i][idx[i]])
    else:
        base_score = np.asarray(pipe.predict(prep(head)), dtype=float).reshape(-1)
        flat = np.asarray(pipe.predict(prep(stacked)), dtype=float).reshape(-1)
        moved = flat.reshape(len(feats), n)

    out = []
    for i in range(n):
        parts = []
        for j, f in enumerate(feats):
            c = float(base_score[i] - moved[j][i])
            if not np.isfinite(c) or c == 0.0:
                continue
            parts.append({'feature': f, 'contribution': round(c, 6),
                          'value': _jsonable_cell(head.iloc[i][f]),
                          'baseline': _jsonable_cell(base.get(f))})
        parts.sort(key=lambda d: -abs(d['contribution']))
        out.append(parts[:top_k])
    return out


def _reason_codes(art, df, pipe, prep, task, classes, top_k, chunk_rows, warnings_):
    # Why every row got its answer, not just the one somebody asked about.
    #
    # THE SAME ABLATION as _explain, deliberately: "what moved this answer" has
    # one definition in this product, and a cheaper second one for batches
    # would be a second answer to the same question wearing the same name. A
    # reason code that disagrees with the explanation shown on the row's own
    # page is worse than no reason code.
    #
    # What changes is the bookkeeping. _explain stacks rows x features into one
    # frame and predicts once, which is right for twenty rows and impossible
    # for two hundred thousand. So the work is CHUNKED: the stacked frame stays
    # bounded by chunk_rows x features however big the batch is, and the cost
    # stays linear in rows rather than quadratic in memory.
    n = len(df)
    step = max(1, int(chunk_rows))
    out = []
    for start in range(0, n, step):
        part = df.iloc[start:start + step]
        got = _explain(art, part, pipe, prep, task, classes, None, len(part), top_k)
        if got is None:
            # _explain refuses for a reason it already knows (no features in
            # the frame, or a classifier with no probabilities to move). Saying
            # nothing is the contract there, so it is the contract here.
            return None
        out.extend(got)
        if start == 0 and n > step:
            _log('reason codes: %d rows per chunk, %d chunks' % (step, (n + step - 1) // step))
    if len(out) != n:
        warnings_.append('Reason codes covered %d of %d rows and were left off.' % (len(out), n))
        return None
    return out


def _reason_frame(reasons, top_k):
    # Flat columns, not a JSON blob.
    #
    # These land in a lakehouse table that people query with plain SQL and
    # point dashboards at. "WHERE reason_1 = 'support_tickets'" has to work
    # without a JSON function, and a BI tool has to be able to group by it.
    #
    # Feature and effect only: the VALUE that drove the answer is already in
    # the row, in the column the reason names, so carrying it again would be a
    # third of the width for a copy.
    cols = {}
    for slot in range(int(top_k)):
        names, effects = [], []
        for parts in reasons:
            if slot < len(parts):
                names.append(parts[slot]['feature'])
                effects.append(parts[slot]['contribution'])
            else:
                # Fewer features moved the answer than slots asked for. None,
                # not an empty string: nothing is not the same as a feature
                # whose name happens to be blank.
                names.append(None)
                effects.append(None)
        cols['reason_%d' % (slot + 1)] = names
        cols['reason_%d_effect' % (slot + 1)] = effects
    return cols


def _drift(stats, df):
    # Population stability index per feature: sum((a - e) * ln(a / e)) over the
    # training bins, with the new rows binned the same way. Below 0.1 is stable,
    # 0.1-0.25 moderate, above 0.25 the population has moved.
    import numpy as np
    import pandas as pd
    out = {}
    for f, st in (stats or {}).items():
        if f not in df.columns:
            continue
        s = df[f]
        if st['kind'] == 'numeric':
            v = pd.to_numeric(s, errors='coerce').dropna().astype(float)
            if len(v) < 10:
                continue
            edges = np.array(st['edges'], dtype=float)
            counts, _ = np.histogram(v.clip(edges[0], edges[-1]), bins=edges)
            actual = counts / max(1, counts.sum())
            expected = np.array(st['props'], dtype=float)
        else:
            vc = s.dropna().astype(str).value_counts(normalize=True)
            cats = list(st['props'].keys())
            seen = sum(float(vc.get(c, 0.0)) for c in cats)
            expected = np.array([st['props'][c] for c in cats] + [st.get('other', 0.0)], dtype=float)
            actual = np.array([float(vc.get(c, 0.0)) for c in cats] + [float(max(0.0, 1.0 - seen))], dtype=float)
        if len(actual) != len(expected):
            continue
        e = np.clip(expected, 1e-4, None)
        a = np.clip(actual, 1e-4, None)
        out[f] = float(np.sum((a - e) * np.log(a / e)))
    if not out:
        return None
    ranked = sorted(out.items(), key=lambda kv: -kv[1])
    return {'score': round(float(ranked[0][1]), 4), 'features': {k: round(v, 4) for k, v in ranked}, 'rows': int(len(df))}


# ── Clustering, anomaly detection, recommendation ───────────────────────────
def _plan_and_prepare(df, cfg, warnings_):
    prep = cfg.get('prep') or {}
    schema, features = _plan_columns(df, cfg)
    by = {e['name']: e for e in schema}
    auto = not (cfg.get('feature_columns') or None)
    # Rows are compared by distance here, so a column that names each row's
    # group, or the calendar it fell in, decides the answer on its own: the
    # "segments" become customers, the "anomalies" the first and last dates.
    # Left out unless the column was picked on purpose, and said either way.
    for f in list(features):
        e = by[f]
        if e['dtype'] == 'categorical':
            nun = int(df[f].nunique(dropna=True))
            if nun > _MAX_DISTANCE_CATEGORIES:
                if auto:
                    e['role'] = 'dropped'
                    e['reason'] = '%d categories: rows would be grouped by it rather than compared; select it explicitly to keep it' % nun
                else:
                    warnings_.append('%s has %d categories; rows sharing a value will tend to fall into the same group.' % (f, nun))
        elif e['dtype'] == 'datetime':
            if auto:
                e['role'] = 'dropped'
                e['reason'] = 'a time column groups rows by when they happened, not what they are; select it explicitly to keep it'
            else:
                warnings_.append('%s is a time column: its year, month, day, weekday and hour are compared like any other number, so rows near each other in the calendar will tend to group together.' % f)
    features = [f for f in features if by[f]['role'] == 'feature']
    if not features:
        raise RuntimeError('No usable feature columns were left: pick the columns to compare rows by explicitly.')
    for e in [e for e in schema if e['role'] == 'dropped' and e.get('reason') not in ('not selected', 'recommendation key column')]:
        warnings_.append('Dropped column %s: %s' % (e['name'], e['reason']))
    prepro, dt_cols, num_all, cat, text = _build_preprocessor(schema, features, prep, df=df, compact=True)
    X = _prepare_x(df, features, dt_cols, num_all, cat, text)
    return prep, schema, features, prepro, dt_cols, num_all, cat, text, X


def _cluster_profiles(df, labels, schema, features):
    import pandas as pd
    by = {e['name']: e for e in schema}
    lab = pd.Series(labels, index=df.index)
    n = max(1, len(df))
    out = []
    for k in sorted(set(int(v) for v in labels)):
        sub = df[lab == k]
        profile = {}
        for f in features:
            d = by[f]['dtype']
            if d in ('numeric', 'boolean'):
                profile[f] = _safe_float(pd.to_numeric(sub[f], errors='coerce').mean())
            elif d == 'categorical':
                vc = sub[f].dropna().astype(str).value_counts()
                profile[f] = str(vc.index[0]) if len(vc) else None
        out.append({'cluster': k, 'size': int(len(sub)), 'share': round(len(sub) / n, 4), 'profile': profile})
    return out


def _train_clustering(df, cfg, warnings_):
    import numpy as np
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    from sklearn.pipeline import Pipeline
    import joblib
    budget = float(cfg.get('time_budget_minutes') or 30) * 60.0
    prep, schema, features, prepro, dt_cols, num_all, cat, text, X = _plan_and_prepare(df, cfg, warnings_)
    Xt = prepro.fit_transform(X)
    n = int(Xt.shape[0])
    if n < 20:
        raise RuntimeError('Clustering needs at least 20 rows; found %d.' % n)
    fixed = cfg.get('n_clusters')
    ks = [int(fixed)] if fixed else list(range(2, min(10, max(2, n // 10)) + 1))
    rng = np.random.RandomState(42)
    sample = rng.choice(n, size=5000, replace=False) if n > 5000 else None
    leaderboard, best = [], None
    for k in ks:
        name = 'kmeans_k%d' % k
        if leaderboard and _elapsed() > budget * 0.85:
            leaderboard.append({'algorithm': name, 'metric': 'silhouette', 'value': None, 'higher_is_better': True, 'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            continue
        t0 = time.time()
        try:
            km = KMeans(n_clusters=k, n_init=5, random_state=42).fit(Xt)
            labels = km.labels_
            if len(set(labels.tolist())) < 2:
                raise RuntimeError('all rows fell into one cluster')
            sil = float(silhouette_score(Xt[sample], labels[sample]) if sample is not None else silhouette_score(Xt, labels))
            leaderboard.append({'algorithm': name, 'metric': 'silhouette', 'value': _safe_float(sil), 'higher_is_better': True, 'fit_seconds': round(time.time() - t0, 2), 'status': 'ok'})
            _log('%s: silhouette=%.4f' % (name, sil))
            if best is None or sil > best[1]:
                best = (k, sil, km)
        except Exception as e:
            leaderboard.append({'algorithm': name, 'metric': 'silhouette', 'value': None, 'higher_is_better': True, 'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('%s failed: %s' % (name, str(e)[:200]))
    if best is None:
        raise RuntimeError('No clustering succeeded. First error: ' + str(leaderboard[0].get('note', 'unknown')))
    leaderboard.sort(key=lambda r: (r['status'] != 'ok', -(r['value'] or -1e18)))
    k, sil, km = best
    pipe = Pipeline([('prep', prepro), ('model', km)])
    profiles = _cluster_profiles(df, km.labels_, schema, features)
    metrics = {'silhouette': _safe_float(sil), 'n_clusters': float(k), 'inertia': _safe_float(km.inertia_), 'clusters': profiles}
    if not fixed:
        warnings_.append('k=%d chosen by silhouette over %s.' % (k, ', '.join(str(x) for x in ks)))
    stats = _feature_stats(df, schema, features)
    payload = {'task': 'clustering', 'algorithm': 'kmeans_k%d' % k, 'pipeline': pipe, 'target': None,
               'features': features, 'dt_cols': dt_cols, 'num_all': num_all, 'cat': cat, 'text': text,
               'classes': None, 'schema': schema, 'prep': prep, 'feature_stats': stats, 'trainer_version': 3}
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    return {'task': 'clustering', 'algorithm': 'kmeans_k%d' % k, 'metrics': metrics, 'primary_metric': 'silhouette',
            'leaderboard': leaderboard, 'feature_importance': [], 'feature_schema': schema, 'feature_stats': stats, 'classes': None,
            'training_rows': n, 'holdout_rows': 0, 'tuning': {'mode': 'none', 'trials': 0}, '_artifact': buf.getvalue()}


def _train_anomaly(df, cfg, warnings_):
    import numpy as np
    from sklearn.ensemble import IsolationForest
    from sklearn.pipeline import Pipeline
    import joblib
    prep, schema, features, prepro, dt_cols, num_all, cat, text, X = _plan_and_prepare(df, cfg, warnings_)
    if len(X) < 20:
        raise RuntimeError('Anomaly detection needs at least 20 rows; found %d.' % len(X))
    # scikit-learn's own threshold flags nothing on a well-behaved table, which
    # reads as a broken detector; two percent is the usual working default.
    cont = float(cfg.get('contamination') or 0.02)
    if not cfg.get('contamination'):
        warnings_.append('The anomaly rate is the setting, not a finding: rows are ranked by how easily they are isolated and the top 2% are flagged. Read the score, and set the share you expect to see.')
    t0 = time.time()
    model = IsolationForest(n_estimators=200, contamination=cont, random_state=42, n_jobs=-1)
    pipe = Pipeline([('prep', prepro), ('model', model)])
    pipe.fit(X)
    flags = pipe.predict(X)
    scores = -pipe.decision_function(X)
    rate = float((np.asarray(flags) == -1).mean())
    metrics = {'anomaly_rate': rate, 'score_threshold': _safe_float(-model.offset_), 'score_mean': _safe_float(np.mean(scores)),
               'score_max': _safe_float(np.max(scores)), 'flagged_rows': float(int((np.asarray(flags) == -1).sum()))}
    leaderboard = [{'algorithm': 'isolation_forest', 'metric': 'anomaly_rate', 'value': rate, 'higher_is_better': False,
                    'fit_seconds': round(time.time() - t0, 2), 'status': 'ok', 'note': 'contamination=%.3f%s' % (cont, '' if cfg.get('contamination') else ' (default)')}]
    _log('isolation forest: %.1f%% of rows flagged' % (rate * 100))
    stats = _feature_stats(df, schema, features)
    payload = {'task': 'anomaly', 'algorithm': 'isolation_forest', 'pipeline': pipe, 'target': None,
               'features': features, 'dt_cols': dt_cols, 'num_all': num_all, 'cat': cat, 'text': text,
               'classes': None, 'schema': schema, 'prep': prep, 'feature_stats': stats, 'trainer_version': 3}
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    return {'task': 'anomaly', 'algorithm': 'isolation_forest', 'metrics': metrics, 'primary_metric': 'anomaly_rate',
            'leaderboard': leaderboard, 'feature_importance': [], 'feature_schema': schema, 'feature_stats': stats, 'classes': None,
            'training_rows': int(len(X)), 'holdout_rows': 0, 'tuning': {'mode': 'none', 'trials': 0}, '_artifact': buf.getvalue()}


def _recommend_for(art, user, n=10):
    seen = set(art['user_items'].get(user, []))
    if not seen:
        return [(it, 0.0) for it in art['popular'][:n]], True
    scores = {}
    for it in seen:
        for other, sim in art['neighbors'].get(it, []):
            if other in seen:
                continue
            scores[other] = scores.get(other, 0.0) + float(sim)
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])[:n]
    if not ranked:
        return [(it, 0.0) for it in art['popular'] if it not in seen][:n], True
    return ranked, False


def _train_recommendation(df, cfg, warnings_):
    import numpy as np
    import pandas as pd
    import joblib
    from scipy import sparse
    ucol, icol, rcol = cfg['user_column'], cfg['item_column'], cfg.get('rating_column')
    d = df[[c for c in [ucol, icol, rcol] if c]].dropna(subset=[ucol, icol]).copy()
    d[ucol] = d[ucol].astype(str)
    d[icol] = d[icol].astype(str)
    d['_w'] = pd.to_numeric(d[rcol], errors='coerce').fillna(1.0).clip(lower=0.0) if rcol else 1.0
    if rcol:
        vals = pd.to_numeric(df[rcol], errors='coerce').dropna()
        if 3 <= vals.nunique() <= 11 and vals.min() >= 0 and vals.max() <= 10 and bool((vals == vals.round()).all()):
            warnings_.append('%s is used as interaction strength: a bigger value is a stronger like, and a low value still counts as a weak one. If low values mean dislike, as on a star scale, filter those rows out before training.' % rcol)
    d = d.groupby([ucol, icol], as_index=False)['_w'].sum()
    users = sorted(d[ucol].unique().tolist())
    items = sorted(d[icol].unique().tolist())
    if len(users) < 5 or len(items) < 3:
        raise RuntimeError('Recommendation needs at least 5 users and 3 items with interactions; found %d users and %d items.' % (len(users), len(items)))
    if len(items) > 20000:
        raise RuntimeError('%d distinct items is more than this recommender handles (20,000). Aggregate items into categories or filter the table.' % len(items))
    uidx = {u: i for i, u in enumerate(users)}
    iidx = {it: j for j, it in enumerate(items)}

    def fit(frame):
        rows = frame[ucol].map(uidx).to_numpy()
        cols = frame[icol].map(iidx).to_numpy()
        vals = frame['_w'].to_numpy(dtype='float64')
        M = sparse.csr_matrix((vals, (rows, cols)), shape=(len(users), len(items)))
        norms = np.sqrt(np.asarray(M.multiply(M).sum(axis=0)).ravel()) + 1e-9
        Mn = sparse.csr_matrix(M.multiply(1.0 / norms))
        S = (Mn.T @ Mn).tocsr()
        S.setdiag(0.0)
        return M, S

    def neighbors_of(S, k=50):
        out = {}
        for j, it in enumerate(items):
            row = S.getrow(j)
            if row.nnz == 0:
                out[it] = []
                continue
            order = np.argsort(-row.data)[:k]
            out[it] = [(items[int(row.indices[t])], float(row.data[t])) for t in order if row.data[t] > 0]
        return out

    # Holdout: one interaction per user with at least two, scored by hit rate at 10.
    rng = np.random.RandomState(42)
    counts = d.groupby(ucol).size()
    eligible = set(counts[counts >= 2].index)
    test_idx = [int(rng.choice(grp.index)) for u, grp in d.groupby(ucol) if u in eligible]
    test = d.loc[test_idx]
    train = d.drop(index=test_idx)
    t0 = time.time()
    _, Str = fit(train)
    art_tr = {'neighbors': neighbors_of(Str), 'user_items': train.groupby(ucol)[icol].apply(list).to_dict(),
              'popular': train.groupby(icol)['_w'].sum().sort_values(ascending=False).index[:50].tolist()}
    hits, evaluated, covered = 0, 0, set()
    for _, r in test.iterrows():
        recs, _cold = _recommend_for(art_tr, r[ucol], 10)
        rec_items = [x for x, _s in recs]
        covered.update(rec_items)
        evaluated += 1
        if r[icol] in rec_items:
            hits += 1
    hit_rate = (hits / evaluated) if evaluated else None
    if not evaluated:
        warnings_.append('No user has two or more interactions, so the hold-out hit rate could not be measured; each row must be one interaction for the metric to mean anything.')
    _log('item similarity: hit@10=%s over %d held-out users' % ('%.3f' % hit_rate if hit_rate is not None else 'n/a', evaluated))
    # Refit on every interaction for serving.
    _, Sall = fit(d)
    neighbors = neighbors_of(Sall)
    popular = d.groupby(icol)['_w'].sum().sort_values(ascending=False).index[:50].tolist()
    user_items = d.groupby(ucol)[icol].apply(list).to_dict()
    metrics = {'hit_rate_10': _safe_float(hit_rate), 'coverage': _safe_float(len(covered) / len(items)) if evaluated else None,
               'n_users': float(len(users)), 'n_items': float(len(items)), 'n_interactions': float(len(d)),
               'evaluated_users': float(evaluated)}
    leaderboard = [{'algorithm': 'item_similarity', 'metric': 'hit_rate_10', 'value': _safe_float(hit_rate), 'higher_is_better': True,
                    'fit_seconds': round(time.time() - t0, 2), 'status': 'ok'}]
    schema = [{'name': ucol, 'dtype': 'categorical', 'role': 'feature', 'categories': users[:200]},
              {'name': icol, 'dtype': 'categorical', 'role': 'target', 'categories': items[:200]}]
    if rcol:
        schema.append({'name': rcol, 'dtype': 'numeric', 'role': 'dropped', 'reason': 'interaction strength'})
    payload = {'task': 'recommendation', 'algorithm': 'item_similarity', 'user_col': ucol, 'item_col': icol,
               'neighbors': neighbors, 'user_items': user_items, 'popular': popular, 'items': items,
               'features': [ucol], 'schema': schema, 'trainer_version': 3}
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    return {'task': 'recommendation', 'algorithm': 'item_similarity', 'metrics': metrics, 'primary_metric': 'hit_rate_10',
            'leaderboard': leaderboard, 'feature_importance': [], 'feature_schema': schema, 'classes': None,
            'training_rows': int(len(train)), 'holdout_rows': int(len(test)), 'tuning': {'mode': 'none', 'trials': 0}, '_artifact': buf.getvalue()}


def _predict_recommendation(art, cfg, warnings_):
    import numpy as np
    import pandas as pd
    # ASKED TO EXPLAIN, AND SAYING SO RATHER THAN RETURNING NOTHING.
    #
    # This path returns before either of the two explain blocks below, so an
    # explained recommendation used to come back with a null explanations
    # field and no word about why: the checkbox was ticked, the request row
    # recorded explain true, and the answer simply had no explanation in it.
    #
    # The ablation those blocks perform replaces one feature value with a
    # typical one and asks the model again. A recommender's answer comes from
    # which items co-occur in OTHER users' histories, not from this row's
    # columns, so there is no cell to replace and nothing the move would mean.
    if cfg.get('explain'):
        warnings_.append("A recommender cannot be explained row by row: the answer comes from which items other users chose together, not from this row's columns.")
    inp = cfg['input']
    ucol = art['user_col']
    if inp['kind'] == 'rows':
        df = pd.DataFrame(inp['rows'])
    else:
        # The app reads the batch (R231). Only this column is wanted, and the
        # duplicates cost nothing to drop here.
        df = _lake_read('input')
        if ucol in df.columns:
            df = df[[ucol]].drop_duplicates()
    if ucol not in df.columns:
        raise RuntimeError('Recommendation input needs the column %s.' % ucol)
    n = int(cfg.get('top_n') or 10)
    preds, scores, cold = [], [], []
    for u in df[ucol].astype(str).tolist():
        recs, is_cold = _recommend_for(art, u, n)
        preds.append(json.dumps([it for it, _s in recs]))
        scores.append(json.dumps([round(sc, 4) for _it, sc in recs]))
        cold.append(bool(is_cold))
    out = pd.DataFrame({ucol: df[ucol].astype(str).tolist(), 'prediction': preds, 'scores': scores, 'cold_start': cold})
    out['_model_version'] = int(cfg['version'])
    out['_predicted_at'] = pd.Timestamp.utcnow().isoformat()
    if any(cold):
        warnings_.append('%d user(s) had no history; they received the most popular items.' % sum(1 for c in cold if c))
    output = cfg.get('output')
    written = None
    if output:
        # Staged as Parquet and loaded by the app, which replaces the table in
        # one transaction and checks the target again before it does (R231).
        _lake_commit([_lake_stage('output', out)])
        written = {'schema': output['schema'], 'table': output['table']}
        _log('wrote %s.%s (%d rows)' % (output['schema'], output['table'], len(out)))
    sample_n = len(out) if inp['kind'] == 'rows' else min(len(out), 50)
    cols = [c for c in out.columns]
    sample = [[_jsonable_cell(v) for v in row] for row in out.head(sample_n).itertuples(index=False, name=None)]
    digest_rows = [[_jsonable_cell(v) for v in row] for row in out[['prediction']].head(1000).itertuples(index=False, name=None)]
    return {'mode': 'predict', 'row_count': int(len(out)), 'total_input_rows': int(len(df)), 'output': written,
            'columns': cols, 'sample': sample, 'digest_columns': ['prediction'], 'digest_rows': digest_rows,
            'algorithm': art.get('algorithm')}


_SEASON = {'h': 24, 'D': 7, 'W': 52, 'MS': 12, 'QS': 4, 'YS': 1}
_FREQ_BY_PERIOD = {'hour': 'h', 'day': 'D', 'week': 'W', 'month': 'MS', 'quarter': 'QS'}
_PERIOD_NAME = {'h': 'hour', 'D': 'day', 'W': 'week', 'MS': 'month', 'QS': 'quarter', 'YS': 'year'}


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


def _calendar(idx, freq):
    # What a period's date says about it, for the lag model (R526): the hour
    # and weekday of an hour, the weekday and month of a day, the month and
    # week of a week, the month of a month, the quarter of a quarter. Numbers,
    # not one-hot columns: a gradient-boosted tree splits them where it needs.
    import pandas as pd
    idx = pd.DatetimeIndex(idx)
    d = {}
    if freq == 'h':
        d['cal_hour'] = idx.hour
        d['cal_dow'] = idx.dayofweek
    elif freq == 'D':
        d['cal_dow'] = idx.dayofweek
        d['cal_month'] = idx.month
    elif freq == 'W':
        d['cal_month'] = idx.month
        d['cal_week'] = idx.isocalendar().week.to_numpy().astype('int64')
    elif freq == 'MS':
        d['cal_month'] = idx.month
    elif freq == 'QS':
        d['cal_quarter'] = idx.quarter
    return pd.DataFrame({k: list(v) for k, v in d.items()}, index=range(len(idx))).astype('float64')


def _lag_frame(y, lags, freq=None, drv=None):
    import numpy as np
    import pandas as pd
    X = pd.DataFrame({'lag_%d' % k: y.shift(k).to_numpy() for k in range(1, lags + 1)})
    X['t'] = np.arange(len(y), dtype='float64')
    if freq:
        cal = _calendar(y.index, freq)
        for c in cal.columns:
            X[c] = cal[c].to_numpy()
    if drv is not None:
        # Known-ahead drivers (R547): each period's own value, as a column.
        for c in drv.columns:
            X['drv_' + str(c)] = drv[c].reindex(y.index).to_numpy(dtype='float64')
    return X


def _lag_forecast(model, history, lags, steps, t_start, future_idx=None, freq=None, drv=None):
    import numpy as np
    import pandas as pd
    hist = list(history)
    cal = _calendar(future_idx, freq) if (freq and future_idx is not None) else None
    out = []
    for i in range(steps):
        row = {'lag_%d' % k: hist[-k] for k in range(1, lags + 1)}
        row['t'] = float(t_start + i)
        if cal is not None:
            for c in cal.columns:
                row[c] = float(cal[c].iloc[i])
        if drv is not None and future_idx is not None:
            for c in drv.columns:
                row['drv_' + str(c)] = float(drv[c].loc[future_idx[i]])
        yhat = float(model.predict(pd.DataFrame([row]))[0])
        out.append(yhat)
        hist.append(yhat)
    return np.array(out)


_MAX_SERIES = 25
_MAX_DRIVERS = 10
_DRIVER_ALGOS = ('gradient_boosting_drivers', 'ridge_drivers')


def _check_drivers(df, drivers, taken):
    # A driver is a number known ahead of time: a planned price, a promotion
    # flag, a holiday count. Refused, with the reason, when it is not one.
    import pandas as pd
    if len(drivers) > _MAX_DRIVERS:
        raise RuntimeError('At most %d drivers; %d were named.' % (_MAX_DRIVERS, len(drivers)))
    for c in drivers:
        if c in taken:
            raise RuntimeError('"%s" is already the time, target or series column, so it cannot also be a driver.' % c)
        if c not in df.columns:
            raise RuntimeError('The driver column "%s" is not in the data.' % c)
        if pd.to_numeric(df[c], errors='coerce').notna().sum() == 0:
            raise RuntimeError('The driver "%s" is not a number in any row: a driver must be numeric (a price, a count, a 0/1 flag).' % c)


def _driver_frame(raw, tcol, drivers, freq, hist_idx, horizon, say):
    # Known-ahead drivers (R547): one value per period for each, the mean of
    # the rows in it, over the history AND the periods ahead. The rows past
    # the last actual carry what the team already knows - a planned price, a
    # promotion, a holiday - with the target left empty.
    import pandas as pd
    d = raw[[tcol] + drivers].dropna(subset=[tcol]).copy()
    for c in drivers:
        d[c] = pd.to_numeric(d[c], errors='coerce')
    per = d.groupby(pd.Grouper(key=tcol, freq=freq))[drivers].mean()
    ahead = pd.date_range(hist_idx[-1], periods=horizon + 1, freq=freq)[1:]
    full = hist_idx.append(ahead)
    per = per.reindex(full)
    gaps = int(per.loc[hist_idx].isna().any(axis=1).sum())
    unknown = int(per.loc[ahead].isna().any(axis=1).sum())
    if gaps:
        say('%d past period(s) had no value for a driver; the nearest known value was used.' % gaps)
    # With none planned at all the caller does not use the drivers, and says
    # so itself; this is for a plan with holes in it.
    if 0 < unknown < horizon:
        say('%d of the %d periods ahead had no value for a driver; the last known value was assumed for them. Add rows past the last actual, with the target empty, to say what is planned.' % (unknown, horizon))
    per = per.ffill().bfill()
    return per, unknown


def _series_values(s, tcol, target, freq, agg, warnings_, label=None):
    # One value per period for one series: the total, or one series of many.
    import pandas as pd
    say = (lambda m: warnings_.append(m)) if label is None else (lambda m: warnings_.append('%s: %s' % (label, m)))
    g = s.groupby(pd.Grouper(key=tcol, freq=freq))[target]
    y = (g.sum() if agg == 'sum' else g.mean()).astype('float64').asfreq(freq)
    # A period the data only partly covers - the month the extract stopped
    # in - understates a total and misleads every candidate; leave it out.
    counts = g.size().reindex(y.index).fillna(0)
    mid = counts.iloc[1:-1]
    typical = float(mid[mid > 0].median() or 0) if len(y) > 3 and (mid > 0).any() else 0.0
    if typical > 0 and counts.iloc[-1] > 0 and counts.iloc[-1] < 0.5 * typical:
        say('The last period (%s) had %d rows against a typical %d and was left out as incomplete.' % (_period_label(y.index[-1], freq), int(counts.iloc[-1]), int(typical)))
        y = y.iloc[:-1]
    if typical > 0 and counts.iloc[0] > 0 and counts.iloc[0] < 0.5 * typical:
        say('The first period (%s) had %d rows against a typical %d and was left out as incomplete.' % (_period_label(y.index[0], freq), int(counts.iloc[0]), int(typical)))
        y = y.iloc[1:]
    empty = int((counts.reindex(y.index).fillna(0) == 0).sum())
    gaps = int(y.isna().sum())
    if agg == 'sum' and empty:
        # No rows in a period is a total of zero, not a value to guess at.
        say('%d empty period(s) had no rows and count as 0. If they are missing data rather than quiet periods, fill them in a prep flow first.' % empty)
        y = y.fillna(0.0)
    elif gaps:
        say('%d empty period(s) were filled by interpolation.' % gaps)
        y = y.interpolate(limit_direction='both')
    if len(y) < 8:
        raise RuntimeError('After aggregating to one value per %s period only %d periods remain; at least 8 are needed.' % (freq, len(y)))
    return y


def _backtest_windows(n, holdout, min_train):
    # Up to three windows, newest first, each one holdout long and
    # trained on everything before it. One window chose a method on one
    # stretch of history; three see whether its advantage holds (R526).
    out = []
    for k in range(3):
        end = n - k * holdout
        start = end - holdout
        if start < min_train:
            break
        out.append((start, end))
    return out


def _forecast_one(y, freq, horizon, budget, warnings_, label=None, drv=None):
    import numpy as np
    import pandas as pd
    say = (lambda m: warnings_.append(m)) if label is None else (lambda m: warnings_.append('%s: %s' % (label, m)))
    season = _SEASON.get(freq)
    if season and season > 1 and len(y) < 2 * season + 2:
        say('Not enough history for a %d-period season; seasonality was not modelled.' % season)
        season = None
    if season == 1:
        season = None
    holdout = max(1, min(horizon, len(y) // 5))
    if len(y) >= 12:
        # One or two points cannot tell a flat line from a trend; three is
        # the least worth choosing a method on.
        holdout = max(holdout, 3)
    min_train = max(8, 2 * season + 2 if season else 8)
    windows = _backtest_windows(len(y), holdout, min_train) or [(len(y) - holdout, len(y))]
    lags = int(max(1, min(season or 7, max(1, windows[-1][0] // 3))))
    _log('%sseries: %d periods at %s, season=%s, holdout=%d x %d window(s), horizon=%d' % (
        (label + ' ') if label else '', len(y), freq, season, holdout, len(windows), horizon))

    leaderboard, best = [], None

    def rmse(a, b):
        return float(np.sqrt(np.mean((np.asarray(a, dtype='float64') - np.asarray(b, dtype='float64')) ** 2)))

    def consider(name, fit):
        nonlocal best
        if leaderboard and _elapsed() > budget * 0.85:
            leaderboard.append({'algorithm': name, 'metric': 'rmse', 'value': None, 'higher_is_better': False, 'fit_seconds': 0.0, 'status': 'skipped', 'note': 'time budget spent'})
            return
        t0 = time.time()
        try:
            scores, resid = [], []
            for start, end in windows:
                tr, te = y.iloc[:start], y.iloc[start:end]
                pred = np.asarray(fit(tr, len(te)), dtype='float64')
                scores.append(rmse(te.to_numpy(), pred))
                resid.extend((te.to_numpy() - pred).tolist())
            score = float(np.mean(scores))
            leaderboard.append({'algorithm': name, 'metric': 'rmse', 'value': _safe_float(score), 'higher_is_better': False,
                                'fit_seconds': round(time.time() - t0, 2), 'status': 'ok', 'windows': len(windows)})
            _log('%s: rmse=%.4f over %d window(s)' % (name, score, len(windows)))
            if best is None or score < best[1]:
                best = (name, score, fit, np.asarray(resid, dtype='float64'))
        except Exception as e:
            leaderboard.append({'algorithm': name, 'metric': 'rmse', 'value': None, 'higher_is_better': False, 'fit_seconds': round(time.time() - t0, 2), 'status': 'failed', 'note': str(e)[:200]})
            _log('%s failed: %s' % (name, str(e)[:200]))

    def future_index(tr, steps):
        return pd.date_range(tr.index[-1], periods=steps + 1, freq=freq)[1:]

    def naive(tr, steps):
        return np.repeat(float(tr.iloc[-1]), steps)

    def moving_average(tr, steps):
        k = int(max(2, min(season or 7, len(tr))))
        return np.repeat(float(tr.iloc[-k:].mean()), steps)

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
        X = _lag_frame(tr, lags, freq).iloc[lags:]
        m = HistGradientBoostingRegressor(random_state=42, max_iter=300)
        m.fit(X, tr.to_numpy()[lags:])
        return _lag_forecast(m, tr.to_numpy(), lags, steps, len(tr), future_index(tr, steps), freq)

    def lag_model_drivers(tr, steps):
        # The same lag model, told each period's drivers (R547). In a backtest
        # the drivers of the held-out periods are their actual values, which
        # is what known ahead means.
        from sklearn.ensemble import HistGradientBoostingRegressor
        X = _lag_frame(tr, lags, freq, drv).iloc[lags:]
        m = HistGradientBoostingRegressor(random_state=42, max_iter=300)
        m.fit(X, tr.to_numpy()[lags:])
        return _lag_forecast(m, tr.to_numpy(), lags, steps, len(tr), future_index(tr, steps), freq, drv)

    def ridge_drivers(tr, steps):
        # A straight line through time and the drivers: for a short history,
        # where the lag model has too few rows to learn from.
        from sklearn.linear_model import Ridge
        def frame(idx, start):
            X = pd.DataFrame({'t': np.arange(start, start + len(idx), dtype='float64')})
            for c in drv.columns:
                X['drv_' + str(c)] = drv[c].reindex(idx).to_numpy(dtype='float64')
            return X
        m = Ridge(alpha=1.0).fit(frame(tr.index, 0), tr.to_numpy())
        return m.predict(frame(future_index(tr, steps), len(tr)))

    consider('naive_last_value', naive)
    consider('moving_average', moving_average)
    if season:
        consider('seasonal_naive', seasonal_naive)
    consider('holt_winters', holt_winters)
    if windows[-1][0] > lags + 10:
        consider('gradient_boosting_lags', lag_model)
    if drv is not None:
        consider('ridge_drivers', ridge_drivers)
        if windows[-1][0] > lags + 10:
            consider('gradient_boosting_drivers', lag_model_drivers)
    if best is None:
        raise RuntimeError('Every forecasting candidate failed. First error: ' + str(leaderboard[0].get('note', 'unknown')))
    leaderboard.sort(key=lambda r: (r['status'] != 'ok', r['value'] if r['value'] is not None else 1e18))
    name, score, fit, resid = best

    # Refit the winner on the whole series and project the horizon. The band
    # is the backtest residual spread widened by sqrt(k): an honest, simple
    # interval that says less the further out it goes.
    sigma = float(np.std(resid)) if len(resid) > 1 else float(abs(resid[0])) if len(resid) else 0.0
    yhat = np.asarray(fit(y, horizon), dtype='float64')
    idx = future_index(y, horizon)
    nonneg = bool((y >= 0).all())
    floored = False
    forecast = []
    for k in range(horizon):
        w = 1.96 * sigma * math.sqrt(k + 1)
        point, lo, hi = float(yhat[k]), float(yhat[k] - w), float(yhat[k] + w)
        if nonneg:
            floored = floored or point < 0
            point, lo, hi = max(point, 0.0), max(lo, 0.0), max(hi, 0.0)
        forecast.append({'period': _period_label(idx[k], freq), 'yhat': _safe_float(point) or 0.0,
                         'lo': _safe_float(lo) or 0.0, 'hi': _safe_float(hi) or 0.0})
    if floored:
        say('Projected values below 0 were floored at 0: the history never goes below it.')
    actual = np.concatenate([y.iloc[s:e].to_numpy() for s, e in windows])
    mask = actual != 0
    metrics = {
        'rmse': _safe_float(score),
        'mae': _safe_float(np.mean(np.abs(resid))),
        'mape': _safe_float(np.mean(np.abs(resid[mask] / actual[mask])) * 100) if mask.any() else None,
        'holdout_periods': float(holdout),
        'backtest_windows': float(len(windows)),
    }
    # What the drivers were worth (R547): the best backtest with them against
    # the best without, so a driver that did not help is seen not to.
    effect = None
    if drv is not None:
        ok = [r for r in leaderboard if r['status'] == 'ok' and r['value'] is not None]
        w = [r['value'] for r in ok if r['algorithm'] in _DRIVER_ALGOS]
        wo = [r['value'] for r in ok if r['algorithm'] not in _DRIVER_ALGOS]
        effect = {'with': min(w) if w else None, 'without': min(wo) if wo else None,
                  'used': name in _DRIVER_ALGOS}
    return {'algorithm': name, 'season': season, 'lags': lags, 'sigma': sigma, 'holdout': holdout,
            'windows': len(windows), 'metrics': metrics, 'leaderboard': leaderboard, 'forecast': forecast,
            'y': y, 'fit': fit, 'drivers_effect': effect}


def _train_forecast(df, cfg, warnings_):
    import numpy as np
    import pandas as pd
    import joblib
    tcol, target = cfg['time_column'], cfg['target_column']
    scol = cfg.get('series_column') or None
    horizon = int(cfg.get('horizon') or 12)
    agg = cfg.get('aggregation') or 'sum'
    budget = float(cfg.get('time_budget_minutes') or 30) * 60.0
    # Known-ahead drivers (R547): a forecast's feature columns.
    drivers = [c for c in (cfg.get('feature_columns') or []) if c]
    cols = [tcol, target] + ([scol] if scol else [])
    if scol and scol not in df.columns:
        raise RuntimeError('The series column "%s" is not in the data.' % scol)
    _check_drivers(df, drivers, set(cols))
    raw = df[cols + drivers].copy()
    raw[tcol] = pd.to_datetime(raw[tcol], errors='coerce')
    if scol:
        raw[scol] = raw[scol].fillna('(blank)').astype(str)
    s = raw[cols].copy()
    s[target] = pd.to_numeric(s[target], errors='coerce')
    # Rows with no target are dropped from the history; with drivers, those
    # past the last actual are where the planned values come from.
    s = s.dropna(subset=[tcol, target])
    if len(s) < 8:
        raise RuntimeError('Forecasting needs at least 8 dated rows with a numeric target; found %d.' % len(s))
    # The period is the user's choice; 'auto' keeps the inference from the
    # gaps between timestamps, which turns dated orders into a daily series.
    freq = _FREQ_BY_PERIOD.get(cfg.get('period') or 'auto') or _infer_freq(s[tcol])
    y = _series_values(s, tcol, target, freq, agg, warnings_)
    drv, assumed, unplanned = (None, 0, False)
    if drivers:
        drv, assumed = _driver_frame(raw, tcol, drivers, freq, y.index, horizon, warnings_.append)
        if assumed >= horizon:
            # FOUND FROM THE UI (R547): with no period ahead planned, the
            # drivers' backtest edge came from knowing values the forecast will
            # not have, so they are not used.
            warnings_.append('None of the %d periods ahead had a planned value for the drivers, so the forecast does not use them. Put the planned values in rows past the last actual, with the target empty.' % horizon)
            drv, unplanned = None, True
    one = _forecast_one(y, freq, horizon, budget, warnings_, drv=drv)

    # Many series (R526): one forecast per value of the series column, each
    # with its own winner, beside the total above. The largest by volume come
    # first; past _MAX_SERIES the rest are named in a warning, not forecast.
    series_out, series_note = [], None
    if scol:
        volume = s.groupby(scol)[target].apply(lambda v: float(np.abs(v).sum())).sort_values(ascending=False)
        chosen = list(volume.index[:_MAX_SERIES])
        if len(volume) > _MAX_SERIES:
            series_note = '%d series in "%s"; the %d largest by volume were forecast one by one, the other %d count only in the total.' % (len(volume), scol, _MAX_SERIES, len(volume) - _MAX_SERIES)
            warnings_.append(series_note)
        per_budget = budget
        for key in chosen:
            sub = s[s[scol] == key]
            try:
                yk = _series_values(sub, tcol, target, freq, agg, warnings_, label=key)
                drvk = None
                if drivers:
                    drvk, gone = _driver_frame(raw[raw[scol] == key], tcol, drivers, freq, yk.index, horizon,
                                               lambda m, k=key: warnings_.append('%s: %s' % (k, m)))
                    if gone >= horizon:
                        drvk = None
                r = _forecast_one(yk, freq, horizon, per_budget, warnings_, label=key, drv=drvk)
                series_out.append({'key': key, 'algorithm': r['algorithm'], 'rmse': r['metrics']['rmse'],
                                   'periods': int(len(yk)), 'forecast': r['forecast'],
                                   'history': [{'period': _period_label(t, freq), 'y': _safe_float(v) or 0.0} for t, v in yk.tail(120).items()]})
            except Exception as e:
                warnings_.append('%s: not forecast on its own - %s' % (key, str(e)[:160]))

    warnings_.append('Prediction intervals are residual-based (backtest spread x 1.96 x sqrt(steps ahead)), not model-derived.')
    name, season, lags = one['algorithm'], one['season'], one['lags']
    history = [{'period': _period_label(t, freq), 'y': _safe_float(v) or 0.0} for t, v in y.tail(240).items()]
    payload = {'task': 'forecast', 'algorithm': name, 'freq': freq, 'season': season, 'lags': lags,
               'aggregation': agg, 'time_column': tcol, 'target': target, 'sigma': one['sigma'],
               'series_column': scol, 'series': [x['key'] for x in series_out],
               'y_tail': y.tail(max(lags, season or 0, 1) + 1).to_numpy().tolist(),
               'last_period': _period_label(y.index[-1], freq), 'drivers': drivers, 'trainer_version': 4}
    if name in ('gradient_boosting_lags', 'gradient_boosting_drivers'):
        from sklearn.ensemble import HistGradientBoostingRegressor
        X = _lag_frame(y, lags, freq, drv if name == 'gradient_boosting_drivers' else None).iloc[lags:]
        m = HistGradientBoostingRegressor(random_state=42, max_iter=300)
        m.fit(X, y.to_numpy()[lags:])
        payload['model'] = m
    buf = io.BytesIO()
    joblib.dump(payload, buf, compress=3)
    schema = [
        {'name': tcol, 'dtype': 'datetime', 'role': 'time'},
        {'name': target, 'dtype': 'numeric', 'role': 'target'},
    ] + ([{'name': scol, 'dtype': 'categorical', 'role': 'series'}] if scol else []) \
      + [{'name': c, 'dtype': 'numeric', 'role': 'driver'} for c in drivers]
    return {
        'task': 'forecast', 'algorithm': name, 'metrics': one['metrics'], 'primary_metric': 'rmse',
        'leaderboard': one['leaderboard'], 'feature_importance': [], 'feature_schema': schema,
        'training_rows': int(len(y) - one['holdout']), 'holdout_rows': int(one['holdout']), 'forecast': one['forecast'],
        'history': history, 'series_forecasts': series_out,
        'series_meta': {'freq': freq, 'period': _PERIOD_NAME.get(freq, freq), 'season_length': season, 'aggregation': agg,
                        'last_period': _period_label(y.index[-1], freq), 'periods': int(len(y)),
                        'backtest_windows': one['windows'], 'series_column': scol,
                        'series_count': int(s[scol].nunique()) if scol else None, 'series_forecast': len(series_out) if scol else None,
                        'drivers': drivers, 'drivers_effect': one['drivers_effect'], 'drivers_assumed': assumed,
                        'drivers_unplanned': unplanned},
        'tuning': {'mode': 'none', 'trials': 0}, '_artifact': buf.getvalue(),
    }


# ── The lakehouse, through the app ───────────────────────────────────────────
def _lake_read_meta(node_id):
    """A declared read, with what the app decided about it.

    The plain _lake_read returns the frame; a trainer also needs to say how
    many rows the source held and whether it was sampled, and those are the
    app's answers, not this container's.
    """
    import duckdb, requests, shutil, tempfile
    out = _lake_call('lake_read', {'id': node_id})
    tmp = tempfile.mkdtemp()
    try:
        paths = []
        for i, f in enumerate(out['files']):
            path = os.path.join(tmp, str(i) + '.parquet')
            with requests.get(f['get'], stream=True, timeout=3600) as g:
                g.raise_for_status()
                with open(path, 'wb') as fh:
                    shutil.copyfileobj(g.raw, fh)
            paths.append(path)
            try:
                requests.delete(f['delete'], timeout=60)
            except Exception:
                pass
        con = duckdb.connect()
        try:
            frame = con.execute('SELECT * FROM read_parquet(' + _lake_sql_list(paths) + ')').df()
        finally:
            con.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {'frame': frame, 'total': int(out.get('total') or len(frame)), 'sampled': bool(out.get('sampled'))}


def _lake_artifact(which, uri):
    # The URL, and the headers it is signed with: under the owner's customer
    # key a put carries them, or the store refuses it (R442).
    return _lake_call('lake_artifact', {'which': which, 'uri': uri})


# ── Model artifacts ──────────────────────────────────────────────────────────
def _upload(blob):
    # R231: no storage credential here. The app signs one URL for this run's
    # own artifact, asked for at the moment there is a model to write — a
    # training job can run for hours, and a URL handed out at the start would
    # have expired by then.
    import requests
    uri = os.environ['ML_ARTIFACT_URI']
    a = _lake_artifact('put', uri)
    r = requests.put(a['url'], data=blob, headers=a.get('headers') or {}, timeout=3600)
    r.raise_for_status()
    return uri


def _fetch_artifact(uri):
    import requests
    r = requests.get(_lake_artifact('get', uri)['url'], timeout=3600)
    r.raise_for_status()
    return r.content


def _download_artifact(cfg):
    import joblib
    blob = _fetch_artifact(cfg['artifact_uri'])
    sha = hashlib.sha256(blob).hexdigest()
    if sha != cfg['artifact_sha256']:
        raise RuntimeError('Artifact digest mismatch: the registry recorded %s but the stored file hashes to %s. Refusing to predict with it.'
                           % (cfg['artifact_sha256'][:12], sha[:12]))
    return joblib.load(io.BytesIO(blob))


def _paste(pipes, task):
    """Several pipelines fitted on disjoint rows, answering as one model.

    A FUNCTION RETURNING A NAMESPACE, not a class, and deliberately: a class
    defined in this program pickles by reference to a module that does not
    exist when the artifact is loaded, which is why the program only uses
    functions. Nothing here is ever pickled — the artifact stores a plain list
    of pipelines and this wraps them when the model is read.

    Averaging PROBABILITIES rather than voting on labels, because a vote
    throws away how sure each worker was, and three timid agreements should
    not outweigh one confident disagreement.
    """
    import numpy as np
    from types import SimpleNamespace
    parts = [p for p in pipes if p is not None]
    if not parts:
        raise RuntimeError('This model has no fitted parts to answer with.')

    # THE UNION of what the workers saw, in one order. A rare class can be
    # missing from one worker's share of the rows entirely, and averaging
    # those probability matrices column by column would line up different
    # classes with each other and report the result as a confident answer.
    # getattr(...) or [] would evaluate the TRUTH of a numpy array, which
    # raises "the truth value of an array with more than one element is
    # ambiguous". classes_ is always an array, so the fallback has to be
    # chosen by identity rather than by truthiness.
    seen = []
    for part in parts:
        cls = getattr(part, 'classes_', None)
        for c in (list(cls) if cls is not None else []):
            if not any(c == k for k in seen):
                seen.append(c)
    try:
        seen = sorted(seen)
    except Exception:
        pass

    def _proba(X):
        index = dict((c, i) for i, c in enumerate(seen))
        out = np.zeros((len(X), len(seen)), dtype='float64')
        for part in parts:
            pr = part.predict_proba(X)
            for j, c in enumerate(list(part.classes_)):
                out[:, index[c]] += pr[:, j]
        return out / float(len(parts))

    def _pred(X):
        if task == 'classification':
            return np.asarray(seen)[np.argmax(_proba(X), axis=1)]
        return np.mean([part.predict(X) for part in parts], axis=0)

    return SimpleNamespace(predict=_pred, predict_proba=_proba, classes_=seen, parts=parts)


# ── What this ran under ──────────────────────────────────────────────────────
def _runtime():
    """The library versions this program ran under (R533).

    Recorded with every version it makes, because a pickled pipeline loads
    reliably only under the scikit-learn that wrote it: an MLflow export pins
    exactly these.
    """
    import platform
    out = {'python': platform.python_version()}
    for name, mod in (('scikit-learn', 'sklearn'), ('lightgbm', 'lightgbm'), ('numpy', 'numpy'),
                      ('pandas', 'pandas'), ('joblib', 'joblib'), ('scipy', 'scipy')):
        try:
            out[name] = str(__import__(mod).__version__)
        except Exception:
            pass
    # Only when the search loaded it (a GPU sandbox, R537); an export then
    # lists it only for a model that holds an XGBoost estimator.
    if 'xgboost' in sys.modules:
        try:
            out['xgboost'] = str(sys.modules['xgboost'].__version__)
        except Exception:
            pass
    return out


# ── Importing a model trained elsewhere (MLflow) ─────────────────────────────
def _estimator_name(est):
    steps = getattr(est, 'steps', None)
    if steps:
        return type(steps[-1][1]).__name__
    return type(est).__name__


# A skops file is opened type by type (R536). skops trusts a set of types of
# its own (scikit-learn's estimators, numpy, scipy, builtins) and names any
# other type the file needs. Beyond that set, this platform admits:
#   - classes scikit-learn itself defines. Its trees (sklearn.tree._tree.Tree)
#     and histogram predictors are not on skops' list, so no forest or boosted
#     model loads without them;
#   - LightGBM's scikit-learn estimators, which the trainer here uses too.
# Never the file's own skops_trusted_types: a crafted file lists builtins.eval.
_SKOPS_PIN = 'skops==0.16.0'
_SKOPS_ALSO = frozenset(('collections.OrderedDict', 'lightgbm.basic.Booster',
                         'lightgbm.sklearn.LGBMClassifier', 'lightgbm.sklearn.LGBMRegressor'))
_SKOPS_NEVER = ('sklearn.externals.', 'sklearn.utils._testing', 'sklearn.utils._mocking',
                'sklearn.conftest', 'sklearn.tests.')
_DOTTED = _re.compile(r'[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+')


def _skops_trustable(name):
    """Whether this platform admits one type a skops file needs (R536).

    A scikit-learn class is looked up and has to BE the class it is named as:
    a name another module's object is re-exported under (joblib's Memory is
    importable as sklearn.utils._joblib.Memory) is refused, as is anything
    that is not a class (a function or a method runs when it is called, and
    the file chose what it is called with). Vendored code and test helpers
    are refused even though they live under sklearn.
    """
    import importlib
    import inspect
    if not isinstance(name, str) or len(name) > 200 or not _DOTTED.fullmatch(name):
        return False
    if name in _SKOPS_ALSO:
        return True
    if not name.startswith('sklearn.') or '.tests.' in name:
        return False
    if any(name.startswith(p) for p in _SKOPS_NEVER):
        return False
    mod, _, attr = name.rpartition('.')
    try:
        obj = getattr(importlib.import_module(mod), attr)
    except Exception:
        return False
    return inspect.isclass(obj) and '%s.%s' % (getattr(obj, '__module__', ''), getattr(obj, '__qualname__', '')) == name


def _skops_io():
    try:
        import skops.io as sio
        return sio
    except Exception:
        pass
    _log('installing skops (this runtime image predates it)')
    p = subprocess.run([sys.executable, '-m', 'pip', 'install', '--user', '--no-input', '-q', _SKOPS_PIN],
                       capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stdout[-1000:], p.stderr[-1000:])
        raise RuntimeError('This runtime has no skops, and installing it failed (see the output above). '
                           'Rebuild the runtime image, or save the model with serialization_format="cloudpickle".')
    import site as _site
    _site.addsitedir(_site.getusersitepackages())
    import importlib as _il
    _il.invalidate_caches()
    import skops.io as sio
    return sio


def _skops_load(blob):
    """The estimator in a skops file, and the types admitted to open it (R536)."""
    sio = _skops_io()
    try:
        needed = [str(t) for t in sio.get_untrusted_types(data=blob)]
    except Exception as e:
        raise RuntimeError('The model file could not be read as skops: %s' % str(e)[:300])
    admitted = sorted(t for t in set(needed) if _skops_trustable(t))
    refused = sorted(t for t in set(needed) if t not in admitted)
    if refused:
        more = (' and %d more' % (len(refused) - 10)) if len(refused) > 10 else ''
        raise RuntimeError(
            'The model file needs types this platform does not open: %s%s. A skops file is opened type by '
            'type, and only scikit-learn classes and LightGBM estimators are admitted beyond skops\' own. '
            'Saved with serialization_format="cloudpickle" instead, it imports as a pickle, which is opened '
            'only in a sandbox.' % (', '.join(refused[:10]), more))
    try:
        est = sio.loads(blob, trusted=admitted or None)
    except Exception as e:
        raise RuntimeError('The skops file could not be opened: %s' % str(e)[:300])
    if admitted:
        _log('skops: admitted %s beyond its own trusted types' % ', '.join(admitted))
    return est, admitted


def _import_model(cfg, warnings_):
    """An MLflow model trained elsewhere, made a version of this model (R533).

    Opened HERE, in the sandbox, and never in the app: loading a pickle runs
    whatever it holds. The app read only the MLmodel file and staged the
    model file in the lake; this checks it is that file, loads it, checks it
    can do what this model's task needs, and writes the version's artifact.

    A model AgentSwarms exported comes back byte for byte: its data file IS
    an artifact, so the version it becomes has the digest it left with.
    """
    import pickle
    import joblib
    imp = cfg['import']
    task = cfg['task']
    skops_trusted = None
    blob = _fetch_artifact(imp['uri'])
    if hashlib.sha256(blob).hexdigest() != imp['sha256']:
        raise RuntimeError('The uploaded model file is not the one that was checked when it arrived. Import it again.')
    sig = imp.get('features') or None
    if imp['kind'] == 'agentswarms':
        art = joblib.load(io.BytesIO(blob))
        if not isinstance(art, dict) or 'pipeline' not in art or 'features' not in art:
            raise RuntimeError('This MLflow model says it came from AgentSwarms, but its data file is not a model artifact.')
        if art.get('task') != task:
            raise RuntimeError('This model was exported from a %s model, so it can only be imported into a %s model, not this %s one.'
                               % (art.get('task'), art.get('task'), task))
        out = blob
        algorithm = str(art.get('algorithm') or 'imported')
        features = [str(f) for f in art['features']]
        dtypes = dict((f['name'], f['dtype']) for f in (sig or []))
        schema = [{'name': f, 'dtype': dtypes.get(f, 'numeric'), 'role': 'feature'} for f in features]
    else:
        serialization = imp.get('serialization') or 'cloudpickle'
        if serialization == 'cloudpickle':
            # cloudpickle writes ordinary pickles; only a model holding a
            # lambda or a class defined in a notebook needs it to load.
            try:
                import cloudpickle  # noqa: F401
            except Exception:
                try:
                    from joblib.externals import cloudpickle as _cp
                    sys.modules.setdefault('cloudpickle', _cp)
                except Exception:
                    pass
        import warnings as _w
        with _w.catch_warnings(record=True) as caught:
            _w.simplefilter('always')
            if serialization == 'skops':
                # Never a pickle: skops builds the objects from its schema,
                # and only from types checked here (R536).
                est, skops_trusted = _skops_load(blob)
            else:
                est = pickle.loads(blob)
        for w in caught:
            text = str(w.message)
            if 'version' in text.lower():
                warnings_.append('Loaded under a different scikit-learn than it was saved with: %s' % text[:300])
        if not hasattr(est, 'predict'):
            raise RuntimeError('The model file holds a %s, which cannot predict.' % type(est).__name__)
        if sig:
            features = [str(f['name']) for f in sig]
            schema = [{'name': str(f['name']), 'dtype': f['dtype'], 'role': 'feature'} for f in sig]
        else:
            names = getattr(est, 'feature_names_in_', None)
            if names is None:
                raise RuntimeError('The model has no signature and does not name its input columns. Log it again with a signature (mlflow.models.infer_signature).')
            features = [str(n) for n in names]
            schema = [{'name': n, 'dtype': 'numeric', 'role': 'feature'} for n in features]
        classes = None
        if task == 'classification':
            cls = getattr(est, 'classes_', None)
            if cls is None:
                raise RuntimeError('A classification model has to know its classes (classes_), and this one does not.')
            classes = [str(c) for c in list(cls)]
        if task == 'anomaly' and not hasattr(est, 'decision_function'):
            raise RuntimeError('An anomaly model has to score how unusual a row is (decision_function), and this one cannot.')
        algorithm = 'mlflow:' + _estimator_name(est)
        payload = {'task': task, 'algorithm': algorithm, 'pipeline': est, 'features': features,
                   'classes': classes, 'external': True,
                   'imported': {'format': 'mlflow', 'flavor': imp.get('flavor'),
                                'serialization': serialization,
                                'sklearn_version': imp.get('sklearn_version')}}
        buf = io.BytesIO()
        joblib.dump(payload, buf, compress=3)
        out = buf.getvalue()
    sha = hashlib.sha256(out).hexdigest()
    _log('uploading the imported model (%d bytes)' % len(out))
    uri = _upload(out)
    # 'metrics' empty but present, as an assembled model's: an imported model
    # has no score of its own here until it is evaluated.
    out_ = {'ok': True, 'mode': 'import', 'algorithm': algorithm, 'primary_metric': None, 'metrics': {},
            'leaderboard': [], 'feature_importance': [], 'feature_schema': schema, 'feature_stats': None,
            'artifact_uri': uri, 'artifact_sha256': sha, 'artifact_bytes': len(out),
            'training_rows': 0, 'training_total_rows': 0, 'training_sampled': False}
    if skops_trusted is not None:
        out_['skops_trusted'] = skops_trusted
    return out_


# ── Prediction ───────────────────────────────────────────────────────────────
def _predict(cfg, warnings_):
    import numpy as np
    import pandas as pd
    art = _download_artifact(cfg)
    if art.get('task') == 'forecast':
        raise RuntimeError('Forecast models are served from their training forecast; retrain with a different horizon to change it.')
    if art.get('task') == 'recommendation':
        return _predict_recommendation(art, cfg, warnings_)
    inp = cfg['input']
    if inp['kind'] == 'rows':
        df = pd.DataFrame(inp['rows'])
        total = len(df)
    else:
        # The app reads the batch and enforces the row limit, as the model's
        # owner and through the owners' policies (R231).
        out = _lake_read_meta('input')
        df, total = out['frame'], out['total']
        _log('read %d row(s) to score' % total)
    if len(df) == 0:
        raise RuntimeError('No rows to score.')
    # Ten rows is the least a distribution can be compared on.
    drift = _drift(art.get('feature_stats'), df) if len(df) >= 10 else None
    missing = [f for f in art['features'] if f not in df.columns]
    if missing:
        warnings_.append('Input is missing %d feature column(s), treated as empty: %s' % (len(missing), ', '.join(missing[:8])))
    if art.get('external'):
        # Registered from outside: the pipeline owns its own preprocessing.
        def _prep(frame):
            return frame[list(art['features'])]
    else:
        def _prep(frame):
            return _prepare_x(frame, art['features'], art['dt_cols'], art['num_all'], art['cat'], art.get('text') or [])
    X = _prep(df)
    pipe = art['pipeline']
    # A model trained across containers stores a LIST. Wrapped here rather
    # than at every call site so there is still one scoring path.
    if isinstance(pipe, list):
        pipe = _paste(pipe, art.get('task'))
    pred = pipe.predict(X)
    out = df.copy()
    classes = art.get('classes')
    task = art.get('task')
    if task == 'clustering':
        out['prediction'] = np.asarray(pred, dtype='int64')
        if not art.get('external'):
            Xt = pipe.named_steps['prep'].transform(X)
            out['distance'] = np.min(pipe.named_steps['model'].transform(Xt), axis=1)
    elif task == 'anomaly':
        out['prediction'] = (np.asarray(pred) == -1).astype('int64')
        out['anomaly_score'] = -pipe.decision_function(X)
    elif classes:
        # The platform's own trainer predicts a class INDEX; a pipeline
        # registered from outside predicts the LABEL itself, because that is
        # what sklearn's predict() returns. Accept both rather than making the
        # author encode indices nothing else in their notebook uses.
        # A model from outside whose classes ARE numbers (1, 2, 3) predicts
        # the label, and reading it as an index would answer 2 for 1 (R533).
        own = set(str(c) for c in classes) if art.get('external') else set()

        def _label(i):
            if str(i) in own:
                return str(i)
            try:
                k = int(i)
            except (TypeError, ValueError):
                return str(i)
            return classes[k] if 0 <= k < len(classes) else str(i)
        out['prediction'] = [_label(i) for i in pred]
        if hasattr(pipe, 'predict_proba'):
            proba = pipe.predict_proba(X)
            # A chosen operating point, for a binary model whose owner set one.
            #
            # argmax is a threshold of 0.5 nobody picked, and it is the wrong
            # one wherever the two mistakes cost different amounts. The line
            # lives on the VERSION rather than in this artifact, so moving it
            # is a setting rather than a retrain — which is why it arrives in
            # the config and is applied here instead of being baked in.
            thr = cfg.get('decision_threshold')
            if thr is not None and len(classes) == 2:
                want = cfg.get('positive_label')
                names = [str(c) for c in classes]
                pos = names.index(str(want)) if str(want) in names else 1
                hit = proba[:, pos] >= float(thr)
                other = 1 - pos
                out['prediction'] = [names[pos] if h else names[other] for h in hit]
                # The probability shown stays the probability OF THE ANSWER, so
                # a row declined at 0.45 does not report 0.55 confidence in a
                # decision nobody made.
                out['probability'] = np.where(hit, proba[:, pos], proba[:, other])
                out['threshold_applied'] = float(thr)
            else:
                out['probability'] = np.max(proba, axis=1)
            if len(classes) <= 20:
                for j, c in enumerate(classes):
                    out['proba_' + _re.sub(r'[^0-9A-Za-z_]+', '_', str(c))[:40]] = proba[:, j]
    else:
        out['prediction'] = np.asarray(pred, dtype='float64')
    out['_model_version'] = int(cfg['version'])
    out['_predicted_at'] = pd.Timestamp.utcnow().isoformat()
    _log('scored %d rows with %s v%d' % (len(out), art.get('algorithm'), int(cfg['version'])))

    # REASON CODES ON EVERY SCORED ROW, when asked for and when there is a
    # table to put them in. Before the write, so they are columns of the
    # scored table rather than something a reader has to join back later.
    if cfg.get('explain') and cfg.get('output'):
        try:
            rk = int(cfg.get('explain_top_k') or 3)
            reasons = _reason_codes(art, df, pipe, _prep, task, classes, rk,
                                    int(cfg.get('explain_chunk_rows') or 2000), warnings_)
            if reasons is not None:
                for col, vals in _reason_frame(reasons, rk).items():
                    out[col] = vals
                _log('wrote %d reason columns for %d rows' % (rk * 2, len(out)))
            else:
                warnings_.append('This model cannot be explained row by row, so no reason codes were written.')
        except Exception as e:
            # The scored rows are the deliverable; reasons are an addition to
            # them. A failure here must not throw away a batch that scored.
            warnings_.append('Reason codes could not be computed: %s' % str(e)[:200])

    output = cfg.get('output')
    written = None
    if output:
        # Staged as Parquet and loaded by the app, which replaces the table in
        # one transaction and checks the target again before it does (R231).
        _lake_commit([_lake_stage('output', out)])
        written = {'schema': output['schema'], 'table': output['table']}
        _log('wrote %s.%s (%d rows)' % (output['schema'], output['table'], len(out)))
    sample_n = len(out) if inp['kind'] == 'rows' else min(len(out), 50)
    cols = [c for c in out.columns]
    sample = [[_jsonable_cell(v) for v in row] for row in out.head(sample_n).itertuples(index=False, name=None)]
    digest_cols = ['prediction'] + [c for c in ('probability', 'anomaly_score', 'distance') if c in out.columns]
    digest_rows = [[_jsonable_cell(v) for v in row] for row in out[digest_cols].head(1000).itertuples(index=False, name=None)]
    # Explanations are opt-in and bounded: every feature costs a prediction, so
    # this is for the row somebody is looking at, not for a million-row batch.
    # A run that wrote a table already carries its reasons in the rows; a
    # second copy in the job result would be the same answer in two places,
    # free to drift apart.
    explanations = None
    if cfg.get('explain') and not cfg.get('output'):
        try:
            explanations = _explain(art, df, pipe, _prep, task, classes, pred,
                                    int(cfg.get('explain_max_rows') or 20),
                                    int(cfg.get('explain_top_k') or 8))
        except Exception as e:
            warnings_.append('Could not explain these rows: %s' % e)
    return {'mode': 'predict', 'row_count': int(len(out)), 'total_input_rows': int(total), 'output': written, 'drift': drift,
            'columns': cols, 'sample': sample, 'digest_columns': digest_cols, 'digest_rows': digest_rows,
            'explanations': explanations, 'algorithm': art.get('algorithm')}


def _assemble(cfg, warnings_):
    """Combine the workers' fitted models into one artifact.

    Runs in its own container because it needs sklearn to unpickle what the
    workers uploaded; the application cannot open a joblib file.

    Every part is digest-checked on the way in, exactly as a prediction checks
    the model it is about to answer from — an assembled model is only as
    trustworthy as the least-checked thing inside it.
    """
    import joblib
    parts = cfg.get('parts') or []
    if not parts:
        raise RuntimeError('Nothing to assemble: no worker reported a fitted model.')
    arts = []
    for i, part in enumerate(parts):
        blob = _fetch_artifact(part['artifact_uri'])
        sha = hashlib.sha256(blob).hexdigest()
        if sha != part['artifact_sha256']:
            raise RuntimeError('Part %d hashes to %s but was recorded as %s. Refusing to assemble it.'
                               % (i, sha[:12], part['artifact_sha256'][:12]))
        arts.append(joblib.load(io.BytesIO(blob)))
        _log('part %d of %d loaded (%d bytes)' % (i + 1, len(parts), len(blob)))

    base = dict(arts[0])
    pipes = []
    for a in arts:
        pipe = a.get('pipeline')
        # A part that is itself pasted flattens in rather than nesting, so the
        # average stays over the FITS and not over a tree of averages, where
        # one worker's models would quietly outweigh another's.
        pipes.extend(pipe if isinstance(pipe, list) else [pipe])
    base['pipeline'] = pipes

    if base.get('task') == 'classification':
        seen = []
        for a in arts:
            cls = a.get('classes')
            for c in (list(cls) if cls is not None else []):
                if not any(c == k for k in seen):
                    seen.append(c)
        try:
            seen = sorted(seen)
        except Exception:
            pass
        base['classes'] = seen
        short = [a for a in arts
                 if len(list(a.get('classes') if a.get('classes') is not None else [])) < len(seen)]
        if short:
            warnings_.append('%d of %d workers did not see every class in their share of the rows; '
                             'their answers still count, weighted by how sure they were.'
                             % (len(short), len(arts)))

    blob = io.BytesIO()
    joblib.dump(base, blob)
    raw = blob.getvalue()
    sha = hashlib.sha256(raw).hexdigest()
    uri = _upload(raw)
    _log('assembled %d fitted models into one artifact (%d bytes)' % (len(pipes), len(raw)))
    # 'metrics' is EMPTY BUT PRESENT, and it has to be: the application only
    # accepts a worker's result as a result when it carries artifact_uri, a
    # digest and a metrics object, and without one this whole phase would be
    # recorded as a failed worker and the job would quietly fall back to the
    # sampled fit every single time. Empty rather than invented, because an
    # assembled model has no score of its own — its metrics are the search's,
    # measured on the holdout the search kept, and the application fills them
    # in from there.
    return {'ok': True, 'mode': 'assemble', 'parts': len(pipes), 'metrics': {},
            'artifact_uri': uri, 'artifact_sha256': sha, 'artifact_bytes': len(raw)}


# ── Entry point ──────────────────────────────────────────────────────────────
def entrypoint(inputs):
    cfg = _ML_CONFIG
    warnings_ = []
    _ensure_packages()
    if cfg.get('mode') == 'assemble':
        _log('assembling %d parts' % len(cfg.get('parts') or []))
        result = _assemble(cfg, warnings_)
        result.update({'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_})
        _log('done in %.1fs' % _elapsed())
        return result
    if cfg.get('mode') == 'import':
        _log('importing an MLflow model (%s) as v%d' % (cfg['import'].get('flavor'), int(cfg['version'])))
        result = _import_model(cfg, warnings_)
        result.update({'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_, 'runtime': _runtime()})
        _log('done in %.1fs: %s' % (_elapsed(), result['algorithm']))
        return result
    if cfg.get('mode') == 'predict':
        _log('prediction %s: %s v%d' % (cfg['prediction_id'][:8], cfg['task'], int(cfg['version'])))
        result = _predict(cfg, warnings_)
        result.update({'ok': True, 'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_})
        _log('done in %.1fs' % _elapsed())
        return result
    _log('job %s: %s on %s.%s -> %s' % (cfg['job_id'][:8], cfg['task'], cfg['source']['schema'], cfg['source']['table'], cfg.get('target_column') or cfg.get('item_column') or '(no target)'))
    gpu = _gpu_context(cfg)
    cfg['_gpu'] = gpu
    if gpu['requested'] or gpu['seen']:
        _log('GPU: %d requested, %s%s' % (gpu['requested'], _gpu_summary(gpu),
             '; training uses it' if gpu.get('device') else '; ' + (gpu.get('note') or 'not usable') + ', so training runs on the CPU'))
    df, total, sampled = _read_frame(cfg)
    if sampled:
        warnings_.append('Trained on a %d-row sample of %d rows.' % (len(df), total))
    if cfg['task'] == 'forecast':
        result = _train_forecast(df, cfg, warnings_)
    elif cfg['task'] == 'clustering':
        result = _train_clustering(df, cfg, warnings_)
    elif cfg['task'] == 'anomaly':
        result = _train_anomaly(df, cfg, warnings_)
    elif cfg['task'] == 'recommendation':
        result = _train_recommendation(df, cfg, warnings_)
    else:
        result = _train_tabular(df, cfg, warnings_)
    if gpu['requested'] or gpu['seen']:
        # What the sandbox was given and what used it, for the version (R537).
        used = [r['algorithm'] for r in (result.get('leaderboard') or [])
                if r.get('device') == 'gpu' and r.get('status') == 'ok']
        result['gpu'] = {k: v for k, v in gpu.items() if k in ('requested', 'seen', 'device', 'note', 'cuda', 'xgboost')}
        result['gpu']['used_by'] = used
        if gpu['requested'] and not gpu.get('device'):
            warnings_.append('%d GPU%s requested for this sandbox, but training could not use one: %s. It trained on the CPU.'
                             % (gpu['requested'], '' if gpu['requested'] == 1 else 's', gpu.get('note') or 'none was visible'))
    blob = result.pop('_artifact')
    sha = hashlib.sha256(blob).hexdigest()
    _log('uploading artifact (%d bytes)' % len(blob))
    uri = _upload(blob)
    result.update({
        'ok': True, 'mode': 'train', 'artifact_uri': uri, 'artifact_sha256': sha, 'artifact_bytes': len(blob),
        'training_total_rows': int(total), 'training_sampled': bool(sampled),
        'elapsed_seconds': round(_elapsed(), 1), 'warnings': warnings_,
        'runtime': _runtime(),
    })
    _log('done in %.1fs: %s, %s=%s' % (_elapsed(), result['algorithm'], result['primary_metric'], result['metrics'].get(result['primary_metric'])))
    return result
`;
