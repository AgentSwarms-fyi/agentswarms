// The connector field of "Any REST API" (R528): start from a template or the
// example, fill in what the template asks, edit the JSON, and see as you type
// whether it will run and why not. The server checks it again before every use.
import { useMemo, useState } from "react";
import { Check } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { checkConnectorSpec, specOrigin, STARTER_SPEC } from "@/lib/connectorSpec";
import { applyTemplate, CONNECTOR_TEMPLATES, templateById } from "@/lib/connectorTemplates";

const EXAMPLE = "example";

export function RestApiSpecField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [from, setFrom] = useState<string>("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [fillErrors, setFillErrors] = useState<string[]>([]);
  const template = from && from !== EXAMPLE ? templateById(from) : undefined;
  const checked = useMemo(() => (value.trim() ? checkConnectorSpec(value) : null), [value]);

  const write = (spec: unknown) => onChange(JSON.stringify(spec, null, 2));

  const pick = (id: string) => {
    setFrom(id);
    setInputs({});
    setFillErrors([]);
    if (id === EXAMPLE) return write(STARTER_SPEC);
    const t = templateById(id);
    // A template with nothing to ask is written straight away.
    if (t && t.inputs.length === 0) {
      const r = applyTemplate(t, {});
      if (r.ok) write(r.spec);
    }
  };

  const fillIn = () => {
    if (!template) return;
    const r = applyTemplate(template, inputs);
    if (r.ok) {
      setFillErrors([]);
      write(r.spec);
    } else setFillErrors(r.errors);
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">Start from</Label>
        <Select value={from} onValueChange={pick}>
          <SelectTrigger className="h-8 text-xs" aria-label="Start from">
            <SelectValue placeholder="A template, or the example" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EXAMPLE}>The example (one list, page by page)</SelectItem>
            {CONNECTOR_TEMPLATES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.label}
                <span className="ml-1.5 text-muted-foreground">
                  {t.checked === "live"
                    ? "· run against a live account"
                    : "· from its API reference"}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {template ? (
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
            <p className="text-[11px] text-muted-foreground">
              {template.description} {template.credential}
              {template.checked === "reference"
                ? " Built from the API's published reference; check the preview before you rely on it."
                : ""}
            </p>
            {template.inputs.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                {template.inputs.map((i) => (
                  <div key={i.key} className="min-w-36 flex-1 space-y-1">
                    <Label className="text-[11px]">{i.label}</Label>
                    <Input
                      className="h-8 text-xs"
                      aria-label={i.label}
                      value={inputs[i.key] ?? ""}
                      placeholder={i.placeholder}
                      onChange={(e) => setInputs((v) => ({ ...v, [i.key]: e.target.value }))}
                    />
                  </div>
                ))}
                <Button type="button" size="sm" variant="outline" className="h-8" onClick={fillIn}>
                  Fill in
                </Button>
              </div>
            ) : null}
            {fillErrors.length ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {fillErrors.join(". ")}.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Textarea
        aria-label="Connector (JSON)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder='{ "name": "…", "base_url": "https://…", "auth": { "kind": "bearer" }, "streams": [ … ] }'
        className="h-56 font-mono text-[11px] leading-relaxed"
      />
      {checked === null ? null : checked.ok ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Check className="h-3 w-3 text-primary" aria-hidden />
          Ready: {checked.spec.streams.length} stream
          {checked.spec.streams.length === 1 ? "" : "s"} on{" "}
          {specOrigin(checked.spec.base_url)?.replace("https://", "")}
          {checked.spec.streams.some((s) => s.incremental)
            ? `, ${checked.spec.streams.filter((s) => s.incremental).length} followed by what changed`
            : ""}
          .
        </p>
      ) : (
        <ul
          className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400"
          aria-label="What to fix in the connector"
        >
          {checked.errors.slice(0, 6).map((e) => (
            <li key={e}>{e}</li>
          ))}
          {checked.errors.length > 6 ? <li>…and {checked.errors.length - 6} more</li> : null}
        </ul>
      )}
    </div>
  );
}
