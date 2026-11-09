"""Long-lived MCP server mode for the sandbox image (NB_MODE=mcp).

Serves ONE user-authored FastMCP server over Streamable HTTP on :8888/mcp, under
the same Tier-A hardening as an interactive kernel. The app never exposes this
port directly — /api/mcp/s/<slug> authenticates and proxies to it.

Why the source and secrets arrive over HTTP rather than the environment: the
session token already authenticates this container to the platform, and a
response body is not visible to `docker inspect` or in a Kubernetes pod spec the
way env vars are. So bound secrets exist only in this process's memory.
"""
import hmac
import os
import runpy
import subprocess
import sys
import traceback

import httpx

ORIGIN = os.environ.get("AGENTSWARMS_ORIGIN", "").rstrip("/")
TOKEN = os.environ.get("AGENTSWARMS_TOKEN", "")
HOST = os.environ.get("KG_IP", "0.0.0.0")
PORT = int(os.environ.get("KG_PORT", "8888"))
PATH = os.environ.get("MCP_PATH", "/mcp")
WORKDIR = os.environ.get("MCP_WORKDIR", "/home/runner/work")
# Who may use this port (R466): the platform, which derives the same value
# from the session id. Every sandbox shares one network, and "the app never
# exposes this port" never stopped a neighbouring sandbox from calling it.
# Taken out of the environment before the user's code runs.
PORT_TOKEN = os.environ.pop("KG_AUTH_TOKEN", "")

# Values that must never reach stdout. Container logs are shown to the app's
# owner, and a traceback through a tool that took a secret as an argument would
# otherwise print it verbatim.
_SECRETS: list[str] = []


def _redact(text: str) -> str:
    for value in _SECRETS:
        if value:
            text = text.replace(value, "***")
    return text


def _log(msg: str) -> None:
    print(_redact(msg), flush=True)


def fetch_bundle() -> dict:
    """Source, extra requirements and resolved secret env, in one authenticated call."""
    with httpx.Client(timeout=60, trust_env=True) as c:
        r = c.post(
            ORIGIN + "/api/notebook/runtime/source",
            json={},
            headers={"Authorization": "Bearer " + TOKEN},
        )
    r.raise_for_status()
    return r.json()


def install_requirements(requirements: str) -> None:
    """pip install the app's declared packages, through the egress proxy.

    Failures are fatal: a server missing a dependency it declared would come up
    and then fail every tool call, which is far harder to diagnose than a deploy
    that stops here with the pip output attached.
    """
    pkgs = [line.strip() for line in (requirements or "").splitlines()]
    pkgs = [p for p in pkgs if p and not p.startswith("#")]
    if not pkgs:
        return
    _log(f"[mcp] installing {len(pkgs)} package(s)")
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--user", "--no-input", *pkgs],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("pip install failed:\n" + (proc.stdout or "") + (proc.stderr or ""))


def _looks_like_mcp_server(obj) -> bool:
    """Both fastmcp 2.x and mcp.server.fastmcp expose .run() and a .tool decorator."""
    return callable(getattr(obj, "run", None)) and getattr(obj, "tool", None) is not None


def locate_server(namespace: dict):
    """Find the FastMCP instance the user defined.

    Conventional names win so behaviour is predictable; the scan is only a
    fallback for someone who named it something else.
    """
    for name in ("mcp", "server", "app"):
        obj = namespace.get(name)
        if obj is not None and _looks_like_mcp_server(obj):
            return obj
    for key, obj in namespace.items():
        if key.startswith("_"):
            continue
        if _looks_like_mcp_server(obj):
            return obj
    raise RuntimeError(
        "No MCP server found. Define a module-level FastMCP instance, e.g.\n\n"
        '    from fastmcp import FastMCP\n'
        '    mcp = FastMCP("my-server")\n\n'
        "    @mcp.tool()\n"
        "    def hello(name: str) -> str:\n"
        '        return f"hi {name}"\n'
    )


class TokenGate:
    """ASGI middleware: a request without this sandbox's port token gets 401 (R466).

    Lifespan events pass straight through, so the MCP library's own startup
    (its session manager) runs as it would under its own run().
    """

    def __init__(self, app, token: str):
        self.app = app
        self.expected = ("token " + token).encode()

    async def __call__(self, scope, receive, send):
        if scope.get("type") in ("http", "websocket"):
            got = b""
            for name, value in scope.get("headers") or []:
                if name.lower() == b"authorization":
                    got = value
            if not hmac.compare_digest(got, self.expected):
                if scope["type"] == "websocket":
                    await receive()  # websocket.connect
                    await send({"type": "websocket.close", "code": 4401})
                    return
                body = b'{"error":"unauthorized"}'
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


def asgi_app(server):
    """The server's Streamable HTTP app, from whichever library defined it.

    fastmcp (4.x) has http_app(); the official SDK has streamable_http_app()
    (MCPServer in 2.x, FastMCP in 1.x). The host is the one run() would have
    used: the SDK turns on DNS-rebinding protection for a loopback host, which
    would refuse the platform's requests by container address.
    """
    http_app = getattr(server, "http_app", None)
    if callable(http_app):
        try:
            return http_app(path=PATH, transport="http")
        except TypeError:
            return http_app(path=PATH)
    streamable = getattr(server, "streamable_http_app", None)
    if callable(streamable):
        try:
            return streamable(streamable_http_path=PATH, host=HOST)
        except TypeError:
            settings = getattr(server, "settings", None)
            if settings is not None:
                for attr, value in (("host", HOST), ("port", PORT), ("streamable_http_path", PATH)):
                    if hasattr(settings, attr):
                        setattr(settings, attr, value)
            return streamable()
    return None


def serve(server) -> None:
    """Run the server over Streamable HTTP, behind this sandbox's port token.

    With a token (every sandbox the platform starts since R466), the library's
    ASGI app is served here, under uvicorn, behind TokenGate. A server whose
    library offers no ASGI app cannot be gated, so it is refused rather than
    served open. Without a token (a sandbox an older app started), it runs as
    it always did.
    """
    if PORT_TOKEN:
        app = asgi_app(server)
        if app is None:
            raise RuntimeError(
                "This MCP library offers no ASGI app (http_app or streamable_http_app), so the "
                "server cannot be put behind the sandbox's token. Use fastmcp or the official mcp SDK."
            )
        import uvicorn

        _log(f"[mcp] serving on {HOST}:{PORT}{PATH}, platform requests only")
        uvicorn.run(TokenGate(app, PORT_TOKEN), host=HOST, port=PORT, log_level="warning")
        return
    _log("[mcp] no KG_AUTH_TOKEN: serving without a port token, as before R466")
    _serve_open(server)


def _serve_open(server) -> None:
    """Run the server over Streamable HTTP.

    The two libraries spell the same transport differently, and neither accepts
    the other's name, so try both rather than pinning users to one package.
    """
    attempts = [
        {"transport": "http", "host": HOST, "port": PORT, "path": PATH},
        {"transport": "streamable-http", "host": HOST, "port": PORT, "path": PATH},
        {"transport": "streamable-http"},
    ]
    last: Exception | None = None
    for kwargs in attempts:
        try:
            # The official SDK reads host/port/path off its settings object
            # rather than run() kwargs, so mirror them there when present.
            settings = getattr(server, "settings", None)
            if settings is not None:
                for attr, value in (("host", HOST), ("port", PORT), ("streamable_http_path", PATH)):
                    if hasattr(settings, attr):
                        setattr(settings, attr, value)
            _log(f"[mcp] serving on {HOST}:{PORT}{PATH} via {kwargs['transport']}")
            server.run(**kwargs)
            return
        except TypeError as e:
            # Wrong kwarg name/shape for this library — try the next spelling.
            last = e
        except ValueError as e:
            # Unknown transport literal — likewise.
            last = e
    raise RuntimeError(f"Could not start the MCP server over Streamable HTTP: {last}")


def main() -> None:
    try:
        bundle = fetch_bundle()
    except Exception as e:
        print(f"[mcp] could not fetch source: {e}", flush=True)
        raise

    env = bundle.get("env") or {}
    if isinstance(env, dict):
        for k, v in env.items():
            if isinstance(k, str) and isinstance(v, str):
                os.environ[k] = v
                _SECRETS.append(v)

    install_requirements(bundle.get("requirements") or "")

    os.makedirs(WORKDIR, exist_ok=True)
    path = os.path.join(WORKDIR, "server.py")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(bundle.get("code") or "")

    # runpy rather than exec() so __file__/__name__ behave as the user expects
    # and relative imports from the work dir resolve.
    if WORKDIR not in sys.path:
        sys.path.insert(0, WORKDIR)
    namespace = runpy.run_path(path, run_name="__mcp__")

    serve(locate_server(namespace))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Redact before the traceback reaches the log stream the owner reads.
        print(_redact(traceback.format_exc()), flush=True)
        sys.exit(1)
