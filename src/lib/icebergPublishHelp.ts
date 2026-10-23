// What to say when a publish to an Iceberg catalog fails.
//
// FOUND IN R245. The recorded failure reads "Failed to commit Iceberg
// transaction: … HTTP 500", while the catalog's own log says
// `SQLITE_BUSY: database is locked`. The reader is told a status code and left
// to go and read docker logs to learn that the bundled development catalog
// holds its file lock in-process and will answer 500 to every write until it
// is restarted.
//
// The model for this is the ETL sandbox's socket-proxy message, which names
// what it tried, offers the likely cause as a QUESTION and gives the command
// that fixes it. On 2026-10-04 that message diagnosed a real failure correctly
// and its remedy worked first time. This aims at the same bar.
//
// It does not claim the lock as fact — the lock is in the catalog's log, not
// in the client's error — it says which failure this looks like and where to
// confirm it. A confident wrong cause is the thing this log keeps finding.

/** The error as text, however it was thrown. */
function textOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** A server-side refusal (HTTP 5xx) rather than a rejected request. */
function looksLikeCatalogRefusal(text: string): boolean {
  const t = text.toLowerCase();
  const serverError = /\b5\d\d\b/.test(t) || t.includes("internal server error");
  return serverError && (t.includes("commit") || t.includes("iceberg") || t.includes("catalog"));
}

/**
 * The description for a failed publish: the engine's own words, plus what this
 * particular shape of failure usually means and how to check.
 */
export function publishFailureHelp(e: unknown): string {
  const text = textOf(e).trim() || "The publish failed without a message.";
  if (!looksLikeCatalogRefusal(text)) return text;
  return (
    `${text}\n\n` +
    "The catalog accepted the request and refused the write. The bundled " +
    "development catalog keeps its state in SQLite and can hold that file's " +
    "lock in-process, answering 500 to every commit until it is restarted — " +
    "its log says SQLITE_BUSY when that is what happened. Check " +
    "`docker logs aswarm-iceberg-rest`, and if so: " +
    "`docker compose restart aswarm-iceberg-rest`. A catalog backed by " +
    "Postgres does not share one file lock between requests."
  );
}
