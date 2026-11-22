// Global search (Ctrl/⌘-K): your own work by name, everything you can start,
// and every page — one keystroke away.
//
// The three lists come from one place each: objects from the search index,
// "new" actions from the object kinds, pages from the navigation the sidebar
// renders. What is shown for what was typed is decided by paletteResults, not
// by the component library's built-in filter, so the palette and the results
// page rank the same way.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Laptop, Loader2, Monitor, Moon, Plus, Sun } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { agoLabel, IconTile, ObjectText } from "@/components/search/parts";
import { useCappedMatches, useObjectIndex } from "@/hooks/use-object-index";
import { useIsSuperadmin } from "@/hooks/use-iam";
import { THEMES, useTheme, type ThemePreference } from "@/hooks/use-theme";
import { ADMIN_GROUP, NAV_GROUPS } from "@/lib/appNav";
import { linkToObject, objectKind, type ObjectLink } from "@/lib/objectKinds";
import { mergeEntries, scoreMatch } from "@/lib/objectSearch";
import { createTitle, paletteResults } from "@/lib/paletteSearch";

// Matches ThemeToggle/AppearanceSettingsPanel's icon choice per theme, so
// "System" isn't left sharing Monitor with "AgentSwarms Native" here as if
// the two were the same option.
const THEME_ICONS: Record<ThemePreference, typeof Sun> = {
  system: Laptop,
  native: Monitor,
  dark: Moon,
  light: Sun,
};

const ROW = "gap-3 rounded-lg px-2 py-2";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const isSuperadmin = useIsSuperadmin();
  const [query, setQuery] = useState("");

  // Typing starts from nothing each time the palette opens.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const index = useObjectIndex(open);
  const older = useCappedMatches(open ? query : "", index.capped);
  const entries = useMemo(() => mergeEntries(index.entries, older), [index.entries, older]);

  const navGroups = useMemo(
    () => (isSuperadmin ? [...NAV_GROUPS, ADMIN_GROUP] : NAV_GROUPS),
    [isSuperadmin],
  );
  const results = useMemo(
    () => paletteResults({ query, entries, navGroups }),
    [query, entries, navGroups],
  );
  const themes = results.searching
    ? THEMES.filter((t) => scoreMatch(query, t.label, "theme appearance colours") > 0)
    : THEMES;

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const go = (link: ObjectLink) =>
    run(() => navigate({ to: link.to, search: link.search ?? {} } as never));

  // The pages, in their navigation groups while the palette is a menu and as
  // one ranked list once something is typed.
  const pageGroups = results.searching
    ? [{ label: "Pages", items: results.pages }]
    : navGroups.map((g) => ({
        label: g.label,
        items: results.pages.filter((p) => p.group === g.label),
      }));

  const stillLoading = index.loading && results.searching && results.objectTotal === 0;
  // Kinds whose names have not arrived yet (the lakehouse can take a while
  // after a restart). Until they do, "nothing matches" is only true so far.
  const stillReading = index.pending.map((k) => objectKind(k).plural.toLowerCase()).join(", ");
  // The footer is where "still reading" is said. The empty answer repeats it
  // only when the footer is busy saying something else.
  const footerSaysReading =
    stillReading !== "" && !index.loading && !index.error && index.failed.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Higher than centre: a list that grows downward should not push its
        // own input off the middle of the screen as results arrive.
        className="top-[12vh] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-xl p-0 shadow-2xl data-[state=closed]:slide-out-to-top-[10vh] data-[state=open]:slide-in-from-top-[10vh] sm:rounded-xl"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Find your work by name, start something new, or go to a page.
        </DialogDescription>
        <Command shouldFilter={false} loop className="rounded-xl">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search your work, pages and actions…"
            className="h-12 pr-8"
          />
          <CommandList className="max-h-[min(60vh,460px)] p-1">
            {/* While the index is still arriving, the "Your work" group says so;
                "nothing matches" would be a claim nobody can make yet. */}
            {!stillLoading && (
              <CommandEmpty className="px-4 py-10 text-center text-sm text-muted-foreground">
                {!stillReading
                  ? `Nothing matches “${query.trim()}”.`
                  : footerSaysReading
                    ? `Nothing matches “${query.trim()}” so far.`
                    : `Nothing matches “${query.trim()}” so far. Still reading ${stillReading}…`}
              </CommandEmpty>
            )}

            {results.searching && (results.objects.length > 0 || stillLoading) && (
              <CommandGroup heading="Your work">
                {results.objects.map((e) => (
                  <CommandItem
                    key={`${e.kind}:${e.id}`}
                    value={`object:${e.kind}:${e.id}`}
                    onSelect={() => go(linkToObject(e))}
                    className={ROW}
                  >
                    <IconTile icon={objectKind(e.kind).icon} />
                    <ObjectText entry={e} query={query} />
                    {/* When it last changed: what tells two things with one
                        name apart. */}
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {agoLabel(e.updatedAt)}
                    </span>
                  </CommandItem>
                ))}
                {stillLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Searching your work…
                  </div>
                )}
                {results.objectTotal > 0 && (
                  <CommandItem
                    value="object:all"
                    onSelect={() =>
                      run(() => navigate({ to: "/search", search: { q: query.trim() } } as never))
                    }
                    className={`${ROW} text-muted-foreground`}
                  >
                    <IconTile icon={ArrowRight} className="bg-transparent" />
                    <span className="text-sm">
                      {results.objectTotal > results.objects.length
                        ? `See all ${results.objectTotal} results`
                        : "Open in search"}
                    </span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}

            {results.create.length > 0 && (
              <CommandGroup heading="Create">
                {results.create.map((a) => (
                  <CommandItem
                    key={a.kind}
                    value={`create:${a.kind}`}
                    onSelect={() => go(a.link)}
                    className={ROW}
                  >
                    <IconTile icon={Plus} className="bg-primary/10 text-primary" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{createTitle(a)}</span>
                      {results.searching && (
                        <span className="truncate text-xs text-muted-foreground">{a.hint}</span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {pageGroups.map(
              (g) =>
                g.items.length > 0 && (
                  <CommandGroup key={g.label} heading={g.label}>
                    {g.items.map((item) => (
                      <CommandItem
                        key={item.url}
                        value={`page:${item.url}`}
                        onSelect={() => run(() => navigate({ to: item.url } as never))}
                        className={ROW}
                      >
                        <IconTile icon={item.icon} className="bg-transparent" />
                        <span className="flex-1 truncate text-sm">{item.title}</span>
                        {results.searching && (
                          <span className="text-xs text-muted-foreground">{item.group}</span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ),
            )}

            {themes.length > 0 && (
              <CommandGroup heading="Preferences">
                {/* One entry per theme rather than a toggle: with four of them,
                    "switch to the other one" no longer names anything. */}
                {themes.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`theme:${t.id}`}
                    onSelect={() => run(() => setTheme(t.id))}
                    className={ROW}
                  >
                    <IconTile icon={THEME_ICONS[t.id]} className="bg-transparent" />
                    <span className="flex-1 truncate text-sm">{t.label}</span>
                    {theme === t.id && <CommandShortcut>current</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>

          <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              {index.error ? (
                `Your work could not be searched: ${index.error}`
              ) : index.failed.length > 0 ? (
                `Not searched just now: ${index.failed.map((k) => objectKind(k).plural.toLowerCase()).join(", ")}`
              ) : footerSaysReading ? (
                <>
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                  <span className="truncate">Still reading {stillReading}…</span>
                </>
              ) : (
                "Finds your work by name"
              )}
            </span>
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
              <kbd className="rounded border bg-muted px-1 font-mono">↑↓</kbd> move
              <kbd className="ml-1.5 rounded border bg-muted px-1 font-mono">↵</kbd> open
              <kbd className="ml-1.5 rounded border bg-muted px-1 font-mono">esc</kbd> close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
