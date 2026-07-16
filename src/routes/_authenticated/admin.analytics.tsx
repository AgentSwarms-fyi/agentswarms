import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useAuth } from "@/hooks/use-auth";
import { useServerFn } from "@tanstack/react-start";
import {
  getAdminAnalytics,
  getAdminUserDetail,
  getAdminContactMessages,
  type AdminAnalyticsResult,
  type AdminUserDetail,
  type AdminContactMessage,
} from "@/utils/adminAnalytics.functions";
import {
  ShieldAlert,
  Users,
  Bot,
  Network,
  MessageSquare,
  DollarSign,
  Cpu,
  Zap,
  ExternalLink,
  GraduationCap,
  Award,
  ClipboardCheck,
  Mail,
} from "lucide-react";
import * as Recharts from "recharts";
import { format, formatDistanceToNow } from "date-fns";

const ResponsiveContainer = Recharts.ResponsiveContainer as any;
const AreaChart = Recharts.AreaChart as any;
const Area = Recharts.Area as any;
const XAxis = Recharts.XAxis as any;
const YAxis = Recharts.YAxis as any;
const Tooltip = Recharts.Tooltip as any;
const CartesianGrid = Recharts.CartesianGrid as any;

const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL?.toLowerCase();

export const Route = createFileRoute("/_authenticated/admin/analytics")({
  component: AdminAnalyticsPage,
});

function statusColor(status: string) {
  switch (status) {
    case "passed":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "failed":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "evaluating":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "in_progress":
      return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function AdminAnalyticsPage() {
  const { user, session } = useAuth();
  const fetchFn = useServerFn(getAdminAnalytics);
  const fetchUserDetail = useServerFn(getAdminUserDetail);
  const fetchContactMessages = useServerFn(getAdminContactMessages);
  const [data, setData] = useState<AdminAnalyticsResult | null>(null);
  const [contactMessages, setContactMessages] = useState<AdminContactMessage[] | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const openUser = (userId: string) => {
    if (!session?.access_token) {
      setDetailError("Missing session token");
      return;
    }
    setOpenUserId(userId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    fetchUserDetail({ data: { userId, accessToken: session.access_token } })
      .then((res) => {
        if (!res) return setDetailError("No data returned");
        if (res.ok) setDetail(res);
        else setDetailError(`${res.error || "Failed"}${res.stage ? ` (${res.stage})` : ""}`);
      })
      .catch((e) => setDetailError(String(e?.message ?? e ?? "Failed")))
      .finally(() => setDetailLoading(false));
  };

  const isAdmin = (user?.email ?? "").toLowerCase() === ADMIN_EMAIL;

  useEffect(() => {
    if (!user || !isAdmin) return;
    setLoading(true);
    setError(null);
    if (!session?.access_token) {
      setError("Missing session token");
      setLoading(false);
      return;
    }

    fetchFn({ data: { accessToken: session.access_token } })
      .then((res) => {
        if (!res) {
          setError("Server returned no data. Please retry.");
          return;
        }
        if (res.ok) {
          setData(res);
        } else {
          setError(
            `${res.error || "Unknown server error"}${res.stage ? ` (stage: ${res.stage})` : ""}`,
          );
        }
      })
      .catch((e) => {
        const msg = e?.message || e?.toString?.() || "Request failed";
        setError(String(msg));
      })
      .finally(() => setLoading(false));

    setContactLoading(true);
    setContactError(null);
    fetchContactMessages({ data: { accessToken: session.access_token } })
      .then((res) => {
        if (!res) return setContactError("No data");
        if (res.ok) setContactMessages(res.messages);
        else setContactError(`${res.error || "Failed"}${res.stage ? ` (${res.stage})` : ""}`);
      })
      .catch((e) => setContactError(String(e?.message ?? e)))
      .finally(() => setContactLoading(false));
  }, [user, isAdmin, session?.access_token, fetchFn, fetchContactMessages]);

  const filteredUsers = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.users;
    return data.users.filter(
      (u) =>
        (u.email ?? "").toLowerCase().includes(q) ||
        (u.display_name ?? "").toLowerCase().includes(q) ||
        (u.organization ?? "").toLowerCase().includes(q),
    );
  }, [data, search]);

  if (!user) return null;

  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card className="max-w-lg mx-auto mt-12 border-destructive/40">
          <CardContent className="p-8 text-center">
            <ShieldAlert className="h-10 w-10 text-destructive mx-auto mb-3" />
            <h2 className="text-lg font-semibold mb-1">Restricted area</h2>
            <p className="text-sm text-muted-foreground mb-4">
              This page is only accessible to the platform administrator.
            </p>
            <Link to="/dashboard" className="text-sm text-primary hover:underline">
              Go back to dashboard
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-destructive/40">
          <CardContent className="p-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const { totals, users, recentMessages, spendByDay, topModels, recentExamAttempts, certificates } =
    data;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Admin Analytics</h1>
            <Badge variant="outline" className="border-amber-500/40 text-amber-400 bg-amber-500/5">
              Admin only
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1">
            Platform-wide usage across {totals.users_total.toLocaleString()} users.
          </p>
        </div>
      </div>

      {/* Top KPIs */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Kpi icon={Users} label="Users" value={totals.users_total.toLocaleString()} />
        <Kpi icon={Bot} label="Agents created" value={totals.agents_total.toLocaleString()} />
        <Kpi icon={Network} label="Swarms created" value={totals.swarms_total.toLocaleString()} />
        <Kpi
          icon={MessageSquare}
          label="Chat messages"
          value={totals.messages_total.toLocaleString()}
        />
        <Kpi icon={DollarSign} label="Total spend" value={`$${totals.cost_total_usd.toFixed(2)}`} />
        <Kpi
          icon={Cpu}
          label="Total tokens"
          value={`${((totals.tokens_in_total + totals.tokens_out_total) / 1000).toFixed(1)}K`}
          subtext={`${(totals.tokens_in_total / 1000).toFixed(0)}K in · ${(totals.tokens_out_total / 1000).toFixed(0)}K out`}
        />
        <Kpi icon={Zap} label="LLM calls" value={totals.traces_total.toLocaleString()} />
        <Kpi
          icon={ClipboardCheck}
          label="Quiz attempts"
          value={totals.quiz_attempts_total.toLocaleString()}
        />
        <Kpi
          icon={GraduationCap}
          label="Exam attempts"
          value={totals.exam_attempts_total.toLocaleString()}
          subtext={`${totals.exam_pass_rate}% pass rate`}
        />
        <Kpi
          icon={Award}
          label="Certificates issued"
          value={totals.certificates_total.toLocaleString()}
        />
      </div>

      {/* Spend chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Platform spend (last 30 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {spendByDay.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              No execution traces yet.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={spendByDay}>
                <defs>
                  <linearGradient id="adminCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    color: "var(--foreground)",
                  }}
                  formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]}
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fill="url(#adminCost)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Per-user usage</TabsTrigger>
          <TabsTrigger value="certification">Certification</TabsTrigger>
          <TabsTrigger value="messages">Recent chat messages</TabsTrigger>
          <TabsTrigger value="contact">Contact messages</TabsTrigger>
          <TabsTrigger value="models">Top models</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-base">Users ({users.length})</CardTitle>
              <Input
                placeholder="Search by email, name or org..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-xs h-8"
              />
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[520px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead className="text-right">Agents</TableHead>
                      <TableHead className="text-right">Swarms</TableHead>
                      <TableHead className="text-right">Chats</TableHead>
                      <TableHead className="text-right">Msgs</TableHead>
                      <TableHead className="text-right">Quizzes</TableHead>
                      <TableHead className="text-right">Exams</TableHead>
                      <TableHead className="text-center">Cert</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead className="w-[60px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map((u) => (
                      <TableRow
                        key={u.user_id}
                        onClick={() => openUser(u.user_id)}
                        className="cursor-pointer hover:bg-muted/40"
                      >
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{u.email ?? "—"}</span>
                            <span className="text-xs text-muted-foreground">
                              {u.display_name ?? "(no name)"}{" "}
                              {u.organization ? `· ${u.organization}` : ""}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{u.agents_count}</TableCell>
                        <TableCell className="text-right tabular-nums">{u.swarms_count}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {u.conversations_count}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {u.messages_count}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {u.quiz_attempts_count > 0 ? (
                            <span>
                              {u.quiz_passed_count}/{u.quiz_attempts_count}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {u.exam_attempts_count > 0 ? (
                            <span className="flex items-center justify-end gap-1">
                              {u.exam_attempts_count}
                              {u.exam_passed && (
                                <span
                                  className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                                  title="Passed"
                                />
                              )}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          {u.has_certificate ? (
                            <Award className="h-4 w-4 text-amber-400 inline" />
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          ${u.total_cost_usd.toFixed(4)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {u.last_sign_in_at
                            ? formatDistanceToNow(new Date(u.last_sign_in_at), { addSuffix: true })
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground inline" />
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredUsers.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={11}
                          className="text-center text-sm text-muted-foreground py-8"
                        >
                          No users match your search.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="certification" className="mt-4 space-y-4">
          {/* Certificates issued */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Certificates issued ({certificates.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {certificates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No certificates issued yet.
                </p>
              ) : (
                <ScrollArea className="h-[300px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipient</TableHead>
                        <TableHead>Organization</TableHead>
                        <TableHead className="text-right">MCQ</TableHead>
                        <TableHead className="text-right">Agent</TableHead>
                        <TableHead className="text-right">Swarm</TableHead>
                        <TableHead>Verification</TableHead>
                        <TableHead>Issued</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {certificates.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">{c.name_on_cert}</span>
                              <span className="text-xs text-muted-foreground">
                                {c.email ?? "—"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">{c.organization ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.mcq_score}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.agent_score}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.swarm_score}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {c.verification_code}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {format(new Date(c.issued_at), "MMM d, yyyy")}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          {/* Recent exam attempts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent exam attempts (last 50)</CardTitle>
            </CardHeader>
            <CardContent>
              {recentExamAttempts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No exam attempts yet.
                </p>
              ) : (
                <ScrollArea className="h-[400px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">MCQ Score</TableHead>
                        <TableHead>Started</TableHead>
                        <TableHead>Submitted</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentExamAttempts.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell>
                            <span className="text-sm">{e.email ?? e.user_id.slice(0, 8)}</span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`text-[10px] capitalize ${statusColor(e.status)}`}
                            >
                              {e.status.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {e.mcq_score}/{e.mcq_total}
                            <span className="text-muted-foreground ml-1 text-xs">
                              ({e.mcq_total > 0 ? Math.round((e.mcq_score / e.mcq_total) * 100) : 0}
                              %)
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {format(new Date(e.started_at), "MMM d, HH:mm")}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {e.submitted_at
                              ? format(new Date(e.submitted_at), "MMM d, HH:mm")
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="messages" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Most recent playground messages (last 50)</CardTitle>
              <p className="text-xs text-muted-foreground">All users · across all conversations</p>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[520px] pr-3">
                <div className="space-y-3">
                  {recentMessages.map((m) => (
                    <div key={m.id} className="rounded-md border border-border p-3 bg-card/50">
                      <div className="flex items-center justify-between mb-1.5 gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 capitalize"
                          >
                            {m.role}
                          </Badge>
                          <span className="text-xs font-medium truncate">
                            {m.email ?? m.user_id.slice(0, 8)}
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {format(new Date(m.created_at), "MMM d, HH:mm")}
                        </span>
                      </div>
                      <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
                        {m.content}
                      </p>
                    </div>
                  ))}
                  {recentMessages.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-12">
                      No messages yet.
                    </p>
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contact" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Contact messages {contactMessages ? `(${contactMessages.length})` : ""}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Submissions from the public contact form (most recent 500)
              </p>
            </CardHeader>
            <CardContent>
              {contactLoading && <Skeleton className="h-64" />}
              {contactError && (
                <div className="rounded border border-destructive/40 p-3 text-sm text-destructive">
                  {contactError}
                </div>
              )}
              {contactMessages &&
                !contactLoading &&
                (contactMessages.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-12">
                    No contact messages yet.
                  </p>
                ) : (
                  <ScrollArea className="h-[560px] pr-3">
                    <div className="space-y-3">
                      {contactMessages.map((m) => (
                        <div key={m.id} className="rounded-md border border-border p-3 bg-card/50">
                          <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold truncate">{m.name}</span>
                                <a
                                  href={`mailto:${m.email}`}
                                  className="text-xs text-primary hover:underline truncate"
                                >
                                  {m.email}
                                </a>
                                <Badge variant="outline" className="text-[10px] capitalize">
                                  {m.status}
                                </Badge>
                              </div>
                              {m.subject && (
                                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                  Subject: {m.subject}
                                </p>
                              )}
                            </div>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {format(new Date(m.created_at), "MMM d, yyyy HH:mm")}
                            </span>
                          </div>
                          <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
                            {m.message}
                          </p>
                          {(m.source_page || m.user_agent) && (
                            <div className="mt-2 pt-2 border-t border-border/60 text-[10px] text-muted-foreground space-y-0.5">
                              {m.source_page && (
                                <div>
                                  From: <span className="font-mono">{m.source_page}</span>
                                </div>
                              )}
                              {m.user_agent && (
                                <div className="truncate">
                                  UA: <span className="font-mono">{m.user_agent}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Top models by spend</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topModels.map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="font-mono text-xs">{m.model}</TableCell>
                      <TableCell className="text-xs capitalize">{m.provider}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m.calls.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        ${m.cost.toFixed(4)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {topModels.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        No model usage yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Per-user detail sheet */}
      <Sheet
        open={!!openUserId}
        onOpenChange={(o) => {
          if (!o) {
            setOpenUserId(null);
            setDetail(null);
            setDetailError(null);
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-3xl p-0 flex flex-col">
          <SheetHeader className="border-b border-border p-4">
            <SheetTitle>User analytics</SheetTitle>
            <SheetDescription className="text-xs">
              {detail?.user.email ?? openUserId ?? ""}
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-5">
              {detailLoading && (
                <div className="space-y-3">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-40" />
                  <Skeleton className="h-40" />
                </div>
              )}
              {detailError && (
                <div className="rounded border border-destructive/40 p-3 text-sm text-destructive">
                  {detailError}
                </div>
              )}
              {detail && (
                <>
                  <Card>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold">{detail.user.email ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            {detail.user.display_name ?? "(no name)"}
                            {detail.user.organization ? ` · ${detail.user.organization}` : ""}
                          </p>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          <div>
                            Joined{" "}
                            {detail.user.created_at
                              ? format(new Date(detail.user.created_at), "MMM d, yyyy")
                              : "—"}
                          </div>
                          <div>
                            Last seen{" "}
                            {detail.user.last_sign_in_at
                              ? formatDistanceToNow(new Date(detail.user.last_sign_in_at), {
                                  addSuffix: true,
                                })
                              : "—"}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 pt-2">
                        <DetailKpi
                          label="Spend"
                          value={`$${detail.totals.total_cost_usd.toFixed(4)}`}
                        />
                        <DetailKpi
                          label="LLM calls"
                          value={detail.totals.traces_count.toLocaleString()}
                        />
                        <DetailKpi
                          label="Tokens"
                          value={`${((detail.totals.tokens_in + detail.totals.tokens_out) / 1000).toFixed(1)}K`}
                        />
                        <DetailKpi
                          label="Messages"
                          value={detail.totals.messages_count.toLocaleString()}
                        />
                        <DetailKpi label="Agents" value={String(detail.totals.agents_count)} />
                        <DetailKpi label="Swarms" value={String(detail.totals.swarms_count)} />
                        <DetailKpi
                          label="Conversations"
                          value={String(detail.totals.conversations_count)}
                        />
                        <DetailKpi
                          label="Certificates"
                          value={String(detail.certificates.length)}
                        />
                      </div>
                    </CardContent>
                  </Card>

                  {detail.spendByDay.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Spend (last 30 days)</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ResponsiveContainer width="100%" height={180}>
                          <AreaChart data={detail.spendByDay}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="var(--border)"
                              opacity={0.4}
                            />
                            <XAxis
                              dataKey="date"
                              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                            />
                            <YAxis
                              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                              tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                            />
                            <Tooltip
                              contentStyle={{
                                background: "var(--card)",
                                border: "1px solid var(--border)",
                                fontSize: 11,
                                color: "var(--foreground)",
                              }}
                              formatter={(v: number) => [`$${v.toFixed(4)}`, "Cost"]}
                            />
                            <Area
                              type="monotone"
                              dataKey="cost"
                              stroke="var(--primary)"
                              fill="var(--primary)"
                              fillOpacity={0.2}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </CardContent>
                    </Card>
                  )}

                  {/* Exam Attempts */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        Exam attempts ({detail.examAttempts.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {detail.examAttempts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No exam attempts.</p>
                      ) : (
                        <div className="space-y-2">
                          {detail.examAttempts.map((ea) => (
                            <div
                              key={ea.id}
                              className="rounded border border-border p-3 bg-card/50 space-y-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] capitalize ${statusColor(ea.status)}`}
                                >
                                  {ea.status.replace(/_/g, " ")}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  {format(new Date(ea.started_at), "MMM d, yyyy HH:mm")}
                                </span>
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-xs">
                                <div>
                                  <span className="text-muted-foreground">MCQ: </span>
                                  <span className="font-medium tabular-nums">
                                    {ea.mcq_score}/{ea.mcq_total} (
                                    {ea.mcq_total > 0
                                      ? Math.round((ea.mcq_score / ea.mcq_total) * 100)
                                      : 0}
                                    %)
                                  </span>
                                </div>
                                {ea.agent_eval &&
                                  typeof ea.agent_eval === "object" &&
                                  Object.keys(ea.agent_eval).length > 0 && (
                                    <div>
                                      <span className="text-muted-foreground">Agent eval: </span>
                                      <span className="font-medium tabular-nums">
                                        {(ea.agent_eval as any).score ?? "—"}/
                                        {(ea.agent_eval as any).max ?? "—"}
                                      </span>
                                    </div>
                                  )}
                                {ea.swarm_eval &&
                                  typeof ea.swarm_eval === "object" &&
                                  Object.keys(ea.swarm_eval).length > 0 && (
                                    <div>
                                      <span className="text-muted-foreground">Swarm eval: </span>
                                      <span className="font-medium tabular-nums">
                                        {(ea.swarm_eval as any).score ?? "—"}/
                                        {(ea.swarm_eval as any).max ?? "—"}
                                      </span>
                                    </div>
                                  )}
                              </div>
                              {ea.evaluator_feedback && (
                                <p className="text-xs text-muted-foreground border-t border-border pt-2 mt-1 whitespace-pre-wrap">
                                  {ea.evaluator_feedback}
                                </p>
                              )}
                              {ea.improvement_areas &&
                                Array.isArray(ea.improvement_areas) &&
                                (ea.improvement_areas as string[]).length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {(ea.improvement_areas as string[]).map((area, i) => (
                                      <Badge key={i} variant="secondary" className="text-[9px]">
                                        {area}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Certificates */}
                  {detail.certificates.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">
                          Certificates ({detail.certificates.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {detail.certificates.map((cert) => (
                            <div
                              key={cert.id}
                              className="rounded border border-border p-3 bg-card/50 flex items-center justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium flex items-center gap-1.5">
                                  <Award className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                                  {cert.name_on_cert}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  {cert.organization ?? "—"}
                                </p>
                              </div>
                              <div className="text-right text-xs shrink-0">
                                <p className="tabular-nums">
                                  MCQ {cert.mcq_score} · Agent {cert.agent_score} · Swarm{" "}
                                  {cert.swarm_score}
                                </p>
                                <p className="text-[10px] text-muted-foreground font-mono">
                                  {cert.verification_code}
                                </p>
                                <p className="text-[10px] text-muted-foreground">
                                  {format(new Date(cert.issued_at), "MMM d, yyyy")}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Quiz attempts */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        Quiz attempts ({detail.quizAttempts.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {detail.quizAttempts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No quiz attempts.</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-[10px]">Track</TableHead>
                              <TableHead className="text-[10px] text-right">Score</TableHead>
                              <TableHead className="text-[10px] text-center">Passed</TableHead>
                              <TableHead className="text-[10px]">Date</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.quizAttempts.map((qa) => (
                              <TableRow key={qa.id}>
                                <TableCell className="text-xs font-medium">{qa.track_id}</TableCell>
                                <TableCell className="text-xs text-right tabular-nums">
                                  {qa.score}/{qa.total}
                                </TableCell>
                                <TableCell className="text-center">
                                  <span
                                    className={`inline-block h-2 w-2 rounded-full ${qa.passed ? "bg-emerald-500" : "bg-red-500"}`}
                                  />
                                </TableCell>
                                <TableCell className="text-[10px] text-muted-foreground">
                                  {format(new Date(qa.created_at), "MMM d, HH:mm")}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Agents ({detail.agents.length})</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {detail.agents.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No agents created.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {detail.agents.map((a) => (
                            <div
                              key={a.id}
                              className="flex items-center justify-between text-xs border border-border rounded-md p-2"
                            >
                              <div className="min-w-0">
                                <p className="font-medium truncate">{a.name}</p>
                                <p className="text-[10px] text-muted-foreground font-mono">
                                  {a.llm_provider} · {a.llm_model}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <Badge variant="outline" className="text-[10px]">
                                  {a.is_active ? "active" : "inactive"}
                                </Badge>
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  {format(new Date(a.created_at), "MMM d")}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Swarms ({detail.swarms.length})</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {detail.swarms.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No swarms created.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {detail.swarms.map((s) => (
                            <div
                              key={s.id}
                              className="flex items-center justify-between text-xs border border-border rounded-md p-2"
                            >
                              <p className="font-medium truncate">{s.name}</p>
                              <div className="flex items-center gap-2 shrink-0">
                                <Badge variant="outline" className="text-[10px]">
                                  {s.is_deployed ? "deployed" : "draft"}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  {format(new Date(s.created_at), "MMM d")}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Recent traces (last 100)</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-[10px]">When</TableHead>
                            <TableHead className="text-[10px]">Agent</TableHead>
                            <TableHead className="text-[10px]">Model</TableHead>
                            <TableHead className="text-[10px] text-right">Tokens</TableHead>
                            <TableHead className="text-[10px] text-right">Cost</TableHead>
                            <TableHead className="text-[10px]">Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.recentTraces.map((t) => (
                            <TableRow key={t.id}>
                              <TableCell className="text-[10px] font-mono text-muted-foreground">
                                {format(new Date(t.created_at), "MMM dd HH:mm")}
                              </TableCell>
                              <TableCell className="text-xs">{t.agent_name}</TableCell>
                              <TableCell className="text-[10px] font-mono text-muted-foreground">
                                {t.llm_model}
                              </TableCell>
                              <TableCell className="text-[10px] font-mono text-right">
                                {t.tokens_in}/{t.tokens_out}
                              </TableCell>
                              <TableCell className="text-[10px] font-mono text-right">
                                ${Number(t.cost_usd).toFixed(4)}
                              </TableCell>
                              <TableCell>
                                <span
                                  className={`inline-block h-2 w-2 rounded-full ${t.status === "success" ? "bg-emerald-500" : "bg-red-500"}`}
                                />
                              </TableCell>
                            </TableRow>
                          ))}
                          {detail.recentTraces.length === 0 && (
                            <TableRow>
                              <TableCell
                                colSpan={6}
                                className="text-center text-xs text-muted-foreground py-4"
                              >
                                No traces.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Recent chat messages (last 50)</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {detail.recentMessages.map((m) => (
                          <div key={m.id} className="rounded border border-border p-2 bg-card/50">
                            <div className="flex items-center justify-between mb-1 gap-2">
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1 py-0 h-4 capitalize"
                              >
                                {m.role}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">
                                {format(new Date(m.created_at), "MMM d HH:mm")}
                              </span>
                            </div>
                            <p className="text-xs whitespace-pre-wrap break-words">{m.content}</p>
                          </div>
                        ))}
                        {detail.recentMessages.length === 0 && (
                          <p className="text-xs text-muted-foreground text-center py-4">
                            No messages.
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DetailKpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border p-2">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  subtext,
}: {
  icon: any;
  label: string;
  value: string;
  subtext?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        {subtext && <p className="text-[10px] text-muted-foreground mt-1.5">{subtext}</p>}
      </CardContent>
    </Card>
  );
}
