import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ADMIN_EMAIL = import.meta.env.ADMIN_EMAIL;

export type AdminUserRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  organization: string | null;
  created_at: string | null;
  last_sign_in_at: string | null;
  agents_count: number;
  swarms_count: number;
  conversations_count: number;
  messages_count: number;
  traces_count: number;
  tokens_in: number;
  tokens_out: number;
  total_cost_usd: number;
  quiz_attempts_count: number;
  quiz_passed_count: number;
  exam_attempts_count: number;
  exam_passed: boolean;
  has_certificate: boolean;
};

export type AdminTotals = {
  users_total: number;
  agents_total: number;
  swarms_total: number;
  traces_total: number;
  messages_total: number;
  cost_total_usd: number;
  tokens_in_total: number;
  tokens_out_total: number;
  quiz_attempts_total: number;
  exam_attempts_total: number;
  certificates_total: number;
  exam_pass_rate: number;
};

export type AdminRecentMessage = {
  id: string;
  user_id: string;
  email: string | null;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
};

export type AdminExamAttemptSummary = {
  id: string;
  user_id: string;
  email: string | null;
  status: string;
  mcq_score: number;
  mcq_total: number;
  started_at: string;
  submitted_at: string | null;
};

export type AdminCertificateSummary = {
  id: string;
  user_id: string;
  email: string | null;
  name_on_cert: string;
  organization: string | null;
  mcq_score: number;
  agent_score: number;
  swarm_score: number;
  verification_code: string;
  issued_at: string;
};

export type AdminAnalyticsResult = {
  ok: true;
  totals: AdminTotals;
  users: AdminUserRow[];
  recentMessages: AdminRecentMessage[];
  spendByDay: { date: string; cost: number; tokens: number }[];
  topModels: { model: string; provider: string; cost: number; calls: number }[];
  recentExamAttempts: AdminExamAttemptSummary[];
  certificates: AdminCertificateSummary[];
};

export type AdminAnalyticsError = {
  ok: false;
  error: string;
  stage?: string;
};

export type AdminAnalyticsResponse = AdminAnalyticsResult | AdminAnalyticsError;

type AdminAnalyticsInput = {
  accessToken: string;
};

type AdminUserDetailInput = {
  userId: string;
  accessToken: string;
};

export type AdminContactMessage = {
  id: string;
  name: string;
  email: string;
  subject: string | null;
  message: string;
  source_page: string | null;
  user_agent: string | null;
  status: string;
  admin_notes: string | null;
  created_at: string;
};

export type AdminContactMessagesResponse =
  | { ok: true; messages: AdminContactMessage[] }
  | AdminAnalyticsError;

export const getAdminContactMessages = createServerFn({ method: "POST" })
  .inputValidator((data: AdminAnalyticsInput) => data)
  .handler(async ({ data }): Promise<AdminContactMessagesResponse> => {
    const guard = await resolveAdminFromAccessToken(data.accessToken);
    if (!guard.ok) return guard;
    try {
      const { data: rows, error } = await supabaseAdmin
        .from("contact_messages")
        .select(
          "id, name, email, subject, message, source_page, user_agent, status, admin_notes, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) return { ok: false, error: error.message, stage: "fetch" };
      return { ok: true, messages: (rows ?? []) as AdminContactMessage[] };
    } catch (err: any) {
      return { ok: false, error: err?.message ? String(err.message) : String(err), stage: "fetch" };
    }
  });

// ===== Per-user detail =====
export type AdminUserTrace = {
  id: string;
  agent_name: string;
  llm_provider: string;
  llm_model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  status: string;
  prompt: string | null;
  error_message: string | null;
  created_at: string;
};

export type AdminUserExamAttempt = {
  id: string;
  set_id: string;
  status: string;
  mcq_score: number;
  mcq_total: number;
  agent_eval: any;
  swarm_eval: any;
  evaluator_feedback: string | null;
  improvement_areas: any;
  started_at: string;
  submitted_at: string | null;
  next_eligible_at: string | null;
};

export type AdminUserCertificate = {
  id: string;
  name_on_cert: string;
  organization: string | null;
  mcq_score: number;
  agent_score: number;
  swarm_score: number;
  verification_code: string;
  issued_at: string;
};

export type AdminUserQuizAttempt = {
  id: string;
  track_id: string;
  score: number;
  total: number;
  passed: boolean;
  created_at: string;
};

export type AdminUserDetail = {
  ok: true;
  user: {
    user_id: string;
    email: string | null;
    display_name: string | null;
    organization: string | null;
    created_at: string | null;
    last_sign_in_at: string | null;
  };
  agents: {
    id: string;
    name: string;
    llm_provider: string;
    llm_model: string;
    created_at: string;
    is_active: boolean;
  }[];
  swarms: { id: string; name: string; is_deployed: boolean; created_at: string }[];
  recentMessages: {
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    created_at: string;
  }[];
  recentTraces: AdminUserTrace[];
  spendByDay: { date: string; cost: number; tokens: number }[];
  examAttempts: AdminUserExamAttempt[];
  certificates: AdminUserCertificate[];
  quizAttempts: AdminUserQuizAttempt[];
  totals: {
    agents_count: number;
    swarms_count: number;
    conversations_count: number;
    messages_count: number;
    traces_count: number;
    tokens_in: number;
    tokens_out: number;
    total_cost_usd: number;
  };
};

export type AdminUserDetailResponse = AdminUserDetail | AdminAnalyticsError;

// Helper: page through a table fully (avoids 1000-row default cap)
async function fetchAll<T>(table: string, columns: string, extra?: (q: any) => any): Promise<T[]> {
  const pageSize = 1000;
  let from = 0;
  const all: T[] = [];
  // safety cap to avoid runaway loops
  for (let i = 0; i < 50; i++) {
    let q: any = supabaseAdmin
      .from(table as any)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`[${table}] ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export const getAdminAnalytics = createServerFn({ method: "POST" })
  .inputValidator((data: AdminAnalyticsInput) => data)
  .handler(async ({ data }): Promise<AdminAnalyticsResponse> => {
    let stage = "auth";
    try {
      const guard = await resolveAdminFromAccessToken(data.accessToken);
      if (!guard.ok) return guard;

      stage = "list_users";
      const { data: usersList, error: usersErr } = await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (usersErr) {
        console.error("[admin-analytics] listUsers failed", usersErr);
        return { ok: false, error: `listUsers: ${usersErr.message}`, stage };
      }
      const users = usersList?.users ?? [];
      const emailById = new Map(users.map((u) => [u.id, u.email ?? null]));

      stage = "fetch_tables";

      const [
        profiles,
        agents,
        swarms,
        conversations,
        messagesAll,
        traces,
        recentMessagesRes,
        quizAttempts,
        examAttempts,
        certificatesAll,
      ] = await Promise.all([
        fetchAll<{ user_id: string; display_name: string | null; organization: string | null }>(
          "profiles",
          "user_id, display_name, organization",
        ),
        fetchAll<{ user_id: string }>("agents", "user_id"),
        fetchAll<{ user_id: string }>("swarms", "user_id"),
        fetchAll<{ user_id: string }>("conversations", "user_id"),
        fetchAll<{ user_id: string }>("messages", "user_id"),
        fetchAll<{
          user_id: string;
          llm_provider: string;
          llm_model: string;
          tokens_in: number;
          tokens_out: number;
          cost_usd: number;
          created_at: string;
        }>(
          "execution_traces",
          "user_id, llm_provider, llm_model, tokens_in, tokens_out, cost_usd, created_at",
        ),
        supabaseAdmin
          .from("messages")
          .select("id, user_id, conversation_id, role, content, created_at")
          .order("created_at", { ascending: false })
          .limit(50),
        fetchAll<{ user_id: string; track_id: string; passed: boolean }>(
          "quiz_attempts",
          "user_id, track_id, passed",
        ),
        fetchAll<{
          id: string;
          user_id: string;
          status: string;
          mcq_score: number;
          mcq_total: number;
          started_at: string;
          submitted_at: string | null;
        }>("exam_attempts", "id, user_id, status, mcq_score, mcq_total, started_at, submitted_at"),
        fetchAll<{
          id: string;
          user_id: string;
          name_on_cert: string;
          organization: string | null;
          mcq_score: number;
          agent_score: number;
          swarm_score: number;
          verification_code: string;
          issued_at: string;
        }>(
          "certificates",
          "id, user_id, name_on_cert, organization, mcq_score, agent_score, swarm_score, verification_code, issued_at",
        ),
      ]);

      stage = "aggregate";
      const profileById = new Map(profiles.map((p) => [p.user_id, p]));

      const tally = (rows: { user_id: string }[]) => {
        const m = new Map<string, number>();
        rows.forEach((r) => m.set(r.user_id, (m.get(r.user_id) ?? 0) + 1));
        return m;
      };

      const agentsByUser = tally(agents);
      const swarmsByUser = tally(swarms);
      const convsByUser = tally(conversations);
      const msgsByUser = tally(messagesAll);

      const tracesCountByUser = new Map<string, number>();
      const tokensInByUser = new Map<string, number>();
      const tokensOutByUser = new Map<string, number>();
      const costByUser = new Map<string, number>();

      traces.forEach((t) => {
        tracesCountByUser.set(t.user_id, (tracesCountByUser.get(t.user_id) ?? 0) + 1);
        tokensInByUser.set(t.user_id, (tokensInByUser.get(t.user_id) ?? 0) + (t.tokens_in ?? 0));
        tokensOutByUser.set(t.user_id, (tokensOutByUser.get(t.user_id) ?? 0) + (t.tokens_out ?? 0));
        costByUser.set(t.user_id, (costByUser.get(t.user_id) ?? 0) + Number(t.cost_usd ?? 0));
      });

      // Quiz & exam per-user tallies
      const quizAttemptsByUser = tally(quizAttempts);
      const quizPassedByUser = new Map<string, number>();
      quizAttempts.forEach((q) => {
        if (q.passed) quizPassedByUser.set(q.user_id, (quizPassedByUser.get(q.user_id) ?? 0) + 1);
      });
      const examAttemptsByUser = tally(examAttempts);
      const examPassedUsers = new Set<string>();
      examAttempts.forEach((e) => {
        if (e.status === "passed") examPassedUsers.add(e.user_id);
      });
      const certUsers = new Set(certificatesAll.map((c) => c.user_id));

      const userRows: AdminUserRow[] = users.map((u) => {
        const p = profileById.get(u.id);
        return {
          user_id: u.id,
          email: u.email ?? null,
          display_name: p?.display_name ?? null,
          organization: p?.organization ?? null,
          created_at: u.created_at ?? null,
          last_sign_in_at: u.last_sign_in_at ?? null,
          agents_count: agentsByUser.get(u.id) ?? 0,
          swarms_count: swarmsByUser.get(u.id) ?? 0,
          conversations_count: convsByUser.get(u.id) ?? 0,
          messages_count: msgsByUser.get(u.id) ?? 0,
          traces_count: tracesCountByUser.get(u.id) ?? 0,
          tokens_in: tokensInByUser.get(u.id) ?? 0,
          tokens_out: tokensOutByUser.get(u.id) ?? 0,
          total_cost_usd: Number((costByUser.get(u.id) ?? 0).toFixed(6)),
          quiz_attempts_count: quizAttemptsByUser.get(u.id) ?? 0,
          quiz_passed_count: quizPassedByUser.get(u.id) ?? 0,
          exam_attempts_count: examAttemptsByUser.get(u.id) ?? 0,
          exam_passed: examPassedUsers.has(u.id),
          has_certificate: certUsers.has(u.id),
        };
      });

      userRows.sort(
        (a, b) => b.total_cost_usd - a.total_cost_usd || b.traces_count - a.traces_count,
      );

      const examPassedCount = examAttempts.filter((e) => e.status === "passed").length;

      const totals: AdminTotals = {
        users_total: users.length,
        agents_total: agents.length,
        swarms_total: swarms.length,
        traces_total: traces.length,
        messages_total: messagesAll.length,
        cost_total_usd: Number(
          Array.from(costByUser.values())
            .reduce((a, b) => a + b, 0)
            .toFixed(4),
        ),
        tokens_in_total: Array.from(tokensInByUser.values()).reduce((a, b) => a + b, 0),
        tokens_out_total: Array.from(tokensOutByUser.values()).reduce((a, b) => a + b, 0),
        quiz_attempts_total: quizAttempts.length,
        exam_attempts_total: examAttempts.length,
        certificates_total: certificatesAll.length,
        exam_pass_rate:
          examAttempts.length > 0 ? Math.round((examPassedCount / examAttempts.length) * 100) : 0,
      };

      const dayBuckets = new Map<string, { cost: number; tokens: number }>();
      const cutoff = Date.now() - 30 * 86400000;
      traces.forEach((t) => {
        const ts = new Date(t.created_at).getTime();
        if (Number.isNaN(ts) || ts < cutoff) return;
        const day = new Date(t.created_at).toISOString().slice(0, 10);
        const cur = dayBuckets.get(day) ?? { cost: 0, tokens: 0 };
        cur.cost += Number(t.cost_usd ?? 0);
        cur.tokens += (t.tokens_in ?? 0) + (t.tokens_out ?? 0);
        dayBuckets.set(day, cur);
      });
      const spendByDay = Array.from(dayBuckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, cost: Number(v.cost.toFixed(4)), tokens: v.tokens }));

      const modelMap = new Map<string, { provider: string; cost: number; calls: number }>();
      traces.forEach((t) => {
        const key = t.llm_model || "unknown";
        const cur = modelMap.get(key) ?? {
          provider: t.llm_provider || "unknown",
          cost: 0,
          calls: 0,
        };
        cur.cost += Number(t.cost_usd ?? 0);
        cur.calls += 1;
        modelMap.set(key, cur);
      });
      const topModels = Array.from(modelMap.entries())
        .map(([model, v]) => ({
          model,
          provider: v.provider,
          cost: Number(v.cost.toFixed(4)),
          calls: v.calls,
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 8);

      const recentMessages: AdminRecentMessage[] = (recentMessagesRes.data ?? []).map((m: any) => ({
        id: m.id,
        user_id: m.user_id,
        email: emailById.get(m.user_id) ?? null,
        conversation_id: m.conversation_id,
        role: m.role,
        content: (m.content ?? "").slice(0, 500),
        created_at: m.created_at,
      }));

      // Recent exam attempts (last 50)
      const recentExamAttempts: AdminExamAttemptSummary[] = examAttempts
        .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
        .slice(0, 50)
        .map((e) => ({
          id: e.id,
          user_id: e.user_id,
          email: emailById.get(e.user_id) ?? null,
          status: e.status,
          mcq_score: e.mcq_score,
          mcq_total: e.mcq_total,
          started_at: e.started_at,
          submitted_at: e.submitted_at,
        }));

      // All certificates
      const certificates: AdminCertificateSummary[] = certificatesAll
        .sort((a, b) => new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime())
        .map((c) => ({
          id: c.id,
          user_id: c.user_id,
          email: emailById.get(c.user_id) ?? null,
          name_on_cert: c.name_on_cert,
          organization: c.organization,
          mcq_score: c.mcq_score,
          agent_score: c.agent_score,
          swarm_score: c.swarm_score,
          verification_code: c.verification_code,
          issued_at: c.issued_at,
        }));

      return {
        ok: true,
        totals,
        users: userRows,
        recentMessages,
        spendByDay,
        topModels,
        recentExamAttempts,
        certificates,
      };
    } catch (err: any) {
      console.error("[admin-analytics] failed at stage", stage, err);
      return {
        ok: false,
        error: err?.message ? String(err.message) : String(err),
        stage,
      };
    }
  });

// ===== Per-user detail server function =====
async function resolveAdminFromAccessToken(
  accessToken: string | undefined,
): Promise<{ ok: true; userId: string; email: string } | AdminAnalyticsError> {
  if (!accessToken) {
    return { ok: false, error: "Missing access token", stage: "auth" };
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    const user = data.user;
    const email = user?.email?.toLowerCase();

    if (error || !user) {
      return {
        ok: false,
        error: error?.message ?? "Invalid session",
        stage: "auth",
      };
    }

    if (!email || email !== ADMIN_EMAIL) {
      return {
        ok: false,
        error: `Forbidden: admin access only (saw email=${email ?? "<none>"})`,
        stage: "auth",
      };
    }

    return { ok: true, userId: user.id, email };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ? String(err.message) : "Failed to validate session",
      stage: "auth",
    };
  }
}

export const getAdminUserDetail = createServerFn({ method: "POST" })
  .inputValidator((data: AdminUserDetailInput) => data)
  .handler(async ({ data }): Promise<AdminUserDetailResponse> => {
    const guard = await resolveAdminFromAccessToken(data.accessToken);
    if (!guard.ok) return guard;

    const { userId } = data;
    if (!userId) return { ok: false, error: "Missing userId", stage: "input" };

    try {
      const [
        userRes,
        profileRes,
        agentsRes,
        swarmsRes,
        conversationsRes,
        messagesAllRes,
        recentMessagesRes,
        tracesAllRes,
        recentTracesRes,
        examAttemptsRes,
        certificatesRes,
        quizAttemptsRes,
      ] = await Promise.all([
        supabaseAdmin.auth.admin.getUserById(userId),
        supabaseAdmin
          .from("profiles")
          .select("display_name, organization")
          .eq("user_id", userId)
          .maybeSingle(),
        supabaseAdmin
          .from("agents")
          .select("id, name, llm_provider, llm_model, created_at, is_active")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("swarms")
          .select("id, name, is_deployed, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        supabaseAdmin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
        supabaseAdmin
          .from("messages")
          .select("id, conversation_id, role, content, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50),
        supabaseAdmin
          .from("execution_traces")
          .select("user_id, tokens_in, tokens_out, cost_usd, created_at")
          .eq("user_id", userId),
        supabaseAdmin
          .from("execution_traces")
          .select(
            "id, agent_name, llm_provider, llm_model, latency_ms, tokens_in, tokens_out, cost_usd, status, prompt, error_message, created_at",
          )
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(100),
        supabaseAdmin
          .from("exam_attempts")
          .select(
            "id, set_id, status, mcq_score, mcq_total, agent_eval, swarm_eval, evaluator_feedback, improvement_areas, started_at, submitted_at, next_eligible_at",
          )
          .eq("user_id", userId)
          .order("started_at", { ascending: false }),
        supabaseAdmin
          .from("certificates")
          .select(
            "id, name_on_cert, organization, mcq_score, agent_score, swarm_score, verification_code, issued_at",
          )
          .eq("user_id", userId)
          .order("issued_at", { ascending: false }),
        supabaseAdmin
          .from("quiz_attempts")
          .select("id, track_id, score, total, passed, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false }),
      ]);

      const u = userRes.data?.user;
      const p: any = profileRes.data ?? {};
      const traces = tracesAllRes.data ?? [];

      const tokensIn = traces.reduce((a: number, t: any) => a + (t.tokens_in ?? 0), 0);
      const tokensOut = traces.reduce((a: number, t: any) => a + (t.tokens_out ?? 0), 0);
      const totalCost = traces.reduce((a: number, t: any) => a + Number(t.cost_usd ?? 0), 0);

      const dayBuckets = new Map<string, { cost: number; tokens: number }>();
      const cutoff = Date.now() - 30 * 86400000;
      traces.forEach((t: any) => {
        const ts = new Date(t.created_at).getTime();
        if (Number.isNaN(ts) || ts < cutoff) return;
        const day = new Date(t.created_at).toISOString().slice(0, 10);
        const cur = dayBuckets.get(day) ?? { cost: 0, tokens: 0 };
        cur.cost += Number(t.cost_usd ?? 0);
        cur.tokens += (t.tokens_in ?? 0) + (t.tokens_out ?? 0);
        dayBuckets.set(day, cur);
      });
      const spendByDay = Array.from(dayBuckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, cost: Number(v.cost.toFixed(4)), tokens: v.tokens }));

      return {
        ok: true,
        user: {
          user_id: userId,
          email: u?.email ?? null,
          display_name: p?.display_name ?? null,
          organization: p?.organization ?? null,
          created_at: u?.created_at ?? null,
          last_sign_in_at: u?.last_sign_in_at ?? null,
        },
        agents: (agentsRes.data ?? []) as any,
        swarms: (swarmsRes.data ?? []) as any,
        recentMessages: (recentMessagesRes.data ?? []).map((m: any) => ({
          id: m.id,
          conversation_id: m.conversation_id,
          role: m.role,
          content: (m.content ?? "").slice(0, 1000),
          created_at: m.created_at,
        })),
        recentTraces: (recentTracesRes.data ?? []) as any,
        spendByDay,
        examAttempts: (examAttemptsRes.data ?? []) as any,
        certificates: (certificatesRes.data ?? []) as any,
        quizAttempts: (quizAttemptsRes.data ?? []) as any,
        totals: {
          agents_count: (agentsRes.data ?? []).length,
          swarms_count: (swarmsRes.data ?? []).length,
          conversations_count: conversationsRes.count ?? 0,
          messages_count: messagesAllRes.count ?? 0,
          traces_count: traces.length,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          total_cost_usd: Number(totalCost.toFixed(6)),
        },
      };
    } catch (err: any) {
      console.error("[admin-user-detail] failed", err);
      return { ok: false, error: err?.message ? String(err.message) : String(err), stage: "fetch" };
    }
  });
