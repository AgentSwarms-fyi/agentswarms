// The session's access token, for calling the server, without making
// anything reload when the session refreshes.
//
// The token changes on every refresh (about hourly, and when a tab regains
// focus near expiry). A load keyed on it ran again each time and put the
// saved copy back over whatever the user was editing: a pipeline's graph, a
// report's blocks, an admin form, a one-time API key on screen (R120, R125).
// Read `tokenRef.current` inside the call; key the load on `signedIn`, which
// changes only when the user signs in or out.

import { useRef } from "react";

export function useTokenRef(token: string | null | undefined) {
  const tokenRef = useRef(token ?? "");
  tokenRef.current = token ?? "";
  return { tokenRef, signedIn: !!token };
}
