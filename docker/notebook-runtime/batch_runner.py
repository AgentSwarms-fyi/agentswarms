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
                json={"status": status, "result": result, "logs": logs, "error": error},
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


def main():
    buf = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = buf
    try:
        code = fetch_source()
        ns = {"__name__": "__main__"}
        compiled = compile(code, "<notebook>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = asyncio.run(_run(compiled, ns))
        sys.stdout = real_stdout
        post_result("succeeded", result=_jsonable(result), logs=buf.getvalue())
    except Exception:
        sys.stdout = real_stdout
        post_result("error", logs=buf.getvalue(), error=traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
