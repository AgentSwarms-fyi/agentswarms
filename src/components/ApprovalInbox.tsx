import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { resumeApprovedSwarmRun } from "@/utils/swarmResume.functions";
import { OPEN_APPROVALS_EVENT, approvalsToAnnounce } from "@/lib/approvalsInbox";
import { useLiveRows } from "@/hooks/use-live-rows";
import { mlApplyApprovedPromotion } from "@/utils/ml.functions";
import { applyApprovedColumnHideFn } from "@/utils/sensitiveData.functions";
import { HIDE_COLUMNS_ACTION, suggestedColumns, suggestedDatasetId } from "@/lib/sensitiveData";
import { fixFromPayload, RUN_FIX_ACTION } from "@/lib/runFixes";
import { applyApprovedRunFixFn } from "@/utils/runFixes.functions";
import { Link } from "@tanstack/react-router";
import {
  Inbox,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldAlert,
  Webhook,
  Database,
  EyeOff,
  Rocket,
  Terminal,
  Globe,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Json } from "@/integrations/supabase/types";
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
import { pendingApprovals } from "@/lib/inboxReads";
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
  payload: Json;
  /** Raised without its text: the owner's key could not be had at the time. */
  body_dropped?: boolean;
  /** Why its text cannot be read now. */
  body_unreadable?: string | null;
  risk_level: string;
  status: string;
  created_at: string;
  approver_user_ids: string[] | null;
  approver_group_ids: string[] | null;
  /** Set when this approval parked a swarm run that has to be resumed. */
  swarm_run_id: string | null;
};

const ACTION_ICON: Record<string, LucideIcon> = {
  n8n_webhook: Webhook,
  mcp_tool: Database,
  shell_command: Terminal,
  external_api: Globe,
  "ml.promote": Rocket,
  [HIDE_COLUMNS_ACTION]: EyeOff,
  [RUN_FIX_ACTION]: Wrench,
};

/** Where a suggested fix's check or pipeline is, built from its checked target. */
function fixLink(payload: unknown): { to: string; open: string } | null {
  const f = fixFromPayload(payload);
  if (!f) return null;
  return { to: f.target.type === "data_monitor" ? "/data-monitors" : "/etl", open: f.target.id };
}

/**
 * What kind of waiting this is. Only an agent's step is a run that paused; a
 * model promotion is a person asking, and a suggestion about a dataset is the
 * platform pointing something out. Calling all three "paused" made the last
 * two read as something stuck.
 */
function waitingWord(actionType: string): string {
  if (actionType === "ml.promote") return "asked";
  if (actionType === HIDE_COLUMNS_ACTION || actionType === RUN_FIX_ACTION) return "suggested";
  return "paused";
}

/** Raised by an agent (it has a face) rather than by the platform itself. */
const fromAnAgent = (actionType: string) =>
  actionType !== "ml.promote" &&
  actionType !== HIDE_COLUMNS_ACTION &&
  actionType !== RUN_FIX_ACTION;

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
  const applyPromotionFn = useServerFn(mlApplyApprovedPromotion);
  const applyHideFn = useServerFn(applyApprovedColumnHideFn);
  const applyRunFixFn = useServerFn(applyApprovedRunFixFn);
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const myGroupIdsRef = useRef<Set<string>>(new Set());
  const loadRef = useRef<() => Promise<void>>(async () => {});

  // A parked run's row in Recent runs asks for the inbox (R108).
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_APPROVALS_EVENT, show);
    return () => window.removeEventListener(OPEN_APPROVALS_EVENT, show);
  }, []);

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

    const announce = (ap: Approval) => {
      const Icon = ACTION_ICON[ap.action_type] ?? Globe;
      const suggestion =
        ap.action_type === HIDE_COLUMNS_ACTION || ap.action_type === RUN_FIX_ACTION;
      toast(suggestion ? ap.action_title : `${ap.agent_name} needs your approval`, {
        description: suggestion ? "A suggestion, waiting for your yes or no." : ap.action_title,
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
    };

    const load = async () => {
      // Through the server: a request's text is sealed under its owner's key
      // (R450). Row-level security still decides which rows come back.
      const { data } = await pendingApprovals();
      if (!mounted || !data) return;
      const list = data as Approval[];
      setApprovals(list);
      const firstLoad = !initializedRef.current;
      initializedRef.current = true;
      // Announced from what was loaded, so a poll finds a new approval exactly
      // as a Realtime event does (R468).
      for (const ap of approvalsToAnnounce(list, seenIdsRef.current, firstLoad, amIApprover)) {
        announce(ap);
      }
    };
    loadRef.current = load;
    void load();

    return () => {
      mounted = false;
      loadRef.current = async () => {};
    };
    // amIApprover reads the user this effect was set up for and the group ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Every change to approvals reloads the list: a Realtime event where the
  // database runs Realtime, a poll where it does not (Amazon RDS) or its
  // channel failed, and the tab coming back into view.
  useLiveRows({
    channel: "approvals-changes",
    table: "approvals",
    refresh: () => void loadRef.current(),
    enabled: !!user,
  });

  const decide = async (id: string, status: "approved" | "rejected") => {
    const item = approvals.find((a) => a.id === id);
    // FOUND IN R317. The decision was written over whatever the approval
    // held, and every decision then resumed the run: two tabs (or two
    // approvers) pressing Approve ran everything after the approval twice.
    // Only a pending approval is decided now, and only by the first.
    const { data: decided, error } = await supabase
      .from("approvals")
      .update({ status, decided_at: new Date().toISOString(), decided_by: user?.id ?? null })
      .eq("id", id)
      .eq("status", "pending")
      .select("id");
    if (error) {
      toast.error("Failed to update approval");
      return;
    }
    if ((decided ?? []).length === 0) {
      setApprovals((list) => list.filter((a) => a.id !== id));
      toast.info(`Already decided: ${item?.action_title ?? "this approval"}`, {
        description: "It was decided elsewhere first. Your decision was not recorded.",
      });
      return;
    }
    // Decided: it leaves the list now, not when the next refresh comes round.
    setApprovals((list) => list.filter((a) => a.id !== id));
    // A suggested fix for something that keeps failing (R525): the server
    // makes the change, checked against the thing itself.
    if (item?.action_type === RUN_FIX_ACTION) {
      if (status === "rejected") {
        toast(`Kept as it is: ${item.agent_name}`, {
          description: "Nothing was changed. You will not be asked about this change again.",
        });
        return;
      }
      try {
        const res = await applyRunFixFn({ data: { approvalId: id } });
        if (res.ok) toast.success("Changed", { description: res.message });
        else toast.warning("Decision saved, but nothing was changed", { description: res.error });
      } catch (e) {
        toast.warning("Decision saved, but nothing was changed", {
          description: (e as Error).message,
        });
      }
      return;
    }
    // A suggestion to hide a dataset's columns: the server carries it out, and
    // the message says what it did, not what was asked.
    if (item?.action_type === HIDE_COLUMNS_ACTION) {
      if (status === "rejected") {
        toast(`Kept as it is: ${item.agent_name}`, {
          description:
            "Its shares still read those columns. You will not be asked about them again.",
        });
        return;
      }
      try {
        const res = await applyHideFn({ data: { approvalId: id } });
        if (res.ok) {
          toast.success(`Hidden in ${item.agent_name}`, {
            description:
              res.changed === 0
                ? "Every grant already hid those columns."
                : `${res.columns.join(", ")} ${res.columns.length === 1 ? "is" : "are"} hidden from ${res.changed} grant${res.changed === 1 ? "" : "s"}. You still see ${res.columns.length === 1 ? "it" : "them"}.`,
          });
        } else {
          toast.warning("Decision saved, but nothing was hidden", { description: res.error });
        }
      } catch (e) {
        toast.warning("Decision saved, but nothing was hidden", {
          description: (e as Error).message,
        });
      }
      return;
    }

    // A model promotion is not an agent resuming, and saying so would be the
    // kind of small lie that makes a reader distrust the rest of the sentence.
    const isPromotion = item?.action_type === "ml.promote";
    if (status === "approved") {
      toast.success(`Approved: ${item?.action_title}`, {
        description: isPromotion
          ? `${item?.agent_name} is going into production.`
          : `${item?.agent_name} is resuming.`,
      });
    } else {
      toast.error(`Rejected: ${item?.action_title}`, {
        description: isPromotion
          ? `${item?.agent_name} stays on the version it is serving.`
          : `${item?.agent_name} has been halted.`,
      });
    }

    // The inbox records the decision; the server does the thing, and re-checks
    // everything — including that the approver is not the person who asked.
    if (isPromotion && status === "approved") {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (token) {
          const res = await applyPromotionFn({ data: { access_token: token, approval_id: id } });
          if (!res.ok) {
            toast.warning("Decision saved, but the version was not promoted", {
              description: res.error,
            });
          }
        }
      } catch (e) {
        toast.warning("Decision saved, but the version was not promoted", {
          description: (e as Error).message,
        });
      }
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
                <span className="absolute -right-0.5 -top-0.5 h-4 w-4 animate-ping rounded-full bg-primary/50" />
              )}
              {/* Something waiting, not something broken: the accent, not red. */}
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
                {approvals.length > 99 ? "99+" : approvals.length}
              </span>
            </>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Pending approvals
            {approvals.length > 0 && (
              <Badge variant="outline" className="ml-1">
                {approvals.length}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            What is waiting for your yes or no: an agent's step, a model going into production, a
            suggestion about your data.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {approvals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center px-4">
              <CheckCircle2 className="h-12 w-12 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium">All caught up</p>
              <p className="text-xs text-muted-foreground mt-1">Nothing is waiting for you.</p>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {approvals.map((ap) => {
                const Icon = ACTION_ICON[ap.action_type] ?? Globe;
                const columns =
                  ap.action_type === HIDE_COLUMNS_ACTION ? suggestedColumns(ap.payload) : [];
                return (
                  <div
                    key={ap.id}
                    className="rounded-lg border border-border bg-card overflow-hidden"
                  >
                    <div className="p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {fromAnAgent(ap.action_type) ? (
                            <span className="text-lg">{ap.agent_avatar ?? "🤖"}</span>
                          ) : (
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                              <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{ap.agent_name}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {waitingWord(ap.action_type)} · {timeAgo(ap.created_at)}
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
                          {ap.body_unreadable && (
                            <p
                              data-approval-unreadable
                              className="mt-1 text-xs text-amber-600 dark:text-amber-400"
                            >
                              This request's text cannot be read: {ap.body_unreadable}
                            </p>
                          )}
                          {ap.body_dropped && (
                            <p
                              data-approval-dropped
                              className="mt-1 text-xs text-amber-600 dark:text-amber-400"
                            >
                              Raised without its text, because its owner's key could not be had at
                              the time.
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {ap.description}
                          </p>
                        </div>
                      </div>

                      {columns.length > 0 ? (
                        <div className="space-y-1.5">
                          <ul className="space-y-1 text-xs" aria-label="Columns it would hide">
                            {columns.map((c) => (
                              <li key={c.column} className="leading-5">
                                <span className="font-medium">{c.column}</span>{" "}
                                <span className="text-muted-foreground">— {c.evidence}</span>
                              </li>
                            ))}
                          </ul>
                          {suggestedDatasetId(ap.payload) && (
                            <Link
                              to="/data-sql/$datasetId"
                              params={{ datasetId: suggestedDatasetId(ap.payload)! }}
                              onClick={() => setOpen(false)}
                              className="inline-block text-xs text-primary underline-offset-2 hover:underline"
                            >
                              Open the dataset
                            </Link>
                          )}
                        </div>
                      ) : ap.action_type === RUN_FIX_ACTION ? (
                        fixLink(ap.payload) && (
                          <Link
                            to={fixLink(ap.payload)!.to as never}
                            search={{ open: fixLink(ap.payload)!.open } as never}
                            onClick={() => setOpen(false)}
                            className="inline-block text-xs text-primary underline-offset-2 hover:underline"
                          >
                            Open it
                          </Link>
                        )
                      ) : (
                        <details className="group">
                          <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none">
                            View payload
                          </summary>
                          <pre className="mt-1 max-w-full rounded-md bg-background border border-border/50 p-2 text-[10px] leading-relaxed whitespace-pre-wrap break-all font-mono text-muted-foreground">
                            {JSON.stringify(ap.payload, null, 2)}
                          </pre>
                        </details>
                      )}
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
