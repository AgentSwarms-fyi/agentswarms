// How a version is named where it is spoken of: in the note taken before a
// restore, the name of a workbook opened from it, and the toast. A named
// version goes by its name; any other by its time, as the person's browser
// shows it (the server only knows UTC, and "18:41" beside a list that says
// "10:41 PM" reads as a different version).

export type VersionRef = { kind: "auto" | "named" | "before_restore"; label: string | null };

/** The time a version was taken, as the server writes it when the browser did not say. */
export function utcShown(createdAt: string): string {
  return `${new Date(createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * "“Sent to finance”", or "the version of 9/25/2026, 10:41:39 PM". A version
 * taken before a restore is spoken of by its time too, so restoring one does
 * not nest: "Before restoring Before restoring …".
 */
export function versionPhrase(v: VersionRef, shown: string): string {
  return v.kind === "named" && v.label ? `“${v.label}”` : `the version of ${shown}`;
}

/** The label of the version taken just before restoring `v`. */
export function beforeRestoreLabel(v: VersionRef, shown: string): string {
  return `Before restoring ${versionPhrase(v, shown)}`.slice(0, 200);
}

/** The name of a workbook opened from `v`. */
export function copyName(workbookName: string, v: VersionRef, shown: string): string {
  const what = v.kind === "named" && v.label ? v.label : shown;
  return `${workbookName} (${what})`.slice(0, 200);
}
