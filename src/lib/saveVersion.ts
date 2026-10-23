// A save that does not say which version it edits (sweep 9, R303).
//
// Five editors write over the stored row only on the version they read: the
// BI report, the workflow, the ETL pipeline, the SQL model and the MCP
// server's source (R284 to R290). Leaving the version out meant "Overwrite
// with mine". A page opened before those rounds were deployed sends no
// version at all, so its save was taken for an overwrite and undid the saves
// made since, without a word. That was R290's unexplained run: a tab loaded on
// the build before took two autosaved lines out of an MCP server's source.
// Overwriting is now said in so many words, and an update that says neither is
// refused.

/**
 * The refusal for an update that carries neither the version it was editing
 * nor `overwrite: true`, or null when it may go ahead. `what` names the thing
 * saved, as the sentence reads it ("report", "MCP server's source").
 */
export function unversionedSave(
  what: string,
  save: { version: string | null | undefined; overwrite?: boolean },
): string | null {
  if (save.overwrite === true || save.version) return null;
  return (
    `This save did not say which version of the ${what} it was editing, so it could have ` +
    "undone a save made since. Nothing was saved. The page was most likely opened before the " +
    "app was updated: copy your changes, reload the page, and save again."
  );
}
