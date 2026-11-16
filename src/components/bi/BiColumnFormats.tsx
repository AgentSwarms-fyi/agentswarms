// Table widgets: each column's number format and cell style (R498 moved this
// out of BiBuilderPane, whose size ceiling the cell styles would have broken).
// Like the builder's other children it owns no state: values and a setter in.
import type React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BiColumnStyle } from "@/components/bi/BiColumnStyle";
import type { BiColumnFormat } from "@/lib/biAgent";
import { CURRENCY_CODES } from "@/lib/biCurrencies";

export function BiColumnFormats({
  columns,
  colFormats,
  setColFormats,
  totals,
  setTotals,
}: {
  columns: string[];
  colFormats: Record<string, BiColumnFormat>;
  setColFormats: React.Dispatch<React.SetStateAction<Record<string, BiColumnFormat>>>;
  /** Show the totals row (R499). */
  totals: boolean;
  setTotals: (v: boolean) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Column formats
        </Label>
        <Label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-normal">
          <Checkbox checked={totals} onCheckedChange={(v) => setTotals(Boolean(v))} />
          Totals row
        </Label>
      </div>
      <div className="space-y-1">
        {columns.map((c) => {
          const cf = colFormats[c] ?? {};
          const val = cf.format ?? "auto";
          return (
            <div key={c} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px]" title={c}>
                {c}
              </span>
              <Select
                value={val}
                onValueChange={(v) =>
                  setColFormats((prev) => {
                    const next = { ...prev };
                    if (v === "auto") {
                      // Auto clears the NUMBER format only; the cell style
                      // (data bar, picture, colours) is a separate choice.
                      const rest = { ...next[c] };
                      delete rest.format;
                      delete rest.currency;
                      if (Object.keys(rest).length > 0) next[c] = rest;
                      else delete next[c];
                    } else next[c] = { ...next[c], format: v as BiColumnFormat["format"] };
                    return next;
                  })
                }
              >
                <SelectTrigger className="h-7 w-24 text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto" className="text-xs">
                    Auto
                  </SelectItem>
                  <SelectItem value="number" className="text-xs">
                    Number
                  </SelectItem>
                  <SelectItem value="currency" className="text-xs">
                    Currency
                  </SelectItem>
                  <SelectItem value="percent" className="text-xs">
                    Percent
                  </SelectItem>
                </SelectContent>
              </Select>
              {cf.format === "currency" && (
                <Select
                  value={cf.currency ?? "USD"}
                  onValueChange={(v) =>
                    setColFormats((prev) => ({ ...prev, [c]: { ...prev[c], currency: v } }))
                  }
                >
                  <SelectTrigger className="h-7 w-20 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_CODES.map((cc) => (
                      <SelectItem key={cc} value={cc} className="text-xs">
                        {cc}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <BiColumnStyle
                column={c}
                value={cf}
                onChange={(next) =>
                  setColFormats((prev) => {
                    const out = { ...prev };
                    const clean = Object.fromEntries(
                      Object.entries(next).filter(([, v]) => v !== undefined),
                    ) as BiColumnFormat;
                    if (Object.keys(clean).length > 0) out[c] = clean;
                    else delete out[c];
                    return out;
                  })
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
