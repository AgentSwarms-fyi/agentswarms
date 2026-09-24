// How long an MCP server may take to come up, and so how long a client of one
// must be prepared to wait for its first answer.
//
// No imports on purpose: src/lib/mcp/probe.functions.ts is bundled into a
// client route, and it needs the same number the server side uses.

/**
 * How long this instance's MCP endpoint waits for a scaled-to-zero Builder
 * server to start before it answers 503. The reasoning behind the figure is
 * with its use in mcpApps/service.server.ts.
 */
export const MCP_COLD_START_MS = 90_000;

/**
 * How long a client waits for the answer to `initialize`.
 *
 * FOUND IN R100. The agents' client gave initialize 15 s and Test connection
 * gave it 12 s, while a Builder server that had scaled to zero took 17.7 s and
 * 35.5 s to start in two measured cold starts. Idle servers stop after 15
 * minutes by default, so the first agent call after a quiet spell failed with
 * "The operation was aborted due to timeout", and Test connection marked a
 * healthy server Error. The endpoint then answered 200 to nobody and kept a
 * session no one would end.
 *
 * A client's patience has to outlast the server's own budget. Then the
 * endpoint's answer arrives whatever it is: ready, or its 503 naming what went
 * wrong. It must not be cut off first. The extra is the ordinary budget for one
 * request once the server is up. For an external server this only lengthens
 * how long a HUNG initialize is waited on; an answer still returns as soon as
 * it comes.
 */
export const MCP_CONNECT_BUDGET_MS = MCP_COLD_START_MS + 15_000;
