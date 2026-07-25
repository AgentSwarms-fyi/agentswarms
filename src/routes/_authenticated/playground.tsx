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
  PanelLeftOpen,
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
} from "lucide-react";
import { parseFileToText } from "@/lib/fileParsers";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { DocGenBar } from "@/components/playground/DocGenBar";
import { BiWidgetCard } from "@/components/bi/BiWidgetCard";
import { generateChatWidget } from "@/lib/chatBi";
import { parseWidgets } from "@/lib/biDashboards";
import type { DocScope } from "@/lib/docGen/types";
import { toast } from "sonner";
import {
  ModelFallbackDialog,
  type FallbackChoice,
} from "@/components/playground/ModelFallbackDialog";
import { TemplateTour, type TourSignals } from "@/components/playground/TemplateTour";
import { SkillSampleTour } from "@/components/playground/SkillSampleTour";
import { ensureSampleAgentsForUser } from "@/lib/sampleAgentsWithSkills";

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
  const dataScopeRef = useRef<DocScope>("sample");
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
          await ensureSampleAgentsForUser();
          try {
            sessionStorage.setItem(seedFlag, "1");
          } catch {
            /* ignore */
          }
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
    let respHeaders: Record<string, string> = {};
    let traceId: string | null = null;

    try {
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
      let streamDone = false;
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

      while (!streamDone) {
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
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            if (currentEvent === "citations") {
              if (Array.isArray(parsed?.citations)) applyCitations(parsed.citations as Citation[]);
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
          metadata: citations.length > 0 ? { citations } : {},
        })
        .select("id")
        .single();
      if (insertedAssistant?.id) {
        dbIdMap.current.set(assistantId, insertedAssistant.id);
      }

      // Visual BI answer: when the agent has it on, generate a data widget from
      // the user's question and attach it to the assistant message (state + DB),
      // so it renders inline and survives reload/embed. Best-effort — never
      // affects the text answer.
      if (biVisualsRef.current && assistantContent) {
        const question =
          [...opts.historySnapshot].reverse().find((m) => m.role === "user")?.content ?? "";
        if (question) {
          void generateChatWidget(question, { scope: dataScopeRef.current }).then((widget) => {
            if (!widget) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, metadata: { ...(m.metadata ?? {}), widgets: [widget] } }
                  : m,
              ),
            );
            const dbId = insertedAssistant?.id;
            if (dbId) {
              void supabase
                .from("messages")
                .update({
                  metadata: {
                    ...(citations.length > 0 ? { citations } : {}),
                    widgets: [widget],
                  } as unknown as Json,
                })
                .eq("id", dbId);
            }
          });
        }
      }

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
              metadata: citations.length > 0 ? { citations } : {},
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

  async function sendMessage() {
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
        {/* Top bar with agent selector */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <div className="flex-1 flex justify-center items-center gap-2">
            <Select
              value={selectedAgent}
              onValueChange={(v) => {
                setSelectedAgent(v);
                setActiveConvo("");
                setMessages([]);
              }}
            >
              <SelectTrigger className="w-64 border-none bg-transparent text-center font-medium">
                <SelectValue placeholder="Select an agent..." />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <div className="flex items-center gap-2">
                      <Bot className="h-3 w-3" />
                      {a.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!selectedAgent && (
              <div
                className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-amber-600 dark:text-amber-400 animate-pulse"
                title="Pick the agent you want to chat with from the dropdown"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline text-[11px] font-medium whitespace-nowrap">
                  ← Pick the right agent first
                </span>
              </div>
            )}
          </div>
          {overrideModel ? (
            <Badge
              variant="outline"
              className="gap-1 cursor-pointer hover:bg-muted"
              onClick={() => setOverrideModel(null)}
              title="Click to revert to the agent's default model"
            >
              <Sparkles className="h-3 w-3 text-primary" />
              <span className="text-[10px] font-medium truncate max-w-[140px]">
                Using {overrideModel.label}
              </span>
            </Badge>
          ) : (
            <div className="w-10" />
          )}
        </div>

        {/* Messages area */}
        <div className="relative flex-1 min-w-0 overflow-hidden">
          <ScrollArea className="h-full w-full px-4 lg:px-6 [&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]]:!w-full">
            <div className="w-full max-w-full min-w-0 py-6 space-y-6 pr-2">
              {messages.length === 0 && !thinking && (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <Bot className="mb-4 h-16 w-16 text-muted-foreground/30" />
                  <h2 className="text-xl font-semibold text-muted-foreground">
                    {currentAgent ? `Chat with ${currentAgent.name}` : "Select an agent to start"}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground/70">
                    Send a message to begin the conversation.
                  </p>
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
        <div className="w-full border-t border-border p-4">
          <div className="w-full min-w-0 space-y-2">
            {attachments.length > 0 && (
              <AttachmentChips
                attachments={attachments}
                onRemove={(idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
              />
            )}
            <div className="flex w-full min-w-0 items-end gap-2 rounded-xl border border-border bg-card p-2">
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
                placeholder="Type a message... (Shift+Enter for a new line)"
                rows={1}
                className="min-h-0 max-h-[200px] min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent py-1.5 shadow-none focus-visible:ring-0"
                disabled={!activeConvo || thinking}
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
                  className="h-8 w-8 p-0"
                  onClick={sendMessage}
                  disabled={(!input.trim() && attachments.length === 0) || !activeConvo}
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
            <DocGenBar
              agentId={selectedAgent || undefined}
              defaultPrompt={input}
              conversation={messages.map((m) => ({
                role: m.role === "user" ? "user" : "assistant",
                content: m.content,
              }))}
              scope={dataScope}
              onScopeChange={setDataScope}
              biControl={selectedAgent ? { enabled: biVisuals, onToggle: setBiVisuals } : undefined}
            />
          </div>
        </div>
      </div>

      {/* Right inspector panel */}
      <aside className="hidden lg:flex w-[420px] shrink-0 flex-col border-l border-border bg-card/40">
        <InspectorPanel
          agent={currentAgent}
          thinking={thinking}
          messageCount={messages.length}
          lastExchange={lastExchange}
          toolEvents={toolEvents}
        />
      </aside>

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
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <User className="h-3.5 w-3.5 text-primary" />
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
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isUser ? "bg-primary/10" : "bg-nexus-glow/15"
        }`}
      >
        {isUser ? (
          <User className="h-3.5 w-3.5 text-primary" />
        ) : (
          <Bot className="h-3.5 w-3.5 text-nexus-glow" />
        )}
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
        {!isUser && citations.length > 0 && <Citations citations={citations} />}
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

function Citations({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-2">
        <BookOpen className="h-3 w-3 text-primary" />
        Sources ({citations.length})
      </p>
      <ol className="space-y-2">
        {citations.map((c) => (
          <li key={c.index} className="text-xs flex gap-2">
            <span className="shrink-0 inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/10 text-primary font-mono text-[10px] px-1">
              {c.index}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground/90 truncate">{c.documentName}</p>
              <p className="text-[10px] text-muted-foreground mb-1">{c.knowledgeBaseName}</p>
              <p className="text-muted-foreground line-clamp-3">{c.snippet}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ThinkingIndicator({ agent }: { agent?: Agent | null }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nexus-glow/15">
        <Bot className="h-3.5 w-3.5 text-nexus-glow" />
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
