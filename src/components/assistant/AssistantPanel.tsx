// The assistant, beside every page. It knows the page the reader is on and
// the thing open on it, answers how-to questions from the handbook, finds the
// reader's own things by name, and links both. Since R552 any of the reader's
// things can be mentioned with @, and the assistant reads it (as the reader)
// to answer about it. It reads and explains; it changes nothing.
import { useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowUp, Loader2, MessageSquareText, Square, SquarePen, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { AssistantState } from "@/hooks/use-assistant";
import { useIsMobile } from "@/hooks/use-mobile";
import { assistantPage, type AssistantPage } from "@/lib/assistantPage";
import { assistantPlacement, type AssistantPlacement } from "@/lib/assistantPlacement";
import { assistantSystemPrompt, starterQuestions } from "@/lib/assistantPrompt";
import {
  appPath,
  insertMention,
  liveMentions,
  localHandbookLinks,
  mentionAt,
  showMentionList,
  MENTIONS_MAX,
  toolLabel,
  type AssistantMention,
  type AssistantMessage,
  type AssistantToolUse,
} from "@/lib/assistantThread";
import { objectKind, type ObjectEntry } from "@/lib/objectKinds";
import { rankObjects } from "@/lib/objectSearch";
import { cn } from "@/lib/utils";
import { useObjectIndex } from "@/hooks/use-object-index";
import { objectsByIds } from "@/utils/objectSearch.functions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The open object's name, read as the reader (an id they cannot see names nothing). */
function useObjectName(page: AssistantPage): string | null {
  const [names, setNames] = useState<Record<string, string>>({});
  // Asked once per object; kept in a ref so asking does not re-run the effect
  // (and drop its own answer).
  const asked = useRef(new Set<string>());
  const kind = page.object?.kind;
  const id = page.object?.id;
  const key = kind && id ? `${kind}:${id}` : null;
  useEffect(() => {
    if (!kind || !id || !key || asked.current.has(key)) return;
    asked.current.add(key);
    if (kind === "lakehouse_table") {
      // A lakehouse table's id is its schema-qualified name.
      setNames((n) => ({ ...n, [key]: id }));
      return;
    }
    if (!UUID.test(id)) return;
    objectsByIds({ data: { ids: { [kind]: [id] } } })
      .then((r) => {
        const hit = r.entries.find((e) => e.kind === kind && e.id === id);
        if (hit) setNames((n) => ({ ...n, [key]: hit.name }));
      })
      .catch(() => {
        // No name: the prompt says "a dashboard" instead. Ask again next time.
        asked.current.delete(key);
      });
  }, [kind, id, key]);
  return key ? (names[key] ?? null) : null;
}

/** The page's visible title, read when a question is asked. */
function visibleHeading(): string | null {
  if (typeof document === "undefined") return null;
  const h =
    document.querySelector<HTMLElement>("main h1") ??
    document.querySelector<HTMLElement>("main [data-testid='workbook-name']");
  return h?.textContent?.trim() || null;
}

/** "Agent Builder", or "Dashboard “Sales overview”" when one is open. */
function whereLabel(page: AssistantPage, objectName: string | null): string {
  if (page.object) {
    const label = objectKind(page.object.kind).label;
    return objectName ? `${label} “${objectName}”` : label;
  }
  return page.title ?? "This page";
}

function ToolLines({ tools }: { tools: AssistantMessage["tools"] }) {
  if (!tools?.length) return null;
  // One line per kind of look-up: three handbook reads are one "Read the handbook".
  const seen = new Map<string, AssistantToolUse>();
  for (const t of tools) {
    const was = seen.get(t.name);
    if (!was || t.status === "running") seen.set(t.name, t);
  }
  return (
    <ul className="mb-1.5 space-y-0.5">
      {[...seen.values()].map((t) => (
        <li key={t.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <span className="h-1 w-1 rounded-full bg-muted-foreground/60" aria-hidden />
          )}
          {toolLabel(t)}
        </li>
      ))}
    </ul>
  );
}

/** How many things the @ list offers at once. */
const PICK_MAX = 6;

/** What the @ list shows for what has been typed after the @. */
function pickFrom(entries: readonly ObjectEntry[], query: string): ObjectEntry[] {
  if (query.trim()) return rankObjects(entries, query, { limit: PICK_MAX });
  // Nothing typed yet: the most recently changed.
  return [...entries]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, PICK_MAX);
}

function PanelBody({
  state,
  page,
  objectName,
  onClose,
}: {
  state: AssistantState;
  page: AssistantPage;
  objectName: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  // R552: things mentioned with @ in the draft, and the open @ list.
  const [mentions, setMentions] = useState<AssistantMention[]>([]);
  const [picking, setPicking] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // The same index search reads (one copy, kept a minute), read the first
  // time an @ is typed: exactly the things the reader may open.
  const [wantIndex, setWantIndex] = useState(false);
  const index = useObjectIndex(wantIndex);
  const choices = useMemo(
    () => (picking && !index.loading ? pickFrom(index.entries, picking.query) : []),
    [picking, index.loading, index.entries],
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const where = whereLabel(page, objectName);
  const starters = useMemo(() => starterQuestions(page), [page]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { ask, busy, pending, clearPending } = state;
  const send = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      setDraft("");
      setPicking(null);
      const used = liveMentions(q, mentions);
      setMentions([]);
      const prompt = assistantSystemPrompt(page, { heading: visibleHeading(), objectName });
      void ask(q, prompt, where, used);
    },
    [ask, busy, page, objectName, where, mentions],
  );

  /** The draft changed: is an @word being typed? */
  const onDraft = (value: string, caret: number) => {
    setDraft(value);
    const at = mentionAt(value, caret, mentions);
    setPicking(at);
    setActive(0);
    if (at) setWantIndex(true);
  };

  const pick = (e: ObjectEntry) => {
    if (!picking) return;
    const next = insertMention(draft, picking, e.name);
    setDraft(next.text);
    setPicking(null);
    setMentions((was) =>
      was.some((m) => m.kind === e.kind && m.id === e.id) || was.length >= MENTIONS_MAX
        ? was
        : [...was, { kind: e.kind, id: e.id, name: e.name }],
    );
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  // A question asked from the search box: asked here, where the page is
  // known. Once per id, even when an effect runs twice.
  const askedRef = useRef(0);
  useEffect(() => {
    if (!pending || busy || askedRef.current === pending.id) return;
    askedRef.current = pending.id;
    clearPending(pending.id);
    send(pending.question);
  }, [pending, busy, clearPending, send]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The @ list has the keys while it is open: Esc closes the list, not the panel.
    if (picking && choices.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + step + choices.length) % choices.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pick(choices[Math.min(active, choices.length - 1)]);
        return;
      }
    }
    if (picking && showMentionList(picking.query, choices.length) && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPicking(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };

  // An app link in an answer moves this tab, through the router, so the
  // panel and its conversation stay. A modified click still opens a new tab.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest("a");
    const path = appPath(a?.getAttribute("href"));
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    router.history.push(path);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MessageSquareText className="h-4 w-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-5">Assistant</p>
          <p className="truncate text-xs leading-4 text-muted-foreground" title={where}>
            On {where}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="New conversation"
          title="New conversation"
          disabled={!state.messages.length && !state.busy}
          onClick={() => {
            state.clear();
            inputRef.current?.focus();
          }}
        >
          <SquarePen className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="Close the assistant"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onClickCapture={onClickCapture}
        aria-live="polite"
      >
        {state.messages.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              Ask what this page is for, how to do something, or where one of your things is. Type @
              to ask about one of your things by name. Answers come from the handbook and your own
              work; the assistant does not change anything.
            </p>
            <div className="flex flex-col items-start gap-2">
              {starters.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => send(q)}
                  className="rounded-lg border px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-muted/50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="space-y-5">
            {state.messages.map((m, i) =>
              m.role === "user" ? (
                <li key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm leading-6">
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  </div>
                </li>
              ) : (
                <li key={i} className="min-w-0">
                  <ToolLines tools={m.tools} />
                  {m.error ? (
                    <p className="text-sm leading-6 text-muted-foreground">{m.content}</p>
                  ) : m.content ? (
                    <div className="text-sm [&_p]:my-2 [&_p]:leading-6">
                      <MarkdownMessage content={localHandbookLinks(m.content)} />
                    </div>
                  ) : !m.tools?.length ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Thinking…
                    </p>
                  ) : null}
                </li>
              ),
            )}
          </ol>
        )}
      </div>

      <div className="relative shrink-0 border-t p-3">
        {picking && (index.loading || showMentionList(picking.query, choices.length)) ? (
          <div
            className="absolute inset-x-3 bottom-full mb-1 overflow-hidden rounded-lg border bg-popover shadow-md"
            data-testid="assistant-mention-list"
          >
            {index.loading ? (
              <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Reading your work…
              </p>
            ) : choices.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {picking.query
                  ? `Nothing of yours is named like “${picking.query}”.`
                  : "Type a name."}
              </p>
            ) : (
              <ul role="listbox" aria-label="Your things" className="py-1">
                {choices.map((c, i) => {
                  const k = objectKind(c.kind);
                  const Icon = k.icon;
                  return (
                    <li key={`${c.kind}:${c.id}`} role="option" aria-selected={i === active}>
                      <button
                        type="button"
                        // Pressed before the textarea loses focus, so the caret stays.
                        onMouseDown={(ev) => {
                          ev.preventDefault();
                          pick(c);
                        }}
                        onMouseEnter={() => setActive(i)}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                          i === active ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {k.label}
                          {c.mine ? "" : " · shared"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
        <div className="flex items-end gap-2 rounded-lg border bg-background px-2 py-1.5 focus-within:border-foreground/25">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) =>
              onDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }
            onKeyDown={onKeyDown}
            onBlur={() => setPicking(null)}
            rows={1}
            placeholder="Ask about this page, or @ one of your things…"
            aria-label="Ask the assistant"
            className="max-h-40 min-h-[2rem] flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground [field-sizing:content]"
          />
          {state.busy ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-lg"
              aria-label="Stop"
              title="Stop"
              onClick={state.stop}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-lg"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!draft.trim()}
              onClick={() => send(draft)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] leading-4 text-muted-foreground">
          Uses your workspace's default model. The conversation lasts until you close this tab.
        </p>
      </div>
    </div>
  );
}

/**
 * Beside the page or over it (src/lib/assistantPlacement.ts), from the width of
 * the area the page and the panel share: the panel's parent, which keeps its
 * width whichever way the panel sits. Measured before paint, so the panel does
 * not open beside a page and then jump over it.
 */
function usePlacement(panel: HTMLElement | null): AssistantPlacement {
  const [placement, setPlacement] = useState<AssistantPlacement>("beside");
  useLayoutEffect(() => {
    const room = panel?.parentElement;
    if (!room) return;
    const measure = () => setPlacement(assistantPlacement(room.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(room);
    return () => ro.disconnect();
  }, [panel]);
  return placement;
}

/**
 * The panel: beside the page on a wide screen, floating over its right edge
 * when beside it would leave the page too narrow, and over it on a phone.
 */
export function AssistantPanel({ state }: { state: AssistantState }) {
  const isMobile = useIsMobile();
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const placement = usePlacement(panel);
  const location = useRouterState({ select: (s) => s.location });
  const page = useMemo(
    () => assistantPage(location.pathname, location.search as Record<string, unknown>),
    [location.pathname, location.search],
  );
  const objectName = useObjectName(page);
  const { setOpen } = state;
  // Closing hands focus back to the button that opened the panel, so the
  // keyboard is not dropped at the top of the page.
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("[data-assistant-toggle]")?.focus(),
    );
  }, [setOpen]);

  // Esc closes the panel when focus is inside it; a dialog's own Esc wins.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.stopPropagation();
      close();
    }
  };

  if (isMobile) {
    return (
      <Sheet open={state.open} onOpenChange={state.setOpen}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-md [&>button]:hidden">
          <SheetTitle className="sr-only">Assistant</SheetTitle>
          <PanelBody state={state} page={page} objectName={objectName} onClose={close} />
        </SheetContent>
      </Sheet>
    );
  }
  if (!state.open) return null;
  return (
    <aside
      ref={setPanel}
      aria-label="Assistant"
      data-placement={placement}
      onKeyDown={onKeyDown}
      className={cn(
        "w-[380px] border-l bg-background",
        "top-[var(--app-chrome-h)] h-[calc(100dvh-var(--app-chrome-h))]",
        // Beside: the page gives up the panel's width. Over: the page keeps
        // its width and the panel floats on its right edge, under dialogs.
        placement === "beside"
          ? "sticky z-30 shrink-0 self-start"
          : "fixed right-0 z-40 shadow-2xl",
      )}
    >
      <PanelBody state={state} page={page} objectName={objectName} onClose={close} />
    </aside>
  );
}

/** The header's button for the panel, with its shortcut. */
export function AssistantToggle({ state, isMac }: { state: AssistantState; isMac: boolean }) {
  const { setOpen } = state;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={state.open}
      aria-label="Assistant"
      data-assistant-toggle
      title={`Assistant (${isMac ? "⌘" : "Ctrl"} J)`}
      onClick={() => state.setOpen((v) => !v)}
      className={cn("h-8 gap-1.5 px-2", state.open && "bg-muted text-foreground")}
    >
      <MessageSquareText className="h-4 w-4" />
      <span className="hidden text-xs font-medium md:inline">Assistant</span>
    </Button>
  );
}
