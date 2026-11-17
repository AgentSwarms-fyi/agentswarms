// Icons a conditional-format rule can put before a cell's value: table cells
// since R498, a pivot's cells since R506. One map, so both draw the same one.
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  Flag,
  type LucideIcon,
} from "lucide-react";
import type { BiCondIcon } from "@/lib/biAgent";

export const COND_ICONS: Record<BiCondIcon, { label: string; Icon: LucideIcon }> = {
  up: { label: "Arrow up", Icon: ArrowUp },
  down: { label: "Arrow down", Icon: ArrowDown },
  dot: { label: "Dot", Icon: Circle },
  flag: { label: "Flag", Icon: Flag },
  check: { label: "Check", Icon: CheckCircle2 },
  alert: { label: "Warning", Icon: AlertTriangle },
};
