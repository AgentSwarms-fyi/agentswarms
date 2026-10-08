import { type QualityRollup } from "@/lib/dataQualityCore";

export function statusTone(status: QualityRollup["status"]): string {
  switch (status) {
    case "pass":
      return "border-emerald-500/50 text-emerald-600 dark:text-emerald-400";
    case "fail":
      return "border-red-500/50 text-red-600 dark:text-red-400";
    case "warn":
      return "border-amber-500/50 text-amber-600 dark:text-amber-400";
    case "error":
      return "border-orange-500/50 text-orange-600 dark:text-orange-400";
    default:
      return "border-border text-muted-foreground";
  }
}
