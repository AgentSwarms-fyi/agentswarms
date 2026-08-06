import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
};

/**
 * Branded spot illustration behind the caller's icon: a small swarm — three
 * satellite nodes wired to a hub — drawn from theme tokens so it works in
 * both themes. The caller's lucide icon sits in the hub, so every empty
 * state stays recognisable while sharing one visual family.
 */
function SwarmSpot({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="relative h-24 w-40">
      <svg viewBox="0 0 160 96" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <linearGradient id="es-edge" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.1" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0.45" />
          </linearGradient>
        </defs>
        {/* edges into the hub */}
        <path
          d="M28 22 C 52 30, 60 40, 76 46"
          fill="none"
          stroke="url(#es-edge)"
          strokeWidth="1.5"
        />
        <path
          d="M22 74 C 46 68, 58 58, 76 51"
          fill="none"
          stroke="url(#es-edge)"
          strokeWidth="1.5"
        />
        <path
          d="M136 26 C 116 34, 104 42, 86 47"
          fill="none"
          stroke="url(#es-edge)"
          strokeWidth="1.5"
        />
        {/* satellite nodes */}
        <g className="text-border">
          <rect
            x="16"
            y="12"
            width="24"
            height="16"
            rx="5"
            fill="var(--card)"
            stroke="currentColor"
          />
          <rect
            x="10"
            y="64"
            width="24"
            height="16"
            rx="5"
            fill="var(--card)"
            stroke="currentColor"
          />
          <rect
            x="126"
            y="16"
            width="24"
            height="16"
            rx="5"
            fill="var(--card)"
            stroke="currentColor"
          />
        </g>
        {/* node dots */}
        <circle cx="28" cy="20" r="2" fill="var(--primary)" opacity="0.7" />
        <circle cx="22" cy="72" r="2" fill="var(--primary)" opacity="0.5" />
        <circle cx="138" cy="24" r="2" fill="var(--primary)" opacity="0.6" />
      </svg>
      {/* hub */}
      <div className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-border bg-card shadow-sm">
        <div className="absolute -inset-3 -z-10 rounded-3xl bg-primary/10 blur-xl" />
        <Icon className="h-6 w-6 text-primary" />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-14 text-center",
        className,
      )}
    >
      <SwarmSpot icon={icon} />
      <h3 className="mt-4 text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
