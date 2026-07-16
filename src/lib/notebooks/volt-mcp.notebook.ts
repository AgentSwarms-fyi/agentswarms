import type { Notebook } from "./types";

export const voltMcpNotebook: Notebook = {
  id: "volt-mcp",
  title: "MCP — connect an Agent to a Model Context Protocol server",
  description:
    "VoltAgent's MCPClient connects to any MCP server (filesystem, GitHub, browser automation, custom). List the server's tools, hand them to an Agent, and watch the model call them as if they were native createTool()s.",
  difficulty: "advanced",
  tags: ["agent"],
  subgroup: "Integrations",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 6 · MCP — \`MCPConfiguration\` + agent tools

The **Model Context Protocol** (MCP) is a standard for letting AI agents talk to external systems through a typed tool/resource API. VoltAgent ships an MCP **client** so any agent can pick up tools exposed by any MCP server — *without* you re-writing them as \`createTool()\`s.

\`\`\`ts
import { Agent, MCPConfiguration } from "@voltagent/core";

const mcp = new MCPConfiguration({
  servers: {
    filesystem: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"] },
    github:     { type: "http",  url: "https://mcp.github.com",  requestInit: { headers: { Authorization: \`Bearer \${process.env.GH_PAT}\` } } },
  },
});

const tools = await mcp.getTools();          // → typed VoltAgent tools, ready to attach

const agent = new Agent({
  name: "research-agent",
  instructions: "Use the filesystem and github tools to answer.",
  model,
  tools,
});
\`\`\`

VoltAgent supports **four transports**: \`http\` (Streamable HTTP, the modern default), \`sse\` (legacy server-sent events), \`stdio\` (local child process), and \`websocket\`. The agent never knows which transport is used — tools just appear.

Below we **simulate** an MCP-shaped server in-memory, discover its catalog, and let an agent use its tools to solve a task.`,
    },

    {
      id: "mcp-server-intro", kind: "markdown",
      source: `### 1. A tiny in-memory MCP server
Real MCP servers usually run as separate processes or HTTP endpoints. Here, we'll create a simple object that implements the core MCP interface: listing tools and calling them. Our server manages a small virtual filesystem for an e-bike shop.`,
    },
    {
      id: "mcp-server-code", kind: "code", language: "js", runtime: "browser",
      source: `const FS = { 
  "notes.md": "# Notes\\n- restock pads\\n- order new chain\\n", 
  "todo.txt": "1. fix brakes\\n2. tune motor\\n" 
};

const MCP_SERVER = {
  name: "shop-mcp",
  async listTools() {
    return [
      { name: "fs_list",    description: "List files in the shop's working directory.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "fs_read",    description: "Read a file by name. Returns its contents as text.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "fs_append",  description: "Append a line to a file. Creates the file if missing.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "string" } }, required: ["path", "line"] } },
    ];
  },
  async callTool(name, args) {
    if (name === "fs_list")   return { files: Object.keys(FS) };
    if (name === "fs_read")   return FS[args.path] !== undefined ? { content: FS[args.path] } : { error: "not found" };
    if (name === "fs_append") { 
      FS[args.path] = (FS[args.path] ?? "") + args.line + "\\n"; 
      return { ok: true, bytes: FS[args.path].length }; 
    }
    throw new Error("unknown tool: " + name);
  },
};

ctx.state.FS = FS;
ctx.state.MCP_SERVER = MCP_SERVER;
ctx.log("Created shop-mcp server with 3 tools.");`,
    },

    {
      id: "mcp-adapter-intro", kind: "markdown",
      source: `### 2. The MCP Configuration Adapter
In VoltAgent, \`MCPConfiguration\` is the bridge. It connects to servers, fetches their tool definitions, and wraps them into standard VoltAgent tools that provide namespacing (to avoid name collisions) and an \`execute()\` method.`,
    },
    {
      id: "mcp-adapter-code", kind: "code", language: "js", runtime: "browser",
      source: `class MCPConfiguration {
  constructor({ servers }) { this.servers = servers; }
  async getTools() {
    const all = [];
    for (const [serverName, server] of Object.entries(this.servers)) {
      const listed = await server.listTools();
      for (const t of listed) {
        all.push({
          // Namespacing prevents collisions across servers
          name: \`\${serverName}__\${t.name}\`,
          description: t.description,
          parameters: t.inputSchema,
          execute: (args) => server.callTool(t.name, args),
        });
      }
    }
    return all;
  }
}

ctx.state.MCPConfiguration = MCPConfiguration;
ctx.log("MCPConfiguration adapter defined.");`,
    },

    {
      id: "mcp-discovery-intro", kind: "markdown",
      source: `### 3. Discovering tools
Now we instantiate the adapter with our mock server and "discover" the tools. Notice how the tools are automatically prefixed with the server name (e.g., \`shop__fs_list\`).`,
    },
    {
      id: "mcp-discovery-code", kind: "code", language: "js", runtime: "browser",
      source: `const { MCPConfiguration, MCP_SERVER } = ctx.state;

const mcp = new MCPConfiguration({ servers: { shop: MCP_SERVER } });
const tools = await mcp.getTools();

ctx.state.tools = tools;
ctx.log("Discovered tools via MCP:");
for (const t of tools) {
  ctx.log(\`  · \${t.name} — \${t.description}\`);
}`,
    },

    {
      id: "mcp-agent-helper-intro", kind: "markdown",
      source: `### 4. The Agent Loop helper
We need a way to talk to the LLM. This helper takes a list of messages and the tools we discovered, formats them for the model, and returns the model's response.`,
    },
    {
      id: "mcp-agent-helper-code", kind: "code", language: "js", runtime: "browser",
      source: `const AI = ctx.aiBaseURL, KEY = ctx.aiApiKey;

async function chat(messages, toolList) {
  const toolDefs = toolList.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const r = await ctx.fetch(\`\${AI}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages, tools: toolDefs }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).choices[0].message;
}

ctx.state.chat = chat;
ctx.log("Chat helper ready.");`,
    },

    {
      id: "mcp-run-intro", kind: "markdown",
      source: `### 5. Running the Agent
Finally, we give the agent a task. It will use the MCP tools to inspect the "shop" files and update the todo list. Because we used \`MCPConfiguration\`, the model sees these as native tools.`,
    },
    {
      id: "mcp-run-code", kind: "code", language: "js", runtime: "browser",
      source: `const { chat, tools, FS } = ctx.state;

const messages = [
  { role: "system", content: "You are an e-bike mechanic's assistant. Use the shop__* tools to inspect and update files. End with a one-line summary." },
  { role: "user",   content: "Add 'replace handlebar grips' as a new task to my todo, then tell me everything that's on the list." },
];

for (let step = 0; step < 6; step++) {
  const msg = await chat(messages, tools);
  messages.push(msg);
  
  if (!msg.tool_calls?.length) {
    ctx.log("\\n💬 Final response:", msg.content);
    break;
  }
  
  for (const call of msg.tool_calls) {
    const tool = tools.find(t => t.name === call.function.name);
    const args = JSON.parse(call.function.arguments || "{}");
    const out  = await tool.execute(args);
    ctx.log(\`▶ \${tool.name}(\${JSON.stringify(args)}) → \${JSON.stringify(out)}\`);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
  }
}

return { finalFiles: FS, toolsExposed: tools.length };`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## What you just simulated

A real MCP flow, end-to-end:

1. **Server side**: a process exposes \`tools/list\` and \`tools/call\` over a transport.
2. **MCPConfiguration.getTools()**: VoltAgent discovers them, namespaces them (\`server__tool\`), and wraps them so they look like native \`createTool()\` outputs.
3. **Agent loop**: the model picks them up like any other tool — VoltAgent forwards the call back to the MCP server transparently.

The only real-world difference is the transport. Swap our in-memory \`MCP_SERVER\` for:

\`\`\`ts
servers: {
  filesystem: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  github:     { type: "http",  url: "https://mcp.github.com" },
}
\`\`\`

…and the rest of your agent code is identical. That's the value of the protocol — and why VoltAgent treats MCP as a first-class tool source.`,
    },
  ],
};
