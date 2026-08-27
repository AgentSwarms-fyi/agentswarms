// Global command palette (Ctrl/⌘-K): every page and the common create
// actions, one keystroke away. Navigation items come from the same NAV_GROUPS
// the sidebar renders, so the two can never disagree.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Monitor, Moon, Plus, Sun } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV_GROUPS } from "@/lib/appNav";
import { THEMES, useTheme } from "@/hooks/use-theme";
import { useIsSuperadmin } from "@/hooks/use-iam";

const CREATE_ACTIONS = [
  { title: "New agent", url: "/agents", search: { new: 1 } as Record<string, unknown> },
  { title: "New swarm", url: "/swarms", search: undefined },
  { title: "New BI project", url: "/bi", search: undefined },
  { title: "New knowledge base", url: "/knowledge", search: undefined },
  { title: "New notebook", url: "/notebooks", search: undefined },
] as const;

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

  const groups = useMemo(() => {
    if (!isSuperadmin) return NAV_GROUPS;
    return [
      ...NAV_GROUPS,
      {
        label: "Admin",
        items: [
          { title: "IAM", url: "/admin/iam", icon: undefined },
          { title: "Developer runtime", url: "/admin/runtime", icon: undefined },
        ],
      },
    ];
  }, [isSuperadmin]);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages and actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Create">
          {CREATE_ACTIONS.map((a) => (
            <CommandItem
              key={a.title}
              onSelect={() =>
                run(() =>
                  navigate(
                    a.search ? { to: a.url, search: a.search as never } : ({ to: a.url } as never),
                  ),
                )
              }
            >
              <Plus className="mr-2 h-4 w-4 text-primary" />
              {a.title}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        {groups.map((g) => (
          <CommandGroup key={g.label} heading={g.label}>
            {g.items.map((item) => {
              const Icon = "icon" in item ? item.icon : undefined;
              return (
                <CommandItem
                  key={item.url}
                  onSelect={() => run(() => navigate({ to: item.url } as never))}
                >
                  {Icon ? (
                    <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                  ) : (
                    <span className="mr-2 inline-block h-4 w-4" />
                  )}
                  {item.title}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Preferences">
          {/* One entry per theme rather than a toggle: with three of them,
              "switch to the other one" no longer names anything. */}
          {THEMES.map((t) => (
            <CommandItem key={t.id} onSelect={() => run(() => setTheme(t.id))}>
              {t.id === "dark" ? (
                <Moon className="mr-2 h-4 w-4 text-muted-foreground" />
              ) : t.id === "light" ? (
                <Sun className="mr-2 h-4 w-4 text-muted-foreground" />
              ) : (
                <Monitor className="mr-2 h-4 w-4 text-muted-foreground" />
              )}
              {t.label}
              {theme === t.id && <CommandShortcut>current</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** Global hotkey: Ctrl/⌘-K opens the palette from anywhere in the app. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
