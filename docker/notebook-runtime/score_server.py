"""Warm inference mode for the sandbox image (NB_MODE=score).

Holds ONE trained model version in memory and answers scoring requests over
HTTP on :8888, under the same Tier-A hardening as every other sandbox. The app
never exposes this port; /api/ml/predict authenticates and proxies to it.

Why this exists: a batch sandbox per prediction pays a container start, a
Python boot, an import of the ML stack and an artifact download before it
scores anything — about twenty seconds of it, measured, which is fine for a
million rows and absurd for one. Here that cost is paid once, at deploy.

WHAT IS DELIBERATELY NOT DIFFERENT: the scoring itself. This process imports
the same program the batch path runs and calls the same `_predict`, so the
fitted preprocessing, the digest check, the drift computation and the output
columns are the ones training produced. A second scoring implementation that
agreed with the first today would disagree with it eventually, and the
disagreement would be invisible — two answers to one question, both plausible.

The model config arrives over HTTP rather than in the environment for the same
reason the MCP runner's secrets do: the session token already authenticates
this container, and a response body is not visible to `docker inspect` or in a
pod spec.
"""

import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

ORIGIN = os.environ.get("AGENTSWARMS_ORIGIN", "").rstrip("/")
TOKEN = os.environ.get("AGENTSWARMS_TOKEN", "")
HOST = os.environ.get("KG_IP", "0.0.0.0")
PORT = int(os.environ.get("KG_PORT", "8888"))

# Bounded so a malformed or hostile request cannot exhaust the sandbox before
# the pandas frame is even built. The app enforces its own row cap too; this is
# the floor under it, not the policy.
MAX_BODY_BYTES = 8 * 1024 * 1024

_state = {
    "ready": False,
    "error": None,
    "loaded_at": None,
    "version": None,
    "algorithm": None,
    "requests": 0,
}
_lock = threading.Lock()
_program = {}


def _log(msg):
    print(msg, flush=True)


def fetch_bundle():
    """The program, its config and the artifact's credentials, in one call."""
    with httpx.Client(timeout=60, trust_env=True) as c:
        r = c.post(
            ORIGIN + "/api/notebook/runtime/source",
            json={},
            headers={"Authorization": "Bearer " + TOKEN},
        )
    r.raise_for_status()
    return r.json()


def load_model():
    """Import the shared program and warm the artifact into memory.

    Runs on a background thread so the HTTP server is listening — and therefore
    reporting readiness honestly as "loading" — while the download and the
    sklearn import happen. A container that accepts no connections for twenty
    seconds is indistinguishable from one that crashed.
    """
    try:
        bundle = fetch_bundle()
        code = bundle["code"]
        cfg = bundle["config"]

        # The artifact lives in the lake bucket; these are the credentials for
        # it, delivered in the response body rather than the container
        # environment so they are not visible to `docker inspect`.
        for key, value in (bundle.get("env") or {}).items():
            os.environ[str(key)] = str(value)

        # The program defines _download_artifact / _predict / _ensure_packages
        # and reads _ML_CONFIG. Executed in its own namespace, exactly as the
        # batch runner executes it.
        ns = {"__name__": "__ml_program__"}
        exec(compile(code, "<ml_program>", "exec"), ns)  # noqa: S102
        ns["_ensure_packages"]()

        art = ns["_download_artifact"](cfg)
        _program["ns"] = ns
        _program["cfg"] = cfg
        _program["art"] = art

        # Score one empty row before declaring ready. sklearn and pandas do a
        # surprising amount of work on their FIRST call — measured at over a
        # second — and the point of a warm endpoint is that the first real
        # request does not pay for it. The row is all-missing on purpose:
        # _prepare_x fills absent features with NaN, so this exercises the
        # whole path without inventing data that looks real.
        try:
            score([{}])
        except Exception:  # noqa: BLE001 — a model that cannot score an empty
            # row is not broken; it just cannot be warmed this way.
            _log("[score] warmup pass skipped: " + traceback.format_exc(limit=1).strip())

        with _lock:
            _state["ready"] = True
            _state["error"] = None
            _state["loaded_at"] = time.time()
            _state["version"] = cfg.get("version")
            _state["algorithm"] = art.get("algorithm")
        _log(
            "[score] loaded model %s v%s (%s)"
            % (cfg.get("model_id"), cfg.get("version"), art.get("algorithm"))
        )
    except Exception as e:  # noqa: BLE001 — reported, not raised into a dead thread
        with _lock:
            _state["ready"] = False
            _state["error"] = "%s: %s" % (type(e).__name__, e)
        _log("[score] load failed: " + traceback.format_exc())


def score(rows):
    """Score rows with the loaded artifact, through the shared program.

    `_predict` re-downloads the artifact by design in the batch path; here it
    is already in memory, so the pre-loaded object is handed back through the
    program's own loader. That keeps ONE code path for the actual scoring.
    """
    ns = _program["ns"]
    cfg = dict(_program["cfg"])
    cfg["input"] = {"kind": "rows", "rows": rows}
    cfg["output"] = None

    art = _program["art"]
    original = ns["_download_artifact"]
    ns["_download_artifact"] = lambda _cfg: art
    try:
        warnings = []
        out = ns["_predict"](cfg, warnings)
        out["warnings"] = warnings
        return out
    finally:
        ns["_download_artifact"] = original


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # The default handler writes to stderr per request; container logs are
        # shown to the model's owner and a line per score is noise.
        return

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # The readiness probe opens a connection, reads what it needs and
            # hangs up. That is not an error, and a traceback per probe would
            # bury the one log line that matters.
            pass

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's contract
        if self.path.rstrip("/") in ("/healthz", ""):
            with _lock:
                self._send(200 if _state["ready"] else 503, dict(_state))
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.rstrip("/") != "/score":
            self._send(404, {"error": "not found"})
            return
        with _lock:
            ready = _state["ready"]
            err = _state["error"]
        if not ready:
            self._send(503, {"error": err or "still loading"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "bad Content-Length"})
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(413, {"error": "body too large"})
            return
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            self._send(400, {"error": "body is not JSON"})
            return
        rows = body.get("rows")
        if not isinstance(rows, list) or not rows:
            self._send(400, {"error": "rows must be a non-empty array"})
            return
        started = time.time()
        try:
            out = score(rows)
        except Exception as e:  # noqa: BLE001 — a bad row must not kill the server
            _log("[score] request failed: " + traceback.format_exc())
            self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})
            return
        out["elapsed_seconds"] = round(time.time() - started, 4)
        with _lock:
            _state["requests"] += 1
        self._send(200, out)


def main():
    if not ORIGIN or not TOKEN:
        _log("[score] AGENTSWARMS_ORIGIN and AGENTSWARMS_TOKEN are required")
        sys.exit(2)
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    _log("[score] listening on %s:%s" % (HOST, PORT))
    server.serve_forever()


if __name__ == "__main__":
    main()
