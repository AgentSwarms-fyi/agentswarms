import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { resumeApprovedSwarmRun } from "@/utils/swarmResume.functions";
import {
  Inbox,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldAlert,
  Webhook,
  Database,
  Terminal,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetDescription,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";

type Approval = {
  id: string;
  user_id: string;
  agent_name: string;
  agent_avatar: string | null;
  action_type: string;
  action_title: string;
  description: string | null;
  payload: any;
  risk_level: string;
  status: string;
  created_at: string;
  approver_user_ids: string[] | null;
  approver_group_ids: string[] | null;
  /** Set when this approval parked a swarm run that has to be resumed. */
  swarm_run_id: string | null;
};

const ACTION_ICON: Record<string, any> = {
  n8n_webhook: Webhook,
  mcp_tool: Database,
  shell_command: Terminal,
  external_api: Globe,
};

const RISK_COLORS: Record<string, string> = {
  low: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  critical: "bg-red-500/10 text-red-400 border-red-500/30",
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function ApprovalInbox() {
  const { user } = useAuth();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const resumeRunFn = useServerFn(resumeApprovedSwarmRun);
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const myGroupIdsRef = useRef<Set<string>>(new Set());

  // Is the current user a designated approver of this approval? When no
  // approvers are set (legacy / single-user swarms), the owner counts. This
  // gates the toast so the swarm runner isn't pinged for approvals routed to
  // others (they'll still see the row in the inbox, but no active nudge).
  const amIApprover = (ap: Approval): boolean => {
    if (!user) return false;
    const uids = ap.approver_user_ids ?? [];
    const gids = ap.approver_group_ids ?? [];
    if (uids.length === 0 && gids.length === 0) return ap.user_id === user.id;
    return uids.includes(user.id) || gids.some((g) => myGroupIdsRef.current.has(g));
  };

  useEffect(() => {
    if (!user) return;
    let mounted = true;

    // Load the current user's group memberships once so we can tell whether a
    // group-routed approval is meant for them.
    void supabase
      .from("iam_group_members")
      .select("group_id")
      .eq("user_id", user.id)
      .then(({ data }) => {
        if (mounted && data) myGroupIdsRef.current = new Set(data.map((r) => r.group_id));
      });

    const load = async () => {
      const { data } = await supabase
        .from("approvals")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (!mounted || !data) return;
      const list = data as Approval[];
      setApprovals(list);
      if (!initializedRef.current) {
        list.forEach((a) => seenIdsRef.current.add(a.id));
        initializedRef.current = true;
      }
    };
    load();

    const channel = supabase
      .channel("approvals-changes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "approvals" },
        (payload) => {
          const ap = payload.new as Approval;
          if (ap.status === "pending" && !seenIdsRef.current.has(ap.id) && amIApprover(ap)) {
            seenIdsRef.current.add(ap.id);
            const Icon = ACTION_ICON[ap.action_type] ?? Globe;
            toast(`${ap.agent_name} needs your approval`, {
              description: ap.action_title,
              icon: <Icon className="h-4 w-4 text-primary" />,
              duration: 10000,
              action: {
                label: "Review",
                onClick: () => setOpen(true),
              },
              className:
                ap.risk_level === "critical" || ap.risk_level === "high"
                  ? "border-destructive/50"
                  : undefined,
            });
            setPulse(true);
            setTimeout(() => setPulse(false), 4000);
          }
          load();
        },
      )
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "approvals" }, () =>
        load(),
      )
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "approvals" }, () =>
        load(),
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [user]);

  const decide = async (id: string, status: "approved" | "rejected") => {
    const item = approvals.find((a) => a.id === id);
    const { error } = await supabase
      .from("approvals")
      .update({ status, decided_at: new Date().toISOString(), decided_by: user?.id ?? null })
      .eq("id", id);
    if (error) {
      toast.error("Failed to update approval");
      return;
    }
    if (status === "approved") {
      toast.success(`Approved: ${item?.action_title}`, {
        description: `${item?.agent_name} is resuming.`,
      });
    } else {
      toast.error(`Rejected: ${item?.action_title}`, {
        description: `${item?.agent_name} has been halted.`,
      });
    }

    // A headless run (API key / schedule) parks at its approval node with a
    // checkpoint and cannot continue itself — recording the decision is only
    // half the job. Runs started from the canvas ignore this: they are still
    // waiting in the tab that started them.
    if (item?.swarm_run_id) {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (token) {
          const res = await resumeRunFn({
            data: { access_token: token, approval_id: id },
          });
          if (!res.ok) {
            toast.warning("Decision saved, but the run could not be resumed", {
              description: res.error,
              duration: 9000,
            });
          }
        }
      } catch (e) {
        toast.warning("Decision saved, but the run could not be resumed", {
          description: (e as Error).message,
          duration: 9000,
        });
      }
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {/* Inbox, not Bell: the alerts button beside this one is already a
            bell, and two bells left this one unnameable (it also had no
            accessible label at all). */}
        <Button
          variant="ghost"
          size="sm"
          className="relative h-9 w-9 p-0"
          aria-label={
            approvals.length > 0 ? `Pending approvals (${approvals.length})` : "Pending approvals"
          }
          title="Pending approvals"
        >
          <Inbox className={`h-4 w-4 ${pulse ? "animate-bounce text-primary" : ""}`} />
          {approvals.length > 0 && (
            <>
              {pulse && (
                <span className="absolute -right-0.5 -top-0.5 h-4 w-4 animate-ping rounded-full bg-destructive/60" />
              )}
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                {approvals.length}
              </span>
            </>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Pending Approvals
            {approvals.length > 0 && (
              <Badge variant="outline" className="ml-1">
                {approvals.length}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Agents pause here when they request a high-impact action. Live-synced from your backend.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {approvals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center px-4">
              <CheckCircle2 className="h-12 w-12 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium">All caught up</p>
              <p className="text-xs text-muted-foreground mt-1">No agents waiting for approval.</p>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {approvals.map((ap) => {
                const Icon = ACTION_ICON[ap.action_type] ?? Globe;
                return (
                  <div
                    key={ap.id}
                    className="rounded-lg border border-border bg-card overflow-hidden"
                  >
                    <div className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-lg">{ap.agent_avatar ?? "🤖"}</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{ap.agent_name}</p>
                            <p className="text-[11px] text-muted-foreground">
                              paused · {timeAgo(ap.created_at)}
                            </p>
                          </div>
                        </div>
                        <Badge
                          variant="outline"
                          className={`text-[10px] uppercase font-bold ${RISK_COLORS[ap.risk_level] ?? RISK_COLORS.low}`}
                        >
                          {ap.risk_level === "critical" && (
                            <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                          )}
                          {ap.risk_level}
                        </Badge>
                      </div>

                      <div className="flex items-start gap-2 rounded-md bg-muted/40 p-2">
                        <Icon className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-semibold">{ap.action_title}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {ap.description}
                          </p>
                        </div>
                      </div>

                      <details className="group">
                        <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                          View payload
                        </summary>
                        <pre className="mt-1 max-w-full rounded-md bg-background border border-border/50 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-all font-mono text-muted-foreground">
                          {JSON.stringify(ap.payload, null, 2)}
                        </pre>
                      </details>
                    </div>

                    <div className="flex border-t border-border">
                      <button
                        onClick={() => decide(ap.id, "rejected")}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors border-r border-border"
                      >
                        <XCircle className="h-3.5 w-3.5" /> Reject
                      </button>
                      <button
                        onClick={() => decide(ap.id, "approved")}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
