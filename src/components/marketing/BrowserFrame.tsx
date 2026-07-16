import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type BrowserFrameProps = {
  children: ReactNode;
  url?: string;
  className?: string;
};

/** Browser-chrome frame for product screenshots and video. */
export function BrowserFrame({ children, url, className }: BrowserFrameProps) {
  return (
    <div
      className={cn(
        "max-w-full overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl shadow-primary/10 ring-1 ring-foreground/5",
        className,
      )}
    >
      <div className="relative flex h-9 items-center gap-1.5 border-b border-border bg-muted/40 px-4">
        <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/20" />
        <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/20" />
        <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/20" />
        {url ? (
          <span className="absolute left-1/2 max-w-[64%] -translate-x-1/2 truncate rounded-full bg-background/80 px-3 py-0.5 font-mono text-[10px] text-muted-foreground">
            {url}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}
