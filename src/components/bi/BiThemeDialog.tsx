// Dashboard theme dialog: background image (client-side compressed to a
// data URL so public pages and PDF export need no storage bucket), fit &
// dim controls, and a dashboard font. Owner-only.
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus, Loader2, Palette, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { DASH_FONTS, dashSurfaceStyle, type BiDashTheme } from "@/lib/biDashboards";

const MAX_EDGE = 1600;
const MAX_DATA_URL_BYTES = 900_000; // ~0.9MB after compression — keeps rows sane

/** Downscale + JPEG-compress an image file into a data URL. */
async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL("image/jpeg", q);
    if (url.length <= MAX_DATA_URL_BYTES) return url;
  }
  throw new Error("Image is too large even after compression — try a smaller image.");
}

export function BiThemeDialog({
  open,
  onOpenChange,
  theme,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  theme: BiDashTheme;
  onSave: (theme: BiDashTheme) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<BiDashTheme>(theme);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-seed the draft each time the dialog opens.
  const [seenOpen, setSeenOpen] = useState(false);
  if (open && !seenOpen) {
    setDraft(theme);
    setSeenOpen(true);
  } else if (!open && seenOpen) {
    setSeenOpen(false);
  }

  async function pickImage(file: File) {
    if (!file.type.startsWith("image/")) return toast.error("Pick an image file");
    setBusy(true);
    try {
      const url = await compressImage(file);
      setDraft((d) => ({ ...d, bg: { url, fit: d.bg?.fit ?? "cover", dim: d.bg?.dim ?? 0.25 } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await onSave(draft);
      toast.success("Dashboard theme saved");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4 text-primary" /> Dashboard theme
          </DialogTitle>
          <DialogDescription className="text-xs">
            The background and font apply everywhere this dashboard renders — the editor, shared
            views, the public link and PDF export.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Background image */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Background image
            </Label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickImage(f);
                e.target.value = "";
              }}
            />
            {draft.bg ? (
              <div
                className="relative h-32 overflow-hidden rounded-lg border border-border"
                style={dashSurfaceStyle({ bg: draft.bg })}
              >
                <div className="absolute inset-x-2 bottom-2 flex justify-between">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 gap-1 text-xs"
                    onClick={() => fileRef.current?.click()}
                    disabled={busy}
                  >
                    <ImagePlus className="h-3 w-3" /> Replace
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 gap-1 text-xs text-destructive"
                    onClick={() => setDraft((d) => ({ ...d, bg: undefined }))}
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flex h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImagePlus className="h-4 w-4" />
                )}
                Upload an image (compressed to ≤0.9MB, stays with the dashboard)
              </button>
            )}
            {draft.bg && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Fit
                  </Label>
                  <Select
                    value={draft.bg.fit}
                    onValueChange={(v) =>
                      setDraft((d) => ({ ...d, bg: { ...d.bg!, fit: v as "cover" } }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cover" className="text-xs">
                        Cover
                      </SelectItem>
                      <SelectItem value="contain" className="text-xs">
                        Contain
                      </SelectItem>
                      <SelectItem value="tile" className="text-xs">
                        Tile
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Darken · {Math.round((draft.bg.dim ?? 0) * 100)}%
                  </Label>
                  <Slider
                    value={[Math.round((draft.bg.dim ?? 0) * 100)]}
                    min={0}
                    max={80}
                    step={5}
                    onValueChange={([v]) =>
                      setDraft((d) => ({ ...d, bg: { ...d.bg!, dim: v / 100 } }))
                    }
                    className="pt-2"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Font */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Dashboard font
            </Label>
            <Select
              value={draft.font ?? "default"}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, font: v === "default" ? undefined : v }))
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DASH_FONTS).map(([id, f]) => (
                  <SelectItem key={id} value={id} className="text-xs">
                    <span style={f.stack ? { fontFamily: f.stack } : undefined}>{f.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button className="w-full" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save theme"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
