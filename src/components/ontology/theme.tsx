// What an object type looks like everywhere in the ontology UI: its icon and
// its colour, and a few chips every tab uses. One place, so a Customer is the
// same teal person on the canvas, in the explorer, in the graph and on a rule.
import {
  Box,
  Briefcase,
  Building2,
  Calendar,
  CreditCard,
  Factory,
  FileText,
  Globe,
  HeartPulse,
  MapPin,
  Package,
  Plane,
  Server,
  ShoppingCart,
  Tag,
  Truck,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ObjectType, TypeColor, TypeIcon } from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

export const TYPE_ICON: Record<TypeIcon, LucideIcon> = {
  box: Box,
  user: User,
  users: Users,
  building: Building2,
  "shopping-cart": ShoppingCart,
  package: Package,
  truck: Truck,
  "file-text": FileText,
  "credit-card": CreditCard,
  "map-pin": MapPin,
  calendar: Calendar,
  tag: Tag,
  factory: Factory,
  briefcase: Briefcase,
  "heart-pulse": HeartPulse,
  plane: Plane,
  server: Server,
  globe: Globe,
};

/** Tailwind classes per palette slot: a soft fill, a strong ink, a border, a dot. */
export const TYPE_TONE: Record<
  TypeColor,
  { soft: string; ink: string; ring: string; dot: string; stroke: string }
> = {
  teal: {
    soft: "bg-teal-500/10 dark:bg-teal-400/10",
    ink: "text-teal-700 dark:text-teal-300",
    ring: "border-teal-500/40",
    dot: "bg-teal-500",
    stroke: "#14b8a6",
  },
  indigo: {
    soft: "bg-indigo-500/10 dark:bg-indigo-400/10",
    ink: "text-indigo-700 dark:text-indigo-300",
    ring: "border-indigo-500/40",
    dot: "bg-indigo-500",
    stroke: "#6366f1",
  },
  amber: {
    soft: "bg-amber-500/10 dark:bg-amber-400/10",
    ink: "text-amber-700 dark:text-amber-300",
    ring: "border-amber-500/40",
    dot: "bg-amber-500",
    stroke: "#f59e0b",
  },
  rose: {
    soft: "bg-rose-500/10 dark:bg-rose-400/10",
    ink: "text-rose-700 dark:text-rose-300",
    ring: "border-rose-500/40",
    dot: "bg-rose-500",
    stroke: "#f43f5e",
  },
  violet: {
    soft: "bg-violet-500/10 dark:bg-violet-400/10",
    ink: "text-violet-700 dark:text-violet-300",
    ring: "border-violet-500/40",
    dot: "bg-violet-500",
    stroke: "#8b5cf6",
  },
  emerald: {
    soft: "bg-emerald-500/10 dark:bg-emerald-400/10",
    ink: "text-emerald-700 dark:text-emerald-300",
    ring: "border-emerald-500/40",
    dot: "bg-emerald-500",
    stroke: "#10b981",
  },
  sky: {
    soft: "bg-sky-500/10 dark:bg-sky-400/10",
    ink: "text-sky-700 dark:text-sky-300",
    ring: "border-sky-500/40",
    dot: "bg-sky-500",
    stroke: "#0ea5e9",
  },
  slate: {
    soft: "bg-slate-500/10 dark:bg-slate-400/10",
    ink: "text-slate-700 dark:text-slate-300",
    ring: "border-slate-500/40",
    dot: "bg-slate-500",
    stroke: "#64748b",
  },
};

const FALLBACK_COLORS: TypeColor[] = [
  "teal",
  "indigo",
  "amber",
  "rose",
  "violet",
  "emerald",
  "sky",
  "slate",
];

/** A type's colour: its own, or a stable one from its name. */
export function toneOf(t: Pick<ObjectType, "name" | "color"> | undefined) {
  if (!t) return TYPE_TONE.slate;
  if (t.color) return TYPE_TONE[t.color];
  let h = 0;
  for (const c of t.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TYPE_TONE[FALLBACK_COLORS[h % FALLBACK_COLORS.length]];
}

export function iconOf(t: Pick<ObjectType, "icon"> | undefined): LucideIcon {
  return (t?.icon && TYPE_ICON[t.icon]) || Box;
}

export function TypeBadge({
  type,
  label,
  className,
  size = "sm",
}: {
  type: Pick<ObjectType, "name" | "color" | "icon"> | undefined;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const tone = toneOf(type);
  const Icon = iconOf(type);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-medium",
        tone.soft,
        tone.ink,
        tone.ring,
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
        className,
      )}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      {label ?? type?.name ?? "?"}
    </span>
  );
}

export const SEVERITY_TONE: Record<string, string> = {
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

export function SeverityChip({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        SEVERITY_TONE[severity] ?? SEVERITY_TONE.info,
      )}
    >
      {severity}
    </span>
  );
}

/** A cell value as people read it: numbers grouped, money with its unit, nulls as a dash. */
/** A key or code column, whose numbers are labels, not quantities: order 1063, not 1,063. */
export function looksLikeIdentifier(name: string): boolean {
  return /(^id$|_id$|^id_|_key$|_number$|_no$|_code$)/i.test(name);
}

export function formatValue(
  v: unknown,
  opts?: { format?: string; unit?: string; plain?: boolean },
): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" && opts?.plain) return String(v);
  if (typeof v === "number") {
    if (opts?.format === "percent") return `${(v * 100).toFixed(1)}%`;
    if (opts?.format === "currency" || opts?.unit === "USD")
      return v.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
    if (opts?.format === "integer" || Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(v);
}

/** A period's first day as people name the period: "Jan 2024", "Q3 2025", "2024". */
export function formatPeriod(
  v: unknown,
  grain: "day" | "week" | "month" | "quarter" | "year",
): string {
  if (v === null || v === undefined || v === "") return "—";
  const s = String(v);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? `${s}T00:00:00Z`
    : /[zZ]$|[+-]\d\d:?\d\d$/.test(s)
      ? s.replace(" ", "T")
      : `${s.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return s;
  const month = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const y = d.getUTCFullYear();
  if (grain === "year") return String(y);
  if (grain === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`;
  if (grain === "month") return `${month} ${y}`;
  if (grain === "week") return `Week of ${d.getUTCDate()} ${month} ${y}`;
  return `${d.getUTCDate()} ${month} ${y}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}
