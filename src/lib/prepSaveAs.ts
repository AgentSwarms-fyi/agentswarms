/**
 * The hover title of Data Prep's "Save as" select, by what is known about
 * the lakehouse.
 *
 * FOUND IN R204: the select said "The lakehouse is not configured on this
 * deployment" while the list of lakehouse tables was still loading and after
 * reading it failed, as well as when the lakehouse really is not configured.
 * On a deployment whose lakehouse works, a slow or failed read told the
 * reader it did not exist.
 */
export type LakeState = "loading" | "error" | "off" | "on";

export function saveAsHint(state: LakeState, error?: string | null): string {
  switch (state) {
    case "loading":
      return "Checking the lakehouse…";
    case "error":
      return `The lakehouse tables could not be read${error ? `: ${error}` : ""}. A local dataset can still be saved.`;
    case "off":
      return "The lakehouse is not configured on this deployment";
    case "on":
      return "A dataset lives in the workspace; a lakehouse table is queryable by SQL, agents and the ML wizard";
  }
}

/** Which of those the component's state is in. */
export function lakeStateOf(lake: { enabled: boolean } | null | "error"): LakeState {
  if (lake === null) return "loading";
  if (lake === "error") return "error";
  return lake.enabled ? "on" : "off";
}
