import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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

type ImageModel = {
  id: string;
  label: string;
  tagline: string;
  bestFor: string;
  speed: "Fast" | "Balanced" | "Slow";
  quality: "Good" | "High" | "Highest";
};

// Curated, deduplicated list of image-generation models the AgentSwarms AI
// gateway can route. Kept aligned with IMAGE_MODEL_IDS in providerSupport.ts.
const IMAGE_MODELS: ImageModel[] = [
  {
    id: "google/gemini-2.5-flash-image",
    label: "Nano Banana (Gemini 2.5 Flash Image)",
    tagline: "Fast, cheap, dependable.",
    bestFor:
      "Quick drafts, iterating on a concept, simple edits. Great default when you want something back in a few seconds.",
    speed: "Fast",
    quality: "Good",
  },
  {
    id: "google/gemini-3.1-flash-image-preview",
    label: "Nano Banana 2 (Gemini 3.1 Flash Image)",
    tagline: "Fast with pro-level quality.",
    bestFor:
      "Best balance of speed and fidelity. Use for finished social posts, product shots, and detailed edits where you still want a quick turnaround.",
    speed: "Fast",
    quality: "High",
  },
  {
    id: "google/gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image",
    tagline: "Highest quality, slower and pricier.",
    bestFor:
      "Hero images, marketing assets, complex compositions with text and fine detail. Use when quality matters more than latency.",
    speed: "Slow",
    quality: "Highest",
  },
];

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
  const [modelId, setModelId] = useState<string>(IMAGE_MODELS[1].id);
  const [inputImage, setInputImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedModel = IMAGE_MODELS.find((m) => m.id === modelId) ?? IMAGE_MODELS[0];
  const isEdit = !!inputImage;
  const activeTrace = traces.find((t) => t.id === activeTraceId) ?? traces[0] ?? null;

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Image is over 8MB — pick a smaller one");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setInputImage({ name: file.name, dataUrl });
  }

  async function generate() {
    const text = prompt.trim();
    if (!text && !inputImage) {
      toast.error("Add a prompt or an image to edit");
      return;
    }
    setLoading(true);

    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    const editFlag = !!inputImage;

    // Build the request payload up-front so we can show it in the trace
    // panel even if the network call never fires.
    const userParts: Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    > = [];
    if (text) userParts.push({ type: "text", text });
    if (inputImage) userParts.push({ type: "image_url", image_url: { url: inputImage.dataUrl } });

    // /api/chat reads `body.provider` and `body.model` — using the wrong
    // field names silently falls back to the default text model and the
    // image branch is never taken (which is what broke editing).
    const requestBody = {
      provider: "openrouter",
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
      modelLabel: selectedModel.label,
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
        modelLabel: selectedModel.label,
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
    setInputImage({ name: "previous-result.png", dataUrl: img.dataUrl });
    toast.info("Loaded as input — describe the edit you want");
  }

  return (
    <div className="container mx-auto max-w-[1600px] space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Image Playground</h1>
          <Badge variant="secondary" className="ml-1">
            New
          </Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Generate or edit images with Gemini image models. No conversation history — every run is a
          fresh prompt so you stay below model token limits. For chat-style use, head to the{" "}
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
              <Wand2 className="h-4 w-4" /> {isEdit ? "Edit image" : "Generate image"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Model</Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMAGE_MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <div className="flex flex-col">
                        <span>{m.label}</span>
                        <span className="text-xs text-muted-foreground">{m.tagline}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="outline">{selectedModel.speed}</Badge>
                  <Badge variant="outline">{selectedModel.quality} quality</Badge>
                </div>
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Best for: </span>
                  {selectedModel.bestFor}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ip-prompt">{isEdit ? "Edit instruction" : "Prompt"}</Label>
              <Textarea
                id="ip-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  isEdit
                    ? "e.g. Make the sky a vivid sunset orange, add light fog over the trees"
                    : "e.g. A neon-lit cyberpunk street market at night, cinematic, ultra-detailed"
                }
                rows={5}
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <Label>Input image (optional — enables editing)</Label>
              {inputImage ? (
                <div className="relative overflow-hidden rounded-md border">
                  <img
                    src={inputImage.dataUrl}
                    alt={inputImage.name}
                    className="max-h-48 w-full object-contain bg-muted"
                  />
                  <Button
                    size="icon"
                    variant="secondary"
                    className="absolute right-2 top-2 h-7 w-7"
                    onClick={() => setInputImage(null)}
                    aria-label="Remove input image"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  Upload an image to edit
                </Button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                  e.currentTarget.value = "";
                }}
              />
            </div>

            <Button
              className="w-full gap-2"
              onClick={generate}
              disabled={loading || (!prompt.trim() && !inputImage)}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> {isEdit ? "Apply edit" : "Generate"}
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
                Generating image with {selectedModel.label}…
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
