// What clicking a widget's marks does (R503): filter the page it is on (the
// default), open another page of the dashboard filtered to the clicked value —
// a station's own page, say — or open a link built from the value.
import { useState } from "react";
import { toast } from "sonner";
import { MousePointerClick } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { clickActionUrl, isClickUrlTemplate, type BiClickAction } from "@/lib/biInteract";

type Kind = "filter" | "page" | "url";

export function BiClickActionDialog({
  open,
  onOpenChange,
  title,
  initial,
  pages,
  currentPageId,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The widget's title, to say which widget this is. */
  title: string;
  initial: BiClickAction | undefined;
  pages: { id: string; name: string }[];
  currentPageId: string;
  /** undefined: back to filtering this page. */
  onSave: (a: BiClickAction | undefined) => void;
}) {
  const [kind, setKind] = useState<Kind>("filter");
  const [pageId, setPageId] = useState("");
  const [url, setUrl] = useState("");
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    setKind(initial?.kind ?? "filter");
    setPageId(initial?.kind === "page" ? initial.pageId : "");
    setUrl(initial?.kind === "url" ? initial.url : "");
  } else if (!open && seen) {
    setSeen(false);
  }

  const others = pages.filter((p) => p.id !== currentPageId);
  const example = url.trim() ? clickActionUrl(url, "Example value") : null;

  function save() {
    if (kind === "filter") {
      onSave(undefined);
    } else if (kind === "page") {
      if (!others.some((p) => p.id === pageId)) return toast.error("Pick the page to open");
      onSave({ kind: "page", pageId });
    } else {
      if (!isClickUrlTemplate(url)) {
        return toast.error("The link must be a full address starting with https:// or http://");
      }
      onSave({ kind: "url", url: url.trim() });
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <MousePointerClick className="h-4 w-4 text-primary" />
            When a mark is clicked
          </DialogTitle>
          <DialogDescription className="text-xs">
            In <strong>{title || "this widget"}</strong>: a bar, a slice, a point on a map or a text
            cell in a table.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={kind}
          onValueChange={(v) => setKind(v as Kind)}
          className="grid gap-3"
          aria-label="What a click does"
        >
          <label className="flex cursor-pointer gap-2.5">
            <RadioGroupItem value="filter" aria-label="Filter this page" className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Filter this page</span>
              <span className="block text-xs text-muted-foreground">
                The other widgets here narrow to what was clicked. Click it again to clear.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-2.5">
            <RadioGroupItem
              value="page"
              aria-label="Open another page"
              className="mt-0.5"
              disabled={others.length === 0}
            />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-sm font-medium">Open another page, filtered to it</span>
              <span className="block text-xs text-muted-foreground">
                {others.length === 0
                  ? "This dashboard has one page. Add a page to open from here."
                  : "That page's widgets narrow to the clicked value, and {{selected}} in its titles and text says what it is."}
              </span>
              {kind === "page" && others.length > 0 && (
                <Select value={pageId || undefined} onValueChange={setPageId}>
                  <SelectTrigger className="h-8 text-xs" aria-label="Page to open">
                    <SelectValue placeholder="Pick a page" />
                  </SelectTrigger>
                  <SelectContent>
                    {others.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </span>
          </label>
          <label className="flex cursor-pointer gap-2.5">
            <RadioGroupItem value="url" aria-label="Open a link" className="mt-0.5" />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-sm font-medium">Open a link</span>
              <span className="block text-xs text-muted-foreground">
                In a new tab. Write <code className="rounded bg-muted px-1">{"{{value}}"}</code>{" "}
                where the clicked value goes.
              </span>
              {kind === "url" && (
                <>
                  <Label htmlFor="click-url" className="sr-only">
                    Link
                  </Label>
                  <Input
                    id="click-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/stations?name={{value}}"
                    className="h-8 font-mono text-xs"
                  />
                  {url.trim() && (
                    <span className="block break-all text-[10px] text-muted-foreground">
                      {example ? `Opens ${example}` : "Not a full https:// or http:// address yet"}
                    </span>
                  )}
                </>
              )}
            </span>
          </label>
        </RadioGroup>
        <DialogFooter>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
