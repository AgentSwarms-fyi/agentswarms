// Conditional formatting for the matrix: a colour scale, or first-match-wins rules.
//
// The best extraction in BiBuilderPane by a wide margin — 160 lines of JSX
// against SIX of the parent's values. It was buried inside the matrix branch
// of the chart editor, which is why a scan of that whole branch made it look
// coupled: the branch's dependency count is a union over chart types that are
// mutually exclusive, and this piece touches almost none of it.
//
// Rule order is meaningful (first match wins), so this deliberately offers no
// sort: the order shown is the order applied.
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BiCondRule } from "@/lib/biAgent";
import { COND_COLORS } from "@/lib/biChartMath";

export function BiCondFormatEditor({
  matFmtMode,
  setMatFmtMode,
  matScaleColor,
  setMatScaleColor,
  matRules,
  setMatRules,
}: {
  matFmtMode: string;
  setMatFmtMode: (v: string) => void;
  matScaleColor: string;
  setMatScaleColor: (v: string) => void;
  matRules: BiCondRule[];
  setMatRules: React.Dispatch<React.SetStateAction<BiCondRule[]>>;
}) {
  return (
    <div className="col-span-2 space-y-1.5">
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Conditional formatting
      </Label>
      <Select value={matFmtMode} onValueChange={setMatFmtMode}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none" className="text-xs">
            None
          </SelectItem>
          <SelectItem value="scale" className="text-xs">
            Colour scale (min → max)
          </SelectItem>
          <SelectItem value="rules" className="text-xs">
            Rules (first match wins)
          </SelectItem>
        </SelectContent>
      </Select>
      {matFmtMode === "scale" && (
        <div className="flex items-center gap-1.5 pt-0.5">
          {Object.entries(COND_COLORS).map(([id, c]) => (
            <button
              key={id}
              type="button"
              title={c.label}
              onClick={() => setMatScaleColor(id)}
              className={`h-6 w-8 rounded-md border ${
                matScaleColor === id ? "border-foreground" : "border-border/60"
              }`}
              style={{
                background: `linear-gradient(to right, color-mix(in oklch, ${c.hex} 10%, transparent), ${c.hex})`,
              }}
            />
          ))}
        </div>
      )}
      {matFmtMode === "rules" && (
        <div className="space-y-1.5 pt-0.5">
          {matRules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1">
              <Select
                value={r.op}
                onValueChange={(v) =>
                  setMatRules((rs) =>
                    rs.map((x, j) => (j === i ? { ...x, op: v as BiCondRule["op"] } : x)),
                  )
                }
              >
                <SelectTrigger className="h-7 w-24 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      ["gt", "> above"],
                      ["gte", "≥ at least"],
                      ["lt", "< below"],
                      ["lte", "≤ at most"],
                      ["eq", "= equals"],
                      ["neq", "≠ not"],
                      ["between", "between"],
                    ] as const
                  ).map(([v, l]) => (
                    <SelectItem key={v} value={v} className="text-xs">
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={Number.isFinite(r.value) ? String(r.value) : ""}
                onChange={(e) =>
                  setMatRules((rs) =>
                    rs.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)),
                  )
                }
                inputMode="decimal"
                placeholder="value"
                className="h-7 w-20 text-[11px]"
              />
              {r.op === "between" && (
                <Input
                  value={
                    r.value2 !== undefined && Number.isFinite(r.value2) ? String(r.value2) : ""
                  }
                  onChange={(e) =>
                    setMatRules((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, value2: Number(e.target.value) } : x)),
                    )
                  }
                  inputMode="decimal"
                  placeholder="and"
                  className="h-7 w-20 text-[11px]"
                />
              )}
              <div className="flex gap-0.5">
                {Object.entries(COND_COLORS).map(([id, c]) => (
                  <button
                    key={id}
                    type="button"
                    title={c.label}
                    onClick={() =>
                      setMatRules((rs) => rs.map((x, j) => (j === i ? { ...x, color: id } : x)))
                    }
                    className={`h-5 w-5 rounded border ${
                      r.color === id ? "border-foreground" : "border-border/60"
                    }`}
                    style={{ background: c.hex }}
                  />
                ))}
              </div>
              <button
                type="button"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => setMatRules((rs) => rs.filter((_, j) => j !== i))}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[11px]"
            onClick={() => setMatRules((rs) => [...rs, { op: "gt", value: 0, color: "emerald" }])}
          >
            <Plus className="h-3 w-3" /> Add rule
          </Button>
          <p className="text-[9px] text-muted-foreground">
            Rules are checked top-down; the first match colours the cell. Totals stay uncoloured.
          </p>
        </div>
      )}
    </div>
  );
}
