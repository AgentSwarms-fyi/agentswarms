// Client-side Python runtime for user notebooks, backed by Pyodide (CPython
// compiled to WebAssembly, loaded from the jsDelivr CDN on first run).
//
// One shared interpreter per browser tab: variables defined in one cell are
// visible to the next, like Jupyter. Cells run through runPythonAsync, so
// top-level `await` works. A synthetic `agentswarms` module is injected with
// a `chat()` helper that calls /api/python-chat under the signed-in user's
// session — per-user provider keys, IAM model rules, and traces all apply.

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Minimal surface of the Pyodide API we use (the package ships no types here).
type Pyodide = {
  runPythonAsync(code: string): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: { set(name: string, value: unknown): void };
};

declare global {
  interface Window {
    loadPyodide?: (options: { indexURL: string }) => Promise<Pyodide>;
  }
}

let enginePromise: Promise<Pyodide> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load the Python runtime (network error)"));
    document.head.appendChild(s);
  });
}

// Injected as a real module so notebook code reads naturally:
//   import agentswarms
//   reply = await agentswarms.chat("hi", provider="openrouter", model="openai/gpt-4o-mini")
//   hits  = await agentswarms.kb_search("refund policy")
const BOOTSTRAP = `
import json as _json
import sys as _sys
import types as _types
from pyodide.http import pyfetch as _pyfetch

_agentswarms = _types.ModuleType("agentswarms")
_agentswarms.__doc__ = "Helpers for calling LLMs and your knowledge bases through your AgentSwarms account."

async def _post(path, payload):
    resp = await _pyfetch(
        _AGENTSWARMS_ORIGIN + path,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + _AGENTSWARMS_TOKEN,
        },
        body=_json.dumps(payload),
    )
    data = await resp.json()
    if resp.status != 200:
        raise RuntimeError(data.get("message") or data.get("error") or f"HTTP {resp.status}")
    return data

async def _chat(prompt=None, *, model, provider="openrouter", system=None,
                temperature=0.7, max_tokens=1024, messages=None):
    """Send a chat completion through AgentSwarms and return the reply text.

    provider: any OpenAI-compatible provider you have connected under
              /integrations (or the instance default "openrouter").
    model:    the provider's model id, e.g. "openai/gpt-4o-mini" on OpenRouter.
    Pass either a prompt string or a full messages list of
    {"role": ..., "content": ...} dicts.
    """
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

async def _kb_search(query, *, kb_ids=None, top_k=5):
    """Hybrid (vector + keyword) retrieval over your knowledge bases.

    query:  what to look for.
    kb_ids: optional list of knowledge-base ids; omit to search every KB your
            account can read (your own, IAM-shared, and public samples).
    Returns a list of {"document", "knowledge_base", "snippet"} dicts.
    """
    data = await _post("/api/python-kb", {
        "action": "search",
        "query": str(query),
        "kb_ids": list(kb_ids) if kb_ids else None,
        "top_k": top_k,
    })
    return data.get("results", [])

async def _list_knowledge_bases():
    """List the knowledge bases your account can read: {"id", "name", "sample"}."""
    data = await _post("/api/python-kb", {"action": "list"})
    return data.get("knowledge_bases", [])

def _format_context(hits):
    """Turn kb_search() results into a numbered context block for a prompt."""
    lines = []
    for i, h in enumerate(hits, 1):
        lines.append(f"[{i}] ({h.get('knowledge_base','KB')} / {h.get('document','doc')}) "
                     + h.get("snippet", ""))
    return "\\n".join(lines)

_agentswarms.chat = _chat
_agentswarms.kb_search = _kb_search
_agentswarms.list_knowledge_bases = _list_knowledge_bases
_agentswarms.format_context = _format_context
_sys.modules["agentswarms"] = _agentswarms
del _chat, _kb_search, _list_knowledge_bases, _format_context, _post, _agentswarms
`;

export async function getPythonEngine(): Promise<Pyodide> {
  if (!enginePromise) {
    enginePromise = (async () => {
      await loadScript(`${PYODIDE_BASE}pyodide.js`);
      if (!window.loadPyodide) throw new Error("Python runtime failed to initialise");
      const py = await window.loadPyodide({ indexURL: PYODIDE_BASE });
      py.globals.set("_AGENTSWARMS_TOKEN", "");
      py.globals.set("_AGENTSWARMS_ORIGIN", window.location.origin);
      await py.runPythonAsync(BOOTSTRAP);
      return py;
    })().catch((e) => {
      enginePromise = null; // allow retry after a failed load
      throw e;
    });
  }
  return enginePromise;
}

export type CellRunResult = {
  stdout: string;
  result: string | null;
  error: string | null;
  durationMs: number;
};

export async function runPythonCell(
  code: string,
  accessToken: string | null,
): Promise<CellRunResult> {
  const started = Date.now();
  let py: Pyodide;
  try {
    py = await getPythonEngine();
  } catch (e) {
    return {
      stdout: "",
      result: null,
      error: e instanceof Error ? e.message : "Python runtime failed to load",
      durationMs: Date.now() - started,
    };
  }

  // Refresh auth context every run — sessions rotate.
  py.globals.set("_AGENTSWARMS_TOKEN", accessToken ?? "");
  py.globals.set("_AGENTSWARMS_ORIGIN", window.location.origin);

  let out = "";
  py.setStdout({ batched: (text) => (out += text + "\n") });
  py.setStderr({ batched: (text) => (out += text + "\n") });

  try {
    // Auto-fetch imported packages that ship with Pyodide (numpy, pandas, …).
    await py.loadPackagesFromImports(code);
    const value = (await py.runPythonAsync(code)) as unknown;
    let result: string | null = null;
    if (value !== undefined && value !== null) {
      result = String(value);
      const proxy = value as { destroy?: () => void };
      if (typeof proxy.destroy === "function") proxy.destroy();
    }
    return { stdout: out, result, error: null, durationMs: Date.now() - started };
  } catch (e) {
    return {
      stdout: out,
      result: null,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
    };
  }
}
