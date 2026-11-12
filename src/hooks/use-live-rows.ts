import { useEffect, useRef, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { type LiveMode, realtimeEnabled, watchRows } from "@/lib/liveRows";
import { publicConfig } from "@/lib/publicConfig";

/**
 * Calls `refresh` whenever the rows of public.<table> may have changed: on a
 * Realtime change event, or by polling where Realtime is off or its channel
 * failed, and whenever the tab comes back into view (src/lib/liveRows.ts).
 * The table must be in the supabase_realtime publication for its events to
 * arrive. Returns how it is currently keeping up.
 */
export function useLiveRows(opts: {
  channel: string;
  table: string;
  refresh: () => void;
  enabled?: boolean;
}): LiveMode {
  const { channel, table, enabled = true } = opts;
  const refreshRef = useRef(opts.refresh);
  refreshRef.current = opts.refresh;
  const [mode, setMode] = useState<LiveMode>("realtime");

  useEffect(() => {
    if (!enabled) return;
    return watchRows(
      { channel, table, refresh: () => refreshRef.current(), onMode: setMode },
      {
        realtime: realtimeEnabled(publicConfig().supabaseRealtime),
        openChannel: (name, tbl, onChange, onStatus) => {
          const ch = supabase
            .channel(name)
            .on("postgres_changes", { event: "*", schema: "public", table: tbl }, () => onChange())
            .subscribe((status) => onStatus(status));
          return () => {
            supabase.removeChannel(ch);
          };
        },
        setInterval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (handle) => window.clearInterval(handle as number),
        isVisible,
        onVisible,
      },
    );
  }, [enabled, channel, table]);

  return mode;
}

/**
 * Calls `refresh` when the tab is focused or comes back into view: for rows
 * that change rarely, and only from this screen or a server action, where
 * neither a channel nor a poll is worth it.
 */
export function useRefreshOnView(refresh: () => void, enabled = true): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    return onVisible(() => {
      if (isVisible()) refreshRef.current();
    });
  }, [enabled]);
}

const isVisible = () => document.visibilityState === "visible";

function onVisible(fn: () => void): () => void {
  window.addEventListener("focus", fn);
  document.addEventListener("visibilitychange", fn);
  return () => {
    window.removeEventListener("focus", fn);
    document.removeEventListener("visibilitychange", fn);
  };
}
