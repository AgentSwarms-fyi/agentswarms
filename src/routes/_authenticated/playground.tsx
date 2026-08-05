import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Send,
  Download,
  PanelLeftOpen,
  PanelRightOpen,
  PanelRightClose,
  Plus,
  Trash2,
  Paperclip,
  Bot,
  User,
  Activity,
  BookOpen,
  X,
  FileText,
  Image as ImageIcon,
  Sparkles,
  Code2,
  ArrowUpRight,
  ArrowDownLeft,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Wrench,
  Loader2,
  Pencil,
  RefreshCw,
  Square,
  Globe,
  Table2,
  Plug,
  ExternalLink,
} from "lucide-react";
import { parseFileToText } from "@/lib/fileParsers";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { ExcelIcon, PptIcon, WordIcon } from "@/components/playground/FileTypeIcons";
import { DocGenBar } from "@/components/playground/DocGenBar";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { BI_FELL_THROUGH_NOTE, generateChatWidget } from "@/lib/chatBi";
import { parseWidgets } from "@/lib/biDashboards";
import { useServerFn } from "@tanstack/react-start";
import { DOC_FORMAT_LABEL } from "@/lib/docGen/types";
import type {
  DocScope,
  DocFormat,
  DocGenMode,
  DocxPlan,
  PptxPlan,
  XlsxPlan,
  MaterializedXlsxPlan,
} from "@/lib/docGen/types";
import {
  attachDiagramSvgs,
  buildDocx,
  buildPptx,
  buildXlsx,
  materializeXlsxPlan,
  downloadBlob,
  type BuiltDoc,
} from "@/lib/docGen/build";
import { materializePptxWithBI } from "@/lib/docGen/biData";
import { pptxThumbUri, docxThumbUri, xlsxThumbUri } from "@/lib/docGen/docThumb";
import { planDocument } from "@/lib/docGen/plan";
import { encodeModelChoice, isBiCompatProvider } from "@/utils/providers/modelChoice";
import { gatherDocContext } from "@/utils/docGen.functions";
import { toast } from "sonner";
import {
  ModelFallbackDialog,
  type FallbackChoice,
} from "@/components/playground/ModelFallbackDialog";
import { TemplateTour, type TourSignals } from "@/components/playground/TemplateTour";
import { SkillSampleTour } from "@/components/playground/SkillSampleTour";
import { ensureSampleAgentsForUser } from "@/lib/sampleAgentsWithSkills";

// Shown as clickable chips on the empty chat state to get people started.
const STARTER_PROMPTS = [
  "What can you help me with?",
  "What data and tools can you access?",
  "Suggest 3 questions I could ask you",
];

export const Route = createFileRoute("/_authenticated/playground")({
  validateSearch: (search: Record<string, unknown>) => ({
    agentId: (search.agentId as string) || undefined,
  }),
  component: PlaygroundPage,
});

type Agent = {
  id: string;
  name: string;
  llm_provider: string;
  llm_model: string;
  system_prompt: string | null;
  tools?: any;
};
type Conversation = { id: string; title: string; agent_id: string; created_at: string };
type Citation = {
  index: number;
  documentId: string;
  documentName: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  snippet: string;
};
// What the answer actually drew on, tagged by kind so a web answer shows links
// and a data answer shows tables. Sent as a trailing `sources` event once the
// text is known; `citations` remains for messages saved before this existed.
type SourceKind = "kb" | "web" | "table" | "mcp" | "tool";
type Source = {
  index: number;
  kind: SourceKind;
  title: string;
  url?: string;
  detail?: string;
  snippet?: string;
  tool?: string;
};
type Message = { id: string; role: string; content: string; created_at: string; metadata?: any };

// Hoisted to module scope so helper components (AttachmentChips, ToolEventsPanel)
// can share the exact same shape as the playground component's state.
type PendingImage = { kind: "image"; name: string; dataUrl: string };
type PendingDoc = { kind: "doc"; name: string; text: string };
type PendingAttachment = PendingImage | PendingDoc;
type ToolUiEvent =
  | { type: "tool_call"; name: string; args: string; id: string }
  | { type: "tool_result"; name: string; id: string; ok: boolean; preview: string };

// Image models can fail mid-conversation when the context grows past their
// token budget — Gemini image models are especially prone to this. When that
// happens, surface a richer toast that points the user at the dedicated
// /image-playground (no history, fresh prompt every run).
function showChatError(message: string) {
  const lower = message.toLowerCase();
  const looksLikeImageError =
    lower.includes("image model returned no image") ||
    lower.includes("max_tokens") ||
    lower.includes("output limit") ||
    (lower.includes("image") && lower.includes("token"));
  if (looksLikeImageError) {
    toast.error(message, {
      duration: 10000,
      description:
        "Image generation in chat hits token limits as conversations grow. Try the Image Playground for a fresh, history-free run.",
      action: {
        label: "Open Image Playground",
        onClick: () => {
          window.location.href = "/image-playground";
        },
      },
    });
    return;
  }
  toast.error(message);
}

function PlaygroundPage() {
  const { user } = useAuth();
  const { agentId } = Route.useSearch();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvo, setActiveConvo] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // Visual BI answers: session state seeded from the agent's saved setting.
  // A ref mirrors it so the async post-answer generator reads the live value.
  const [biVisuals, setBiVisuals] = useState(false);
  const biVisualsRef = useRef(false);
  // Sample vs. full data scope for doc generation + the Visual BI widget.
  const [dataScope, setDataScope] = useState<DocScope>("sample");
  // Browser (fast, in-browser) vs Deep (slow, server renderer + AI review).
  const [docMode, setDocMode] = useState<DocGenMode>("fast");
  // Probed once per mount: Deep silently degrades to the browser build when the
  // renderer isn't configured, which looks like "Deep did nothing". Knowing up
  // front lets the control say so instead.
  const [deepStatus, setDeepStatus] = useState<{ available: boolean; reason: string | null }>({
    available: true,
    reason: null,
  });
  // Document generation: the "armed" format turns the chat box into "describe
  // the document" mode; docPhase drives the inline "Preparing…" status.
  const [armedDoc, setArmedDoc] = useState<DocFormat | null>(null);
  const [docPhase, setDocPhase] = useState<"idle" | "gathering" | "planning" | "building">("idle");
  const gatherDocContextFn = useServerFn(gatherDocContext);
  const dataScopeRef = useRef<DocScope>("sample");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Developer inspector (request/tools/trace) — collapsed by default so the
  // chat is the star; the choice is remembered per browser.
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("agentswarms.chat_inspector") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("agentswarms.chat_inspector", inspectorOpen ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [inspectorOpen]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Messages are appended to state with a client-generated id the instant
  // they're created (so streaming/optimistic UI has something to key on),
  // but persisted rows get their own Postgres-generated id. This map lets
  // edit/delete/regenerate resolve a message's real DB row id; messages
  // loaded fresh from loadMessages() already carry their real id, so a miss
  // here just falls back to the message's own id (see resolveDbId).
  const dbIdMap = useRef(new Map<string, string>());

  // Aborts the in-flight /api/chat stream when the user hits "Stop".
  const abortControllerRef = useRef<AbortController | null>(null);

  // Pending attachments (per turn). Images become vision parts; documents
  // are parsed client-side and inlined into the user message as context.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [parsingFiles, setParsingFiles] = useState(false);

  // Live tool execution events streamed from /api/chat (event: tool frames).
  // Reset at the start of each turn; the inspector renders them in real time.
  const [toolEvents, setToolEvents] = useState<ToolUiEvent[]>([]);

  // Memory recall surfaced from the last `memory_used` SSE event. Used to
  // render the "Memory: N items recalled" chip on the latest assistant message.
  const [memoryUsed, setMemoryUsed] = useState<{
    messageId: string;
    items: Array<{ id: string; kind: string; content: string; matchScore?: number }>;
    summaryUsed: boolean;
  } | null>(null);

  // When the selected model fails (rate limit / credits), we open this dialog
  // to let the user pick another model and replay the same conversation.
  const [fallbackInfo, setFallbackInfo] = useState<{
    reason: "rate_limit" | "credits" | "error";
    errorMessage?: string;
    history: Message[];
    isFirstUserMessage: boolean;
    failedProvider?: string;
    failedModel?: string;
  } | null>(null);

  // Once the user picks a fallback model in this session, keep using it for
  // subsequent messages so they don't hit the same wall every turn.
  const [overrideModel, setOverrideModel] = useState<{
    provider: string;
    model: string;
    label: string;
  } | null>(null);

  // Approval-related signals for the guided tour.
  const [approvalSignals, setApprovalSignals] = useState<{
    pending: boolean;
    decided: boolean;
  }>({ pending: false, decided: false });

  // Last raw HTTP exchange with /api/chat — exposed in the right inspector
  // so users can see the exact request body and the raw streamed response,
  // which is invaluable when debugging external providers (Gemini, Grok, etc.).
  const [lastExchange, setLastExchange] = useState<{
    requestBody: unknown;
    status: number | null;
    responseHeaders: Record<string, string>;
    responseText: string;
    error?: string;
    startedAt: number;
    durationMs: number | null;
    traceId?: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Idempotently seed the Skill-sample agents the first time this user
      // opens the Playground in this session. Safe no-op if they already exist.
      try {
        const seedFlag = "skill-sample-agents-seeded";
        const already = typeof window !== "undefined" && sessionStorage.getItem(seedFlag) === "1";
        if (!already) {
          // Claim the flag BEFORE awaiting. Written afterwards it guarded
          // nothing: the whole seeding duration was an open window, and a
          // second invocation in that window seeded again. ensureSampleAgents-
          // ForUser is single-flight now too, so this is belt and braces —
          // but a guard set after the work it guards is simply not a guard.
          try {
            sessionStorage.setItem(seedFlag, "1");
          } catch {
            /* private mode — the single-flight guard still applies */
          }
          await ensureSampleAgentsForUser();
        }
      } catch (err) {
        console.warn("[playground] sample-agent seed failed:", err);
      }
      if (cancelled) return;
      const { data } = await supabase
        .from("agents")
        .select("id, name, llm_provider, llm_model, system_prompt, tools");
      if (cancelled || !data) return;
      setAgents(data as Agent[]);
      if (agentId && data.find((a) => a.id === agentId)) {
        setSelectedAgent(agentId);
      } else if (data.length > 0) {
        setSelectedAgent(data[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (selectedAgent) loadConversations();
  }, [selectedAgent]);

  useEffect(() => {
    if (activeConvo) loadMessages();
  }, [activeConvo]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  // Poll approvals for the selected agent so the guided tour can tick its
  // approval-related checkpoints in near-real-time.
  useEffect(() => {
    if (!selectedAgent) {
      setApprovalSignals({ pending: false, decided: false });
      return;
    }
    let cancelled = false;
    const fetchApprovals = async () => {
      const { data } = await supabase
        .from("approvals")
        .select("status")
        .eq("agent_id", selectedAgent);
      if (cancelled || !data) return;
      setApprovalSignals({
        pending: data.some((a) => a.status === "pending"),
        decided: data.some((a) => a.status === "approved" || a.status === "rejected"),
      });
    };
    fetchApprovals();
    const interval = setInterval(fetchApprovals, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedAgent]);

  async function loadConversations() {
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("agent_id", selectedAgent)
      .order("updated_at", { ascending: false });
    if (data) {
      setConversations(data);
      if (data.length > 0) {
        if (!activeConvo) setActiveConvo(data[0].id);
      } else if (user && selectedAgent) {
        // Auto-create a first conversation so the input is usable
        const { data: newConvo } = await supabase
          .from("conversations")
          .insert({ user_id: user.id, agent_id: selectedAgent, title: "New Chat" })
          .select()
          .single();
        if (newConvo) {
          setConversations([newConvo as Conversation]);
          setActiveConvo(newConvo.id);
          setMessages([]);
        }
      }
    }
  }

  async function loadMessages() {
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", activeConvo)
      .order("created_at", { ascending: true });
    if (data) setMessages(data as Message[]);
  }

  async function createConversation() {
    if (!user || !selectedAgent) return;
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: user.id,
        agent_id: selectedAgent,
        title: "New Chat",
      })
      .select()
      .single();
    if (data) {
      setActiveConvo(data.id);
      setMessages([]);
      loadConversations();
    }
  }

  async function deleteConversation(id: string) {
    await supabase.from("conversations").delete().eq("id", id);
    if (activeConvo === id) {
      setActiveConvo("");
      setMessages([]);
    }
    loadConversations();
  }

  function resolveDbId(id: string): string {
    return dbIdMap.current.get(id) ?? id;
  }

  // Core streaming runner. Re-used by initial sends and "retry with another model".
  // Returns { ok: true } on success or { ok: false, status, errorMessage } on failure.
  async function runChatRequest(opts: {
    historySnapshot: Message[];
    isFirstUserMessage: boolean;
    providerOverride?: string;
    modelOverride?: string;
  }): Promise<
    | { ok: true }
    | {
        ok: false;
        status: number;
        errorMessage: string;
        reason: "rate_limit" | "credits" | "error";
      }
  > {
    if (!user || !activeConvo) {
      return { ok: false, status: 0, errorMessage: "No active conversation", reason: "error" };
    }
    const agent = agents.find((a) => a.id === selectedAgent);
    const provider =
      opts.providerOverride || overrideModel?.provider || agent?.llm_provider || "openrouter";
    const model =
      opts.modelOverride || overrideModel?.model || agent?.llm_model || "openai/gpt-4o-mini";

    setThinking(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const assistantId = crypto.randomUUID();
    let assistantContent = "";
    let firstTokenReceived = false;
    let citations: Citation[] = [];
    let sources: Source[] = [];

    const startedAt = Date.now();
    const requestBody = {
      agentId: selectedAgent || undefined,
      // Pass the active conversation id so the chat route can load STM
      // (rolling summary + sliding window) and persist post-turn extraction.
      conversationId: activeConvo || undefined,
      provider,
      model,
      systemPrompt: agent?.system_prompt || undefined,
      messages: opts.historySnapshot.map((m) => {
        // If the message has attachments stashed in metadata, render them as
        // multi-part content (vision parts for images, inlined text blocks
        // prefacing the user text for documents).
        const att: PendingAttachment[] = Array.isArray(m.metadata?.attachments)
          ? (m.metadata!.attachments as PendingAttachment[])
          : [];
        const role = m.role === "assistant" ? "assistant" : "user";
        if (att.length === 0) {
          return { role, content: m.content };
        }
        const parts: Array<
          { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
        > = [];
        const docs = att.filter((a): a is PendingDoc => a.kind === "doc");
        for (const d of docs) {
          parts.push({
            type: "text",
            text: `[Attached document: ${d.name}]\n${d.text.slice(0, 12000)}`,
          });
        }
        if (m.content?.trim()) parts.push({ type: "text", text: m.content });
        for (const a of att) {
          if (a.kind === "image") {
            parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
          }
        }
        return { role, content: parts };
      }),
    };
    const displayRequestBody = requestBody;
    setLastExchange({
      requestBody: displayRequestBody,
      status: null,
      responseHeaders: {},
      responseText: "",
      startedAt,
      durationMs: null,
    });

    let rawResponseText = "";
    let respStatus: number | null = null;
    const respHeaders: Record<string, string> = {};
    let traceId: string | null = null;

    try {
      // Visual BI mode: answer data questions with the BI analyst FIRST — a
      // data-grounded narrative + chart computed from the user's own data —
      // instead of letting a data-unaware agent reply. That agent reply was the
      // source of two problems the user hit: it cited irrelevant KB how-to docs,
      // and it forced a visible "wrong answer, then suddenly corrected" swap.
      // We fall through to the normal agent path when the question isn't
      // answerable from data (BI returns nothing), so ordinary chat, KB Q&A and
      // attachments still work with real citations and token streaming.
      if (biVisualsRef.current) {
        const lastUserMsg = [...opts.historySnapshot].reverse().find((m) => m.role === "user");
        const hasAttachments =
          Array.isArray(lastUserMsg?.metadata?.attachments) &&
          (lastUserMsg!.metadata!.attachments as unknown[]).length > 0;
        const q = lastUserMsg?.content ?? "";
        if (q && !hasAttachments) {
          const bi = await generateChatWidget(q, {
            scope: dataScopeRef.current,
            // Same model as the conversation. Without this the analyst ran on
            // /api/bi's fallback, so Visual BI could fail on a model the user
            // never chose while the chat around it worked fine.
            model: docGenModelChoice(),
            // Everything BEFORE this question, so a follow-up can be resolved
            // into a standalone one. Without it "show me this as a bar chart"
            // reached a stateless analyst with no subject, produced nothing,
            // and fell through to the agent — which replied by explaining how
            // to draw the chart manually on /data-sql.
            history: opts.historySnapshot
              .filter((m) => m !== lastUserMsg && typeof m.content === "string" && m.content.trim())
              .map((m) => ({
                role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
                content: m.content,
              })),
          });
          if (bi.narrative?.trim() || bi.widgets.length > 0) {
            const content = bi.narrative?.trim() || "Here's what your data shows.";
            // The analyst answers from the user's data, so it carries no KB
            // citations — but it does cite the TABLE it read and the SELECT it
            // ran, the same way the agent's sql_query tool does. Without that
            // a chart and a confident sentence arrived with no provenance at
            // all, while the identical question answered by the tool showed
            // both.
            const meta: Record<string, unknown> = {};
            if (bi.widgets.length > 0) meta.widgets = bi.widgets;
            if (bi.sources.length > 0) meta.sources = bi.sources;
            setMessages((prev) => [
              ...prev,
              {
                id: assistantId,
                role: "assistant",
                content,
                created_at: new Date().toISOString(),
                metadata: meta,
              },
            ]);
            setLastExchange({
              requestBody: displayRequestBody,
              status: 200,
              responseHeaders: {},
              responseText: "Answered by the Visual BI analyst (plan → SQL → execute).",
              startedAt,
              durationMs: Date.now() - startedAt,
              traceId: null,
            });
            const { data: insertedBi } = await supabase
              .from("messages")
              .insert({
                conversation_id: activeConvo,
                user_id: user.id,
                role: "assistant",
                content,
                metadata: meta as unknown as Json,
              })
              .select("id")
              .single();
            if (insertedBi?.id) dbIdMap.current.set(assistantId, insertedBi.id);
            if (opts.isFirstUserMessage && lastUserMsg) {
              await supabase
                .from("conversations")
                .update({ title: lastUserMsg.content.slice(0, 50) })
                .eq("id", activeConvo);
              loadConversations();
            }
            return { ok: true };
          }
          // BI ran and produced nothing, so the agent answers instead. Tell it
          // that, or it recommends building the chart by hand on another page
          // while the Visual BI toggle sits lit in front of the user.
          requestBody.systemPrompt = requestBody.systemPrompt
            ? `${requestBody.systemPrompt}\n\n${BI_FELL_THROUGH_NOTE}`
            : BI_FELL_THROUGH_NOTE;
        }
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sessionData.session?.access_token) {
        headers.Authorization = `Bearer ${sessionData.session.access_token}`;
      }
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      respStatus = resp.status;
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      traceId = resp.headers.get("x-trace-id");

      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        rawResponseText = errText;
        let errMsg = `Request failed (${resp.status})`;
        try {
          const j = JSON.parse(errText);
          // Prefer the human-readable message (e.g. IAM model_not_allowed).
          if (j?.message) errMsg = j.message;
          else if (j?.error) errMsg = j.error;
        } catch {
          /* ignore */
        }
        setLastExchange({
          requestBody: displayRequestBody,
          status: respStatus,
          responseHeaders: respHeaders,
          responseText: rawResponseText,
          error: errMsg,
          startedAt,
          durationMs: Date.now() - startedAt,
          traceId,
        });
        let reason: "rate_limit" | "credits" | "error";
        if (resp.status === 429) {
          reason = "rate_limit";
        } else if (resp.status === 402 || /credit|payment required|insufficient/i.test(errMsg)) {
          reason = "credits";
        } else if (/rate limit|too many requests/i.test(errMsg)) {
          reason = "rate_limit";
        } else {
          reason = "error";
        }
        if (reason === "error") {
          errMsg = `${provider}: ${errMsg}`;
        }
        return { ok: false, status: resp.status, errorMessage: errMsg, reason };
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";
      let currentEvent: string | null = null;

      const appendDelta = (delta: string) => {
        assistantContent += delta;
        if (!firstTokenReceived) {
          firstTokenReceived = true;
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: assistantContent,
              created_at: new Date().toISOString(),
              metadata: citations.length > 0 ? { citations } : undefined,
            },
          ]);
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: assistantContent } : m)),
          );
        }
      };

      const applySources = (srcs: Source[]) => {
        sources = srcs;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, metadata: { ...(m.metadata || {}), sources: srcs } } : m,
          ),
        );
      };

      const applyCitations = (cits: Citation[]) => {
        citations = cits;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, metadata: { ...(m.metadata || {}), citations: cits } }
              : m,
          ),
        );
      };

      // Read to the end of the stream, not to [DONE] — see the note there.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        rawResponseText += chunkText;
        textBuffer += chunkText;

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":")) continue;
          if (line.trim() === "") {
            currentEvent = null;
            continue;
          }
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") {
            // Do NOT stop reading here. Events that depend on the finished
            // answer — `sources`, and the guardrail rewrite/warning — are
            // appended AFTER the gateway's [DONE], so breaking out at this
            // point silently discarded them. The stream ends when the reader
            // reports done; every wrapper closes its controller.
            continue;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            if (currentEvent === "citations") {
              if (Array.isArray(parsed?.citations)) applyCitations(parsed.citations as Citation[]);
              continue;
            }
            if (currentEvent === "sources") {
              if (Array.isArray(parsed?.sources)) applySources(parsed.sources as Source[]);
              continue;
            }
            if (currentEvent === "tool") {
              // Real-time tool execution event from the server-side loop.
              setToolEvents((prev) => [...prev, parsed as ToolUiEvent]);
              continue;
            }
            if (currentEvent === "memory_used") {
              // Memory recall preamble from the chat route — chip rendered on
              // the assistant message we're about to stream.
              const items = Array.isArray(parsed?.items) ? parsed.items : [];
              setMemoryUsed({
                messageId: assistantId,
                items,
                summaryUsed: !!parsed?.summary_used,
              });
              continue;
            }
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) appendDelta(content);
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      setLastExchange({
        requestBody: displayRequestBody,
        status: respStatus,
        responseHeaders: respHeaders,
        responseText: rawResponseText,
        startedAt,
        durationMs: Date.now() - startedAt,
        traceId,
      });

      if (!assistantContent) {
        return {
          ok: false,
          status: 502,
          errorMessage: "Empty response from model",
          reason: "error",
        };
      }

      const { data: insertedAssistant } = await supabase
        .from("messages")
        .insert({
          conversation_id: activeConvo,
          user_id: user.id,
          role: "assistant",
          content: assistantContent,
          metadata: {
            ...(citations.length > 0 ? { citations } : {}),
            ...(sources.length > 0 ? { sources } : {}),
          },
        })
        .select("id")
        .single();
      if (insertedAssistant?.id) {
        dbIdMap.current.set(assistantId, insertedAssistant.id);
      }

      // (Visual BI answers are produced up-front by the BI-first branch above;
      // reaching here means either BI is off or the question wasn't answerable
      // from data, so the agent's own reply + its KB citations stand.)

      if (opts.isFirstUserMessage) {
        const lastUser = [...opts.historySnapshot].reverse().find((m) => m.role === "user");
        if (lastUser) {
          await supabase
            .from("conversations")
            .update({
              title: lastUser.content.slice(0, 50),
            })
            .eq("id", activeConvo);
          loadConversations();
        }
      }
      return { ok: true };
    } catch (err) {
      // User hit "Stop" — keep whatever text streamed so far instead of
      // treating this as a failure. Mirrors ChatGPT/Claude's stop behavior.
      if (err instanceof DOMException && err.name === "AbortError") {
        setLastExchange({
          requestBody: displayRequestBody,
          status: respStatus,
          responseHeaders: respHeaders,
          responseText: rawResponseText,
          startedAt,
          durationMs: Date.now() - startedAt,
          traceId,
        });
        if (assistantContent) {
          const { data: insertedAssistant } = await supabase
            .from("messages")
            .insert({
              conversation_id: activeConvo,
              user_id: user.id,
              role: "assistant",
              content: assistantContent,
              metadata: {
                ...(citations.length > 0 ? { citations } : {}),
                ...(sources.length > 0 ? { sources } : {}),
              },
            })
            .select("id")
            .single();
          if (insertedAssistant?.id) {
            dbIdMap.current.set(assistantId, insertedAssistant.id);
          }
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        }
        return { ok: true };
      }
      const message = err instanceof Error ? err.message : "Failed to get response";
      setLastExchange({
        requestBody: displayRequestBody,
        status: respStatus,
        responseHeaders: respHeaders,
        responseText: rawResponseText,
        error: message,
        startedAt,
        durationMs: Date.now() - startedAt,
        traceId,
      });
      // Drop the streamed assistant placeholder so we don't leave a half message.
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      return { ok: false, status: 0, errorMessage: message, reason: "error" };
    } finally {
      setThinking(false);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }

  function stopGeneration() {
    abortControllerRef.current?.abort();
  }

  async function handleFilesPicked(files: File[]) {
    setParsingFiles(true);
    const next: PendingAttachment[] = [];
    for (const f of files) {
      const isImage = f.type.startsWith("image/");
      try {
        if (isImage) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ""));
            r.onerror = () => reject(new Error("Failed to read image"));
            r.readAsDataURL(f);
          });
          next.push({ kind: "image", name: f.name, dataUrl });
        } else {
          const text = await parseFileToText(f);
          if (!text.trim()) {
            toast.warning(`${f.name}: no text extracted`);
            continue;
          }
          next.push({ kind: "doc", name: f.name, text });
        }
      } catch (err) {
        toast.error(`${f.name}: ${err instanceof Error ? err.message : "parse failed"}`);
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
    setParsingFiles(false);
  }

  // Shared tail for every call site that kicks off a runChatRequest: opens
  // the model-fallback dialog on rate-limit/credits, otherwise toasts.
  async function runAndHandleFallback(opts: {
    historySnapshot: Message[];
    isFirstUserMessage: boolean;
    providerOverride?: string;
    modelOverride?: string;
  }) {
    const agent = agents.find((a) => a.id === selectedAgent);
    const result = await runChatRequest(opts);
    if (!result.ok) {
      if (result.reason === "rate_limit" || result.reason === "credits") {
        // Don't toast — open the model picker so the user can keep going.
        setFallbackInfo({
          reason: result.reason,
          errorMessage: result.errorMessage,
          history: opts.historySnapshot,
          isFirstUserMessage: opts.isFirstUserMessage,
          failedProvider:
            opts.providerOverride || overrideModel?.provider || agent?.llm_provider || "openrouter",
          failedModel:
            opts.modelOverride || overrideModel?.model || agent?.llm_model || "openai/gpt-4o-mini",
        });
      } else {
        showChatError(result.errorMessage);
      }
    }
  }

  /**
   * The model doc generation should plan with: the one this conversation is
   * already using.
   *
   * Without this it sent nothing, and /api/bi fell back to the integration's
   * default model — so a chat running happily on a free model could still fail
   * document generation with "AI credits exhausted", because the fallback was a
   * paid model the account had no credit for. Only BI-compatible providers can
   * execute there; for anything else we send nothing and let the endpoint pick,
   * which is the old behaviour.
   */
  function docGenModelChoice(): string | undefined {
    const agent = agents.find((a) => a.id === selectedAgent);
    const provider = overrideModel?.provider || agent?.llm_provider || "";
    const model = overrideModel?.model || agent?.llm_model || "";
    if (!provider || !model || !isBiCompatProvider(provider)) return undefined;
    return encodeModelChoice(provider, model);
  }

  // Generate a document from a typed description (the chat box, in "armed" mode)
  // — gather connected KB/data context, plan it, and build a real editable file.
  async function runDocGen(format: DocFormat, prompt: string) {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      toast.error("Please sign in again");
      return;
    }
    const docModel = docGenModelChoice();
    try {
      setDocPhase("gathering");
      const ctx = await gatherDocContextFn({
        data: { access_token: token, prompt, agent_id: selectedAgent || undefined },
      });
      if (!ctx.ok) throw new Error(ctx.error);
      // The prompt asked for live figures and the search came back empty. The
      // document itself is told not to fabricate sources, but the person who
      // asked has to hear it too — a BoQ of unverified prices is exactly the
      // kind of file that gets forwarded to a customer.
      if (ctx.context.webAttempted && !ctx.context.web?.length) {
        toast.warning("Web research found nothing — figures won't be sourced", {
          description:
            (ctx.context.webNote ?? "The search returned no usable results.") +
            " Treat any prices or external facts in this document as unverified.",
          duration: 12000,
        });
      }
      setDocPhase("planning");
      const plan = await planDocument(format, {
        prompt,
        context: ctx.context,
        scope: dataScope,
        model: docModel,
        // Deep is not just a different renderer — it commissions a bigger,
        // more varied deck. Without this the plan was identical to Fast's.
        mode: docMode,
        conversation: messages.map((m) => ({
          role: m.role === "user" ? "user" : ("assistant" as const),
          content: m.content,
        })),
      });
      setDocPhase("building");
      const fileBase =
        prompt
          .slice(0, 40)
          .replace(/[^\w.-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "document";
      let built: BuiltDoc;
      if (format === "pptx")
        built = await buildPptxDoc(plan as PptxPlan, fileBase, token, docMode, docModel);
      else if (format === "docx")
        built = await buildDocxDoc(plan as DocxPlan, fileBase, token, docMode);
      else {
        const materialized = await materializeXlsxPlan(plan as XlsxPlan, dataScope);
        // A silent repair hides a defect nobody will ever fix, and the person
        // about to send this workbook on deserves to know a cell moved.
        if (materialized.repairs?.length) {
          toast.info("Fixed the layout of a totals row", {
            description: `${materialized.repairs.join("; ")}. A column total had been written under a different column.`,
            duration: 9000,
          });
        }
        built = await buildXlsxDoc(materialized, fileBase, token, docMode);
      }
      // Show the result as a preview card in chat (thumbnail + download button)
      // instead of auto-downloading. The blob URL lives for this session; the
      // file is also parked in the private `chat-docs` bucket so the Download
      // button still works after a reload (via a signed URL) until the agent's
      // retention window purges it.
      const url = URL.createObjectURL(built.blob);
      const docId = crypto.randomUUID();
      let path: string | undefined;
      if (user) {
        try {
          const p = `${user.id}/${docId}.${format}`;
          const { error } = await supabase.storage
            .from("chat-docs")
            .upload(p, built.blob, { contentType: DOC_MIME[format], upsert: true });
          if (!error) path = p;
        } catch {
          /* storage unavailable (bucket not migrated yet) → session-only download */
        }
      }
      const docMeta = { format, filename: built.filename, thumb: built.thumb, path };
      setMessages((prev) => [
        ...prev,
        {
          id: docId,
          role: "assistant",
          content: `Here's your ${DOC_FORMAT_LABEL[format]} — **${built.filename}**`,
          created_at: new Date().toISOString(),
          metadata: { doc: { ...docMeta, url } },
        },
      ]);
      // Awaited, not fire-and-forget: this insert is the ONLY thing that keeps
      // the document in the conversation after a reload, and a silent failure
      // looks exactly like the feature not saving anything.
      if (activeConvo && user) {
        const { data: savedDoc, error: saveErr } = await supabase
          .from("messages")
          .insert({
            conversation_id: activeConvo,
            user_id: user.id,
            role: "assistant",
            content: `Here's your ${DOC_FORMAT_LABEL[format]} — **${built.filename}**`,
            metadata: { doc: docMeta } as unknown as Json,
          })
          .select("id")
          .single();
        if (savedDoc?.id) dbIdMap.current.set(docId, savedDoc.id);
        if (saveErr) {
          toast.warning("Document built, but not saved to this conversation", {
            description: `${saveErr.message}. Download it now — it won't be here after a reload.`,
            duration: 12000,
          });
        }
      } else {
        toast.warning("Document built, but there's no conversation to save it to", {
          description: "Download it now — it won't be here after a reload.",
          duration: 10000,
        });
      }
    } catch (e) {
      const reason = (e as Error).message || "Generation failed";
      toast.error(reason, { duration: 10000 });
      // Also leave it in the conversation. A toast disappears, and a failed
      // generation that only toasted read as "it showed planning, then nothing
      // happened" — the prompt was still sitting there with no reply next to it.
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `I couldn't build that ${DOC_FORMAT_LABEL[format]}.\n\n**${reason}**`,
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setDocPhase("idle");
    }
  }

  async function sendMessage() {
    // Document mode: a format is armed, so the typed text is the doc description.
    if (armedDoc) {
      const p = input.trim();
      if (!p) {
        toast.error("Describe what the document should contain");
        return;
      }
      const fmt = armedDoc;
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      setArmedDoc(null);
      // Record the request as a real turn. It used to go straight into
      // runDocGen, so the prompt was never shown OR saved — the conversation
      // jumped from nothing to a document with no sign of what was asked for.
      const isFirstDocMessage = messages.length === 0;
      const docPrompt: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: p,
        created_at: new Date().toISOString(),
        metadata: { docRequest: fmt },
      };
      setMessages((prev) => [...prev, docPrompt]);
      if (activeConvo && user) {
        const { data: insertedPrompt } = await supabase
          .from("messages")
          .insert({
            conversation_id: activeConvo,
            user_id: user.id,
            role: "user",
            content: p,
            metadata: { docRequest: fmt } as unknown as Json,
          })
          .select("id")
          .single();
        if (insertedPrompt?.id) dbIdMap.current.set(docPrompt.id, insertedPrompt.id);
        // Doc-gen never went through the normal reply path, so a conversation
        // that only ever generated documents stayed titled "New Chat".
        if (isFirstDocMessage) {
          await supabase
            .from("conversations")
            .update({ title: p.slice(0, 50) })
            .eq("id", activeConvo);
          loadConversations();
        }
      }
      await runDocGen(fmt, p);
      return;
    }
    if ((!input.trim() && attachments.length === 0) || !activeConvo || !user) return;
    const userMsg = input.trim();
    const turnAttachments = attachments;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setAttachments([]);
    setToolEvents([]);
    setMemoryUsed(null);

    const isFirstMessage = messages.length === 0;

    const tempUserMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMsg,
      created_at: new Date().toISOString(),
      metadata: turnAttachments.length > 0 ? { attachments: turnAttachments } : undefined,
    };
    const historySnapshot = [...messages, tempUserMsg];
    setMessages(historySnapshot);

    // Persist a textual summary of attachments alongside the user content
    // so the conversation history remains intelligible after reload.
    const attachmentSummary =
      turnAttachments.length > 0
        ? "\n\n" +
          turnAttachments
            .map((a) => (a.kind === "image" ? `📎 image: ${a.name}` : `📎 document: ${a.name}`))
            .join("\n")
        : "";
    const { data: insertedUser } = await supabase
      .from("messages")
      .insert({
        conversation_id: activeConvo,
        user_id: user.id,
        role: "user",
        content: userMsg + attachmentSummary,
      })
      .select("id")
      .single();
    if (insertedUser?.id) dbIdMap.current.set(tempUserMsg.id, insertedUser.id);

    await runAndHandleFallback({ historySnapshot, isFirstUserMessage: isFirstMessage });
  }

  async function retryWithModel(choice: FallbackChoice) {
    if (!fallbackInfo) return;
    const info = fallbackInfo;
    setFallbackInfo(null);
    // Remember choice for the rest of the session.
    setOverrideModel({ provider: choice.provider, model: choice.model, label: choice.label });
    toast.info(`Retrying with ${choice.label}…`);
    await runAndHandleFallback({
      historySnapshot: info.history,
      isFirstUserMessage: info.isFirstUserMessage,
      providerOverride: choice.provider,
      modelOverride: choice.model,
    });
  }

  // Regenerate: re-run the last assistant reply with the same model. Drops
  // the old assistant row (state + DB) and streams a fresh one from the same
  // history — the same mechanism as sendMessage, just without a new user turn.
  async function regenerateResponse(assistantMsgId: string) {
    if (thinking || !user) return;
    const idx = messages.findIndex((m) => m.id === assistantMsgId);
    if (idx === -1) return;
    const historySnapshot = messages.slice(0, idx);
    const dbId = resolveDbId(assistantMsgId);
    setMessages(historySnapshot);
    setToolEvents([]);
    setMemoryUsed(null);
    await supabase.from("messages").delete().eq("id", dbId);
    await runAndHandleFallback({
      historySnapshot,
      isFirstUserMessage: historySnapshot.length === 1,
    });
  }

  // Edit-and-resend: rewinds the conversation to the edited message (discarding
  // it and everything after, in both state and the DB) and sends the edited
  // text as a fresh turn — matches ChatGPT/Claude's edit behavior.
  async function editAndResend(userMsgId: string, newContent: string) {
    if (thinking || !user) return;
    const trimmed = newContent.trim();
    if (!trimmed) return;
    const idx = messages.findIndex((m) => m.id === userMsgId);
    if (idx === -1) return;

    const toRemoveDbIds = messages.slice(idx).map((m) => resolveDbId(m.id));
    const beforeHistory = messages.slice(0, idx);
    const isFirstMessage = beforeHistory.length === 0;

    const editedMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    const historySnapshot = [...beforeHistory, editedMsg];
    setMessages(historySnapshot);
    setToolEvents([]);
    setMemoryUsed(null);

    if (toRemoveDbIds.length > 0) {
      await supabase.from("messages").delete().in("id", toRemoveDbIds);
    }
    const { data: insertedUser } = await supabase
      .from("messages")
      .insert({
        conversation_id: activeConvo,
        user_id: user.id,
        role: "user",
        content: trimmed,
      })
      .select("id")
      .single();
    if (insertedUser?.id) dbIdMap.current.set(editedMsg.id, insertedUser.id);

    await runAndHandleFallback({ historySnapshot, isFirstUserMessage: isFirstMessage });
  }

  async function deleteMessage(id: string) {
    const dbId = resolveDbId(id);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    await supabase.from("messages").delete().eq("id", dbId);
  }

  const currentAgent = agents.find((a) => a.id === selectedAgent);

  // Seed the Visual-BI toggle from the selected agent's saved setting.
  useEffect(() => {
    const on = !!(currentAgent?.tools as { biVisuals?: boolean } | undefined)?.biVisuals;
    setBiVisuals(on);
  }, [currentAgent]);
  // Keep the ref in sync so the async post-answer generator sees the live value.
  useEffect(() => {
    biVisualsRef.current = biVisuals;
  }, [biVisuals]);
  useEffect(() => {
    dataScopeRef.current = dataScope;
  }, [dataScope]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/docgen/status");
        const j = (await r.json()) as { available?: boolean; reason?: string | null };
        if (cancelled) return;
        const available = !!j.available;
        setDeepStatus({ available, reason: j.reason ?? null });
        // Don't leave the user on a mode that cannot run.
        if (!available) setDocMode("fast");
      } catch {
        if (!cancelled) {
          setDeepStatus({ available: false, reason: "the status probe failed" });
          setDocMode("fast");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve template id for the guided tour. Prefer the agent's stored
  // tools.templateId; fall back to the value the templates page wrote into
  // sessionStorage at provision time.
  const templateId: string | null = (() => {
    const fromAgent = (currentAgent?.tools as any)?.templateId;
    if (typeof fromAgent === "string") return fromAgent;
    if (!selectedAgent) return null;
    try {
      const raw = sessionStorage.getItem(`template-tour:${selectedAgent}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { templateId?: string };
        if (parsed.templateId) return parsed.templateId;
      }
    } catch {
      /* ignore */
    }
    return null;
  })();

  const userMessageCount = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const lastAssistantHasCitations =
    !!lastAssistant?.metadata?.citations &&
    Array.isArray(lastAssistant.metadata.citations) &&
    lastAssistant.metadata.citations.length > 0;

  const tourSignals: TourSignals = {
    agentId: selectedAgent || null,
    userMessageCount,
    assistantMessageCount: assistantMessages.length,
    lastAssistantHasCitations,
    hasPendingApproval: approvalSignals.pending,
    hasDecidedApproval: approvalSignals.decided,
  };

  return (
    <div className="flex h-[calc(100vh-3rem)] w-full overflow-hidden">
      {/* Mobile sidebar trigger */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <ChatSidebar
            conversations={conversations}
            activeConvo={activeConvo}
            onSelect={(id) => {
              setActiveConvo(id);
              setSidebarOpen(false);
            }}
            onNew={createConversation}
            onDelete={deleteConversation}
          />
        </SheetContent>
      </Sheet>

      {/* Desktop sidebar */}
      <div className="hidden md:flex w-64 flex-col border-r border-border bg-card/50">
        <ChatSidebar
          conversations={conversations}
          activeConvo={activeConvo}
          onSelect={setActiveConvo}
          onNew={createConversation}
          onDelete={deleteConversation}
        />
      </div>

      {/* Main chat area */}
      <div className="flex w-full min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <div className="flex items-center gap-2 border-b border-border/70 bg-background/80 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-nexus-glow text-primary-foreground shadow-sm">
              <Bot className="h-4 w-4" />
            </div>
            <Select
              value={selectedAgent}
              onValueChange={(v) => {
                setSelectedAgent(v);
                setActiveConvo("");
                setMessages([]);
              }}
            >
              <SelectTrigger className="h-9 w-auto min-w-[170px] max-w-[260px] gap-1.5 rounded-lg border-border/70 bg-card/60 px-3 font-semibold shadow-sm hover:bg-card">
                <SelectValue placeholder="Select an agent…" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <div className="flex items-center gap-2">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                      {a.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!selectedAgent && (
              <div
                className="flex animate-pulse items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-600 dark:text-amber-400"
                title="Pick the agent you want to chat with from the dropdown"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden whitespace-nowrap text-[11px] font-medium sm:inline">
                  Pick an agent to begin
                </span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {overrideModel && (
              <Badge
                variant="outline"
                className="cursor-pointer gap-1 hover:bg-muted"
                onClick={() => setOverrideModel(null)}
                title="Click to revert to the agent's default model"
              >
                <Sparkles className="h-3 w-3 text-primary" />
                <span className="max-w-[140px] truncate text-[10px] font-medium">
                  Using {overrideModel.label}
                </span>
              </Badge>
            )}
            <Button
              variant={inspectorOpen ? "secondary" : "ghost"}
              size="sm"
              className="hidden h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground lg:inline-flex"
              onClick={() => setInspectorOpen((v) => !v)}
              title={
                inspectorOpen
                  ? "Hide the developer inspector"
                  : "Show request, tool calls & execution trace"
              }
            >
              {inspectorOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
              <span className="hidden xl:inline">Inspector</span>
              {!inspectorOpen && toolEvents.length > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/20 px-1 text-[9px] font-medium text-primary">
                  {toolEvents.filter((e) => e.type === "tool_call").length}
                </span>
              )}
            </Button>
          </div>
        </div>

        {/* Messages area */}
        <div className="relative flex-1 min-w-0 overflow-hidden bg-gradient-to-b from-muted/20 via-background to-background">
          {/* soft premium glow behind the conversation */}
          <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[36rem] -translate-x-1/2 rounded-full bg-primary/5 blur-3xl" />
          <ScrollArea className="relative h-full w-full [&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]]:!w-full">
            <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-8">
              {messages.length === 0 && !thinking && (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                  <div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-primary to-nexus-glow text-primary-foreground shadow-lg shadow-primary/20">
                    <Bot className="h-8 w-8" />
                  </div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    {currentAgent ? `Chat with ${currentAgent.name}` : "Select an agent to start"}
                  </h2>
                  <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
                    {currentAgent
                      ? "Ask a question, share a task, or try a starter below."
                      : "Choose an agent from the top bar, then send your first message."}
                  </p>
                  {currentAgent && activeConvo && (
                    <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                      {STARTER_PROMPTS.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => {
                            setInput(p);
                            textareaRef.current?.focus();
                          }}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3.5 py-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-card hover:text-foreground"
                        >
                          <Sparkles className="h-3.5 w-3.5 text-primary" />
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  memoryUsed={memoryUsed && memoryUsed.messageId === msg.id ? memoryUsed : null}
                  disabled={thinking}
                  isLastAssistant={!!lastAssistant && msg.id === lastAssistant.id}
                  onEdit={editAndResend}
                  onRegenerate={regenerateResponse}
                  onDelete={deleteMessage}
                />
              ))}

              {thinking && <ThinkingIndicator agent={currentAgent} />}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>

          {/* Guided tour overlay (template-provisioned agents only) */}
          <TemplateTour
            templateId={templateId}
            signals={tourSignals}
            onUseSuggestedPrompt={(p) => setInput(p)}
          />

          {/* Skill-sample tour overlay (sample agents seeded from /skills) */}
          <SkillSampleTour
            agentId={selectedAgent || null}
            skillTourId={
              (currentAgent?.tools as { skillTourId?: string } | undefined)?.skillTourId ?? null
            }
            onUseSuggestedPrompt={(p) => setInput(p)}
          />
        </div>

        {/* Input area */}
        <div className="w-full border-t border-border/70 bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="mx-auto w-full min-w-0 max-w-3xl space-y-2">
            {attachments.length > 0 && (
              <AttachmentChips
                attachments={attachments}
                onRemove={(idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
              />
            )}
            {(armedDoc || docPhase !== "idle") && (
              <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
                {docPhase !== "idle" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    <span className="font-medium text-foreground">
                      Preparing {armedDoc ? DOC_FORMAT_LABEL[armedDoc] : "document"}…
                    </span>
                    <span className="text-muted-foreground">
                      {docPhase === "gathering"
                        ? "analyzing connected data"
                        : docPhase === "planning"
                          ? "planning the document"
                          : "building the file"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-primary">
                      {armedDoc ? DOC_FORMAT_LABEL[armedDoc] : ""} mode
                    </span>
                    <span className="text-muted-foreground">
                      — describe the document below, then press send
                    </span>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      onClick={() => setArmedDoc(null)}
                      title="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="flex w-full min-w-0 items-end gap-2 rounded-2xl border border-border/70 bg-card p-2 shadow-lg shadow-black/5 transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,.pdf,.docx,.txt,.md,.json,.csv"
                className="hidden"
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length === 0) return;
                  await handleFilesPicked(files);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={parsingFiles || thinking}
                title="Attach images or documents"
              >
                {parsingFiles ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </Button>
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={
                  armedDoc
                    ? `Describe the ${DOC_FORMAT_LABEL[armedDoc]} to generate…`
                    : "Type a message... (Shift+Enter for a new line)"
                }
                rows={1}
                className="min-h-0 max-h-[200px] min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent py-1.5 shadow-none focus-visible:ring-0"
                disabled={(!activeConvo && !armedDoc) || thinking || docPhase !== "idle"}
              />
              {thinking ? (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 w-8 p-0"
                  onClick={stopGeneration}
                  title="Stop generating"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 w-8 shrink-0 rounded-xl bg-gradient-to-br from-primary to-nexus-glow p-0 shadow-sm transition hover:opacity-90"
                  onClick={sendMessage}
                  disabled={
                    docPhase !== "idle" ||
                    (armedDoc
                      ? !input.trim()
                      : (!input.trim() && attachments.length === 0) || !activeConvo)
                  }
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
            <DocGenBar
              armed={armedDoc}
              onPick={(f) => {
                const next = armedDoc === f ? null : f;
                setArmedDoc(next);
                // One output per turn. Visual BI answers a data question by
                // returning BEFORE the agent runs, so with a format also armed
                // the turn produced a chart and silently dropped the document
                // that was asked for in the same breath — no file, and no
                // mention that none was made.
                if (next) setBiVisuals(false);
                if (armedDoc !== f) textareaRef.current?.focus();
              }}
              busy={docPhase !== "idle"}
              scope={dataScope}
              onScopeChange={setDataScope}
              mode={docMode}
              onModeChange={setDocMode}
              deepAvailable={deepStatus.available}
              deepReason={deepStatus.reason}
              biControl={
                selectedAgent
                  ? {
                      enabled: biVisuals,
                      onToggle: (next) => {
                        setBiVisuals(next);
                        // The other half of the same rule — see onPick above.
                        if (next) setArmedDoc(null);
                      },
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>

      {/* Right inspector panel — collapsible (default hidden; toggled from the top bar) */}
      {inspectorOpen && (
        <aside className="hidden w-[400px] shrink-0 flex-col border-l border-border/70 bg-card/40 lg:flex">
          <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Code2 className="h-3.5 w-3.5 text-primary" /> Developer inspector
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setInspectorOpen(false)}
              title="Hide inspector"
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <InspectorPanel
              agent={currentAgent}
              thinking={thinking}
              messageCount={messages.length}
              lastExchange={lastExchange}
              toolEvents={toolEvents}
            />
          </div>
        </aside>
      )}

      <ModelFallbackDialog
        open={!!fallbackInfo}
        reason={fallbackInfo?.reason || "error"}
        errorMessage={fallbackInfo?.errorMessage}
        failedProvider={fallbackInfo?.failedProvider}
        failedModel={fallbackInfo?.failedModel}
        onClose={() => setFallbackInfo(null)}
        onPickModel={retryWithModel}
      />
    </div>
  );
}

type LastExchange = {
  requestBody: unknown;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseText: string;
  error?: string;
  startedAt: number;
  durationMs: number | null;
  traceId?: string | null;
};

function InspectorPanel({
  agent,
  thinking,
  messageCount,
  lastExchange,
  toolEvents,
}: {
  agent?: Agent | null;
  thinking: boolean;
  messageCount: number;
  lastExchange: LastExchange | null;
  toolEvents: ToolUiEvent[];
}) {
  return (
    <Tabs defaultValue="exchange" className="flex flex-col h-full">
      <TabsList className="m-2 grid grid-cols-3">
        <TabsTrigger value="exchange" className="text-xs">
          <Code2 className="h-3 w-3 mr-1.5" /> Request
        </TabsTrigger>
        <TabsTrigger value="tools" className="text-xs">
          <Wrench className="h-3 w-3 mr-1.5" /> Tools
          {toolEvents.length > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/20 px-1 text-[9px] text-primary">
              {toolEvents.filter((e) => e.type === "tool_call").length}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="trace" className="text-xs">
          <Activity className="h-3 w-3 mr-1.5" /> Trace
        </TabsTrigger>
      </TabsList>

      <TabsContent value="exchange" className="flex-1 overflow-hidden m-0 px-3 pb-3">
        <RequestResponseInspector exchange={lastExchange} thinking={thinking} />
      </TabsContent>

      <TabsContent value="tools" className="flex-1 overflow-hidden m-0 px-3 pb-3">
        <ToolEventsPanel events={toolEvents} thinking={thinking} />
      </TabsContent>

      <TabsContent value="trace" className="flex-1 overflow-hidden m-0 px-3 pb-3">
        <RealExecutionTrace traceId={lastExchange?.traceId ?? null} thinking={thinking} />
      </TabsContent>
    </Tabs>
  );
}

function ToolEventsPanel({ events, thinking }: { events: ToolUiEvent[]; thinking: boolean }) {
  // Pair tool_call with its matching tool_result by id so the user sees
  // input + output side by side as the loop progresses.
  const calls = events.filter(
    (e): e is Extract<ToolUiEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  const resultsById = new Map(
    events
      .filter((e): e is Extract<ToolUiEvent, { type: "tool_result" }> => e.type === "tool_result")
      .map((r) => [r.id, r]),
  );

  if (events.length === 0) {
    return (
      <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col items-center justify-center text-center p-6">
        <Wrench className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No tool calls yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          {thinking
            ? "Waiting for the model to invoke a tool…"
            : "If the agent uses KB search, web search, n8n, or MCP, calls show up here in real time."}
        </p>
      </div>
    );
  }

  return (
    <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-xs font-semibold flex items-center gap-1.5">
          <Wrench className="h-3 w-3 text-primary" /> Tool Calls
        </p>
        <Badge variant="outline" className="text-[10px]">
          {calls.length} call{calls.length === 1 ? "" : "s"}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {calls.map((c, i) => {
            const r = resultsById.get(c.id);
            const pending = !r;
            const ok = r?.ok ?? false;
            let prettyArgs = c.args;
            try {
              prettyArgs = JSON.stringify(JSON.parse(c.args || "{}"), null, 2);
            } catch {
              /* keep raw */
            }
            return (
              <div
                key={c.id + i}
                className="rounded-md border border-border/60 bg-muted/20 overflow-hidden"
              >
                <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border/60 bg-muted/30">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Wrench className="h-3 w-3 text-primary shrink-0" />
                    <code className="text-[11px] font-mono truncate">{c.name}</code>
                  </div>
                  {pending ? (
                    <Badge
                      variant="outline"
                      className="text-[10px] gap-1 border-amber-400/40 text-amber-400"
                    >
                      <Loader2 className="h-2.5 w-2.5 animate-spin" /> running
                    </Badge>
                  ) : ok ? (
                    <Badge
                      variant="outline"
                      className="text-[10px] gap-1 border-emerald-400/40 text-emerald-400"
                    >
                      <CheckCircle2 className="h-2.5 w-2.5" /> ok
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="text-[10px] gap-1 border-destructive/40 text-destructive"
                    >
                      <AlertTriangle className="h-2.5 w-2.5" /> error
                    </Badge>
                  )}
                </div>
                <div className="p-2 space-y-2">
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
                      Arguments
                    </p>
                    <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-background/40 rounded p-1.5 max-h-32 overflow-auto">
                      {prettyArgs || "(none)"}
                    </pre>
                  </div>
                  {r && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
                        Result preview
                      </p>
                      <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-background/40 rounded p-1.5 max-h-32 overflow-auto">
                        {r.preview || "(empty)"}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a, i) => (
        <div
          key={i}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs max-w-[220px]"
        >
          {a.kind === "image" ? (
            <ImageIcon className="h-3 w-3 text-primary shrink-0" />
          ) : (
            <FileText className="h-3 w-3 text-primary shrink-0" />
          )}
          <span className="truncate">{a.name}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => onRemove(i)}
            aria-label={`Remove ${a.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function RequestResponseInspector({
  exchange,
  thinking,
}: {
  exchange: LastExchange | null;
  thinking: boolean;
}) {
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Copy failed"),
    );
  };

  if (!exchange) {
    return (
      <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col items-center justify-center text-center p-6">
        <Code2 className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No request yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Send a message to inspect the exact HTTP request and response.
        </p>
      </div>
    );
  }

  const isError = !!exchange.error || (exchange.status !== null && exchange.status >= 400);
  const statusClass = isError
    ? "text-destructive border-destructive/40 bg-destructive/10"
    : exchange.status === null
      ? "text-amber-400 border-amber-400/40 bg-amber-400/10"
      : "text-emerald-400 border-emerald-400/40 bg-emerald-400/10";

  const requestJson = JSON.stringify(exchange.requestBody, null, 2);
  const responsePretty = (() => {
    if (!exchange.responseText) return "";
    try {
      const parsed = JSON.parse(exchange.responseText);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return exchange.responseText;
    }
  })();

  return (
    <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="outline" className={`text-[10px] font-mono ${statusClass}`}>
            {exchange.error ? (
              <>
                <AlertTriangle className="h-3 w-3 mr-1" /> ERROR
              </>
            ) : exchange.status === null ? (
              <>… streaming</>
            ) : (
              <>
                <CheckCircle2 className="h-3 w-3 mr-1" /> {exchange.status}
              </>
            )}
          </Badge>
          {exchange.durationMs !== null && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {exchange.durationMs} ms
            </span>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground font-mono truncate">POST /api/chat</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {exchange.error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5">
              <p className="text-[11px] font-semibold text-destructive flex items-center gap-1.5 mb-1">
                <AlertTriangle className="h-3 w-3" /> Error
              </p>
              <p className="text-xs text-destructive font-mono break-all">{exchange.error}</p>
            </div>
          )}

          <section>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <ArrowUpRight className="h-3 w-3 text-primary" /> Request body
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => copy(requestJson)}
              >
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
            </div>
            <pre className="rounded-md border border-border bg-muted/30 p-2.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all max-h-64 overflow-auto">
              {requestJson}
            </pre>
          </section>

          <section>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <ArrowDownLeft className="h-3 w-3 text-nexus-glow" /> Response
                {thinking && (
                  <span className="text-[9px] text-amber-400 animate-pulse">streaming…</span>
                )}
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => copy(responsePretty || "")}
                disabled={!responsePretty}
              >
                <Copy className="h-3 w-3 mr-1" /> Copy
              </Button>
            </div>
            <pre className="rounded-md border border-border bg-muted/30 p-2.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all max-h-[40vh] overflow-auto">
              {responsePretty || (thinking ? "Waiting for first byte…" : "(empty)")}
            </pre>
          </section>

          {Object.keys(exchange.responseHeaders).length > 0 && (
            <section>
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Response headers
              </p>
              <div className="rounded-md border border-border bg-muted/20 p-2 text-[10px] font-mono space-y-0.5">
                {Object.entries(exchange.responseHeaders).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">{k}:</span>
                    <span className="text-foreground/80 break-all">{v}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

type TraceRow = {
  id: string;
  agent_name: string;
  llm_provider: string;
  llm_model: string;
  status: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error_message: string | null;
  request_payload: any;
  response_payload: any;
  tool_calls: any;
  created_at: string;
};

function RealExecutionTrace({ traceId, thinking }: { traceId: string | null; thinking: boolean }) {
  const [trace, setTrace] = useState<TraceRow | null>(null);
  const [loading, setLoading] = useState(false);

  // Poll the execution_traces table by trace_id (set as the row's `id`).
  // The chat route generates the UUID and writes the row when the LLM call
  // settles, so we may need a couple of attempts before the row appears.
  useEffect(() => {
    if (!traceId) {
      setTrace(null);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    setLoading(true);
    setTrace(null);

    const tick = async () => {
      attempts += 1;
      const { data } = await supabase
        .from("execution_traces")
        .select("*")
        .eq("id", traceId)
        .maybeSingle();
      if (cancelled) return;
      if (data) {
        setTrace(data as TraceRow);
        setLoading(false);
        return;
      }
      if (attempts < 8) {
        setTimeout(tick, 750);
      } else {
        setLoading(false);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  if (!traceId && !thinking) {
    return (
      <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col items-center justify-center text-center p-6">
        <Activity className="h-8 w-8 text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No trace yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Send a message to see the real execution trace recorded in the database.
        </p>
      </div>
    );
  }

  if ((thinking && !trace) || (loading && !trace)) {
    return (
      <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col items-center justify-center text-center p-6">
        <Activity className="h-8 w-8 text-primary/60 mb-3 animate-pulse" />
        <p className="text-sm font-medium text-muted-foreground">Recording trace…</p>
        <p className="text-xs text-muted-foreground/70 mt-1 font-mono break-all">{traceId}</p>
      </div>
    );
  }

  if (!trace) {
    return (
      <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col items-center justify-center text-center p-6">
        <AlertTriangle className="h-8 w-8 text-amber-400/70 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Trace not recorded</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          The request may have failed before the trace row was written.
        </p>
      </div>
    );
  }

  const isError = trace.status !== "success";
  const toolCalls: any[] = Array.isArray(trace.tool_calls) ? trace.tool_calls : [];

  return (
    <div className="h-full rounded-lg border border-border bg-background/60 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-xs font-semibold flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-primary" /> Execution Trace
        </p>
        <Badge
          variant="outline"
          className={
            isError
              ? "text-[10px] text-destructive border-destructive/40"
              : "text-[10px] text-emerald-400 border-emerald-400/40"
          }
        >
          {isError ? (
            <AlertTriangle className="h-2.5 w-2.5 mr-1" />
          ) : (
            <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
          )}
          {trace.status}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Latency" value={`${trace.latency_ms} ms`} />
            <Stat label="Cost" value={`$${Number(trace.cost_usd).toFixed(6)}`} />
            <Stat label="Tokens in" value={String(trace.tokens_in)} />
            <Stat label="Tokens out" value={String(trace.tokens_out)} />
          </div>

          <div className="rounded-md border border-border/60 bg-muted/20 p-2 space-y-1">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">
              Model
            </p>
            <p className="font-mono text-[11px] break-all">
              {trace.llm_provider} · {trace.llm_model}
            </p>
          </div>

          {trace.error_message && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <p className="text-[10px] font-semibold uppercase text-destructive tracking-wide mb-1">
                Error
              </p>
              <p className="font-mono text-[11px] text-destructive/90 break-all">
                {trace.error_message}
              </p>
            </div>
          )}

          {toolCalls.length > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-2 space-y-1">
              <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide">
                Tool calls ({toolCalls.length})
              </p>
              <ul className="space-y-1 font-mono text-[11px]">
                {toolCalls.map((tc, i) => (
                  <li key={i} className="text-foreground/80 truncate">
                    {tc?.name || tc?.function?.name || "tool"}
                    {tc?.arguments ? (
                      <span className="text-muted-foreground">
                        {" "}
                        · {String(tc.arguments).slice(0, 60)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-md border border-border/60 bg-muted/20 p-2">
            <p className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wide mb-1">
              Trace ID
            </p>
            <p className="font-mono text-[10px] text-muted-foreground break-all">{trace.id}</p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-2">
      <p className="text-[10px] uppercase text-muted-foreground tracking-wide">{label}</p>
      <p className="font-mono text-[11px] text-foreground/90">{value}</p>
    </div>
  );
}

function ChatSidebar({
  conversations,
  activeConvo,
  onSelect,
  onNew,
  onDelete,
}: {
  conversations: Conversation[];
  activeConvo: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <Button variant="outline" size="sm" className="w-full" onClick={onNew}>
          <Plus className="h-3 w-3 mr-1" /> New Chat
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-2 rounded-md py-1 pl-3 pr-1 text-sm cursor-pointer transition-colors ${
                activeConvo === c.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <span className="min-w-0 truncate" title={c.title}>
                {c.title}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete ${c.title}`}
                title="Delete chat"
                className="h-8 w-8 shrink-0 rounded-md border border-border/60 bg-background/80 p-0 text-destructive opacity-100 shadow-sm hover:bg-destructive hover:text-destructive-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function MessageBubble({
  message,
  memoryUsed,
  disabled,
  isLastAssistant,
  onEdit,
  onRegenerate,
  onDelete,
}: {
  message: Message;
  memoryUsed?: {
    items: Array<{ id: string; kind: string; content: string; matchScore?: number }>;
    summaryUsed: boolean;
  } | null;
  disabled?: boolean;
  isLastAssistant?: boolean;
  onEdit?: (id: string, newContent: string) => void;
  onRegenerate?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const citations: Citation[] = Array.isArray(message.metadata?.citations)
    ? (message.metadata.citations as Citation[])
    : [];
  // Messages saved before sources existed only carry KB citations; show those
  // rather than dropping attribution on old conversations.
  const sources: Source[] = Array.isArray(message.metadata?.sources)
    ? (message.metadata.sources as Source[])
    : citations.map((c) => ({
        index: c.index,
        kind: "kb" as const,
        title: c.documentName,
        detail: c.knowledgeBaseName,
        snippet: c.snippet,
      }));
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — clipboard unavailable");
    }
  }

  function startEdit() {
    setDraft(message.content);
    setEditing(true);
  }

  function saveEdit() {
    if (!draft.trim() || draft.trim() === message.content.trim()) {
      setEditing(false);
      return;
    }
    onEdit?.(message.id, draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex gap-3">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-slate-500 to-slate-700 text-white shadow-sm">
          <User className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            rows={3}
            className="text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveEdit();
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" onClick={saveEdit}>
              Save &amp; resend
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex gap-3">
      <div
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white shadow-sm ${
          isUser
            ? "bg-gradient-to-br from-slate-500 to-slate-700"
            : "bg-gradient-to-br from-primary to-nexus-glow"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {isUser ? "You" : "Assistant"}
          </p>
          {/* Hover-revealed action row — hidden while a response is streaming
              so actions can't target a message mid-turn. */}
          {!disabled && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={handleCopy}
                title="Copy"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </button>
              {isUser && onEdit && (
                <button
                  type="button"
                  onClick={startEdit}
                  title="Edit &amp; resend"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {!isUser && isLastAssistant && onRegenerate && (
                <button
                  type="button"
                  onClick={() => onRegenerate(message.id)}
                  title="Regenerate response"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(message.id)}
                  title="Delete"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {message.content}
          </p>
        ) : (
          <div className="min-w-0 overflow-hidden">
            <MarkdownMessage content={message.content} />
          </div>
        )}
        {!isUser && memoryUsed && (memoryUsed.items.length > 0 || memoryUsed.summaryUsed) && (
          <MemoryChip items={memoryUsed.items} summaryUsed={memoryUsed.summaryUsed} />
        )}
        {!isUser && sources.length > 0 && <Sources sources={sources} />}
        {!isUser &&
          (() => {
            const widgets = parseWidgets(message.metadata?.widgets ?? []).filter(
              (w) => w.kind === "chart" && (w.rows?.length ?? 0) > 0,
            );
            return widgets.length > 0 ? (
              <div className="mt-3 space-y-3">
                {widgets.map((w) => (
                  <div key={w.id} className="h-72 max-w-2xl">
                    <BiWidgetCard widget={w} />
                  </div>
                ))}
              </div>
            ) : null;
          })()}
        {!isUser && message.metadata?.doc ? (
          <DocResultCard doc={message.metadata.doc as unknown as DocResultMeta} />
        ) : null}
      </div>
    </div>
  );
}

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Build a PPTX: fill data + pre-render diagrams once, try the optional
// server-side python-pptx renderer (native editable + render-verify), and fall
// back to the in-browser pptxgenjs builder when it isn't configured/reachable.
// One-time notice when Deep mode silently falls back to the browser build.
function notifyDeepFallback() {
  // Has to be loud: the fallback file is byte-for-byte what Fast produces, so
  // an info toast reads as "fine" to someone wondering why Deep changed nothing.
  toast.warning("Deep mode unavailable — built in the browser instead", {
    description:
      "This document is identical to Browser · fast. Start the renderer with `docker compose --profile docgen up -d --build`.",
    duration: 12000,
  });
}

async function buildPptxDoc(
  plan: PptxPlan,
  fileBase: string,
  token: string,
  mode: DocGenMode,
  model?: string,
): Promise<BuiltDoc> {
  // The BI analyst that fills charts with real figures is a second LLM path —
  // it needs the same model, or planning succeeds and every chart still fails.
  const fill = await materializePptxWithBI(plan, { model });
  // A deck where half the queries failed looked identical to one where they all
  // worked — the slides just quietly lost their charts.
  if (fill.visuals > 0 && fill.filled < fill.visuals) {
    toast.warning(`${fill.filled} of ${fill.visuals} visuals could be filled with your data`, {
      description:
        "The rest could not be answered from the connected tables — those slides fall back to text or a table.",
      duration: 9000,
    });
  }
  attachDiagramSvgs(plan);
  if (mode === "deep") {
    try {
      const resp = await fetch("/api/docgen/pptx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan, verify: true }),
      });
      if (resp.ok) {
        const j = (await resp.json()) as { pptx_base64?: string; thumb?: string };
        if (j.pptx_base64) {
          return {
            blob: b64ToBlob(
              j.pptx_base64,
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
            filename: fileBase.toLowerCase().endsWith(".pptx") ? fileBase : `${fileBase}.pptx`,
            thumb: j.thumb || pptxThumbUri(plan),
          };
        }
      }
      // 501 not_configured or any non-OK → in-browser build below.
    } catch {
      /* network error → in-browser build below */
    }
    notifyDeepFallback();
  }
  return buildPptx(plan, fileBase, { skipMaterialize: true });
}

// Deep mode: the server-side python-docx renderer (multi-page, real TOC,
// fixed-width tables); falls back to the in-browser `docx` builder.
async function buildDocxDoc(
  plan: DocxPlan,
  fileBase: string,
  token: string,
  mode: DocGenMode,
): Promise<BuiltDoc> {
  if (mode === "deep") {
    try {
      const resp = await fetch("/api/docgen/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      if (resp.ok) {
        const j = (await resp.json()) as { docx_base64?: string; thumb?: string };
        if (j.docx_base64) {
          return {
            blob: b64ToBlob(
              j.docx_base64,
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            filename: fileBase.toLowerCase().endsWith(".docx") ? fileBase : `${fileBase}.docx`,
            thumb: j.thumb || docxThumbUri(plan),
          };
        }
      }
    } catch {
      /* network error → in-browser build below */
    }
    notifyDeepFallback();
  }
  return buildDocx(plan, fileBase);
}

// Deep mode: the server-side openpyxl renderer (formulas recalculated by
// LibreOffice so values are cached); falls back to the in-browser
// write-excel-file builder. The plan is already materialized (data-bound
// sheets → literal rows + formula cells), so both paths get identical inputs.
async function buildXlsxDoc(
  plan: MaterializedXlsxPlan,
  fileBase: string,
  token: string,
  mode: DocGenMode,
): Promise<BuiltDoc> {
  if (mode === "deep") {
    try {
      const resp = await fetch("/api/docgen/xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      if (resp.ok) {
        const j = (await resp.json()) as { xlsx_base64?: string; thumb?: string };
        if (j.xlsx_base64) {
          return {
            blob: b64ToBlob(
              j.xlsx_base64,
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            filename: fileBase.toLowerCase().endsWith(".xlsx") ? fileBase : `${fileBase}.xlsx`,
            thumb: j.thumb || xlsxThumbUri(plan),
          };
        }
      }
    } catch {
      /* network error → in-browser build below */
    }
    notifyDeepFallback();
  }
  return buildXlsx(plan, fileBase);
}

type DocResultMeta = {
  format: DocFormat;
  filename: string;
  thumb: string;
  /** Session-only object URL (present right after generation). */
  url?: string;
  /** Path in the private `chat-docs` bucket — used to mint a signed URL after reload. */
  path?: string;
};

const DOC_MIME: Record<DocFormat, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function DocResultCard({ doc }: { doc: DocResultMeta }) {
  const Icon = doc.format === "pptx" ? PptIcon : doc.format === "xlsx" ? ExcelIcon : WordIcon;
  const [busy, setBusy] = useState(false);
  const trigger = (href: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = doc.filename;
    a.click();
  };
  const onDownload = async () => {
    if (doc.url) {
      trigger(doc.url);
      return;
    }
    // Reloaded session: fetch a short-lived signed URL for the stored file.
    if (doc.path) {
      setBusy(true);
      try {
        const { data, error } = await supabase.storage
          .from("chat-docs")
          .createSignedUrl(doc.path, 300, { download: doc.filename });
        if (error || !data?.signedUrl) throw error ?? new Error("no url");
        trigger(data.signedUrl);
      } catch {
        toast.error("This document has expired or is no longer available.");
      } finally {
        setBusy(false);
      }
    }
  };
  const canDownload = !!doc.url || !!doc.path;
  return (
    <div className="mt-3 w-full max-w-sm overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      {doc.thumb && (
        <img
          src={doc.thumb}
          alt={doc.filename}
          className="block w-full border-b border-border/60 bg-muted/30"
        />
      )}
      <div className="flex items-center gap-2 p-2.5">
        <Icon className="h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{doc.filename}</p>
          <p className="text-[11px] text-muted-foreground">
            {DOC_FORMAT_LABEL[doc.format]} · ready
          </p>
        </div>
        {canDownload ? (
          <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={onDownload} disabled={busy}>
            <Download className="h-3.5 w-3.5" /> {busy ? "Preparing…" : "Download"}
          </Button>
        ) : (
          <span className="text-[11px] text-muted-foreground">Regenerate to download</span>
        )}
      </div>
    </div>
  );
}

function MemoryChip({
  items,
  summaryUsed,
}: {
  items: Array<{ id: string; kind: string; content: string; matchScore?: number }>;
  summaryUsed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = items.length;
  return (
    <div className="mt-2 inline-flex flex-col gap-1.5 max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors w-fit"
        title="What the agent remembered for this turn"
      >
        <Sparkles className="h-3 w-3" />
        {count > 0 ? `Memory: ${count} item${count === 1 ? "" : "s"} recalled` : "Memory used"}
        {summaryUsed && <span className="opacity-70">+ summary</span>}
      </button>
      {open && count > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-2 max-w-md">
          <ol className="space-y-1.5">
            {items.slice(0, 8).map((it, i) => (
              <li key={it.id || i} className="text-[11px] flex gap-2">
                <span className="shrink-0 inline-flex items-center justify-center rounded bg-primary/10 text-primary font-mono text-[9px] px-1 h-4">
                  {it.kind}
                </span>
                <span className="text-muted-foreground line-clamp-2">{it.content}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// Per-kind presentation. The label is what the reader needs in order to judge
// the answer: a web result is only useful if you can click it, a document is
// only meaningful next to its collection, an MCP call next to its server.
const SOURCE_KIND_META: Record<
  SourceKind,
  { icon: typeof BookOpen; label: string; className: string }
> = {
  web: { icon: Globe, label: "Web", className: "text-sky-600 dark:text-sky-400" },
  kb: { icon: BookOpen, label: "Knowledge base", className: "text-primary" },
  table: { icon: Table2, label: "Data", className: "text-emerald-600 dark:text-emerald-400" },
  mcp: { icon: Plug, label: "MCP", className: "text-violet-600 dark:text-violet-400" },
  tool: { icon: Wrench, label: "Tool", className: "text-amber-600 dark:text-amber-400" },
};

const SOURCE_KIND_ORDER: SourceKind[] = ["web", "kb", "table", "mcp", "tool"];

function Sources({ sources }: { sources: Source[] }) {
  // Grouped by kind so several kinds can appear together without reading as one
  // undifferentiated list — the answer says which parts came from where.
  const groups = SOURCE_KIND_ORDER.map((kind) => ({
    kind,
    items: sources.filter((s) => s.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-2">
        <BookOpen className="h-3 w-3 text-primary" />
        Sources ({sources.length})
      </p>
      <div className="space-y-3">
        {groups.map((group) => {
          const meta = SOURCE_KIND_META[group.kind];
          const Icon = meta.icon;
          return (
            <div key={group.kind}>
              {groups.length > 1 && (
                <p className="text-[10px] font-medium text-muted-foreground/80 uppercase tracking-wide flex items-center gap-1 mb-1.5">
                  <Icon className={`h-3 w-3 ${meta.className}`} />
                  {meta.label}
                </p>
              )}
              <ol className="space-y-2">
                {group.items.map((s) => (
                  <li key={`${s.kind}-${s.index}`} className="text-xs flex gap-2">
                    <span className="shrink-0 inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/10 text-primary font-mono text-[10px] px-1">
                      {s.index}
                    </span>
                    <div className="min-w-0 flex-1">
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-foreground/90 hover:text-primary hover:underline inline-flex items-center gap-1 max-w-full"
                        >
                          <span className="truncate">{s.title}</span>
                          <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                        </a>
                      ) : (
                        <p className="font-medium text-foreground/90 truncate">{s.title}</p>
                      )}
                      {s.detail && (
                        <p className="text-[10px] text-muted-foreground mb-1">{s.detail}</p>
                      )}
                      {s.snippet && (
                        <p className="text-muted-foreground line-clamp-3">{s.snippet}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThinkingIndicator({ agent }: { agent?: Agent | null }) {
  return (
    <div className="flex gap-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-nexus-glow text-white shadow-sm">
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex gap-1">
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary" />
          <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        <span className="text-xs">{agent?.name || "Agent"} is thinking...</span>
      </div>
    </div>
  );
}
