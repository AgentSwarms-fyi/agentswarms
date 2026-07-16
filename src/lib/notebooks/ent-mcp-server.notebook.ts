import type { Notebook } from "./types";

export const entMcpServerNotebook: Notebook = {
  id: "ent-mcp-server",
  title: "Building a Custom TypeScript MCP Server",
  description:
    "Build an MCP (Model Context Protocol) server from scratch in TypeScript. Define tools with Zod schemas, generate the JSON-RPC envelope any LLM client can call, and handle initialize, tools/list, and tools/call end-to-end.",
  difficulty: "advanced",
  tags: ["agent", "langchain"],
  requires: [],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# Custom MCP Server

The **Model Context Protocol** is the open standard for letting LLMs talk to external tools. Claude Desktop, Cursor, modern Gemini clients, and many agent frameworks all speak it. Build one MCP server, get it for free everywhere.

\`\`\`
┌──────────────┐    JSON-RPC over HTTP/stdio    ┌──────────────┐
│  LLM Client  │ ◀──────────────────────────▶ │  Your Server │
└──────────────┘     initialize                  └──────────────┘
                     tools/list                   exposes:
                     tools/call                    - read_file
                                                   - send_email
                                                   - query_db
\`\`\`

In this notebook you'll build the server logic in pure TypeScript — no framework required. By the end you'll have a working JSON-RPC dispatcher you could mount on any HTTP endpoint (we show the TanStack Start route at the very end).

**The three methods every MCP server must implement:**
1. \`initialize\` — version handshake and capability advertisement.
2. \`tools/list\` — return the catalog of available tools, each with a JSON Schema for its arguments.
3. \`tools/call\` — execute a named tool with validated arguments and return the result.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · Define a tool with a Zod schema\n\nThe MCP spec requires each tool to publish its parameter schema as **JSON Schema Draft 7**. We use Zod for ergonomic TypeScript typing, then convert to JSON Schema for the wire format. (\`zod-to-json-schema\` is what \`mcp-tanstack-start\` and the MCP SDK use under the hood — here we'll hand-write a tiny converter so you see what it produces.)` },
    {
      id: "define-tool", kind: "code", language: "js", runtime: "browser",
      source: `const { z } = ctx.lc;

// Minimal Zod → JSON Schema converter (handles the subset MCP tools need).
function zodToJsonSchema(schema) {
  if (schema instanceof z.ZodString)  return { type: "string",  ...(schema.description ? { description: schema.description } : {}) };
  if (schema instanceof z.ZodNumber)  return { type: "number",  ...(schema.description ? { description: schema.description } : {}) };
  if (schema instanceof z.ZodBoolean) return { type: "boolean", ...(schema.description ? { description: schema.description } : {}) };
  if (schema instanceof z.ZodEnum)    return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToJsonSchema(v);
      if (!(v instanceof z.ZodOptional)) required.push(k);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
  }
  return {};
}

// The tool factory: pair a Zod schema with an async execute function.
function defineTool({ name, description, parameters, execute }) {
  return {
    name,
    description,
    inputSchema: zodToJsonSchema(parameters),
    parameters,         // kept for runtime validation
    execute,
  };
}

ctx.state.defineTool = defineTool;

// Demo tool: a fake filesystem reader.
const readFile = defineTool({
  name: "read_file",
  description: "Read the contents of a workspace file. Returns the file body as text.",
  parameters: z.object({
    path: z.string().describe("Workspace-relative path, e.g. 'docs/README.md'."),
  }),
  execute: async ({ path }) => {
    const fake = {
      "docs/README.md": "# Demo Project\\n\\nThis is a fake file served by our MCP demo.",
      "src/index.ts":   "export const greet = (n: string) => \`Hello, \${n}!\`;",
    };
    return fake[path] ?? "(file not found: " + path + ")";
  },
});

ctx.state.tools = [readFile];
return { tool: readFile.name, jsonSchema: readFile.inputSchema };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · The JSON-RPC dispatcher\n\nMCP rides on JSON-RPC 2.0. Every request has \`{ jsonrpc: "2.0", id, method, params }\` and every response has \`{ jsonrpc: "2.0", id, result | error }\`. Errors use standardised codes (\`-32600\` invalid request, \`-32601\` method not found, \`-32602\` invalid params).` },
    {
      id: "dispatcher", kind: "code", language: "js", runtime: "browser",
      source: `function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function createMcpServer({ name, version, tools, instructions }) {
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

  return {
    async handle(req) {
      const { id, method, params } = req;
      try {
        if (method === "initialize") {
          return rpcResult(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            instructions,
          });
        }

        if (method === "tools/list") {
          return rpcResult(id, {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
        }

        if (method === "tools/call") {
          const tool = toolsByName[params?.name];
          if (!tool) return rpcError(id, -32601, "Unknown tool: " + params?.name);
          // Runtime-validate arguments with the Zod schema. The wire schema
          // (JSON Schema) is for the client; we never trust it on our side.
          const parsed = tool.parameters.safeParse(params.arguments ?? {});
          if (!parsed.success) return rpcError(id, -32602, "Invalid arguments: " + parsed.error.message);
          const output = await tool.execute(parsed.data);
          return rpcResult(id, { content: [{ type: "text", text: String(output) }] });
        }

        return rpcError(id, -32601, "Method not found: " + method);
      } catch (e) {
        return rpcError(id, -32603, "Internal error: " + (e instanceof Error ? e.message : String(e)));
      }
    },
  };
}

const server = createMcpServer({
  name: "demo-mcp", version: "1.0.0",
  instructions: "A demo MCP server exposing fake workspace file access.",
  tools: ctx.state.tools,
});

ctx.state.server = server;
return { ready: true };
`,
    },

    { id: "md-3", kind: "markdown", source: `## 3 · Simulate a full client conversation\n\nWatch the JSON-RPC envelopes flow. This is exactly what travels over the wire when Claude Desktop or Cursor connects to your server — just three calls and you're plugged into the entire MCP ecosystem.` },
    {
      id: "conversation", kind: "code", language: "js", runtime: "browser",
      source: `const server = ctx.state.server;

const trace = [];
async function call(label, req) {
  const res = await server.handle(req);
  trace.push({ step: label, request: req, response: res });
  ctx.log("→ " + label + ": " + JSON.stringify(req).slice(0, 100));
  ctx.log("← " + JSON.stringify(res).slice(0, 200));
}

await call("initialize", {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", clientInfo: { name: "demo-client", version: "0.1" } },
});

await call("tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list" });

await call("tools/call (valid)", {
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: "read_file", arguments: { path: "docs/README.md" } },
});

await call("tools/call (bad args)", {
  jsonrpc: "2.0", id: 4, method: "tools/call",
  params: { name: "read_file", arguments: { wrong: 42 } },
});

await call("unknown method", { jsonrpc: "2.0", id: 5, method: "tools/dance" });

return trace;
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · Mounting it on TanStack Start\n\nIn the AgentSwarms stack you'd expose this server as a TanStack Start server route. The handler is a one-liner: parse the JSON body, hand it to \`server.handle\`, return the result. This is a code reference — don't run it from the notebook.\n\n\`\`\`ts\n// src/routes/api/mcp.ts\nimport { createFileRoute } from "@tanstack/react-router";\nimport { server } from "@/lib/mcp/server";\n\nexport const Route = createFileRoute("/api/mcp")({\n  server: {\n    handlers: {\n      POST: async ({ request }) => {\n        const body = await request.json();\n        const result = await server.handle(body);\n        return new Response(JSON.stringify(result), {\n          headers: { "Content-Type": "application/json" },\n        });\n      },\n      GET:    async () => new Response("Method Not Allowed", { status: 405 }),\n      DELETE: async () => new Response("Method Not Allowed", { status: 405 }),\n    },\n  },\n});\n\`\`\`\n\nFor production use the official **\`mcp-tanstack-start\`** package — it handles SSE streaming, session management, and the \`Accept: application/json, text/event-stream\` header that MCP clients require.` },

    { id: "md-5", kind: "markdown", source: `**Things to try:**\n\n- Add a second tool (e.g. \`list_files\`) with an enum parameter (\`sort: z.enum(["name", "size"])\`). Re-run cell 3's \`tools/list\` call and see the new JSON Schema appear in the response.\n- Break the JSON-RPC contract on purpose: send a request without an \`id\`. Look at the error code in the response — JSON-RPC has been a stable standard since 2010, the codes are worth knowing by heart.\n- Wrap \`server.handle\` with an auth layer that requires a bearer token before any method other than \`initialize\`. That's the standard production hardening for any MCP server with side effects.` },
  ],
};
