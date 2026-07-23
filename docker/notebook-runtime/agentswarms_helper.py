"""In-kernel AgentSwarms helper for the server runtime.

Mirrors the browser (Pyodide) helper's API so the sample notebooks run
identically here. Every call is brokered back to the platform with the session
token injected as AGENTSWARMS_TOKEN — provider keys never live in the sandbox,
and calls are governed (IAM model rules, budgets, Traces) exactly as elsewhere.

Callbacks to the platform go direct (the app host is in NO_PROXY); any other
network access (pip, direct LLM calls) is forced through the egress proxy.
"""
import os
import httpx

_ORIGIN = os.environ.get("AGENTSWARMS_ORIGIN", "").rstrip("/")
_TOKEN = os.environ.get("AGENTSWARMS_TOKEN", "")

__all__ = ["chat", "kb_search", "list_knowledge_bases", "format_context"]


async def _post(path, payload):
    if not _ORIGIN or not _TOKEN:
        raise RuntimeError(
            "AgentSwarms runtime is not configured (AGENTSWARMS_ORIGIN / AGENTSWARMS_TOKEN)."
        )
    async with httpx.AsyncClient(timeout=120, trust_env=True) as client:
        resp = await client.post(
            _ORIGIN + path, json=payload, headers={"Authorization": "Bearer " + _TOKEN}
        )
    try:
        data = resp.json()
    except Exception:
        data = {}
    if resp.status_code != 200:
        raise RuntimeError(data.get("message") or data.get("error") or f"HTTP {resp.status_code}")
    return data


async def chat(prompt=None, *, model, provider="openrouter", system=None,
               temperature=0.7, max_tokens=1024, messages=None):
    """Send a chat completion through AgentSwarms and return the reply text."""
    if messages is None:
        if prompt is None:
            raise ValueError("Pass a prompt string or a messages list")
        messages = []
        if system:
            messages.append({"role": "system", "content": str(system)})
        messages.append({"role": "user", "content": str(prompt)})
    data = await _post("/api/python-chat", {
        "provider": provider,
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    })
    return data["content"]


async def kb_search(query, *, kb_ids=None, top_k=5):
    """Hybrid retrieval over your knowledge bases. Returns list of dicts."""
    data = await _post("/api/python-kb", {
        "action": "search",
        "query": str(query),
        "kb_ids": list(kb_ids) if kb_ids else None,
        "top_k": top_k,
    })
    return data.get("results", [])


async def list_knowledge_bases():
    """List the knowledge bases your account can read."""
    data = await _post("/api/python-kb", {"action": "list"})
    return data.get("knowledge_bases", [])


def format_context(hits):
    """Turn kb_search() results into a numbered context block for a prompt."""
    return "\n".join(
        f"[{i}] ({h.get('knowledge_base', 'KB')} / {h.get('document', 'doc')}) "
        + h.get("snippet", "")
        for i, h in enumerate(hits, 1)
    )
