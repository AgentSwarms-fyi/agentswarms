import { Boxes, Cpu, Database, KeyRound, Power, Sparkles } from "lucide-react";

/**
 * The page's tabs, in the order an operator meets them: turn it on, size the
 * sandboxes, size the data platform, size ML, configure AI services, decide
 * who may use it. Exported so the route can validate `?tab=` against them.
 */
export const RUNTIME_TABS = [
  { id: "runtime", label: "Runtime", icon: Power },
  { id: "sandboxes", label: "Sandboxes", icon: Boxes },
  { id: "data", label: "Data platform", icon: Database },
  { id: "ml", label: "Machine learning", icon: Cpu },
  { id: "ai", label: "AI services", icon: Sparkles },
  { id: "access", label: "Access", icon: KeyRound },
] as const;

export function isRuntimeTabId(v: unknown): v is RuntimeTabId {
  return RUNTIME_TABS.some((t) => t.id === v);
}

export type RuntimeTabId = (typeof RUNTIME_TABS)[number]["id"];
