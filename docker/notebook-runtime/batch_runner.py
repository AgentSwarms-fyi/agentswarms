"""Headless batch runner for heavy / scheduled notebook jobs.

Fetches the notebook's code from the platform (using the session token),
executes it (top-level await supported), optionally calls an entrypoint(inputs)
function, and POSTs the result back to NB_RESULT_CALLBACK. Runs under the same
hardening + governance as an interactive kernel, but with no live websocket.
"""
import ast
import asyncio
import inspect
import io
import json
import os
import sys
import traceback

import httpx

ORIGIN = os.environ.get("AGENTSWARMS_ORIGIN", "").rstrip("/")
TOKEN = os.environ.get("AGENTSWARMS_TOKEN", "")
CALLBACK = os.environ.get("NB_RESULT_CALLBACK", "")
ENTRYPOINT = os.environ.get("NB_ENTRYPOINT", "").strip()

try:
    INPUTS = json.loads(os.environ.get("NB_INPUTS", "{}") or "{}")
except Exception:
    INPUTS = {}

# Seconds between posts of the output so far while the job runs.
STREAM_EVERY = 5


def _scrub(text):
    """Replace every secret value this run was handed with ***.

    FOUND IN R292. The platform scrubbed a run's output against the values
    that were current when the output ARRIVED, so a secret replaced or deleted
    while the run was going was no longer on its list, and the value the run
    had printed was stored in clear. A node preview's output was not scrubbed
    at all. The prelude keeps the values the run was handed on
    sys._agentswarms_scrub for as long as the run lasts, and everything this
    runner posts goes through here first. Longest first, so a value that
    contains another is not left in pieces; under four characters is left
    alone, as the platform's own scrub does.
    """
    if not text:
        return text
    values = [v for v in getattr(sys, "_agentswarms_scrub", None) or () if isinstance(v, str)]
    for v in sorted(values, key=len, reverse=True):
        if len(v) >= 4:
            text = text.replace(v, "***")
    return text


def _headers():
    return {"Authorization": "Bearer " + TOKEN}


def fetch_source() -> str:
    with httpx.Client(timeout=60, trust_env=True) as c:
        r = c.post(ORIGIN + "/api/notebook/runtime/source", json={}, headers=_headers())
    r.raise_for_status()
    return r.json().get("code", "")


def post_result(status, result=None, logs="", error=None):
    if not CALLBACK:
        return
    try:
        with httpx.Client(timeout=60, trust_env=True) as c:
            c.post(
                CALLBACK,
                json={
                    "status": status,
                    "result": result,
                    "logs": _scrub(logs),
                    "error": _scrub(error),
                },
                headers=_headers(),
            )
    except Exception:
        pass


def _jsonable(v):
    try:
        json.dumps(v)
        return v
    except Exception:
        return str(v)


async def _run(compiled, ns):
    coro = eval(compiled, ns)  # exec-mode code object; returns a coroutine if it awaits
    if inspect.isawaitable(coro):
        await coro
    fn = ns.get(ENTRYPOINT) if ENTRYPOINT else None
    if fn is None:
        return None
    out = fn(INPUTS)
    if inspect.isawaitable(out):
        out = await out
    return out


def _stream_logs(buf, stop):
    """Post the captured-so-far output every few seconds while the job runs.

    Long ETL jobs (a pip install alone can take minutes) were a black box
    until completion; the platform shows these partial posts in the run's
    Logs dialog. Errors are swallowed: live logs are a convenience, and the
    final post carries the authoritative copy.
    """
    import threading

    last = ""
    while not stop.wait(STREAM_EVERY):
        current = buf.getvalue()
        if current != last:
            last = current
            try:
                with httpx.Client(timeout=15, trust_env=True) as c:
                    c.post(
                        CALLBACK,
                        # Scrubbed before it is cut, so the cut cannot leave
                        # the end of a value behind.
                        json={"partial": True, "logs": _scrub(current)[-190_000:]},
                        headers=_headers(),
                    )
            except Exception:
                pass


def main():
    import threading

    buf = io.StringIO()
    real_stdout, real_stderr = sys.stdout, sys.stderr
    sys.stdout = buf
    # FOUND IN R299. Only stdout was captured. `logging` writes to stderr by
    # default, and so do warnings and every library that reports through
    # them: a run's logging.info lines went to the container's log, which is
    # removed with the container once the result is posted, and the Logs
    # dialog showed print() alone. stderr joins the same buffer, in order,
    # and is scrubbed with it.
    sys.stderr = buf
    stop = threading.Event()
    streamer = None
    if CALLBACK:
        streamer = threading.Thread(target=_stream_logs, args=(buf, stop), daemon=True)
        streamer.start()
    try:
        code = fetch_source()
        ns = {"__name__": "__main__"}
        compiled = compile(code, "<notebook>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = asyncio.run(_run(compiled, ns))
        stop.set()
        sys.stdout, sys.stderr = real_stdout, real_stderr
        post_result("succeeded", result=_jsonable(result), logs=buf.getvalue())
    except Exception:
        stop.set()
        sys.stdout, sys.stderr = real_stdout, real_stderr
        error = traceback.format_exc()
        post_result("error", logs=buf.getvalue(), error=error)
        # Not a bare raise: the traceback Python prints on the way out lands
        # in the container's log, which the platform reads when the post above
        # was lost. Same exit status as the uncaught exception.
        sys.stderr.write(_scrub(error))
        sys.exit(1)


if __name__ == "__main__":
    main()
