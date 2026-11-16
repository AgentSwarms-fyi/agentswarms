// The value format picker (currency, percent, decimals) — moved out of
// BiBuilderPane in R499 to make room for the Fields mode. Like the builder's
// other children it owns no state: values and setters in.
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CURRENCY_CODES } from "@/lib/biCurrencies";

export function BiValueFormat({
  numFormat,
  setNumFormat,
  currencyCode,
  setCurrencyCode,
  decimalsSel,
  setDecimalsSel,
}: {
  numFormat: "auto" | "currency" | "percent";
  setNumFormat: (v: "auto" | "currency" | "percent") => void;
  currencyCode: string;
  setCurrencyCode: (v: string) => void;
  decimalsSel: string;
  setDecimalsSel: (v: string) => void;
}) {
  return (
    <div
      className="space-y-1"
      title="How numeric values are displayed on axes, tooltips, KPI and gauge figures"
    >
      <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Value format
      </Label>
      <Select value={numFormat} onValueChange={(v) => setNumFormat(v as typeof numFormat)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto" className="text-xs">
            Auto — 1234 → 1.2k
          </SelectItem>
          <SelectItem value="currency" className="text-xs">
            Currency — 1234 → $1.2k
          </SelectItem>
          <SelectItem value="percent" className="text-xs">
            Percent — 12.3 → 12.3%
          </SelectItem>
        </SelectContent>
      </Select>
      {(numFormat === "currency" || numFormat === "percent") && (
        <div className="flex gap-1.5">
          {numFormat === "currency" && (
            <Select value={currencyCode} onValueChange={setCurrencyCode}>
              <SelectTrigger className="h-7 flex-1 text-[11px]" title="Currency (ISO 4217)">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCY_CODES.map((c) => (
                  <SelectItem key={c} value={c} className="text-xs">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={decimalsSel} onValueChange={setDecimalsSel}>
            <SelectTrigger className="h-7 flex-1 text-[11px]" title="Fixed decimal places">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto" className="text-xs">
                Auto decimals
              </SelectItem>
              {["0", "1", "2", "3"].map((d) => (
                <SelectItem key={d} value={d} className="text-xs">
                  {d} decimals
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Formats follow each viewer's locale (separators & symbols).
      </p>
    </div>
  );
}
