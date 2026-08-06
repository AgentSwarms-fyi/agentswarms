// Header notification bell: unread badge, dropdown list, mark-read.
// Polls every 60s and on window focus (no realtime dependency). On mount it
// also pings /api/bi/cron once so the in-process BI scheduler is running and
// overdue dashboard refreshes catch up.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BellRing, CheckCheck, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

const KIND_DOT: Record<string, string> = {
  alert: "bg-red-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  info: "bg-primary",
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("notifications")
      .select("id, kind, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) setItems(data);
  }, []);

  useEffect(() => {
    void load();
    // Kick the BI scheduler once per app session (fire-and-forget).
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      fetch("/api/bi/cron", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    })();
    const timer = setInterval(() => void load(), 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const unread = items.filter((n) => !n.read_at).length;

  async function markAllRead() {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    await supabase.from("notifications").update({ read_at: now }).is("read_at", null);
  }

  async function clearAll() {
    setItems([]);
    await supabase.from("notifications").delete().not("id", "is", null);
  }

  async function markRead(id: string) {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: now } : n)));
    await supabase.from("notifications").update({ read_at: now }).eq("id", id);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          title="Alerts & notifications"
          aria-label={
            unread > 0 ? `Alerts & notifications (${unread} unread)` : "Alerts & notifications"
          }
        >
          <BellRing className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Notifications</span>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10px]"
                onClick={() => void markAllRead()}
              >
                <CheckCheck className="h-3 w-3" /> Mark all read
              </Button>
            )}
            {items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
                onClick={() => void clearAll()}
              >
                <Trash2 className="h-3 w-3" /> Clear
              </Button>
            )}
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No notifications — dashboard alerts and scheduled-refresh results land here.
            </p>
          )}
          {items.map((n) => {
            const inner = (
              <div
                className={cn(
                  "flex items-start gap-2 border-b border-border/50 px-3 py-2 text-left hover:bg-muted/50",
                  !n.read_at && "bg-primary/5",
                )}
              >
                <span
                  className={cn(
                    "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                    n.read_at ? "bg-transparent" : (KIND_DOT[n.kind] ?? KIND_DOT.info),
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium leading-snug">{n.title}</p>
                  {n.body && (
                    <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-[11px] leading-snug text-muted-foreground">
                      {n.body}
                    </p>
                  )}
                  <p className="mt-0.5 text-[9px] text-muted-foreground/70">{ago(n.created_at)}</p>
                </div>
              </div>
            );
            return n.link ? (
              <Link
                key={n.id}
                to={n.link}
                className="block"
                onClick={() => {
                  void markRead(n.id);
                  setOpen(false);
                }}
              >
                {inner}
              </Link>
            ) : (
              <button
                key={n.id}
                type="button"
                className="block w-full"
                onClick={() => void markRead(n.id)}
              >
                {inner}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
