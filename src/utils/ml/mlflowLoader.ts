// The loader module an exported MLflow model names (R533).
//
// MLflow's python_function flavor, in its loader-module form: MLflow puts the
// model's `code/` folder on sys.path, imports this module and calls
// `_load_pyfunc(data_path)`; whatever that returns is asked to `predict`.
// No class of ours is pickled anywhere: the model folder holds the artifact
// exactly as the platform stored it, and this module and the scoring program
// as plain source.
//
// It scores through the program's own `_predict`, the function the batch
// path and the warm scorer call, so an exported model answers the same rows
// the same way it does here: the same feature preparation, the same class
// labels, the same decision line when one is passed. The artifact's digest is
// checked on load, against the one the registry recorded.
//
// String.raw: the Python must not contain a backtick or "$" followed by "{".
export const MLFLOW_LOADER_PY = String.raw`"""Load a model exported from AgentSwarms in the MLflow format.

MLflow imports this module (the model's code/ folder is on sys.path) and calls
_load_pyfunc with the path of the model's data file. The returned object's
predict() scores a table of rows through the same program AgentSwarms runs.
"""

import json
import os

import agentswarms_program as _program

_HERE = os.path.dirname(os.path.abspath(__file__))


def _rows_of(model_input):
    if hasattr(model_input, "to_dict"):
        return model_input.to_dict(orient="records")
    if isinstance(model_input, dict):
        keys = list(model_input.keys())
        n = len(model_input[keys[0]]) if keys else 0
        return [dict((k, model_input[k][i]) for k in keys) for i in range(n)]
    return [dict(r) for r in model_input]


class AgentSwarmsModel:
    """One version of one model, loaded once, scoring as often as asked."""

    def __init__(self, cfg, art):
        self._cfg = cfg
        self._art = art

    @property
    def metadata(self):
        return dict(self._cfg)

    def predict(self, model_input, params=None):
        import pandas as pd

        cfg = dict(self._cfg)
        cfg["input"] = {"kind": "rows", "rows": _rows_of(model_input)}
        cfg["output"] = None
        cfg["max_rows"] = 0
        for key in ("decision_threshold", "positive_label"):
            if params and params.get(key) is not None:
                cfg[key] = params[key]
        art = self._art
        original = _program._download_artifact
        # Already loaded and checked: hand it back through the program's own
        # loader, as the warm scorer does, so the scoring path is the one.
        _program._download_artifact = lambda _cfg: art
        try:
            warnings = []
            out = _program._predict(cfg, warnings)
        finally:
            _program._download_artifact = original
        return pd.DataFrame(out["sample"], columns=out["columns"])


def _load_pyfunc(data_path):
    with open(os.path.join(_HERE, "agentswarms.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    with open(data_path, "rb") as f:
        blob = f.read()
    # The program reads the artifact through _fetch_artifact and refuses
    # bytes whose digest is not the one the registry recorded.
    _program._fetch_artifact = lambda _uri: blob
    art = _program._download_artifact(cfg)
    return AgentSwarmsModel(cfg, art)
`;
