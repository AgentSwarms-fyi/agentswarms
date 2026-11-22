// The top of every page: where you are, what the page is called, one line on
// what it is for, and the page's own actions on the right.
//
// One component, so every page opens the same way. Before it, page titles came
// in three sizes and two typefaces, some with an icon and some without, and
// the eye had to find the title again on each page. A title here is a label,
// not a poster: the work below it is what the page is for.
import type { ReactNode } from "react";

import { PageEyebrow } from "@/components/PageEyebrow";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  meta,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  /** One sentence on what this page is for. */
  description?: ReactNode;
  /** Something small that belongs beside the title: a count, a status. */
  meta?: ReactNode;
  /** The page's own buttons, right-aligned. One of them, at most, is primary. */
  actions?: ReactNode;
  /** For a page the menu does not list (Settings, Account): the group to name. */
  eyebrow?: string;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start gap-x-6 gap-y-3", className)}>
      {/* The text takes the room the buttons leave, so they stay on the right
          beside the title; only on a narrow screen do they move under it. */}
      <div className="min-w-0 flex-1 basis-72">
        <PageEyebrow fallback={eyebrow} />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="truncate text-[22px] font-semibold leading-7 tracking-[-0.012em] text-foreground">
            {title}
          </h1>
          {meta}
        </div>
        {description ? (
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

/** A small count beside a title: "14 agents". */
export function TitleCount({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}
