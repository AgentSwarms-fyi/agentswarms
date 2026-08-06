import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchConnectedIntegrations,
  type ConnectedIntegration,
} from "@/components/bi/BiModelSelect";
import { listProviderImageModels, type ProviderModelInfo } from "@/utils/providerModels.functions";
import { PROVIDER_LABELS, type ProviderId } from "@/utils/providers/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sparkles,
  Loader2,
  Download,
  Copy,
  Image as ImageIcon,
  X,
  Wand2,
  Upload,
  Activity,
  ArrowUpRight,
  ArrowDownLeft,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/image-playground")({
  component: ImagePlaygroundPage,
});

// Providers and models come from the caller's connected integrations —
// the provider dropdown lists what /integrations has, and each provider's
// model dropdown shows only its IMAGE-generation models (from its /models
// endpoint). These notes enrich the picker for models we know well.
const MODEL_NOTES: Record<string, { tagline: string; bestFor: string }> = {
  "google/gemini-2.5-flash-image": {
    tagline: "Fast, cheap, dependable.",
    bestFor: "Quick drafts, iterating on a concept, simple edits.",
  },
  "google/gemini-3.1-flash-image": {
    tagline: "Fast with pro-level quality.",
    bestFor: "Finished social posts, product shots, detailed edits with quick turnaround.",
  },
  "google/gemini-3-pro-image": {
    tagline: "Highest quality, slower and pricier.",
    bestFor: "Hero images, marketing assets, complex compositions with text and fine detail.",
  },
};

const MAX_INPUT_IMAGES = 4;

// Per-session cache of each provider's image-model list.
const imageModelsCache = new Map<string, ProviderModelInfo[]>();

type GeneratedImage = {
  id: string;
  prompt: string;
  modelId: string;
  modelLabel: string;
  dataUrl: string;
  caption: string;
  createdAt: number;
};

type TraceEntry = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  status: "pending" | "success" | "error";
  modelId: string;
  modelLabel: string;
  isEdit: boolean;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    httpStatus?: number;
    traceId?: string;
    rawText: string;
    captionText: string;
    imageDataUrl?: string;
  };
  errorMessage?: string;
  durationMs?: number;
};

// Truncate base64 image data URLs in a JSON-serializable payload so the
// trace panel stays readable. Recursively walks the value.
function redactImageDataUrls(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/") && value.length > 120) {
      return `${value.slice(0, 80)}…[${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactImageDataUrls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactImageDataUrls(v);
    return out;
  }
  return value;
}

function ImagePlaygroundPage() {
  const [prompt, setPrompt] = useState("");
  const [providers, setProviders] = useState<ConnectedIntegration[] | null>(null);
  const [provider, setProvider] = useState<string>("");
  const [models, setModels] = useState<ProviderModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [inputImages, setInputImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listImageModelsFn = useServerFn(listProviderImageModels);

  const selectedLabel = models?.find((m) => m.id === modelId)?.name ?? modelId;
  const notes = MODEL_NOTES[modelId];
  const isEdit = inputImages.length > 0;
  const isBlend = inputImages.length > 1;
  const activeTrace = traces.find((t) => t.id === activeTraceId) ?? traces[0] ?? null;

  // Providers: only what the user connected under /integrations.
  useEffect(() => {
    fetchConnectedIntegrations()
      .then((list) => {
        setProviders(list);
        if (list.length > 0) {
          setProvider((p) =>
            p && list.some((i) => i.provider === p)
              ? p
              : (list.find((i) => i.provider === "openrouter")?.provider ?? list[0].provider),
          );
        }
      })
      .catch(() => setProviders([]));
  }, []);

  // Image models for the selected provider (its /models endpoint, filtered
  // server-side to image-generation models; cached per session).
  useEffect(() => {
    if (!provider) return;
    setModelsError(null);
    const cached = imageModelsCache.get(provider);
    if (cached) {
      setModels(cached);
      setModelId((m) => (m && cached.some((x) => x.id === m) ? m : (cached[0]?.id ?? "")));
      return;
    }
    setModels(null);
    void (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      const res = await listImageModelsFn({ data: { access_token: token, provider } });
      if (!res.ok) {
        setModels([]);
        setModelsError(res.error);
        return;
      }
      imageModelsCache.set(provider, res.models);
      setModels(res.models);
      setModelId((m) => (m && res.models.some((x) => x.id === m) ? m : (res.models[0]?.id ?? "")));
    })();
  }, [provider, listImageModelsFn]);

  async function handleFiles(files: File[] | FileList) {
    const incoming = [...files];
    for (const file of incoming) {
      if (inputImages.length + incoming.indexOf(file) >= MAX_INPUT_IMAGES) {
        toast.error(`Up to ${MAX_INPUT_IMAGES} images`);
        break;
      }
      if (!file.type.startsWith("image/")) {
        toast.error(`"${file.name}" is not an image file`);
        continue;
      }
      if (file.size > 8 * 1024 * 1024) {
        toast.error(`"${file.name}" is over 8MB — pick a smaller one`);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      setInputImages((prev) =>
        prev.length >= MAX_INPUT_IMAGES ? prev : [...prev, { name: file.name, dataUrl }],
      );
    }
  }

  async function generate() {
    const text = prompt.trim();
    if (!text && inputImages.length === 0) {
      toast.error("Add a prompt or at least one image");
      return;
    }
    if (!provider || !modelId) {
      toast.error("Pick a provider and an image model first");
      return;
    }
    setLoading(true);

    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    const editFlag = inputImages.length > 0;

    // Build the request payload up-front so we can show it in the trace
    // panel even if the network call never fires. Every input image rides
    // along as its own image_url part, so multi-image blending works.
    const userParts: Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    > = [];
    if (text) userParts.push({ type: "text", text });
    for (const img of inputImages) {
      userParts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }

    // /api/chat reads `body.provider` and `body.model` — using the wrong
    // field names silently falls back to the default text model and the
    // image branch is never taken (which is what broke editing).
    const requestBody = {
      provider,
      model: modelId,
      messages: [
        {
          role: "user",
          content: userParts.length === 1 && userParts[0].type === "text" ? text : userParts,
        },
      ],
    };

    const initialTrace: TraceEntry = {
      id: traceId,
      startedAt,
      status: "pending",
      modelId,
      modelLabel: selectedLabel,
      isEdit: editFlag,
      request: {
        url: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer ••••",
        },
        body: redactImageDataUrls({ ...requestBody, provider: "AgentSwarms AI Gateway" }),
      },
      response: { rawText: "", captionText: "" },
    };
    setTraces((prev) => [initialTrace, ...prev].slice(0, 20));
    setActiveTraceId(traceId);

    const finishTrace = (patch: Partial<TraceEntry>) =>
      setTraces((prev) =>
        prev.map((t) =>
          t.id === traceId
            ? { ...t, ...patch, finishedAt: Date.now(), durationMs: Date.now() - startedAt }
            : t,
        ),
      );

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error("Please sign in again");
        finishTrace({ status: "error", errorMessage: "No auth session" });
        return;
      }

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      const httpStatus = resp.status;
      const upstreamTraceId = resp.headers.get("X-Trace-Id") || undefined;

      if (!resp.ok) {
        let msg = `Generation failed (${resp.status})`;
        let bodyText = "";
        try {
          bodyText = await resp.text();
          const j = JSON.parse(bodyText);
          if (j?.error) msg = j.error;
        } catch {
          /* keep raw text */
        }
        toast.error(msg);
        finishTrace({
          status: "error",
          errorMessage: msg,
          response: {
            httpStatus,
            traceId: upstreamTraceId,
            rawText: bodyText.slice(0, 4000),
            captionText: "",
          },
        });
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let assembled = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string") assembled += delta;
          } catch {
            buf = line + "\n" + buf;
            break;
          }
        }
      }

      const match = assembled.match(/!\[[^\]]*\]\((data:image\/[^)]+)\)/);
      const captionText = match ? assembled.replace(match[0], "").trim() : assembled.trim();
      const dataUrl = match?.[1];
      // Build a redacted assembled text for the trace panel — keep only
      // a short marker for the data URL so the panel stays scrollable.
      const redactedAssembled = match
        ? assembled.replace(match[0], `![generated image](data:image/…[${dataUrl!.length} chars])`)
        : assembled;

      if (!dataUrl) {
        const errMsg = assembled.trim()
          ? `No image returned. Model said: "${assembled.slice(0, 140)}…"`
          : "No image returned. Try a more descriptive prompt.";
        toast.error(errMsg);
        finishTrace({
          status: "error",
          errorMessage: errMsg,
          response: {
            httpStatus,
            traceId: upstreamTraceId,
            rawText: redactedAssembled.slice(0, 8000),
            captionText,
          },
        });
        return;
      }

      const result: GeneratedImage = {
        id: crypto.randomUUID(),
        prompt: text || "(image edit)",
        modelId,
        modelLabel: selectedLabel,
        dataUrl,
        caption: captionText,
        createdAt: Date.now(),
      };
      setResults((prev) => [result, ...prev]);
      toast.success("Image ready");
      finishTrace({
        status: "success",
        response: {
          httpStatus,
          traceId: upstreamTraceId,
          rawText: redactedAssembled.slice(0, 8000),
          captionText,
          imageDataUrl: dataUrl,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Generation failed";
      toast.error(msg);
      finishTrace({ status: "error", errorMessage: msg });
    } finally {
      setLoading(false);
    }
  }

  function downloadImage(img: GeneratedImage) {
    const a = document.createElement("a");
    a.href = img.dataUrl;
    const ext = img.dataUrl.match(/^data:image\/([a-zA-Z+]+);/)?.[1] || "png";
    a.download = `agentswarms-${img.id.slice(0, 8)}.${ext.replace("+xml", "")}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function copyImage(img: GeneratedImage) {
    try {
      const blob = await (await fetch(img.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy not supported in this browser");
    }
  }

  function reuseAsInput(img: GeneratedImage) {
    setInputImages((prev) =>
      prev.length >= MAX_INPUT_IMAGES
        ? prev
        : [...prev, { name: "previous-result.png", dataUrl: img.dataUrl }],
    );
    toast.info("Added as input — describe the edit or blend you want");
  }

  return (
    <div className="container mx-auto max-w-[1600px] space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-6 w-6 text-primary" />
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
            Experiment
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Image Playground</h1>
          <Badge variant="secondary" className="ml-1">
            New
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Generate, edit or blend images with the image models your connected providers offer. No
          conversation history — every run is a fresh prompt. For chat-style use, head to the{" "}
          <Link
            to="/playground"
            search={{ agentId: undefined }}
            className="underline underline-offset-2"
          >
            Chat Playground
          </Link>
          .
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)_400px] lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* Left: controls */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wand2 className="h-4 w-4" />{" "}
              {isBlend ? "Blend images" : isEdit ? "Edit image" : "Generate image"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {providers !== null && providers.length === 0 && (
              <div className="rounded-md border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
                No model providers connected. Connect one under{" "}
                <Link to="/integrations" className="text-primary underline underline-offset-2">
                  Integrations
                </Link>{" "}
                to generate images.
              </div>
            )}
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={providers === null ? "Loading providers…" : "Pick a provider…"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(providers ?? []).map((p) => (
                    <SelectItem key={p.provider} value={p.provider}>
                      {PROVIDER_LABELS[p.provider as ProviderId] ?? p.provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Image model</Label>
              <Select value={modelId} onValueChange={setModelId} disabled={!models?.length}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      !provider
                        ? "Pick a provider first"
                        : models === null
                          ? "Loading image models…"
                          : models.length === 0
                            ? "No image models from this provider"
                            : "Pick a model…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(models ?? []).map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <div className="flex flex-col">
                        <span>{m.name ?? m.id}</span>
                        {MODEL_NOTES[m.id] && (
                          <span className="text-xs text-muted-foreground">
                            {MODEL_NOTES[m.id].tagline}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelsError && <p className="text-xs text-destructive">{modelsError}</p>}
              {models !== null && models.length === 0 && !modelsError && provider && (
                <p className="text-xs text-muted-foreground">
                  {PROVIDER_LABELS[provider as ProviderId] ?? provider} lists no image-generation
                  models — try another connected provider.
                </p>
              )}
              {notes && (
                <div className="rounded-md border bg-muted/40 p-3 text-xs">
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Best for: </span>
                    {notes.bestFor}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="ip-prompt">
                {isBlend ? "Blend instruction" : isEdit ? "Edit instruction" : "Prompt"}
              </Label>
              <Textarea
                id="ip-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  isBlend
                    ? "e.g. Combine these into one scene: put the product from the first image into the setting of the second"
                    : isEdit
                      ? "e.g. Make the sky a vivid sunset orange, add light fog over the trees"
                      : "e.g. A neon-lit cyberpunk street market at night, cinematic, ultra-detailed"
                }
                rows={5}
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <Label>
                Input images (optional — one edits, several blend, up to {MAX_INPUT_IMAGES})
              </Label>
              {inputImages.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {inputImages.map((img, i) => (
                    <div
                      key={`${img.name}-${i}`}
                      className="relative overflow-hidden rounded-md border"
                    >
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        className="h-24 w-full bg-muted object-cover"
                      />
                      <Button
                        size="icon"
                        variant="secondary"
                        className="absolute right-1 top-1 h-6 w-6"
                        onClick={() => setInputImages((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove ${img.name}`}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                      <span className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                        {img.name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {inputImages.length < MAX_INPUT_IMAGES && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  {inputImages.length === 0
                    ? "Upload images to edit or blend"
                    : "Add another image"}
                </Button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void handleFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            <Button
              className="w-full gap-2"
              onClick={generate}
              disabled={
                loading || (!prompt.trim() && inputImages.length === 0) || !provider || !modelId
              }
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />{" "}
                  {isBlend
                    ? `Blend ${inputImages.length} images`
                    : isEdit
                      ? "Apply edit"
                      : "Generate"}
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Right: output */}
        <div className="space-y-4">
          {results.length === 0 && !loading && (
            <Card className="flex h-[420px] items-center justify-center border-dashed">
              <div className="text-center text-sm text-muted-foreground">
                <ImageIcon className="mx-auto mb-3 h-10 w-10 opacity-40" />
                <p>Your generated images will appear here.</p>
                <p className="mt-1 text-xs">Each run is independent — no chat history is sent.</p>
              </div>
            </Card>
          )}
          {loading && results.length === 0 && (
            <Card className="flex h-[420px] items-center justify-center border-dashed">
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                Generating image with {selectedLabel}…
              </div>
            </Card>
          )}
          {results.map((img) => (
            <Card key={img.id} className="overflow-hidden">
              <CardContent className="space-y-3 p-4">
                <div className="overflow-hidden rounded-md border bg-muted">
                  <img
                    src={img.dataUrl}
                    alt={img.prompt}
                    className="mx-auto max-h-[600px] object-contain"
                  />
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">
                        {img.modelLabel}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(img.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-3">{img.prompt}</p>
                    {img.caption && (
                      <p className="text-xs italic text-muted-foreground">{img.caption}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => reuseAsInput(img)}
                    >
                      <Wand2 className="h-3.5 w-3.5" /> Edit this
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => copyImage(img)}
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy
                    </Button>
                    <Button size="sm" className="gap-1.5" onClick={() => downloadImage(img)}>
                      <Download className="h-3.5 w-3.5" /> Download
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Right: trace + request/response */}
        <TracePanel
          traces={traces}
          activeTraceId={activeTrace?.id ?? null}
          onSelect={setActiveTraceId}
        />
      </div>
    </div>
  );
}

function TracePanel({
  traces,
  activeTraceId,
  onSelect,
}: {
  traces: TraceEntry[];
  activeTraceId: string | null;
  onSelect: (id: string) => void;
}) {
  const active = traces.find((t) => t.id === activeTraceId) ?? traces[0] ?? null;

  return (
    <Card className="flex h-[calc(100vh-220px)] min-h-[480px] flex-col xl:sticky xl:top-6 xl:self-start">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4" /> Trace · Request & Response
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden p-3 pt-0">
        {traces.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            <div>
              <Activity className="mx-auto mb-2 h-6 w-6 opacity-40" />
              Trace details for each generation will appear here — request payload, response body,
              status, and timing.
            </div>
          </div>
        ) : (
          <>
            {/* Run selector */}
            <ScrollArea className="max-h-32 shrink-0 rounded-md border">
              <div className="divide-y">
                {traces.map((t) => {
                  const isActive = t.id === active?.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onSelect(t.id)}
                      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                        isActive ? "bg-muted" : "hover:bg-muted/50"
                      }`}
                    >
                      <StatusDot status={t.status} />
                      <span className="flex-1 truncate font-mono">
                        {new Date(t.startedAt).toLocaleTimeString()} · {t.modelId.split("/").pop()}
                      </span>
                      {t.durationMs != null && (
                        <span className="shrink-0 text-muted-foreground">{t.durationMs}ms</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>

            {active && (
              <ScrollArea className="flex-1 rounded-md border">
                <div className="space-y-3 p-3">
                  {/* Status */}
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={active.status} />
                    {active.response.httpStatus != null && (
                      <Badge variant="outline" className="text-[10px] font-mono">
                        HTTP {active.response.httpStatus}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[10px]">
                      {active.isEdit ? "edit" : "generate"}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {active.modelLabel}
                    </Badge>
                    {active.durationMs != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {active.durationMs}ms
                      </span>
                    )}
                  </div>

                  {active.response.traceId && (
                    <div className="rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
                      <span className="text-muted-foreground">trace_id: </span>
                      {active.response.traceId}
                    </div>
                  )}

                  {/* Error */}
                  {active.errorMessage && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-[11px] text-destructive">
                      <div className="mb-1 flex items-center gap-1.5 font-semibold">
                        <AlertTriangle className="h-3 w-3" /> Error
                      </div>
                      {active.errorMessage}
                    </div>
                  )}

                  {/* Request */}
                  <Section title="Request" icon={<ArrowUpRight className="h-3 w-3 text-sky-400" />}>
                    <div className="mb-1 text-[10px] text-muted-foreground">
                      <span className="font-mono">{active.request.method}</span>{" "}
                      <span className="font-mono">{active.request.url}</span>
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
                      {JSON.stringify(active.request.body, null, 2)}
                    </pre>
                  </Section>

                  {/* Response */}
                  <Section
                    title="Response"
                    icon={<ArrowDownLeft className="h-3 w-3 text-emerald-400" />}
                  >
                    {active.response.captionText && (
                      <div className="mb-2">
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Caption / model text
                        </div>
                        <div className="rounded bg-muted/40 p-2 text-[11px] italic">
                          {active.response.captionText}
                        </div>
                      </div>
                    )}
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      Stream content
                    </div>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
                      {active.response.rawText ||
                        (active.status === "pending" ? "(streaming…)" : "(empty)")}
                    </pre>
                    {active.response.imageDataUrl && (
                      <div className="mt-2 text-[10px] text-muted-foreground">
                        ✓ Image data URL captured (
                        {active.response.imageDataUrl.length.toLocaleString()} chars) — rendered in
                        Output panel.
                      </div>
                    )}
                  </Section>
                </div>
              </ScrollArea>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function StatusDot({ status }: { status: TraceEntry["status"] }) {
  if (status === "pending")
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />;
  if (status === "success") return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />;
  return <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />;
}

function StatusBadge({ status }: { status: TraceEntry["status"] }) {
  if (status === "pending")
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" /> Streaming
      </Badge>
    );
  if (status === "success")
    return (
      <Badge className="gap-1 bg-emerald-600 text-[10px] text-white hover:bg-emerald-600">
        <CheckCircle2 className="h-2.5 w-2.5" /> Success
      </Badge>
    );
  return (
    <Badge variant="destructive" className="gap-1 text-[10px]">
      <AlertTriangle className="h-2.5 w-2.5" /> Error
    </Badge>
  );
}
