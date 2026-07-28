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

__all__ = [
    "chat",
    "kb_search",
    "list_knowledge_bases",
    "format_context",
    "run_agent",
    "run_swarm",
    "list_agents",
]


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


async def run_agent(agent_id, prompt, *, history=None):
    """Run one of your saved agents and return its reply text.

    Unlike chat(), this uses the agent exactly as configured in the Agent
    Builder — its system prompt, tools, knowledge bases, memory and guardrails —
    so a notebook gets the same behaviour as the rest of the platform instead of
    a re-implementation that drifts.

        reply = await agentswarms.run_agent(agent_id, "Summarise ticket 48213")
    """
    payload = {"action": "run_agent", "agent_id": agent_id, "prompt": prompt}
    if history:
        payload["history"] = history
    data = await _post("/api/python-agent", payload)
    return data.get("output", "")


async def run_swarm(swarm_id, input="", *, inputs=None):
    """Run one of your saved swarms end to end and return its final output.

    `inputs` supplies typed start-form values by field name. Approval nodes are
    REJECTED rather than waited on: a notebook cell is unattended, so a human
    gate would simply hang until the run times out.

        out = await agentswarms.run_swarm(swarm_id, "Weekly summary")
    """
    payload = {"action": "run_swarm", "swarm_id": swarm_id, "input": input}
    if inputs:
        payload["inputs"] = inputs
    data = await _post("/api/python-agent", payload)
    return data.get("output", "")


async def list_agents():
    """Your saved agents and swarms as {"agents": [...], "swarms": [...]}."""
    return await _post("/api/python-agent", {"action": "list"})


def format_context(hits):
    """Turn kb_search() results into a numbered context block for a prompt."""
    return "\n".join(
        f"[{i}] ({h.get('knowledge_base', 'KB')} / {h.get('document', 'doc')}) "
        + h.get("snippet", "")
        for i, h in enumerate(hits, 1)
    )


# ── Framework adapters ───────────────────────────────────────────────────────
# Real LangChain / LlamaIndex objects that route their model calls through the
# platform instead of holding a provider key. That keeps notebooks written in
# genuine framework code (LCEL chains, LangGraph nodes, LlamaIndex query
# engines) while IAM model rules, budgets and Traces still apply — and no API
# key ever exists inside the sandbox.
#
# Imported lazily so kernels start fast and stay usable without the frameworks.

def _to_role(message_type):
    return {"system": "system", "ai": "assistant", "human": "user", "tool": "tool"}.get(
        message_type, "user"
    )


def _message_to_openai(m):
    """Convert one LangChain message to an OpenAI chat-completions dict,
    preserving tool calls (on AI messages) and tool results (tool messages)."""
    import json as _json

    role = _to_role(getattr(m, "type", "human"))
    content = m.content if m.content is not None else ""
    out = {"role": role, "content": content}

    # Tool result: ToolMessage carries the id of the call it answers.
    tool_call_id = getattr(m, "tool_call_id", None)
    if tool_call_id:
        out["role"] = "tool"
        out["tool_call_id"] = tool_call_id
        out["content"] = "" if content is None else str(content)
        return out

    # Assistant tool calls: LangChain AIMessage.tool_calls → OpenAI shape.
    tool_calls = getattr(m, "tool_calls", None)
    if tool_calls:
        out["tool_calls"] = [
            {
                "id": tc.get("id") or f"call_{i}",
                "type": "function",
                "function": {
                    "name": tc.get("name"),
                    "arguments": _json.dumps(tc.get("args", {})),
                },
            }
            for i, tc in enumerate(tool_calls)
        ]
        # OpenAI wants content null (not "") when tool_calls are present.
        if not content:
            out["content"] = None
    return out


def chat_model(model="openai/gpt-4o-mini", provider="openrouter", temperature=0.7, max_tokens=1024):
    """A LangChain chat model backed by AgentSwarms.

        from agentswarms import chat_model
        llm = chat_model(model="openai/gpt-4o-mini")
        chain = prompt | llm | StrOutputParser()

    Works anywhere a LangChain BaseChatModel is accepted — LCEL chains,
    LangGraph nodes, agents, and LlamaIndex via LangChainLLM. Supports
    tool-calling via ``llm.bind_tools([...])`` (and therefore LangGraph's
    ``create_react_agent`` / ``ToolNode``) when the routed provider returns
    ``tool_calls`` (OpenAI, OpenRouter, Groq, …).
    """
    import json as _json

    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.utils.function_calling import convert_to_openai_tool

    # Bind to differently-named locals: a class body cannot read an enclosing
    # function's variable whose name it also assigns (LOAD_NAME, not closure).
    _m, _p, _t, _mt = model, provider, temperature, max_tokens

    class AgentSwarmsChatModel(BaseChatModel):
        model_name: str = _m
        provider_name: str = _p
        temperature: float = _t
        max_tokens: int = _mt

        @property
        def _llm_type(self) -> str:
            return "agentswarms"

        def bind_tools(self, tools, *, tool_choice=None, **kwargs):
            """Attach tools so the model can emit tool_calls. Accepts anything
            convert_to_openai_tool understands (@tool functions, Pydantic
            models, dicts). Returns a runnable bound with the OpenAI schemas."""
            formatted = [convert_to_openai_tool(t) for t in tools]
            if tool_choice is not None:
                kwargs["tool_choice"] = tool_choice
            return self.bind(tools=formatted, **kwargs)

        def _payload(self, messages, **kwargs):
            payload = {
                "provider": self.provider_name,
                "model": self.model_name,
                "messages": [_message_to_openai(m) for m in messages],
                "temperature": self.temperature,
                "max_tokens": self.max_tokens,
            }
            tools = kwargs.get("tools")
            if tools:
                payload["tools"] = tools
            tool_choice = kwargs.get("tool_choice")
            if tool_choice is not None:
                payload["tool_choice"] = tool_choice
            return payload

        @staticmethod
        def _result(text, tool_calls=None):
            lc_tool_calls = []
            for i, tc in enumerate(tool_calls or []):
                fn = tc.get("function", {}) if isinstance(tc, dict) else {}
                raw_args = fn.get("arguments") or "{}"
                try:
                    parsed = _json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except Exception:
                    parsed = {}
                lc_tool_calls.append({
                    "name": fn.get("name"),
                    "args": parsed if isinstance(parsed, dict) else {},
                    "id": tc.get("id") or f"call_{i}",
                    "type": "tool_call",
                })
            msg = AIMessage(content=text or "", tool_calls=lc_tool_calls)
            return ChatResult(generations=[ChatGeneration(message=msg)])

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if not _ORIGIN or not _TOKEN:
                raise RuntimeError("AgentSwarms runtime is not configured in this kernel.")
            with httpx.Client(timeout=120, trust_env=True) as client:
                resp = client.post(
                    _ORIGIN + "/api/python-chat",
                    json=self._payload(messages, **kwargs),
                    headers={"Authorization": "Bearer " + _TOKEN},
                )
            data = resp.json() if resp.content else {}
            if resp.status_code != 200:
                raise RuntimeError(data.get("message") or data.get("error") or f"HTTP {resp.status_code}")
            return self._result(data.get("content"), data.get("tool_calls"))

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            data = await _post("/api/python-chat", self._payload(messages, **kwargs))
            return self._result(data.get("content"), data.get("tool_calls"))

    return AgentSwarmsChatModel()


def llama_llm(model="openai/gpt-4o-mini", provider="openrouter", temperature=0.7, max_tokens=1024):
    """A LlamaIndex LLM backed by AgentSwarms (for query engines and agents)."""
    from llama_index.core.llms import CustomLLM, CompletionResponse, LLMMetadata
    from llama_index.core.llms.callbacks import llm_completion_callback

    _m, _p, _t, _mt = model, provider, temperature, max_tokens

    class AgentSwarmsLlamaLLM(CustomLLM):
        model_name: str = _m
        provider_name: str = _p
        temperature: float = _t
        num_output: int = _mt

        @property
        def metadata(self) -> LLMMetadata:
            return LLMMetadata(context_window=8192, num_output=self.num_output,
                               model_name=self.model_name)

        def _complete(self, prompt: str) -> str:
            if not _ORIGIN or not _TOKEN:
                raise RuntimeError("AgentSwarms runtime is not configured in this kernel.")
            with httpx.Client(timeout=120, trust_env=True) as client:
                resp = client.post(
                    _ORIGIN + "/api/python-chat",
                    json={
                        "provider": self.provider_name,
                        "model": self.model_name,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": self.temperature,
                        "max_tokens": self.num_output,
                    },
                    headers={"Authorization": "Bearer " + _TOKEN},
                )
            data = resp.json() if resp.content else {}
            if resp.status_code != 200:
                raise RuntimeError(data.get("message") or data.get("error") or f"HTTP {resp.status_code}")
            return data["content"]

        @llm_completion_callback()
        def complete(self, prompt: str, **kwargs) -> CompletionResponse:
            return CompletionResponse(text=self._complete(prompt))

        @llm_completion_callback()
        def stream_complete(self, prompt: str, **kwargs):
            text = self._complete(prompt)
            yield CompletionResponse(text=text, delta=text)

    return AgentSwarmsLlamaLLM()


def kb_retriever(top_k=4, kb_ids=None):
    """A LlamaIndex retriever over your AgentSwarms knowledge bases.

    Uses the platform's managed hybrid search, so there is no embedding model to
    configure and access stays RLS-scoped to what you may read.
    """
    from llama_index.core.retrievers import BaseRetriever
    from llama_index.core.schema import NodeWithScore, TextNode

    class AgentSwarmsKBRetriever(BaseRetriever):
        def _retrieve(self, query_bundle):
            hits = _run_sync(kb_search(query_bundle.query_str, kb_ids=kb_ids, top_k=top_k))
            return [
                NodeWithScore(
                    node=TextNode(
                        text=h.get("snippet", ""),
                        metadata={
                            "document": h.get("document"),
                            "knowledge_base": h.get("knowledge_base"),
                        },
                    ),
                    score=1.0,
                )
                for h in hits
            ]

    return AgentSwarmsKBRetriever()


def _run_sync(coro):
    """Run a coroutine from sync code, whether or not a loop is already running."""
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # Inside a running loop (IPython autoawait): use a worker thread.
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(asyncio.run, coro).result()


__all__ += ["chat_model", "llama_llm", "kb_retriever"]
