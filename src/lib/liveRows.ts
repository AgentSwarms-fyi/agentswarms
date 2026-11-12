// Keeping a screen's rows current, with or without Supabase Realtime (R468).
//
// Realtime is optional. Hosted and self-hosted Supabase run it, and a screen
// there hears about a change the moment it is written. On Amazon RDS it cannot
// run: Supabase Realtime needs a true superuser, which RDS gives no one. An
// install there sets PUBLIC_SUPABASE_REALTIME=off, and the screen polls
// instead. It also polls when Realtime is on but its channel fails (a proxy
// that drops websockets, a Realtime service that is down), and goes back to
// listening when the channel recovers.
//
// Either way a screen refreshes when its tab comes back into view, so one left
// in the background is current the moment someone looks at it.
//
// Polling asks only while the tab is visible, every REALTIME_POLL_MS: a
// parked run waits on an approval, so a quarter of a minute is the most a
// person waits to see one.

export const REALTIME_POLL_MS = 15_000;

/** Off only when the setting says so; any other value, or none, is on. */
export function realtimeEnabled(setting: string | undefined): boolean {
  return !/^(off|false|0|no)$/i.test(setting?.trim() ?? "");
}

/** Channel states after which no change event will arrive until it rejoins. */
export function realtimeFailed(status: string): boolean {
  return status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED";
}

export type LiveMode = "realtime" | "polling";

export type LiveDeps = {
  realtime: boolean;
  /** Subscribes to every change of public.<table>; returns how to unsubscribe. */
  openChannel: (
    name: string,
    table: string,
    onChange: () => void,
    onStatus: (status: string) => void,
  ) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  isVisible: () => boolean;
  /** Calls back when the tab is focused or becomes visible; returns how to stop. */
  onVisible: (fn: () => void) => () => void;
};

/**
 * Calls `refresh` whenever the rows of `table` may have changed. Returns how
 * to stop. `onMode` hears which way it is currently keeping up.
 */
export function watchRows(
  opts: { channel: string; table: string; refresh: () => void; onMode?: (mode: LiveMode) => void },
  deps: LiveDeps,
): () => void {
  let active = true;
  let timer: unknown;
  const refresh = () => {
    if (active) opts.refresh();
  };
  const startPolling = () => {
    if (!active || timer !== undefined) return;
    timer = deps.setInterval(() => {
      if (deps.isVisible()) refresh();
    }, REALTIME_POLL_MS);
    opts.onMode?.("polling");
  };
  const stopPolling = () => {
    if (timer === undefined) return;
    deps.clearInterval(timer);
    timer = undefined;
  };

  const stopVisible = deps.onVisible(() => {
    if (deps.isVisible()) refresh();
  });

  let closeChannel: (() => void) | undefined;
  if (deps.realtime) {
    opts.onMode?.("realtime");
    closeChannel = deps.openChannel(opts.channel, opts.table, refresh, (status) => {
      if (!active) return;
      if (status === "SUBSCRIBED") {
        // Back from a failure: listening again, and catching up on whatever
        // changed while nobody was listening.
        if (timer !== undefined) {
          stopPolling();
          opts.onMode?.("realtime");
          refresh();
        }
      } else if (realtimeFailed(status)) {
        startPolling();
      }
    });
  } else {
    startPolling();
  }

  return () => {
    active = false;
    stopPolling();
    stopVisible();
    closeChannel?.();
  };
}
