// Starter sources for MCP Builder.
//
// Every template is a complete, deployable server — not a fragment with TODOs.
// The first thing a new user does is press Deploy, and a template that cannot
// survive that teaches them nothing except that the feature is broken.
//
// Pure module so both the list page (to show the choices) and the create
// server function (to seed the source) can read it.

export type McpTemplate = {
  id: string;
  title: string;
  tagline: string;
  /** Extra pip packages this template needs, one per line. */
  requirements: string;
  source: string;
};

/**
 * The contract the sandbox runner enforces: a module-level FastMCP instance
 * (preferably named `mcp`) with `@mcp.tool()` functions. Repeated at the top of
 * each template because that is where someone editing will actually read it.
 *
 * The decorator is written WITH parentheses on purpose: bare `@mcp.tool` is
 * only accepted by fastmcp 2.11+, while `@mcp.tool()` works on every version
 * and on the official SDK's FastMCP too. A template that fails to deploy on a
 * slightly older image teaches the user nothing.
 */
const HEADER = `# Runs on a sandboxed server kernel. The runner looks for a module-level
# FastMCP instance named \`mcp\` (or \`server\`/\`app\`) and serves it over
# Streamable HTTP. Type hints become the tool's input schema, and the
# docstring becomes the description the calling model reads.
`;

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "starter",
    title: "Hello world",
    tagline: "Two tools and a docstring — the smallest thing that deploys.",
    requirements: "",
    source: `${HEADER}
from fastmcp import FastMCP

mcp = FastMCP("my-server")


@mcp.tool()
def greet(name: str) -> str:
    """Return a friendly greeting for the given name."""
    return f"Hello, {name}!"


@mcp.tool()
def word_count(text: str) -> dict:
    """Count words and characters in a block of text."""
    words = text.split()
    return {"words": len(words), "characters": len(text)}
`,
  },
  {
    id: "http-api",
    title: "Wrap an HTTP API",
    tagline: "Turn an internal REST service into typed MCP tools.",
    requirements: "",
    source: `${HEADER}#
# The sandbox reaches the internet only through the instance egress
# allow-list, so add this host under Admin -> Developer runtime first or the
# request will be refused by the proxy rather than by the remote server.
import os

import httpx
from fastmcp import FastMCP

mcp = FastMCP("http-api")

BASE_URL = os.environ.get("API_BASE_URL", "https://api.example.com")
# Bind a secret on the Secrets tab; it arrives as an environment variable and
# is never written to the database or the logs.
API_TOKEN = os.environ.get("API_TOKEN", "")


def _client() -> httpx.Client:
    headers = {"Authorization": f"Bearer {API_TOKEN}"} if API_TOKEN else {}
    return httpx.Client(base_url=BASE_URL, headers=headers, timeout=20, trust_env=True)


@mcp.tool()
def get_customer(customer_id: str) -> dict:
    """Fetch one customer record by id."""
    with _client() as c:
        r = c.get(f"/customers/{customer_id}")
        r.raise_for_status()
        return r.json()


@mcp.tool()
def search_customers(query: str, limit: int = 10) -> list:
    """Search customers by name or email. Returns at most \`limit\` matches."""
    with _client() as c:
        r = c.get("/customers", params={"q": query, "limit": limit})
        r.raise_for_status()
        return r.json()
`,
  },
  {
    id: "knowledge",
    title: "Search a knowledge base",
    tagline: "Expose your RAG index as an MCP tool any client can call.",
    requirements: "",
    source: `${HEADER}#
# \`agentswarms\` is preinstalled and already authenticated as you: calls are
# governed by your IAM rules and budgets, and no provider key exists inside
# this sandbox.
import asyncio

import agentswarms
from fastmcp import FastMCP

mcp = FastMCP("knowledge")


@mcp.tool()
def search_knowledge(query: str, top_k: int = 5) -> list:
    """Search the connected knowledge bases and return the matching passages."""
    hits = asyncio.run(agentswarms.kb_search(query, top_k=top_k))
    return [
        {"text": h.get("content", ""), "source": h.get("document_name", ""), "score": h.get("score")}
        for h in hits
    ]


@mcp.tool()
def list_knowledge_bases() -> list:
    """List the knowledge bases available to this server."""
    return asyncio.run(agentswarms.list_knowledge_bases())
`,
  },
];

export function templateById(id: string | null | undefined): McpTemplate {
  return MCP_TEMPLATES.find((t) => t.id === id) ?? MCP_TEMPLATES[0];
}
