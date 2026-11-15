// One HTTP header's value: text, or a secret (R493).
//
// A header is where a request carries its credential, and the one place a
// secret shared with the author may go (toward a host its owner allowed). So a
// header row asks where its value comes from. "Text" is free text, templates
// and all. "Secret" is a scheme ("Bearer ", or none) and a secret picked by
// name, stored as `Bearer {{secret:NAME}}`: the spelling the server resolves,
// which nobody has to type.
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SecretSelect } from "@/components/secrets/SecretSelect";
import { cn } from "@/lib/utils";
import {
  HEADER_SECRET_PREFIXES,
  headerSecretValue,
  initialHeaderSource,
  isCredentialHeader,
  isTypedHeaderKey,
  parseHeaderSecret,
  parseSecretRef,
  secretRef,
  type HeaderSecretPrefix,
} from "@/lib/secretRefs";

type Source = "text" | "secret";

const PREFIX_NONE = "__none";

/**
 * Render rows with keys from `useRowKeys` (src/hooks/use-row-keys.ts): the
 * value source is this component's own state, and an index key would hand it
 * to the next row when one above is removed.
 */
export function SecretHeaderValue({
  headerName,
  value,
  onChange,
  destination,
  index,
  textPlaceholder = "application/json",
  textHint,
  size = "sm",
}: {
  headerName: string;
  value: string;
  onChange: (value: string) => void;
  /** The request's URL: a secret shared with you is sent only toward hosts its owner allowed. */
  destination?: string | null;
  /** The row's position, for accessible names. */
  index: number;
  textPlaceholder?: string;
  /** How to write a text value, e.g. which template syntax applies. */
  textHint?: React.ReactNode;
  size?: "sm" | "md";
}) {
  const parsed = parseHeaderSecret(value);
  const [source, setSource] = useState<Source>(() => initialHeaderSource(headerName, value));
  const [pendingPrefix, setPendingPrefix] = useState<HeaderSecretPrefix>(() =>
    /^(proxy-)?authorization$/i.test(headerName.trim()) ? "Bearer " : "",
  );

  // An empty row follows its name: "Authorization" asks for a secret,
  // "Content-Type" for text. Once it has a value, only the user moves it.
  const lastName = useRef(headerName);
  useEffect(() => {
    if (lastName.current === headerName) return;
    lastName.current = headerName;
    if (value !== "") return;
    setSource(isCredentialHeader(headerName) ? "secret" : "text");
    if (/^(proxy-)?authorization$/i.test(headerName.trim())) setPendingPrefix("Bearer ");
  }, [headerName, value]);

  const prefix = parsed ? parsed.prefix : pendingPrefix;
  const typedKey = isTypedHeaderKey(headerName, value);
  const h = size === "sm" ? "h-7 text-xs" : "h-9 text-sm";
  const label = `Header ${index + 1}`;

  const switchTo = (next: Source) => {
    if (next === source) return;
    setSource(next);
    // A value written for one source means nothing to the other. Switching a
    // saved key to Text clears it rather than putting it on screen.
    onChange("");
  };

  return (
    <div className="grid min-w-0 gap-1">
      <Select value={source} onValueChange={(v) => switchTo(v as Source)}>
        <SelectTrigger className={h} aria-label={`${label} value source`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="text" className="text-xs">
            Text
          </SelectItem>
          <SelectItem value="secret" className="text-xs">
            Secret
          </SelectItem>
        </SelectContent>
      </Select>
      {source === "secret" ? (
        <div className="flex min-w-0 items-start gap-1">
          <Select
            value={prefix === "" ? PREFIX_NONE : prefix}
            onValueChange={(v) => {
              const p = (v === PREFIX_NONE ? "" : v) as HeaderSecretPrefix;
              setPendingPrefix(p);
              if (parsed) onChange(headerSecretValue(p, parsed.name));
            }}
          >
            <SelectTrigger className={cn(h, "w-[5.5rem] shrink-0")} aria-label={`${label} scheme`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HEADER_SECRET_PREFIXES.map((p) => (
                <SelectItem key={p || PREFIX_NONE} value={p || PREFIX_NONE} className="text-xs">
                  {p ? p.trim() : "No scheme"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SecretSelect
            className="flex-1"
            size={size}
            aria-label={`${label} secret`}
            // The secret part, or the key typed here before, which the picker
            // shows as a key saved directly and never displays.
            value={parsed ? secretRef(parsed.name) : value}
            onChange={(v) => {
              const name = parseSecretRef(v);
              onChange(name ? headerSecretValue(prefix, name) : "");
            }}
            destination={destination ? [destination] : undefined}
            purpose={headerName.trim() ? `For the ${headerName.trim()} header.` : undefined}
          />
        </div>
      ) : (
        <>
          <Input
            className={cn(h, "font-mono")}
            placeholder={textPlaceholder}
            aria-label={`${label} value`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {typedKey ? (
            <p className="text-[10px] leading-snug text-warning">
              This looks like a key typed in directly, which is saved in plain text. Choose Secret
              as the value source to store it encrypted instead.
            </p>
          ) : textHint ? (
            <p className="text-[10px] leading-snug text-muted-foreground">{textHint}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
