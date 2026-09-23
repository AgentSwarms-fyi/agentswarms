// Why a user may not run notebook code on a server kernel. Pure, so the
// wording every path gives is one decision, tested once.
//
// FOUND FROM THE SURVEY (R96). Admin → Developer runtime promises two things:
// "Enable server runtime — Allow Developer-workspace notebooks to launch server
// kernels", and "Require an access grant — When on, only superadmins and granted
// users/groups may start a kernel". Only the interactive kernel route and MCP
// deploys asked. A published notebook's API, a workflow's Notebook step and
// minting the key that publishes a notebook ran — or enabled — server kernels
// with the runtime switched off, for anyone.

export type RuntimeRefusal = {
  code: "runtime_disabled" | "not_permitted";
  message: string;
};

/** null when the user may run notebook code; otherwise the reason, owner-facing. */
export function runtimeRefusalFor(state: {
  enabled: boolean;
  permitted: boolean;
}): RuntimeRefusal | null {
  if (!state.enabled) {
    return {
      code: "runtime_disabled",
      message:
        "The server runtime is not enabled on this instance. An administrator can enable it in Admin settings.",
    };
  }
  if (!state.permitted) {
    return {
      code: "not_permitted",
      message: "Your administrator has not granted you access to the server runtime.",
    };
  }
  return null;
}
