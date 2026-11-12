// R468: Supabase Realtime is optional. On Amazon RDS it cannot run (it needs a
// true superuser), so PUBLIC_SUPABASE_REALTIME=off turns it off and the
// approvals inbox polls; where Realtime is on but its channel fails, the inbox
// polls until it recovers. Before R468 a new approval was announced only by
// the Realtime INSERT event itself, so on a database without Realtime nobody
// was ever told a run was waiting for them.
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { approvalsToAnnounce } from "../../src/lib/approvalsInbox";
import {
  REALTIME_POLL_MS,
  realtimeEnabled,
  realtimeFailed,
  watchRows,
  type LiveDeps,
  type LiveMode,
} from "../../src/lib/liveRows";

function harness(realtime: boolean) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let visible = true;
  let visibleCb: (() => void) | undefined;
  let status: ((s: string) => void) | undefined;
  let change: (() => void) | undefined;
  let opened = 0;
  let closed = 0;
  let refreshes = 0;
  const modes: LiveMode[] = [];
  const deps: LiveDeps = {
    realtime,
    openChannel: (_name, _table, onChange, onStatus) => {
      opened++;
      change = onChange;
      status = onStatus;
      return () => {
        closed++;
      };
    },
    setInterval: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id as number);
    },
    isVisible: () => visible,
    onVisible: (fn) => {
      visibleCb = fn;
      return () => {
        visibleCb = undefined;
      };
    },
  };
  const stop = watchRows(
    { channel: "c", table: "approvals", refresh: () => refreshes++, onMode: (m) => modes.push(m) },
    deps,
  );
  return {
    stop,
    tick: () => [...timers.values()].forEach((fn) => fn()),
    timers: () => timers.size,
    setVisible: (v: boolean) => {
      visible = v;
      visibleCb?.();
    },
    status: (s: string) => status?.(s),
    change: () => change?.(),
    refreshes: () => refreshes,
    opened: () => opened,
    closed: () => closed,
    modes,
  };
}

describe("the setting", () => {
  it("is on unless it says off", () => {
    expect(realtimeEnabled(undefined)).toBe(true);
    expect(realtimeEnabled("")).toBe(true);
    expect(realtimeEnabled("on")).toBe(true);
    for (const off of ["off", "OFF", " false ", "0", "no"])
      expect(realtimeEnabled(off)).toBe(false);
  });

  it("knows which channel states mean no events are coming", () => {
    expect(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].every(realtimeFailed)).toBe(true);
    expect(realtimeFailed("SUBSCRIBED")).toBe(false);
  });
});

describe("Realtime off (Amazon RDS)", () => {
  it("opens no channel and polls, only while the tab is visible", () => {
    const h = harness(false);
    expect(h.opened()).toBe(0);
    expect(h.modes).toEqual(["polling"]);
    expect(h.timers()).toBe(1);
    h.tick();
    expect(h.refreshes()).toBe(1);
    h.setVisible(false);
    h.tick();
    expect(h.refreshes()).toBe(1);
  });

  it("refreshes when the tab comes back into view", () => {
    const h = harness(false);
    h.setVisible(false);
    h.setVisible(true);
    expect(h.refreshes()).toBe(1);
  });

  it("polls often enough that a parked run is not left waiting", () => {
    expect(REALTIME_POLL_MS).toBeLessThanOrEqual(30_000);
  });

  it("stops everything when the screen goes away", () => {
    const h = harness(false);
    h.stop();
    expect(h.timers()).toBe(0);
    h.setVisible(true);
    h.tick();
    expect(h.refreshes()).toBe(0);
  });
});

describe("Realtime on", () => {
  it("listens and does not poll while the channel is up", () => {
    const h = harness(true);
    expect(h.opened()).toBe(1);
    h.status("SUBSCRIBED");
    expect(h.timers()).toBe(0);
    h.change();
    expect(h.refreshes()).toBe(1);
    expect(h.modes).toEqual(["realtime"]);
  });

  it("polls when the channel fails, and stops polling and catches up when it is back", () => {
    const h = harness(true);
    h.status("SUBSCRIBED");
    h.status("CHANNEL_ERROR");
    expect(h.timers()).toBe(1);
    h.status("TIMED_OUT"); // a second failure does not start a second timer
    expect(h.timers()).toBe(1);
    h.tick();
    expect(h.refreshes()).toBe(1);
    h.status("SUBSCRIBED");
    expect(h.timers()).toBe(0);
    expect(h.refreshes()).toBe(2); // what changed while nobody listened
    expect(h.modes).toEqual(["realtime", "polling", "realtime"]);
  });

  it("closes the channel, and a CLOSED status after that starts nothing", () => {
    const h = harness(true);
    h.stop();
    expect(h.closed()).toBe(1);
    h.status("CLOSED");
    expect(h.timers()).toBe(0);
  });
});

describe("announcing new approvals", () => {
  type A = { id: string; status: string; mine: boolean };
  const a = (id: string, mine = true, status = "pending"): A => ({ id, status, mine });
  const isMine = (x: A) => x.mine;

  it("the first load announces nothing that was already waiting", () => {
    const seen = new Set<string>();
    expect(approvalsToAnnounce([a("1"), a("2")], seen, true, isMine)).toEqual([]);
    expect([...seen]).toEqual(["1", "2"]);
  });

  it("a later load announces each new approval of mine once, however often it reloads", () => {
    const seen = new Set<string>(["1"]);
    const list = [a("1"), a("2"), a("3", false)];
    expect(approvalsToAnnounce(list, seen, false, isMine).map((x) => x.id)).toEqual(["2"]);
    expect(approvalsToAnnounce(list, seen, false, isMine)).toEqual([]);
  });

  it("does not announce one that is no longer pending", () => {
    expect(approvalsToAnnounce([a("9", true, "approved")], new Set(), false, isMine)).toEqual([]);
  });
});

describe("the screens", () => {
  it("the approvals inbox keeps up through useLiveRows, and announces from what it loaded", () => {
    const inbox = readFileSync("src/components/ApprovalInbox.tsx", "utf8");
    expect(inbox).toMatch(/useLiveRows\(\{\s*channel: "approvals-changes",\s*table: "approvals"/);
    expect(inbox).toContain(
      "approvalsToAnnounce(list, seenIdsRef.current, firstLoad, amIApprover)",
    );
    expect(inbox).not.toContain(".channel(");
  });

  it("the MCP panel no longer listens on a channel that never fires", () => {
    // mcp_servers left the realtime publication in 20260504100311: its rows
    // held auth_token.
    const panel = readFileSync("src/components/settings/McpServersPanel.tsx", "utf8");
    expect(panel).not.toContain(".channel(");
    expect(panel).toContain("useRefreshOnView(");
  });

  it("only the shared hook opens Realtime channels, so none ignores the setting", () => {
    const hook = readFileSync("src/hooks/use-live-rows.ts", "utf8");
    expect(hook).toContain("realtimeEnabled(publicConfig().supabaseRealtime)");
    expect(hook).toContain('.on("postgres_changes", { event: "*", schema: "public", table: tbl }');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const opening = walk("src").filter((f) => /\.channel\(/.test(readFileSync(f, "utf8")));
    expect(opening).toEqual(["src/hooks/use-live-rows.ts"]);
  });
});
