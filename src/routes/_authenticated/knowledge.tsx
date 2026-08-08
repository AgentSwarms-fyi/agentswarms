import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { parseFileToText } from "@/lib/fileParsers";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  BookOpen,
  Plus,
  Trash2,
  FileText,
  Database,
  Settings2,
  Layers,
  UploadCloud,
  X,
  Loader2,
  AlertCircle,
  Globe,
  GitBranch,
  RefreshCw,
  Edit3,
  Eye,
  Download,
  Cloud,
  Clock,
  Lock,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AddSourceDialog } from "@/components/knowledge/AddSourceDialog";
import { ConnectSourceDialog } from "@/components/knowledge/ConnectSourceDialog";
import { KnowledgeGraphTab } from "@/components/knowledge/KnowledgeGraphTab";
import {
  embedKbDocuments,
  backfillKbEmbeddings,
  kbEmbedStatus,
} from "@/utils/tools/kbEmbed.functions";
import { formatDistanceToNow } from "date-fns";
import { Slider } from "@/components/ui/slider";
import { type ChunkMode, type RetrievalMode, resolveRetrievalSettings } from "@/lib/kbRag";

export const Route = createFileRoute("/_authenticated/knowledge")({
  component: KnowledgePage,
  validateSearch: (s: Record<string, unknown>) => {
    const out: { new?: 1 } = {};
    if (s.new === 1 || s.new === "1") out.new = 1;
    return out;
  },
});

type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  is_sample?: boolean;
  user_id?: string | null;
};
type KnowledgeDoc = {
  id: string;
  name: string;
  content: string | null;
  created_at: string;
  metadata?: any;
  source_id?: string | null;
};
type KbSource = {
  id: string;
  knowledge_base_id: string;
  kind: "manual" | "pdf" | "csv" | "url" | "github" | ConnectorKind | string;
  label: string | null;
  status: "idle" | "syncing" | "ok" | "error" | "embedding_failed" | string;
  config: Record<string, unknown>;
  last_synced_at: string | null;
  error: string | null;
  is_sample: boolean;
  created_at: string;
  sync_schedule: string;
  next_sync_at: string | null;
  access_scope: string;
  last_sync_stats: {
    listed?: number;
    added?: number;
    updated?: number;
    unchanged?: number;
    removed?: number;
    skipped?: { name: string; reason: string }[];
    acl_unavailable?: number;
  } | null;
};

type ConnectorKind = "gdrive" | "notion" | "sharepoint" | "dropbox";
const CONNECTOR_KINDS = new Set<string>(["gdrive", "notion", "sharepoint", "dropbox"]);
const CONNECTOR_LABELS: Record<ConnectorKind, string> = {
  gdrive: "Google Drive",
  notion: "Notion",
  sharepoint: "SharePoint",
  dropbox: "Dropbox",
};

// Vector store providers. The built-in store uses pgvector (1536-dim
// embeddings via OpenAI's text-embedding-3-small, HNSW cosine index).
// Documents that haven't been embedded yet fall back to a keyword scan
// during retrieval so existing data keeps working.
type VectorStoreField = {
  key: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
};
type VectorStoreDef = {
  id: string;
  name: string;
  description: string;
  fields: VectorStoreField[];
};
const VECTOR_STORES: VectorStoreDef[] = [
  {
    id: "local",
    name: "Supabase pgvector (default — configured)",
    description:
      "Documents are chunked and embedded with the embedding model you select above (OpenAI or Google), truncated to 1536 dims via Matryoshka so all models share one pgvector column with an HNSW cosine index. Retrieval embeds the query with the same model and runs semantic similarity search; any document that hasn't been embedded yet falls back to a keyword scan so nothing goes silent during back-fill.",
    fields: [],
  },
];

// Embedding models available via the server's OPENAI_API_KEY. Both are
// truncated to 1536 dims via Matryoshka so they land in the same kb_chunks
// vector space and stay searchable side-by-side. Selecting a different
// model on an existing KB requires a Re-index.
type EmbeddingModelDef = { value: string; label: string; provider: string };
const ALL_EMBEDDING_MODELS: EmbeddingModelDef[] = [
  {
    value: "text-embedding-3-small",
    label: "OpenAI text-embedding-3-small (1536d) — Built-in",
    provider: "openai_builtin",
  },
  {
    value: "text-embedding-3-large",
    label: "OpenAI text-embedding-3-large (→1536d) — Built-in",
    provider: "openai_builtin",
  },
  {
    value: "openai/text-embedding-3-small",
    label: "OpenAI text-embedding-3-small (1536d) — via OpenRouter",
    provider: "openrouter",
  },
  {
    value: "openai/text-embedding-3-large",
    label: "OpenAI text-embedding-3-large (→1536d) — via OpenRouter",
    provider: "openrouter",
  },
  {
    value: "google/gemini-embedding-001",
    label: "Gemini embedding-001 (→1536d) — via OpenRouter",
    provider: "openrouter",
  },
  {
    value: "qwen/qwen3-embedding-8b",
    label: "Qwen3 embedding 8B (→1536d) — via OpenRouter",
    provider: "openrouter",
  },
];

// Providers whose integrations expose an OpenAI-compatible /embeddings
// endpoint. "openai_builtin" = the operator's OPENAI_API_KEY (zero config).
// OpenRouter embedding models, every one probed against the live endpoint and
// confirmed to return 1536 dimensions — the width of the pgvector column.
//
// text-embedding-3-small leads deliberately: it is the same vector space the
// built-in OpenAI key produces, so moving a collection between the two does NOT
// invalidate chunks that are already embedded. The others are different spaces
// and selecting one means a re-index.
//
// Two nvidia/* models used to be listed here and both returned 404 "No
// endpoints found". Only add a model to this list after calling /embeddings
// with it: OpenRouter does not expose embedding models in its /models
// catalogue, so a plausible-looking id is not evidence that it exists.
const OPENROUTER_EMBED_MODELS = [
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  "google/gemini-embedding-001",
  "qwen/qwen3-embedding-8b",
  "qwen/qwen3-embedding-4b",
];

const EMBED_PROVIDERS: { id: string; label: string; models: string[] }[] = [
  {
    id: "openai_builtin",
    label: "Built-in (operator OpenAI key)",
    models: ["text-embedding-3-small", "text-embedding-3-large"],
  },
  {
    id: "openai",
    label: "OpenAI (your integration)",
    models: ["text-embedding-3-small", "text-embedding-3-large"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    models: OPENROUTER_EMBED_MODELS,
  },
  // Notionally alphabetical below; OpenRouter sits high because it is the
  // default when connected (see DEFAULT_EMBED_PROVIDER).
  { id: "gemini", label: "Google Gemini", models: ["gemini-embedding-001"] },
  { id: "ollama", label: "Ollama", models: ["nomic-embed-text", "mxbai-embed-large"] },
  { id: "vllm", label: "vLLM", models: [] },
  { id: "nvidia", label: "NVIDIA NIM", models: ["nvidia/nv-embed-v1"] },
  { id: "qwen", label: "Qwen", models: ["text-embedding-v3"] },
];

/**
 * Preferred embedding provider when the user has it connected.
 *
 * OpenRouter rather than the operator's OpenAI key: it is the provider an
 * instance most likely already has credentials for, and it keeps embedding off
 * the OpenAI quota that chat, doc generation and retrieval otherwise share —
 * a quota that, once exhausted, takes knowledge-base search down with it.
 */
const DEFAULT_EMBED_PROVIDER = "openrouter";

const CHUNKING_STRATEGIES = [
  { value: "fixed", label: "Fixed Size" },
  { value: "sentence", label: "Sentence-based" },
  { value: "paragraph", label: "Paragraph-based" },
  { value: "semantic", label: "Semantic Chunking" },
  { value: "recursive", label: "Recursive Character" },
];

function KnowledgePage() {
  const { user } = useAuth();
  const embedFn = useServerFn(embedKbDocuments);
  const embedStatusFn = useServerFn(kbEmbedStatus);
  const backfillFn = useServerFn(backfillKbEmbeddings);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedBase, setSelectedBase] = useState<KnowledgeBase | null>(null);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [sources, setSources] = useState<KbSource[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [editingConnector, setEditingConnector] = useState<KbSource | null>(null);
  const [resyncingId, setResyncingId] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<KnowledgeDoc | null>(null);
  // Per-document indexing status, derived from kb_chunks. Map docId → chunk count.
  const [chunkCounts, setChunkCounts] = useState<Map<string, number>>(new Map());
  const [backfilling, setBackfilling] = useState(false);

  // Open the Create dialog when navigated to with ?new=1 (Global "+" menu).
  useEffect(() => {
    if (search.new === 1) {
      setCreateOpen(true);
      navigate({ search: {}, replace: true });
    }
  }, [search.new, navigate]);

  // Create form
  const [newBaseName, setNewBaseName] = useState("");
  const [newBaseDesc, setNewBaseDesc] = useState("");

  // Doc form
  const [docName, setDocName] = useState("");
  const [docContent, setDocContent] = useState("");

  // Vector store settings
  const [vectorStore, setVectorStore] = useState("local");
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embedProvider, setEmbedProvider] = useState("openai_builtin");
  // Set once the user picks a provider, so the auto-default stops interfering.
  const [embedProviderTouched, setEmbedProviderTouched] = useState(false);
  const [builtinConfigured, setBuiltinConfigured] = useState<boolean | null>(null);
  const [openrouterAvailable, setOpenrouterAvailable] = useState<boolean | null>(null);
  const [customEmbedModel, setCustomEmbedModel] = useState("");
  const [chunkStrategy, setChunkStrategy] = useState("recursive");
  const [chunkSize, setChunkSize] = useState(512);
  const [chunkOverlap, setChunkOverlap] = useState(50);
  const [autoEmbed, setAutoEmbed] = useState(true);
  // How a document becomes rows: flat | parent_child | qa. Applied to documents
  // added AFTER the change — existing chunks keep whatever they were built with
  // until they are re-embedded, which the UI says out loud.
  const [chunkMode, setChunkMode] = useState<ChunkMode>("flat");
  const [parentChunkSize, setParentChunkSize] = useState(1024);
  // Retrieval settings belong to the knowledge base, not the document.
  const [retrievalMode, setRetrievalMode] = useState<RetrievalMode>("semantic");
  const [semanticWeight, setSemanticWeight] = useState(0.7);
  const [savingRetrieval, setSavingRetrieval] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  // Connected embedding providers. "openai_builtin" is always available —
  // it's backed by the server's OPENAI_API_KEY, not a per-user integration.
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(
    new Set(["openai_builtin"]),
  );

  // Multi-file upload state
  const [uploadFiles, setUploadFiles] = useState<{ name: string; content: string; size: number }[]>(
    [],
  );
  const [uploading, setUploading] = useState(false);

  // "Usable" means the SERVER can reach it, not that this user added a personal
  // integration. Two providers are backed by operator keys and never appear in
  // connectedProviders; three separate places used to ask this question and
  // answered it differently, which is how the dialog ended up defaulting to
  // OpenRouter while warning that OpenRouter was not connected.
  const providerUsable = useCallback(
    (id: string) =>
      connectedProviders.has(id) ||
      (id === "openrouter" && openrouterAvailable === true) ||
      (id === "openai_builtin" && builtinConfigured !== false),
    [connectedProviders, openrouterAvailable, builtinConfigured],
  );

  const availableEmbeddingModels = useMemo(
    () =>
      ALL_EMBEDDING_MODELS.filter((m) => providerUsable(m.provider) || m.value === embeddingModel),
    [providerUsable, embeddingModel],
  );
  const embedProviderOptions = EMBED_PROVIDERS.filter(
    (p) => p.id === "openai_builtin" || providerUsable(p.id),
  );

  // Default to OpenRouter when it is connected: it is the provider most
  // instances already have a key for, so embedding works without a second
  // account, and it does not share the operator OpenAI key's quota. Falls back
  // to the built-in key, then to any other connected embedding-capable
  // integration. Only ever moves off an untouched default — once the user picks
  // a provider themselves, `embedProviderTouched` stops this from overriding it.
  useEffect(() => {
    if (embedProviderTouched || embedProvider !== "openai_builtin") return;
    // Mirrors resolveEmbedTarget on the server: a connected OpenRouter
    // integration, then the operator's OpenRouter key, then the operator's
    // OpenAI key. If this order disagreed with the server's, the dialog would
    // name one provider while ingest quietly used another — and the stamp on
    // each document would be the only evidence.
    const preferred =
      EMBED_PROVIDERS.find(
        (p) => p.id === DEFAULT_EMBED_PROVIDER && connectedProviders.has(p.id),
      ) ??
      (openrouterAvailable === true
        ? EMBED_PROVIDERS.find((p) => p.id === DEFAULT_EMBED_PROVIDER)
        : undefined) ??
      (builtinConfigured === false
        ? EMBED_PROVIDERS.find((p) => p.id !== "openai_builtin" && connectedProviders.has(p.id))
        : undefined);
    if (preferred) {
      setEmbedProvider(preferred.id);
      if (preferred.models[0]) setEmbeddingModel(preferred.models[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtinConfigured, openrouterAvailable, connectedProviders, embedProviderTouched]);
  const embedModelSuggestions = EMBED_PROVIDERS.find((p) => p.id === embedProvider)?.models ?? [];
  const effectiveEmbedModel = customEmbedModel.trim() || embeddingModel;
  const currentEmbeddingDef = ALL_EMBEDDING_MODELS.find((m) => m.value === embeddingModel);
  const isEmbeddingProviderConnected = currentEmbeddingDef
    ? providerUsable(currentEmbeddingDef.provider)
    : true;

  useEffect(() => {
    loadBases();
    loadConnectedProviders();
    embedStatusFn({})
      .then((r) => {
        setBuiltinConfigured(r.builtinConfigured);
        setOpenrouterAvailable(r.openrouterAvailable);
      })
      .catch(() => setBuiltinConfigured(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selectedBase) {
      loadDocs(selectedBase.id);
      loadSources(selectedBase.id);
    }
  }, [selectedBase]);

  async function loadConnectedProviders() {
    if (!user) return;
    const connected = new Set<string>(["openai_builtin"]);
    const { data: integ } = await supabase
      .from("integrations")
      .select("provider, type, is_active")
      .eq("type", "llm_provider")
      .eq("is_active", true);
    integ?.forEach((row: any) => row.provider && connected.add(row.provider));
    const { data: creds } = await supabase
      .from("provider_credentials")
      .select("provider, is_active")
      .eq("is_active", true);
    creds?.forEach((row: any) => row.provider && connected.add(row.provider));
    setConnectedProviders(connected);
  }

  useEffect(() => {
    if (user) loadConnectedProviders();
  }, [user]);

  // The dialog must open showing what this KB actually does. Leaving the
  // controls on their defaults would tell a user with hybrid enabled that they
  // are on semantic, and the first save would then silently undo their setting.
  useEffect(() => {
    if (!selectedBase) return;
    const r = resolveRetrievalSettings(
      (selectedBase as { retrieval_settings?: unknown }).retrieval_settings,
    );
    setRetrievalMode(r.mode);
    // resolveRetrievalSettings pins the weight to 1/0 outside hybrid mode; the
    // slider only means something in hybrid, so keep a usable value otherwise.
    setSemanticWeight(r.mode === "hybrid" ? r.semanticWeight : 0.7);
  }, [selectedBase]);

  async function loadBases() {
    const { data } = await supabase
      .from("knowledge_bases")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setBases(data);
  }

  async function reindexWithCurrentSettings() {
    if (!selectedBase) return;
    setReindexing(true);
    const t = toast.loading("Re-indexing with the current chunking settings\u2026");
    try {
      const r = await backfillFn({
        data: {
          knowledgeBaseId: selectedBase.id,
          limit: 100,
          provider: embedProvider,
          model: effectiveEmbedModel,
          // force, because every document in this KB already has chunks — that
          // is exactly the case a mode change needs to rebuild.
          force: true,
          chunkSettings: {
            mode: chunkMode,
            strategy: chunkStrategy,
            chunkSize: chunkSize,
            chunkOverlap: chunkOverlap,
            parentSize: parentChunkSize,
          },
        },
      });
      if (r.skipped) {
        toast.error("Embeddings are unavailable on this workspace.", { id: t });
      } else if (r.documentsProcessed === 0) {
        toast.success("Nothing to re-index.", { id: t });
      } else {
        toast.success(
          `Re-indexed ${r.documentsProcessed} document(s) into ${r.chunksInserted} chunks.`,
          { id: t },
        );
      }
      // Q&A generation can fail per document without failing the run. Saying so
      // matters: the alternative is a knowledge base that quietly disagrees
      // with the mode shown in this dialog.
      for (const w of r.warnings ?? []) toast.warning(w);
      await loadChunkCounts(selectedBase.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-index failed", { id: t });
    } finally {
      setReindexing(false);
    }
  }

  async function saveRetrievalSettings() {
    if (!selectedBase) return;
    setSavingRetrieval(true);
    const { error } = await supabase
      .from("knowledge_bases")
      .update({
        retrieval_settings: { mode: retrievalMode, semantic_weight: semanticWeight },
      })
      .eq("id", selectedBase.id);
    setSavingRetrieval(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Retrieval settings saved");
    loadBases();
  }

  async function loadDocs(kbId: string) {
    const { data } = await supabase
      .from("knowledge_documents")
      .select("*")
      .eq("knowledge_base_id", kbId)
      .order("created_at", { ascending: false });
    if (data) setDocs(data as KnowledgeDoc[]);
    await loadChunkCounts(kbId);
  }

  async function loadChunkCounts(kbId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (supabase.from("kb_chunks" as any) as any)
      .select("document_id")
      .eq("knowledge_base_id", kbId);
    const counts = new Map<string, number>();
    ((rows ?? []) as { document_id: string }[]).forEach((r) => {
      counts.set(r.document_id, (counts.get(r.document_id) ?? 0) + 1);
    });
    setChunkCounts(counts);
  }

  async function loadSources(kbId: string) {
    // Explicit columns — the row also carries encrypted connector credentials,
    // which have no business in a browser even ciphertext-form.
    const { data } = await supabase
      .from("kb_sources")
      .select(
        "id, knowledge_base_id, kind, label, status, config, last_synced_at, error, is_sample, created_at, sync_schedule, next_sync_at, access_scope, last_sync_stats",
      )
      .eq("knowledge_base_id", kbId)
      .order("created_at", { ascending: false });
    if (data) setSources(data as KbSource[]);
  }

  // Re-sync a URL or GitHub source via the same ingest endpoint with the
  // existing source_id, so it replaces the stored docs in place. Connector
  // sources (Drive/Notion/SharePoint/Dropbox) go through the sync engine,
  // which skips unchanged items instead of replacing everything.
  async function resyncSource(src: KbSource) {
    if (CONNECTOR_KINDS.has(src.kind)) {
      setResyncingId(src.id);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const res = await fetch("/api/kb/sources/sync", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ source_id: src.id }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 207) {
          toast.error(json.error || `Sync failed (${res.status})`);
        } else {
          const s = json.stats ?? {};
          toast.success(
            `Synced — ${s.added ?? 0} added, ${s.updated ?? 0} updated, ` +
              `${s.unchanged ?? 0} unchanged, ${s.removed ?? 0} removed` +
              (json.error ? ` · ${json.error}` : ""),
          );
        }
        if (selectedBase) {
          loadDocs(selectedBase.id);
          loadSources(selectedBase.id);
        }
      } finally {
        setResyncingId(null);
      }
      return;
    }
    if (src.kind !== "url" && src.kind !== "github") {
      toast.error("Only URL, GitHub and connector sources can be re-synced");
      return;
    }
    setResyncingId(src.id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const cfg = src.config as { url?: string; repo?: string; branch?: string; globs?: string[] };
      const endpoint = src.kind === "url" ? "/api/kb/ingest-url" : "/api/kb/ingest-github";
      const body =
        src.kind === "url"
          ? {
              knowledge_base_id: src.knowledge_base_id,
              source_id: src.id,
              url: cfg.url,
              label: src.label || undefined,
            }
          : {
              knowledge_base_id: src.knowledge_base_id,
              source_id: src.id,
              repo: cfg.repo,
              branch: cfg.branch || undefined,
              globs: cfg.globs,
            };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || `Re-sync failed (${res.status})`);
      } else {
        toast.success(
          `Re-synced — ${json.documents ?? 1} document${json.documents === 1 ? "" : "s"}`,
        );
        if (selectedBase) {
          loadDocs(selectedBase.id);
          loadSources(selectedBase.id);
        }
      }
    } finally {
      setResyncingId(null);
    }
  }

  async function deleteSource(src: KbSource) {
    if (src.is_sample) {
      toast.error("Sample sources can't be removed");
      return;
    }
    await supabase.from("knowledge_documents").delete().eq("source_id", src.id);
    const { error } = await supabase.from("kb_sources").delete().eq("id", src.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Source removed");
    if (selectedBase) {
      loadDocs(selectedBase.id);
      loadSources(selectedBase.id);
    }
  }

  async function createBase() {
    if (!user) return;
    const { error } = await supabase.from("knowledge_bases").insert({
      user_id: user.id,
      name: newBaseName,
      description: newBaseDesc || null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Knowledge base created");
    setCreateOpen(false);
    setNewBaseName("");
    setNewBaseDesc("");
    loadBases();
  }

  async function deleteBase(id: string) {
    const target = bases.find((b) => b.id === id);
    if (target?.is_sample) {
      toast.error("Sample knowledge bases can't be deleted");
      return;
    }
    await supabase.from("knowledge_bases").delete().eq("id", id);
    if (selectedBase?.id === id) {
      setSelectedBase(null);
      setDocs([]);
    }
    toast.success("Deleted");
    loadBases();
  }

  async function addDoc() {
    if (!user || !selectedBase) return;
    const meta = {
      embedding_model: effectiveEmbedModel,
      embedding_provider: embedProvider,
      chunk_strategy: chunkStrategy,
      chunk_size: chunkSize,
      chunk_overlap: chunkOverlap,
      auto_embed: autoEmbed,
      chunk_mode: chunkMode,
      parent_chunk_size: parentChunkSize,
    };

    // Combined: paste + uploaded files
    const rows: any[] = [];
    if (docName.trim() && docContent.trim()) {
      rows.push({
        user_id: user.id,
        knowledge_base_id: selectedBase.id,
        name: docName,
        content: docContent,
        metadata: meta,
      });
    }
    uploadFiles.forEach((f) => {
      rows.push({
        user_id: user.id,
        knowledge_base_id: selectedBase.id,
        name: f.name,
        content: f.content,
        metadata: { ...meta, source: "upload", size_bytes: f.size },
      });
    });

    if (rows.length === 0) {
      toast.error("Add some content or upload at least one file");
      return;
    }

    setUploading(true);
    const { data: inserted, error } = await supabase
      .from("knowledge_documents")
      .insert(rows)
      .select("id");
    setUploading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const insertedIds = (inserted ?? []).map((r) => r.id);
    if (insertedIds.length > 0) {
      try {
        await embedFn({
          data: {
            documentIds: insertedIds,
            provider: embedProvider,
            model: effectiveEmbedModel,
          },
        });
      } catch (err) {
        console.warn("[knowledge] embedding failed:", err);
      }
    }
    toast.success(`${rows.length} document${rows.length === 1 ? "" : "s"} added`);
    setDocOpen(false);
    setDocName("");
    setDocContent("");
    setUploadFiles([]);
    loadDocs(selectedBase.id);
  }

  const onDropFiles = useCallback((accepted: File[], rejected: any[]) => {
    if (rejected && rejected.length > 0) {
      rejected.forEach((r: any) => {
        const reasons = (r.errors || []).map((e: any) => e.message).join(", ");
        toast.error(`${r.file?.name || "file"} rejected: ${reasons || "unsupported"}`);
      });
    }
    accepted.forEach(async (file) => {
      if (file.size > 50 * 1024 * 1024) {
        toast.error(`${file.name} exceeds 50MB limit`);
        return;
      }
      try {
        const text = await parseFileToText(file);
        if (!text || !text.trim()) {
          toast.error(`${file.name}: no extractable text found`);
          return;
        }
        setUploadFiles((prev) => [...prev, { name: file.name, content: text, size: file.size }]);
      } catch (err: any) {
        toast.error(`${file.name}: ${err.message || "could not parse"}`);
      }
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropFiles,
    // Validate by extension via a custom validator. Browsers report inconsistent
    // MIME types for many doc formats, so extension-based matching is safer.
    validator: (file: File) => {
      const allowed = [
        ".txt",
        ".md",
        ".markdown",
        ".csv",
        ".tsv",
        ".log",
        ".html",
        ".htm",
        ".xml",
        ".yaml",
        ".yml",
        ".json",
        ".rtf",
        ".pdf",
        ".docx",
      ];
      const lower = file.name.toLowerCase();
      const ok = allowed.some((ext) => lower.endsWith(ext));
      return ok
        ? null
        : {
            code: "file-invalid-type",
            message: `Unsupported extension. Allowed: ${allowed.join(", ")}`,
          };
    },
    multiple: true,
    maxSize: 50 * 1024 * 1024,
  } as unknown as Parameters<typeof useDropzone>[0]);

  async function deleteDoc(id: string) {
    await supabase.from("knowledge_documents").delete().eq("id", id);
    if (selectedBase) loadDocs(selectedBase.id);
    toast.success("Document deleted");
  }

  function downloadDoc(doc: KnowledgeDoc) {
    const content = doc.content ?? "";
    // Pick an extension based on the original filename if it already has one,
    // otherwise default to .txt so it opens cleanly anywhere.
    const hasExt = /\.[a-z0-9]{1,8}$/i.test(doc.name);
    const filename = hasExt ? doc.name : `${doc.name || "document"}.txt`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const currentVectorStore = VECTOR_STORES.find((v) => v.id === vectorStore);

  return (
    <div className="flex">
      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              Data &amp; BI
            </p>
            <h1 className="font-display text-3xl font-semibold tracking-tight">Knowledge Bases</h1>
            <p className="text-muted-foreground mt-1">
              The documents your agents retrieve from. Add sources, watch them get chunked and
              embedded, then wire a knowledge base into any agent.
            </p>
          </div>
          <div className="flex gap-2">
            <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Settings2 className="h-4 w-4 mr-2" /> RAG Settings
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>RAG Pipeline Settings</DialogTitle>
                </DialogHeader>
                <Tabs defaultValue="vectorstore">
                  <TabsList className="w-full">
                    <TabsTrigger value="vectorstore" className="flex-1">
                      Vector Store
                    </TabsTrigger>
                    <TabsTrigger value="embedding" className="flex-1">
                      Embedding
                    </TabsTrigger>
                    <TabsTrigger value="chunking" className="flex-1">
                      Chunking
                    </TabsTrigger>
                    <TabsTrigger value="retrieval" className="flex-1">
                      Retrieval
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="vectorstore" className="space-y-4 mt-4">
                    <div className="space-y-2">
                      <Label>Vector Store Provider</Label>
                      <Select value={vectorStore} onValueChange={setVectorStore}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {VECTOR_STORES.map((vs) => (
                            <SelectItem key={vs.id} value={vs.id}>
                              <div className="flex items-center gap-2">
                                <Database className="h-3 w-3" />
                                {vs.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {currentVectorStore && (
                        <p className="text-xs text-muted-foreground">
                          {currentVectorStore.description}
                        </p>
                      )}
                    </div>
                    <Button
                      onClick={() => {
                        toast.success("Defaults updated — they apply to documents you add next");
                        setSettingsOpen(false);
                      }}
                    >
                      Use These Defaults
                    </Button>
                  </TabsContent>

                  <TabsContent value="embedding" className="space-y-4 mt-4">
                    <div className="space-y-2">
                      <Label>Embedding Provider</Label>
                      <Select
                        value={embedProvider}
                        onValueChange={(v) => {
                          setEmbedProvider(v);
                          setEmbedProviderTouched(true);
                          setCustomEmbedModel("");
                          const first = EMBED_PROVIDERS.find((p) => p.id === v)?.models[0];
                          if (first) setEmbeddingModel(first);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {embedProviderOptions.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.label}
                              {p.id === "openai_builtin" && builtinConfigured === false
                                ? " — not configured"
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {embedProvider === "openai_builtin" && builtinConfigured === false && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>
                            The operator's OPENAI_API_KEY is not set on this instance, so the
                            built-in provider can't embed. Connect an embedding-capable provider
                            under Integrations instead.
                          </span>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Only providers with an embeddings API are listed. Chat-only providers (e.g.
                        Anthropic, Grok, Groq) can't embed documents — connect OpenRouter, OpenAI,
                        Gemini, Ollama, vLLM, NVIDIA or Qwen under{" "}
                        <Link to="/integrations" className="text-primary underline">
                          Integrations
                        </Link>{" "}
                        to see them here.
                      </p>
                      <Label className="pt-1">Embedding Model</Label>
                      {embedModelSuggestions.length > 0 && (
                        <Select
                          value={
                            customEmbedModel
                              ? "__custom__"
                              : embedModelSuggestions.includes(embeddingModel)
                                ? embeddingModel
                                : "__custom__"
                          }
                          onValueChange={(v) => {
                            if (v === "__custom__") setCustomEmbedModel(embeddingModel);
                            else {
                              setEmbeddingModel(v);
                              setCustomEmbedModel("");
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {embedModelSuggestions.map((m) => (
                              <SelectItem key={m} value={m}>
                                {m}
                              </SelectItem>
                            ))}
                            <SelectItem value="__custom__">Custom model name…</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      {(customEmbedModel !== "" || embedModelSuggestions.length === 0) && (
                        <Input
                          value={customEmbedModel}
                          onChange={(e) => setCustomEmbedModel(e.target.value)}
                          placeholder="Model name, e.g. text-embedding-3-small"
                        />
                      )}
                      <p className="text-xs text-muted-foreground">
                        Custom models must return 1536-dim vectors (or support dimension truncation)
                        to match the pgvector column — mismatches are rejected with a clear error.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Only models from connected providers are listed.{" "}
                        <Link to="/integrations" className="text-primary underline">
                          Connect more providers
                        </Link>
                        .
                      </p>
                      {!isEmbeddingProviderConnected && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span>
                            The selected model's provider is not connected. Connect it before
                            embedding.
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Auto-Embed on Upload</Label>
                        <p className="text-xs text-muted-foreground">
                          Automatically generate embeddings when documents are added
                        </p>
                      </div>
                      <Switch checked={autoEmbed} onCheckedChange={setAutoEmbed} />
                    </div>
                  </TabsContent>

                  <TabsContent value="chunking" className="space-y-4 mt-4">
                    <div className="space-y-2">
                      <Label>Chunking Mode</Label>
                      <Select value={chunkMode} onValueChange={(v) => setChunkMode(v as ChunkMode)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="flat">Flat &mdash; one size for both</SelectItem>
                          <SelectItem value="parent_child">
                            Parent-child &mdash; match small, read large
                          </SelectItem>
                          <SelectItem value="qa">
                            Q&amp;A &mdash; index generated questions
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        {chunkMode === "flat"
                          ? "The chunk that matches is the text the model reads. Best for short documents."
                          : chunkMode === "parent_child"
                            ? "Small chunks are embedded so matching stays precise; the surrounding parent is what reaches the model. Best for long reference documents."
                            : "An LLM writes question/answer pairs and the QUESTION is embedded, so a user question is compared against a question. Costs one model call per passage at index time."}
                      </p>
                    </div>
                    {chunkMode === "parent_child" && (
                      <div className="space-y-2">
                        <Label>Parent Size (tokens)</Label>
                        <Input
                          type="number"
                          value={parentChunkSize}
                          onChange={(e) => setParentChunkSize(Number(e.target.value))}
                          min={128}
                          max={4096}
                        />
                        <p className="text-xs text-muted-foreground">
                          The chunk size below becomes the CHILD size &mdash; what gets embedded. A
                          child is capped at half the parent, so leave clear space between the two.
                        </p>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>Chunking Strategy</Label>
                      <Select value={chunkStrategy} onValueChange={setChunkStrategy}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CHUNKING_STRATEGIES.map((s) => (
                            <SelectItem key={s.value} value={s.value}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Chunk Size (tokens)</Label>
                        <Input
                          type="number"
                          value={chunkSize}
                          onChange={(e) => setChunkSize(Number(e.target.value))}
                          min={64}
                          max={8192}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Chunk Overlap (tokens)</Label>
                        <Input
                          type="number"
                          value={chunkOverlap}
                          onChange={(e) => setChunkOverlap(Number(e.target.value))}
                          min={0}
                          max={1024}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Overlap ensures context continuity between chunks. Typically 10-20% of chunk
                      size.
                    </p>
                    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                      <p>
                        These settings apply to documents added from now on. Documents that are
                        already embedded keep the chunks they were built with &mdash; changing the
                        mode does not rewrite them, because re-chunking means paying to embed the
                        whole document again.
                      </p>
                      {selectedBase && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reindexing}
                          onClick={reindexWithCurrentSettings}
                        >
                          {reindexing
                            ? "Re-indexing\u2026"
                            : `Re-index \u201C${selectedBase.name}\u201D with these settings`}
                        </Button>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="retrieval" className="space-y-4 mt-4">
                    {!selectedBase ? (
                      <p className="text-sm text-muted-foreground">
                        Select a knowledge base to configure how it is searched.
                      </p>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <Label>Search Mode</Label>
                          <Select
                            value={retrievalMode}
                            onValueChange={(v) => setRetrievalMode(v as RetrievalMode)}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="semantic">Semantic &mdash; vector only</SelectItem>
                              <SelectItem value="hybrid">
                                Hybrid &mdash; vector + keyword
                              </SelectItem>
                              <SelectItem value="keyword">
                                Keyword &mdash; full-text only
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            Semantic finds meaning and misses exact strings. Keyword finds part
                            numbers, error codes and names that vectors blur together. Hybrid runs
                            both and merges them.
                          </p>
                        </div>

                        {retrievalMode === "hybrid" && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Label>Weighting</Label>
                              <span className="text-xs font-mono text-muted-foreground">
                                {Math.round(semanticWeight * 100)}% semantic /{" "}
                                {Math.round((1 - semanticWeight) * 100)}% keyword
                              </span>
                            </div>
                            <Slider
                              value={[semanticWeight]}
                              onValueChange={([v]) => setSemanticWeight(v)}
                              min={0}
                              max={1}
                              step={0.05}
                            />
                            <p className="text-xs text-muted-foreground">
                              Each retriever scores on a different scale &mdash; cosine similarity
                              and text rank are not the same kind of number &mdash; so both are
                              normalised before weighting. A chunk found by both is ranked above a
                              chunk found by only one.
                            </p>
                          </div>
                        )}

                        <Button
                          size="sm"
                          disabled={savingRetrieval}
                          onClick={saveRetrievalSettings}
                        >
                          {savingRetrieval ? "Saving\u2026" : "Save retrieval settings"}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          Applies immediately to every agent and swarm that searches this knowledge
                          base. No re-embedding needed &mdash; this changes how the existing index
                          is queried, not how it was built.
                        </p>
                      </>
                    )}
                  </TabsContent>
                </Tabs>
              </DialogContent>
            </Dialog>

            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" /> New Knowledge Base
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Knowledge Base</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={newBaseName}
                      onChange={(e) => setNewBaseName(e.target.value)}
                      placeholder="e.g. Product docs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Input value={newBaseDesc} onChange={(e) => setNewBaseDesc(e.target.value)} />
                  </div>
                  <Button onClick={createBase} disabled={!newBaseName.trim()}>
                    Create
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Active Retrieval Banner */}
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center justify-between py-3">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-medium">Retrieval: {currentVectorStore?.name}</p>
                <p className="text-xs text-muted-foreground">
                  Semantic search over pgvector embeddings (HNSW cosine index). Documents that
                  haven't been embedded yet fall back to a keyword scan.
                </p>
              </div>
            </div>
            <Badge variant="outline" className="border-primary/30 text-primary">
              Built-in
            </Badge>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Knowledge bases
            </h2>
            {bases.map((base) => (
              <Card
                key={base.id}
                className={`cursor-pointer border-border/50 transition-colors hover:border-primary/30 ${selectedBase?.id === base.id ? "border-primary bg-primary/5" : ""}`}
                onClick={() => setSelectedBase(base)}
              >
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-border/50 transition-colors ${
                          selectedBase?.id === base.id
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <BookOpen className="h-4 w-4" />
                      </div>
                      <CardTitle className="text-sm truncate">{base.name}</CardTitle>
                      {base.is_sample && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                          Sample
                        </Badge>
                      )}
                      {!base.is_sample && base.user_id !== user?.id && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                          Shared
                        </Badge>
                      )}
                    </div>
                    {!base.is_sample && base.user_id === user?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteBase(base.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </CardHeader>
                {base.description && (
                  <CardContent className="px-4 pb-3 pt-0">
                    <p className="text-xs text-muted-foreground">{base.description}</p>
                  </CardContent>
                )}
              </Card>
            ))}
            {bases.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No knowledge bases yet.
              </p>
            )}
          </div>

          <div className="lg:col-span-2 space-y-4">
            {selectedBase ? (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">{selectedBase.name}</h2>
                    {selectedBase.is_sample && <Badge variant="secondary">Sample</Badge>}
                    {!selectedBase.is_sample && selectedBase.user_id !== user?.id && (
                      <Badge variant="outline">Shared</Badge>
                    )}
                  </div>
                  {selectedBase.is_sample ? (
                    <p className="text-xs text-muted-foreground">Read-only sample knowledge base</p>
                  ) : selectedBase.user_id !== user?.id ? (
                    <p className="text-xs text-muted-foreground">
                      Shared with you (read-only) by an administrator
                    </p>
                  ) : (
                    <div className="flex items-center gap-2">
                      {(() => {
                        const pending = docs.filter(
                          (d) => (d.content?.trim().length ?? 0) > 0 && !chunkCounts.has(d.id),
                        ).length;
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={backfilling}
                            onClick={async () => {
                              if (!selectedBase) return;
                              setBackfilling(true);
                              const t = toast.loading(
                                pending > 0
                                  ? `Embedding ${pending} pending document${pending === 1 ? "" : "s"}…`
                                  : "Checking for pending documents…",
                              );
                              try {
                                const r = await backfillFn({
                                  data: {
                                    knowledgeBaseId: selectedBase.id,
                                    limit: 100,
                                    provider: embedProvider,
                                    model: effectiveEmbedModel,
                                  },
                                });
                                if (r.skipped)
                                  toast.error("Embeddings are unavailable on this workspace.", {
                                    id: t,
                                  });
                                else if (r.documentsProcessed === 0)
                                  toast.success("All documents are already indexed.", { id: t });
                                else
                                  toast.success(
                                    `Indexed ${r.documentsProcessed} document(s) into ${r.chunksInserted} chunks.`,
                                    { id: t },
                                  );
                                await loadChunkCounts(selectedBase.id);
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Re-index failed",
                                  { id: t },
                                );
                              } finally {
                                setBackfilling(false);
                              }
                            }}
                          >
                            {backfilling ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3 mr-1" />
                            )}
                            {pending > 0 ? `Embed ${pending} pending` : "Re-index"}
                          </Button>
                        );
                      })()}
                      <Button size="sm" variant="outline" onClick={() => setAddSourceOpen(true)}>
                        <Plus className="h-3 w-3 mr-1" /> Add Source
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingConnector(null);
                          setConnectOpen(true);
                        }}
                      >
                        <Cloud className="h-3 w-3 mr-1" /> Connect
                      </Button>
                      <Dialog open={docOpen} onOpenChange={setDocOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm">
                            <Plus className="h-3 w-3 mr-1" /> Add Document
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
                          <DialogHeader>
                            <DialogTitle>Add Documents</DialogTitle>
                          </DialogHeader>
                          <div className="space-y-4">
                            {/* Multi-file upload */}
                            <div className="space-y-2">
                              <Label>Upload Files</Label>
                              <div
                                {...(getRootProps() as React.HTMLAttributes<HTMLDivElement>)}
                                className={cn(
                                  "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all",
                                  isDragActive
                                    ? "border-primary bg-primary/5"
                                    : "border-border hover:border-primary/50",
                                )}
                              >
                                <input
                                  {...(getInputProps() as React.InputHTMLAttributes<HTMLInputElement>)}
                                />
                                <UploadCloud className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                                <p className="text-sm font-medium">
                                  Drop files here or click to browse
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  PDF, DOCX, TXT, MD, CSV, JSON, HTML, XML, YAML — up to 50MB each
                                </p>
                              </div>
                              {uploadFiles.length > 0 && (
                                <div className="space-y-1 max-h-40 overflow-y-auto">
                                  {uploadFiles.map((f, i) => (
                                    <div
                                      key={i}
                                      className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                                        <span className="truncate">{f.name}</span>
                                        <span className="text-muted-foreground shrink-0">
                                          ({(f.size / 1024).toFixed(1)} KB)
                                        </span>
                                      </div>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 w-6 p-0"
                                        onClick={() =>
                                          setUploadFiles((prev) =>
                                            prev.filter((_, idx) => idx !== i),
                                          )
                                        }
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="relative">
                              <div className="absolute inset-0 flex items-center">
                                <span className="w-full border-t border-border" />
                              </div>
                              <div className="relative flex justify-center text-xs">
                                <span className="bg-background px-2 text-muted-foreground">
                                  or paste content
                                </span>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <Label>Document Name (optional)</Label>
                              <Input
                                value={docName}
                                onChange={(e) => setDocName(e.target.value)}
                                placeholder="e.g. Product FAQ"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Content (optional)</Label>
                              <Textarea
                                rows={5}
                                value={docContent}
                                onChange={(e) => setDocContent(e.target.value)}
                                placeholder="Paste document content here..."
                              />
                            </div>

                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Layers className="h-3 w-3" />
                              Will be chunked using{" "}
                              {CHUNKING_STRATEGIES.find((s) => s.value === chunkStrategy)?.label} (
                              {chunkSize} tokens) and embedded with{" "}
                              {currentEmbeddingDef?.label || embeddingModel}
                            </div>
                            <Button onClick={addDoc} disabled={uploading} className="w-full">
                              {uploading ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Adding…
                                </>
                              ) : (
                                `Add ${uploadFiles.length + (docName.trim() && docContent.trim() ? 1 : 0) || ""} Document${uploadFiles.length + (docName.trim() && docContent.trim() ? 1 : 0) === 1 ? "" : "s"} & Process`
                              )}
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  )}
                </div>

                <Tabs defaultValue="documents" className="w-full">
                  <TabsList>
                    <TabsTrigger value="documents">Documents ({docs.length})</TabsTrigger>
                    <TabsTrigger value="sources">Sources ({sources.length})</TabsTrigger>
                    <TabsTrigger value="graph" className="gap-1">
                      <GitBranch className="h-3 w-3" /> Graph
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="documents" className="mt-3">
                    {docs.length > 0 &&
                      (() => {
                        // Indexing coverage for this base — derived from data
                        // already loaded (docs + chunkCounts), no extra query.
                        const withContent = docs.filter((d) => (d.content?.trim().length ?? 0) > 0);
                        const indexed = withContent.filter(
                          (d) => (chunkCounts.get(d.id) ?? 0) > 0,
                        ).length;
                        if (withContent.length === 0) return null;
                        return (
                          <div className="mb-3 flex items-center gap-3">
                            <Progress
                              value={(indexed / withContent.length) * 100}
                              className="h-1.5 flex-1"
                            />
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                              Indexed {indexed}/{withContent.length} documents
                            </span>
                          </div>
                        );
                      })()}
                    {docs.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-8 text-center">
                        No documents in this knowledge base.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {docs.map((doc) => {
                          const sourceForDoc = sources.find((s) => s.id === doc.source_id);
                          const sourceBadge =
                            sourceForDoc?.kind === "url"
                              ? "URL"
                              : sourceForDoc?.kind === "github"
                                ? "GitHub"
                                : sourceForDoc?.kind === "pdf"
                                  ? "PDF"
                                  : sourceForDoc?.kind === "csv"
                                    ? "CSV"
                                    : "Manual";
                          return (
                            <Card
                              key={doc.id}
                              className="border-border/50 transition-colors hover:border-primary/30"
                            >
                              <CardContent className="flex items-center justify-between p-3.5">
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <div
                                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-border/50 ${
                                      sourceBadge === "PDF"
                                        ? "bg-rose-500/10 text-rose-500 dark:text-rose-400"
                                        : sourceBadge === "CSV"
                                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                          : sourceBadge === "URL"
                                            ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
                                            : "bg-muted text-muted-foreground"
                                    }`}
                                  >
                                    <FileText className="h-4 w-4" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium truncate">{doc.name}</p>
                                    <p className="text-xs text-muted-foreground line-clamp-1">
                                      {doc.content?.slice(0, 100)}
                                    </p>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      <Badge variant="outline" className="text-[10px] px-1 py-0">
                                        {sourceBadge}
                                      </Badge>
                                      {(() => {
                                        const n = chunkCounts.get(doc.id) ?? 0;
                                        const hasContent = (doc.content?.trim().length ?? 0) > 0;
                                        if (n > 0) {
                                          return (
                                            <Badge className="text-[10px] px-1 py-0 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15">
                                              Indexed · {n} chunk{n === 1 ? "" : "s"}
                                            </Badge>
                                          );
                                        }
                                        if (!hasContent) {
                                          return (
                                            <Badge
                                              variant="outline"
                                              className="text-[10px] px-1 py-0 text-muted-foreground"
                                            >
                                              No text
                                            </Badge>
                                          );
                                        }
                                        return (
                                          <Badge className="text-[10px] px-1 py-0 bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/15">
                                            Pending embedding
                                          </Badge>
                                        );
                                      })()}
                                      {doc.metadata?.embedding_model && (
                                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                                          {doc.metadata.embedding_model}
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    title="View content"
                                    onClick={() => setViewDoc(doc)}
                                  >
                                    <Eye className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    title="Download"
                                    onClick={() => downloadDoc(doc)}
                                  >
                                    <Download className="h-3 w-3" />
                                  </Button>
                                  {!selectedBase.is_sample && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-destructive"
                                      title="Delete"
                                      onClick={() => deleteDoc(doc.id)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="sources" className="mt-3">
                    {sources.length === 0 ? (
                      <div className="text-center py-8 space-y-3">
                        <p className="text-sm text-muted-foreground">
                          No sources yet — add a URL or GitHub repo, upload a file, or connect
                          Google Drive, Notion, SharePoint or Dropbox.
                        </p>
                        {!selectedBase.is_sample && (
                          <div className="flex items-center justify-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setAddSourceOpen(true)}
                            >
                              <Plus className="h-3 w-3 mr-1" /> Add your first source
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditingConnector(null);
                                setConnectOpen(true);
                              }}
                            >
                              <Cloud className="h-3 w-3 mr-1" /> Connect a service
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {sources.map((src) => {
                          const isConnector = CONNECTOR_KINDS.has(src.kind);
                          const Icon =
                            src.kind === "url"
                              ? Globe
                              : src.kind === "github"
                                ? GitBranch
                                : isConnector
                                  ? Cloud
                                  : src.kind === "pdf" || src.kind === "csv"
                                    ? FileText
                                    : Edit3;
                          const cfg = src.config as {
                            url?: string;
                            repo?: string;
                            branch?: string;
                            folder_id?: string;
                            path?: string;
                            folder_path?: string;
                            site_id?: string;
                            page_ids?: string[];
                            database_ids?: string[];
                          };
                          const subtitle =
                            src.kind === "url"
                              ? cfg.url
                              : src.kind === "github"
                                ? `${cfg.repo}${cfg.branch ? `@${cfg.branch}` : ""}`
                                : src.kind === "gdrive"
                                  ? `Folder ${cfg.folder_id ?? "?"}`
                                  : src.kind === "notion"
                                    ? `${(cfg.page_ids?.length ?? 0) + (cfg.database_ids?.length ?? 0)} page/database id(s)`
                                    : src.kind === "sharepoint"
                                      ? cfg.folder_path || cfg.site_id || "Document library"
                                      : src.kind === "dropbox"
                                        ? cfg.path || "Entire Dropbox"
                                        : src.kind === "pdf" || src.kind === "csv"
                                          ? "Uploaded file"
                                          : "Manual paste";
                          const docCount = docs.filter((d) => d.source_id === src.id).length;
                          return (
                            <Card key={src.id} className="border-border/50">
                              <CardContent className="flex items-center justify-between p-4 gap-3">
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-sm font-medium truncate">
                                        {src.label || subtitle}
                                      </p>
                                      <Badge
                                        variant="outline"
                                        className="text-[10px] px-1 py-0 uppercase"
                                      >
                                        {isConnector
                                          ? CONNECTOR_LABELS[src.kind as ConnectorKind]
                                          : src.kind}
                                      </Badge>
                                      {isConnector && src.sync_schedule !== "manual" && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1 py-0 gap-0.5"
                                          title={
                                            src.next_sync_at
                                              ? `Next sync ${formatDistanceToNow(new Date(src.next_sync_at), { addSuffix: true })}`
                                              : undefined
                                          }
                                        >
                                          <Clock className="h-2.5 w-2.5" />
                                          {src.sync_schedule}
                                        </Badge>
                                      )}
                                      {isConnector && src.access_scope !== "inherit" && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1 py-0 gap-0.5 border-sky-500/40 text-sky-600 dark:text-sky-400"
                                          title={
                                            src.access_scope === "private"
                                              ? "Only you can retrieve these documents"
                                              : "Visibility mirrors the provider's sharing settings"
                                          }
                                        >
                                          <Lock className="h-2.5 w-2.5" />
                                          {src.access_scope === "private"
                                            ? "private"
                                            : "source ACL"}
                                        </Badge>
                                      )}
                                      {src.status === "ok" && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1 py-0 border-emerald-500/40 text-emerald-500"
                                        >
                                          ok
                                        </Badge>
                                      )}
                                      {src.status === "syncing" && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1 py-0 border-amber-500/40 text-amber-500"
                                        >
                                          syncing
                                        </Badge>
                                      )}
                                      {src.status === "error" && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1 py-0 border-destructive/40 text-destructive"
                                        >
                                          error
                                        </Badge>
                                      )}
                                      {src.status === "embedding_failed" && (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] px-1 py-0 border-amber-500/40 text-amber-500"
                                          title={
                                            src.error ||
                                            "Embedding failed — re-sync to retry. Chat will fall back to keyword search until embeddings exist."
                                          }
                                        >
                                          embed failed
                                        </Badge>
                                      )}
                                    </div>
                                    <p className="text-xs text-muted-foreground truncate">
                                      {subtitle}
                                    </p>
                                    <p className="text-[10px] text-muted-foreground mt-0.5">
                                      {docCount} doc{docCount === 1 ? "" : "s"}
                                      {src.last_synced_at
                                        ? ` · synced ${formatDistanceToNow(new Date(src.last_synced_at), { addSuffix: true })}`
                                        : ""}
                                      {isConnector && src.last_sync_stats
                                        ? ` · +${src.last_sync_stats.added ?? 0} ~${src.last_sync_stats.updated ?? 0} =${src.last_sync_stats.unchanged ?? 0} −${src.last_sync_stats.removed ?? 0}` +
                                          ((src.last_sync_stats.skipped?.length ?? 0) > 0
                                            ? ` · ${src.last_sync_stats.skipped!.length} skipped`
                                            : "")
                                        : ""}
                                    </p>
                                    {isConnector &&
                                      (src.last_sync_stats?.skipped?.length ?? 0) > 0 && (
                                        <p
                                          className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1"
                                          title={src
                                            .last_sync_stats!.skipped!.map(
                                              (s) => `${s.name}: ${s.reason}`,
                                            )
                                            .join("\n")}
                                        >
                                          Skipped:{" "}
                                          {src
                                            .last_sync_stats!.skipped!.slice(0, 3)
                                            .map((s) => s.name)
                                            .join(", ")}
                                          {src.last_sync_stats!.skipped!.length > 3 ? "…" : ""}
                                        </p>
                                      )}
                                    {src.error && (
                                      <p className="text-[10px] text-destructive mt-0.5 line-clamp-2">
                                        {src.error}
                                      </p>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  {(src.kind === "url" ||
                                    src.kind === "github" ||
                                    CONNECTOR_KINDS.has(src.kind)) &&
                                    !src.is_sample && (
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 w-7 p-0"
                                        title="Sync now"
                                        disabled={resyncingId === src.id}
                                        onClick={() => resyncSource(src)}
                                      >
                                        {resyncingId === src.id ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                          <RefreshCw className="h-3 w-3" />
                                        )}
                                      </Button>
                                    )}
                                  {CONNECTOR_KINDS.has(src.kind) && !src.is_sample && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0"
                                      title="Edit connection"
                                      onClick={() => {
                                        setEditingConnector(src);
                                        setConnectOpen(true);
                                      }}
                                    >
                                      <Edit3 className="h-3 w-3" />
                                    </Button>
                                  )}
                                  {!src.is_sample && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-destructive"
                                      title="Remove source"
                                      onClick={() => deleteSource(src)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="graph">
                    <KnowledgeGraphTab
                      knowledgeBaseId={selectedBase.id}
                      isSample={!!selectedBase.is_sample}
                    />
                  </TabsContent>
                </Tabs>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-16">
                <BookOpen className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">Select a knowledge base to view documents.</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {selectedBase && user && (
        <AddSourceDialog
          open={addSourceOpen}
          onOpenChange={setAddSourceOpen}
          knowledgeBaseId={selectedBase.id}
          userId={user.id}
          onAdded={() => {
            loadDocs(selectedBase.id);
            loadSources(selectedBase.id);
          }}
          onConnectInstead={() => {
            setAddSourceOpen(false);
            setConnectOpen(true);
          }}
        />
      )}
      {selectedBase && user && (
        <ConnectSourceDialog
          open={connectOpen}
          onOpenChange={(o) => {
            setConnectOpen(o);
            if (!o) setEditingConnector(null);
          }}
          knowledgeBaseId={selectedBase.id}
          editing={
            editingConnector
              ? {
                  id: editingConnector.id,
                  kind: editingConnector.kind,
                  label: editingConnector.label,
                  config: editingConnector.config,
                  sync_schedule: editingConnector.sync_schedule,
                  access_scope: editingConnector.access_scope,
                }
              : null
          }
          onSaved={() => {
            loadDocs(selectedBase.id);
            loadSources(selectedBase.id);
          }}
        />
      )}
      <Dialog open={!!viewDoc} onOpenChange={(o) => !o && setViewDoc(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-8">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{viewDoc?.name}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between gap-2 -mt-2 mb-2">
            <p className="text-xs text-muted-foreground">
              {viewDoc?.content?.length.toLocaleString() ?? 0} characters
            </p>
            {viewDoc && (
              <Button size="sm" variant="outline" onClick={() => downloadDoc(viewDoc)}>
                <Download className="h-3 w-3 mr-1" /> Download
              </Button>
            )}
          </div>
          <div className="flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-3">
            <pre className="text-xs whitespace-pre-wrap break-words font-mono text-foreground">
              {viewDoc?.content || "(empty)"}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
