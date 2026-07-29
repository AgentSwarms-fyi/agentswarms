// "Describe it, get a FastMCP server" — the AI tab in MCP Builder.
//
// Runs in the browser through /api/bi (JSON mode) like the rest of the app's
// generative features, so it inherits the caller's own integration, IAM model
// rules, budgets and execution traces without a second code path.
import { llmJson } from "@/lib/biAgent";

const SYSTEM = `You write Python MCP servers using FastMCP. Return ONLY JSON.

Rules that the runtime enforces — code that breaks them will not start:
- Create exactly one module-level server object named \`mcp\`:  mcp = FastMCP("name")
- Import it as:  from fastmcp import FastMCP
- Define tools with the @mcp.tool() decorator (with parentheses) on plain functions.
- NEVER call mcp.run(), asyncio.run(mcp...), or any serve/start function. The
  platform serves the object for you; calling run() yourself deadlocks startup.
- Every tool needs type hints on all parameters and a return type: they become
  the tool's JSON schema.
- Every tool needs a one-line docstring. The calling model reads it to decide
  when to use the tool, so describe WHAT it does and WHEN to use it.
- Read configuration from os.environ.get(...) with a sensible default. Never
  hard-code a credential, and never print one.
- The sandbox has no filesystem persistence and reaches the network only
  through an allow-listed proxy. Prefer httpx (installed) for HTTP.
- Available without installing: httpx, pydantic, pandas, numpy, langchain,
  llama_index, and \`agentswarms\` (governed model + knowledge-base access:
  await agentswarms.kb_search(q), await agentswarms.chat(prompt, model=...)).

Respond with: {"code": "<the complete python file>", "requirements": "<extra pip packages, one per line, or empty>", "notes": "<one sentence on anything the user must configure>"}`;

export type GeneratedServer = { code: string; requirements: string; notes: string };

/**
 * Generate a server from a plain-English description.
 *
 * `model` is threaded explicitly rather than left to the endpoint's default —
 * a caller that sends none gets a silently substituted model, which is how
 * unrelated features have previously reported spurious credit errors.
 */
export async function generateMcpServer(opts: {
  description: string;
  /** Encoded "provider::model" choice from BiModelSelect. */
  model?: string;
  /** Current source, when the user is asking for a change rather than a rewrite. */
  existingCode?: string;
}): Promise<GeneratedServer> {
  const userPrompt = opts.existingCode?.trim()
    ? `Here is the current server:\n\n\`\`\`python\n${opts.existingCode}\n\`\`\`\n\nApply this change and return the COMPLETE updated file:\n${opts.description}`
    : `Write an MCP server that does the following:\n${opts.description}`;

  const out = await llmJson<Partial<GeneratedServer>>({
    systemPrompt: SYSTEM,
    userPrompt,
    model: opts.model,
    temperature: 0.2,
    maxTokens: 4000,
  });

  const code = typeof out.code === "string" ? out.code.trim() : "";
  if (!code) throw new Error("The model did not return any code. Try rephrasing the description.");
  return {
    code: stripFence(code),
    requirements: typeof out.requirements === "string" ? out.requirements.trim() : "",
    notes: typeof out.notes === "string" ? out.notes.trim() : "",
  };
}

/** Models often wrap code in a fence even when told to return raw JSON. */
function stripFence(code: string): string {
  const m = code.match(/^```(?:python)?\n([\s\S]*?)\n```$/);
  return (m ? m[1] : code).trim() + "\n";
}
