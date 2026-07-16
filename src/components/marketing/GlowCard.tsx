import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type GlowCardProps = {
  children: ReactNode;
  className?: string;
  /** Adds a soft radial brand tint for the hero cell of a bento grid. */
  featured?: boolean;
};

export function GlowCard({ children, className, featured = false }: GlowCardProps) {
  return (
    <div
      className={cn(
        "glow-card rounded-xl border border-border bg-card p-6",
        featured &&
          "bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_oklch,var(--primary)_6%,var(--card)),var(--card))]",
        className,
      )}
    >
      {children}
    </div>
  );
}
