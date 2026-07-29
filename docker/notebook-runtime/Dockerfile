# Server-side notebook kernel image for the AgentSwarms Developer workspace.
#
# Runs Jupyter Kernel Gateway (websocket mode) with one IPython kernel per
# container for interactive sessions, a headless batch runner for jobs, or a
# user-authored FastMCP server for MCP Builder (NB_MODE=mcp).
# Ships the real agentic frameworks and an `agentswarms` helper that brokers
# model/KB calls back to the platform (no provider keys ever live in here).
#
# Built to run under the Tier-A hardening in docs/DEVELOPER_WORKSPACE_RUNTIME.md:
# non-root (uid 1000), read-only root filesystem (writable paths are mounted
# tmpfs/emptyDir at /home/runner/work, /home/runner/.local, /tmp), all caps
# dropped. Runtime `pip install` works because PIP_USER targets the writable
# ~/.local mount.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/bash runner

WORKDIR /opt/agentswarms
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agentswarms_helper.py /opt/agentswarms/agentswarms.py
COPY batch_runner.py /opt/agentswarms/batch_runner.py
COPY mcp_runner.py /opt/agentswarms/mcp_runner.py
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# `import agentswarms` resolves to our helper; runtime pip installs go to the
# writable per-session ~/.local so the root fs can stay read-only.
ENV PYTHONPATH=/opt/agentswarms \
    PYTHONUNBUFFERED=1 \
    PIP_USER=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH=/home/runner/.local/bin:/usr/local/bin:/usr/bin:/bin \
    KG_IP=0.0.0.0 \
    KG_PORT=8888

USER runner
# The working directory is a writable mount; nothing else on the fs is writable.
WORKDIR /home/runner/work
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
