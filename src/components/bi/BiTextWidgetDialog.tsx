// Add or edit a dashboard text block (R500 moved it here from the dashboard
// route and gave it a style): markdown plus how it is set — size, alignment,
// body and heading colours, italic — with a live preview. A race title such
// as "# Brazilian Grand Prix" over "*8 November 2026*" is one block.
//
// FOUND IN R500: saving rebuilt the widget from its title and text alone, so
// editing a text block dropped its appearance (accent, card, hidden title).
// The edit now keeps every field it does not change.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BiTextBlock } from "@/components/bi/BiTextBlock";
import { BiColourPick } from "@/components/bi/BiColourPick";
import { type BiTextStyle, type BiWidget } from "@/lib/biDashboards";

const SIZES: [NonNullable<BiTextStyle["size"]>, string][] = [
  ["sm", "Small"],
  ["md", "Normal"],
  ["lg", "Large"],
  ["xl", "Larger"],
  ["2xl", "Display"],
  ["3xl", "Headline"],
];

const small = "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

function ColourField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <div className="col-span-2 space-y-1">
      <Label className={small}>{label}</Label>
      <BiColourPick label={label} value={value} onChange={onChange} />
    </div>
  );
}

export function BiTextWidgetDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: BiWidget | null;
  onSubmit: (w: BiWidget) => void;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [style, setStyle] = useState<BiTextStyle>({});

  useEffect(() => {
    if (!open) return;
    setTitle(initial?.title ?? "");
    setText(initial?.text ?? "");
    setStyle(initial?.textStyle ?? {});
  }, [open, initial]);

  const styled = Object.values(style).some((v) => v !== undefined && v !== false);
  const set = (patch: Partial<BiTextStyle>) => setStyle((s) => ({ ...s, ...patch }));

  function submit() {
    if (!title.trim()) return toast.error("Give the text block a title");
    onSubmit({
      ...(initial ?? {}),
      id: initial?.id ?? crypto.randomUUID(),
      kind: "text",
      title: title.trim(),
      text,
      textStyle: styled ? style : undefined,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit text block" : "Add text block"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Executive summary"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Content (Markdown supported)</Label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={7}
                placeholder={"## Key takeaways\n- Revenue grew 12% QoQ\n- …"}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className={small}>Size</Label>
                <Select
                  value={style.size ?? "md"}
                  onValueChange={(v) =>
                    set({ size: v === "md" ? undefined : (v as BiTextStyle["size"]) })
                  }
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Text size">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SIZES.map(([v, l]) => (
                      <SelectItem key={v} value={v} className="text-xs">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className={small}>Align</Label>
                <Select
                  value={style.align ?? "left"}
                  onValueChange={(v) =>
                    set({ align: v === "left" ? undefined : (v as BiTextStyle["align"]) })
                  }
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Text alignment">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="left" className="text-xs">
                      Left
                    </SelectItem>
                    <SelectItem value="center" className="text-xs">
                      Centre
                    </SelectItem>
                    <SelectItem value="right" className="text-xs">
                      Right
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <ColourField
                label="Text colour"
                value={style.color}
                onChange={(c) => set({ color: c })}
              />
              <ColourField
                label="Heading colour"
                value={style.headingColor}
                onChange={(c) => set({ headingColor: c })}
              />
            </div>
            <Label className="flex cursor-pointer items-center gap-2 text-xs font-normal">
              <Checkbox
                checked={style.italic === true}
                onCheckedChange={(v) => set({ italic: v === true ? true : undefined })}
              />
              Italic
            </Label>
          </div>
          <div className="space-y-1">
            <Label className={small}>Preview</Label>
            <div className="dark h-64 overflow-auto rounded-lg border border-border bg-background p-3 text-foreground">
              {styled ? (
                <BiTextBlock text={text} style={style} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Unstyled — the block uses the standard text look. Pick a size, colour or alignment
                  to set it yourself.
                </p>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>{initial ? "Save" : "Add to dashboard"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
