// A server function's validator error, said as the sentence it was written with.
//
// FOUND FROM THE UI. Data Catalog → Add → Object storage bucket, named
// "R422 private store (kept fixture)" → Connect & crawl: the dialog read
// `Not saved: [ { "origin": "string", "code": "invalid_format", ... } ]`.
// catalogCreateSource validates with `schema.parse(input)`, and a ZodError's
// message is its issue array as pretty-printed JSON. The server-function
// transport keeps only an error's message (router-core's ShallowErrorPlugin
// rebuilds `new Error(message)` on the client), so the issues arrive as that
// JSON text and nothing else. The validator's own message — "Letters,
// numbers, spaces, - _ . only" — is in there, buried.
//
// slack.functions.ts fixes this on the server for its own functions
// (`parseInput`). This is the caller's side of it, for a dialog that shows
// whatever a server function threw: a validator error becomes its messages,
// and any other error is shown as it was.

type Issue = { code: string; path: (string | number)[]; message: string };

function isIssue(v: unknown): v is Issue {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.code === "string" && typeof o.message === "string" && Array.isArray(o.path);
}

/**
 * The issues a validator's error carries, or null when the error is not one.
 * Read from the message, which is the issue JSON on either side of the call.
 */
export function validatorIssues(e: unknown): Issue[] | null {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isIssue) ? parsed : null;
}

/**
 * What to show for an error from a server-function call. A validator's error
 * becomes one message per field, in the order it reported them, each after the
 * field's label when `labels` names its path ("storage.bucket"); a field with
 * several problems gets its first. Anything else is its message unchanged.
 */
export function validatorErrorText(e: unknown, labels: Record<string, string> = {}): string {
  const issues = validatorIssues(e);
  if (!issues) return e instanceof Error ? e.message : String(e);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const issue of issues) {
    const key = issue.path.join(".");
    if (seen.has(key)) continue;
    seen.add(key);
    const label = labels[key];
    out.push(label ? `${label}: ${issue.message}` : issue.message);
  }
  return out.join("; ");
}
