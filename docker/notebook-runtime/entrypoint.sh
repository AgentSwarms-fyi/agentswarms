#!/usr/bin/env bash
# Interactive sessions run Jupyter Kernel Gateway (one kernel, websocket mode);
# batch jobs run the headless runner which executes the notebook and posts its
# result back to the platform; mcp serves a user-authored FastMCP server; score
# holds one trained model in memory and answers predictions over HTTP.
set -euo pipefail

if [ "${NB_MODE:-interactive}" = "batch" ]; then
  exec python /opt/agentswarms/batch_runner.py
fi

# MCP Builder: one user-authored FastMCP server, served over Streamable HTTP.
if [ "${NB_MODE:-interactive}" = "mcp" ]; then
  exec python /opt/agentswarms/mcp_runner.py
fi

# Warm inference: one trained model held in memory, scored over HTTP.
if [ "${NB_MODE:-interactive}" = "score" ]; then
  exec python /opt/agentswarms/score_server.py
fi

exec jupyter kernelgateway \
  --KernelGatewayApp.ip="${KG_IP:-0.0.0.0}" \
  --KernelGatewayApp.port="${KG_PORT:-8888}" \
  --KernelGatewayApp.allow_origin='*' \
  --KernelGatewayApp.api='kernel_gateway.jupyter_websocket' \
  --KernelGatewayApp.max_kernels=1
