"""Fetch this sandbox's environment from the platform, once (R477).

On the ECS backend the task is started with a one-time nonce instead of its
secrets: RunTask's request is recorded in CloudTrail and returned by
DescribeTasks, so a session token put there would be readable by anyone who
can read either. This trades the nonce for the environment at the app and
prints it as shell `export` lines for entrypoint.sh to evaluate. stdout carries
nothing else; every failure goes to stderr with exit status 1.

Stdlib only, run with `python -I`: nothing the user installs can shadow it.
"""

import json
import os
import re
import shlex
import sys
import time
import urllib.error
import urllib.request

NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# The app may still be starting, or rolling: retry this long on no answer, a
# 429 or a 5xx. A 4xx is final; the nonce is wrong, used or expired.
DEADLINE_S = 120


def fail(message: str) -> None:
    sys.exit(f"[bootstrap] {message}")


def fetch(url: str, body: bytes) -> dict:
    # Straight to the app: it is in NO_PROXY, and the egress proxy would
    # refuse a private address anyway.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + DEADLINE_S
    delay = 1.0
    last = ""
    while True:
        request = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with opener.open(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                fail(f"{url} refused the nonce (HTTP {e.code}); it is used, expired or wrong")
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = str(e)
        if time.monotonic() + delay > deadline:
            fail(f"{url} did not hand over the environment within {DEADLINE_S} s: {last}")
        time.sleep(delay)
        delay = min(delay * 2, 10.0)


def main() -> None:
    url = os.environ.get("NB_BOOTSTRAP_URL", "")
    nonce = os.environ.get("NB_BOOTSTRAP_NONCE", "")
    session = os.environ.get("NB_SESSION_ID", "")
    if not (url and nonce and session):
        fail("NB_BOOTSTRAP_URL, NB_BOOTSTRAP_NONCE and NB_SESSION_ID are all required")
    answer = fetch(url, json.dumps({"session_id": session, "nonce": nonce}).encode())
    env = answer.get("env") if isinstance(answer, dict) else None
    if not isinstance(env, dict):
        fail(f"{url} answered without an environment")
    lines = []
    for name, value in env.items():
        if not isinstance(name, str) or not NAME.match(name) or not isinstance(value, str):
            fail(f"refused a variable that is not NAME=string: {name!r}")
        lines.append(f"export {name}={shlex.quote(value)}")
    # Bytes, so a line ends in \n wherever this runs (text mode on Windows
    # would add \r, and the shell would keep it in the value).
    sys.stdout.buffer.write(("\n".join(lines) + "\n").encode())


if __name__ == "__main__":
    main()
