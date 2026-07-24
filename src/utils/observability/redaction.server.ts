// Compliance gate for persisting free-text bodies in the observability tables.
//
// Traces and swarm-run steps store the actual prompts, model responses, node
// inputs/outputs and chain-of-thought. That is what makes debugging good, but
// regulated tenants often cannot keep user content at rest, or must answer
// "what do you retain, and can you delete it". PERSIST_PROMPT_BODIES=false lets
// them keep the full operational skeleton — model, provider, tokens, cost,
// latency, status, node graph, tool-call shape — while dropping the text.
//
// Default ON, so nothing changes unless an operator opts out. Every writer of
// these bodies is server-side (the canvas tracer writes via server functions),
// so this single server-side gate covers all paths.
//
// NOTE: this drops bodies at WRITE time; it is not retroactive. Pair it with
// trace_retention_days to bound anything captured before it was enabled.
export function persistPromptBodies(): boolean {
  return !/^(0|false|no)$/i.test(process.env.PERSIST_PROMPT_BODIES ?? "");
}

/** A text body to store, or null when body persistence is disabled. */
export function bodyText<T>(value: T): T | null {
  return persistPromptBodies() ? value : null;
}

/** A JSON body to store, or a redaction marker when persistence is disabled. */
export function bodyJson<T>(value: T): T | { redacted: true } {
  return persistPromptBodies() ? value : { redacted: true };
}
