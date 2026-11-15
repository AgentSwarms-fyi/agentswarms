// A key field: a searchable list of the secrets the user may use there (R493).
//
// WHY THIS EXISTS. Every form that needed a credential asked for it as text:
// paste the key, or type `{{secret:NAME}}` from memory. The first put keys into
// configs in plain text (and into every export of a swarm graph); the second
// was a notation nobody should have to hold, where a typo became a literal
// string sent as the password. The names are known, so they are offered. The
// field stores the reference (or, for the few fields built that way, the bare
// name) and the server swaps in the value at use time. Nothing here fetches,
// holds or renders a secret's value.
//
// What a field can be in, and what each looks like:
//   - empty: "Choose a secret".
//   - a secret: its name; a shared one says whose it is and where its owner
//     lets it go, and warns when this field sends it somewhere else.
//   - a name no longer listed (deleted, renamed, unshared): the name, marked
//     not found, with what to do.
//   - a key saved in the field itself (from before, or a write-only field the
//     server holds): "A key is saved here directly — replace it with a
//     secret". It is never shown, and it stays until a secret is picked.
// "New secret…" at the foot of the list creates one in place, encrypted, and
// picks it.
import { useId, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronsUpDown, KeyRound, Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CreateSecretDialog } from "@/components/secrets/CreateSecretDialog";
import { useSecretList } from "@/hooks/use-secret-list";
import {
  destinationHosts,
  ownsSecret,
  sharedSecretNote,
  sharedSecretProblem,
  sharedSecretProblemText,
  usableSecrets,
} from "@/lib/secretChoices";
import { readSecretField, secretFieldValue, type SecretFormat } from "@/lib/secretRefs";
import { cn } from "@/lib/utils";
import type { SecretSummary } from "@/utils/secrets.functions";

export type SecretSelectProps = {
  /** What the field stores now. */
  value: string;
  /** Called with what the field should store: a reference, a bare name, or "" when cleared. */
  onChange: (value: string) => void;
  /** `ref` (default) stores `{{secret:NAME}}`; `name` stores the bare NAME. */
  format?: SecretFormat;
  /**
   * The server resolves only the caller's own secrets here (a sandbox's
   * environment, a URL): shared ones are not offered.
   */
  ownedOnly?: boolean;
  /**
   * Where the value is sent (URLs or hosts), when the field knows: a shared
   * secret whose owner did not allow one of them is flagged, and a new secret
   * starts with them as its allowed hosts.
   */
  destination?: string | readonly string[] | null;
  /**
   * A key is saved for this field on the server, out of this page's reach (a
   * write-only field whose form starts empty). Shown as a key saved directly.
   */
  storedKey?: boolean;
  /**
   * What to say about text in the field that is not a reference, where the
   * default ("keeps working until you pick one") is untrue: a binding that the
   * run ignores unless it names a secret, say.
   */
  rawNote?: string;
  /** Offer "None" to clear the field. */
  optional?: boolean;
  /** For a `<Label htmlFor>`. */
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
  disabled?: boolean;
  /** A name the New secret form starts from, such as `OPENAI_API_KEY`. */
  suggestedName?: string;
  /** Which field it is for, said in the New secret form. */
  purpose?: string;
  /** `sm` for the compact inspectors (h-7), `md` (default, h-9) for forms. */
  size?: "sm" | "md";
  className?: string;
};

type Found =
  | { kind: "none" }
  | { kind: "listed"; secret: SecretSummary; mine: boolean }
  /** Listed, but shared, where only the caller's own resolve. */
  | { kind: "shared-here"; secret: SecretSummary }
  | { kind: "missing" };

export function SecretSelect({
  value,
  onChange,
  format = "ref",
  ownedOnly = false,
  destination,
  storedKey = false,
  rawNote,
  optional = false,
  id,
  "aria-label": ariaLabel,
  placeholder = "Choose a secret",
  disabled,
  suggestedName,
  purpose,
  size = "md",
  className,
}: SecretSelectProps) {
  const list = useSecretList();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const statusId = useId();

  const destinations: readonly string[] =
    typeof destination === "string" ? [destination] : (destination ?? []);
  const state = readSecretField(value, format, storedKey);
  const me = list.me;

  // What the list offers. A shared secret with the same name as one of yours
  // never resolves (yours wins), so it is not offered.
  const usable = useMemo(() => {
    const all = usableSecrets(list.secrets, me, { ownedOnly });
    const ownNames = new Set(all.filter((s) => ownsSecret(s, me)).map((s) => s.name));
    return all.filter((s) => ownsSecret(s, me) || !ownNames.has(s.name));
  }, [list.secrets, me, ownedOnly]);
  const sharedNameCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of usable) if (!ownsSecret(s, me)) m.set(s.name, (m.get(s.name) ?? 0) + 1);
    return m;
  }, [usable, me]);

  const found = findSecret(state, list, ownedOnly);

  const q = query.trim().toLowerCase();
  const matches = (s: SecretSummary) =>
    !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
  const mineShown = usable.filter((s) => ownsSecret(s, me) && matches(s));
  const sharedShown = usable.filter((s) => !ownsSecret(s, me) && matches(s));

  const pick = (name: string) => {
    onChange(secretFieldValue(name, format));
    setOpen(false);
    setQuery("");
  };
  const startCreate = () => {
    setOpen(false);
    setQuery("");
    setCreateOpen(true);
  };

  // ── The trigger's text ────────────────────────────────────────────────────
  let shown: React.ReactNode;
  if (state.kind === "raw") {
    shown = rawNote ? (
      <span className="truncate text-destructive">Text, not a secret</span>
    ) : (
      <span className="truncate text-warning">Key saved in this field</span>
    );
  } else if (state.kind === "invalid") {
    shown = (
      <span className="truncate">
        <span className="font-mono">{state.text}</span>
        <span className="ml-1.5 text-destructive">not a secret name</span>
      </span>
    );
  } else if (state.kind === "secret") {
    shown = (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono">{state.name}</span>
        {found.kind === "missing" ? (
          <span className="shrink-0 text-destructive">not found</span>
        ) : found.kind === "shared-here" ? (
          <span className="shrink-0 text-destructive">shared, not usable here</span>
        ) : found.kind === "listed" && !found.mine ? (
          <span className="shrink-0 rounded-sm border px-1 text-[10px] text-muted-foreground">
            shared
          </span>
        ) : null}
      </span>
    );
  } else {
    shown = <span className="truncate text-muted-foreground">{placeholder}</span>;
  }

  // ── The line under it ─────────────────────────────────────────────────────
  let status: { tone: "warn" | "error" | "note"; text: string } | null = null;
  if (state.kind === "raw") {
    status = rawNote
      ? { tone: "error", text: rawNote }
      : {
          tone: "warn",
          text: "A key is saved here directly — replace it with a secret. It keeps working until you pick one, and is never shown.",
        };
  } else if (state.kind === "invalid") {
    status = {
      tone: "error",
      text: `"${state.text}" is not a secret name. Pick a secret from the list.`,
    };
  } else if (found.kind === "missing" && state.kind === "secret") {
    status = {
      tone: "error",
      text: `No secret named ${state.name} is available to you: it was deleted or renamed, or is no longer shared with you. Pick another, or create it with New secret.`,
    };
  } else if (found.kind === "shared-here") {
    status = {
      tone: "error",
      text: `${found.secret.name} is shared with you, but this field takes only secrets you own: its value would reach something you control. Pick one of yours, or create it with New secret.`,
    };
  } else if (found.kind === "listed" && !found.mine) {
    const problem = sharedSecretProblem(found.secret, me, destinations);
    status = problem
      ? {
          tone: problem.kind === "host-not-allowed" ? "warn" : "note",
          text: sharedSecretProblemText(found.secret.name, problem),
        }
      : { tone: "note", text: sharedSecretNote(found.secret) };
  }

  const height = size === "sm" ? "h-7 px-2 text-xs" : "h-9 text-sm";

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          // A secret made on /secrets since this page loaded shows up.
          if (o) void list.reload();
          else setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={ariaLabel}
            aria-describedby={status ? statusId : undefined}
            aria-invalid={status?.tone === "error" || undefined}
            id={id}
            disabled={disabled}
            className={cn(
              "w-full justify-between gap-1.5 font-normal",
              height,
              status?.tone === "error" && "border-destructive/60",
              state.kind === "raw" && "border-warning/60",
            )}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <KeyRound className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
              {shown}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] min-w-[18rem] p-0"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search secrets…"
              value={query}
              onValueChange={setQuery}
              autoFocus
            />
            <CommandList className="max-h-72">
              {!list.loaded ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your secrets…
                </div>
              ) : list.error && list.secrets.length === 0 ? (
                <div role="alert" className="space-y-1.5 px-3 py-3 text-xs">
                  <p className="text-warning">Your secrets could not be listed: {list.error}</p>
                  <button
                    type="button"
                    className="text-primary underline underline-offset-2"
                    onClick={() => void list.reload()}
                  >
                    Try again
                  </button>
                </div>
              ) : mineShown.length + sharedShown.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  {q
                    ? `No secret matches “${query.trim()}”.`
                    : ownedOnly
                      ? "You have no secrets yet. Create one with New secret below."
                      : "No secrets yet, of yours or shared with you. Create one with New secret below."}
                </p>
              ) : null}
              {mineShown.length > 0 ? (
                <CommandGroup heading="Your secrets">
                  {mineShown.map((s) => (
                    <SecretRow
                      key={s.id}
                      secret={s}
                      selected={state.kind === "secret" && state.name === s.name}
                      onPick={pick}
                    />
                  ))}
                </CommandGroup>
              ) : null}
              {sharedShown.length > 0 ? (
                <CommandGroup heading="Shared with you">
                  {sharedShown.map((s) => {
                    const problem = sharedSecretProblem(s, me, destinations);
                    return (
                      <SecretRow
                        key={s.id}
                        secret={s}
                        selected={state.kind === "secret" && state.name === s.name}
                        onPick={pick}
                        note={sharedSecretNote(s)}
                        warning={
                          (sharedNameCount.get(s.name) ?? 0) > 1
                            ? "Two secrets shared with you use this name, so the run cannot tell them apart."
                            : problem?.kind === "host-not-allowed"
                              ? `Not allowed toward ${problem.hosts.join(", ")}: the run will refuse it here.`
                              : undefined
                        }
                      />
                    );
                  })}
                </CommandGroup>
              ) : null}
              <CommandSeparator />
              <CommandGroup>
                {optional && value ? (
                  <CommandItem
                    value="__secret_select_clear"
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                  >
                    <X className="mr-2 h-3.5 w-3.5" aria-hidden />
                    <span className="text-xs">None</span>
                  </CommandItem>
                ) : null}
                <CommandItem value="__secret_select_new" onSelect={startCreate}>
                  <Plus className="mr-2 h-3.5 w-3.5" aria-hidden />
                  <span className="text-xs font-medium">New secret…</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {status ? (
        <p
          id={statusId}
          className={cn(
            "flex items-start gap-1 text-[11px] leading-snug",
            status.tone === "error" && "text-destructive",
            status.tone === "warn" && "text-warning",
            status.tone === "note" && "text-muted-foreground",
          )}
        >
          {status.tone !== "note" ? (
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
          ) : null}
          <span>{status.text}</span>
        </p>
      ) : null}
      <CreateSecretDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialName={suggestedName ?? ""}
        initialHosts={ownedOnly ? [] : (destinationHosts(destinations) ?? [])}
        purpose={purpose}
        onCreated={(name) => {
          void list.reload();
          onChange(secretFieldValue(name, format));
        }}
      />
    </div>
  );
}

/** The listed secret a field's value names, by the resolver's rule: your own first. */
function findSecret(
  state: ReturnType<typeof readSecretField>,
  list: { secrets: SecretSummary[]; me: string | null; loaded: boolean; error: string | null },
  ownedOnly: boolean,
): Found {
  if (state.kind !== "secret") return { kind: "none" };
  const own = list.secrets.find((s) => s.name === state.name && ownsSecret(s, list.me));
  if (own) return { kind: "listed", secret: own, mine: true };
  const shared = list.secrets.find((s) => s.name === state.name);
  if (shared) {
    return ownedOnly
      ? { kind: "shared-here", secret: shared }
      : { kind: "listed", secret: shared, mine: false };
  }
  // Until a listing has answered, a name is just a name.
  return list.loaded && !list.error ? { kind: "missing" } : { kind: "none" };
}

function SecretRow({
  secret,
  selected,
  onPick,
  note,
  warning,
}: {
  secret: SecretSummary;
  selected: boolean;
  onPick: (name: string) => void;
  note?: string;
  warning?: string;
}) {
  return (
    <CommandItem value={secret.id} onSelect={() => onPick(secret.name)} className="items-start">
      <Check
        className={cn("mr-2 mt-0.5 h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{secret.name}</span>
        {secret.description ? (
          <span className="block truncate text-[10px] text-muted-foreground">
            {secret.description}
          </span>
        ) : null}
        {note ? <span className="block text-[10px] text-muted-foreground">{note}</span> : null}
        {warning ? <span className="block text-[10px] text-warning">{warning}</span> : null}
      </span>
    </CommandItem>
  );
}
