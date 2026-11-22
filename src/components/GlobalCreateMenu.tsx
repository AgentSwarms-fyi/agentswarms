// The "New" menu in the app header: everything that can be started, in one
// place.
//
// It is drawn from the object kinds (src/lib/objectKinds.ts), the same list the
// palette's "Create" group reads — so the two offer the same things, and a kind
// added there appears in both. Each entry is a link to that kind's page asking
// it to start a new one; nothing is created by opening the menu.
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CREATE_SECTIONS, createActions, type CreateSection } from "@/lib/objectKinds";

// Three columns of roughly equal height: the two long sections get a column
// each and the short ones share the third.
const COLUMNS: CreateSection[][] = [
  ["Agents"],
  ["Data"],
  ["Analysis", "Automation", "Connections"],
];

export function GlobalCreateMenu() {
  const actions = createActions();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-md border border-border/60 bg-card/60 px-2.5 text-xs font-medium hover:border-primary/50 hover:text-primary"
          aria-label="Create something new"
          title="Create new"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden md:inline">New</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(80vh,640px)] w-[min(94vw,720px)] overflow-y-auto rounded-xl p-3"
      >
        <div className="grid gap-x-3 gap-y-2 sm:grid-cols-3">
          {COLUMNS.map((sections) => (
            <div key={sections.join()} className="space-y-2">
              {sections
                .filter((s) => CREATE_SECTIONS.includes(s))
                .map((section) => (
                  <div key={section}>
                    <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {section}
                    </DropdownMenuLabel>
                    {actions
                      .filter((a) => a.section === section)
                      .map((a) => (
                        <DropdownMenuItem key={a.kind} asChild className="rounded-lg px-2 py-1.5">
                          <Link
                            to={a.link.to as never}
                            search={(a.link.search ?? {}) as never}
                            title={a.hint}
                            className="flex cursor-pointer items-start gap-2.5"
                          >
                            <span
                              aria-hidden
                              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground"
                            >
                              <a.icon className="h-4 w-4" />
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-sm">{a.title}</span>
                              <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                                {a.hint}
                              </span>
                            </span>
                          </Link>
                        </DropdownMenuItem>
                      ))}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
