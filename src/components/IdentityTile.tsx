// The small square that stands for one named thing on a card: its kind's icon
// on a soft wash of a colour picked from its name, so twenty cards are told
// apart at a glance without any of them shouting.
import type { LucideIcon } from "lucide-react";

import { identityHue } from "@/lib/identityHue";
import { cn } from "@/lib/utils";

export function IdentityTile({
  name,
  icon: Icon,
  className,
}: {
  name: string;
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
        identityHue(name),
        className,
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}
