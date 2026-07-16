import { cn } from "@/lib/utils";
import { Reveal } from "./Reveal";

type SectionHeadingProps = {
  eyebrow: string;
  title: string;
  lede?: string;
  align?: "left" | "center";
  className?: string;
};

export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "left",
  className,
}: SectionHeadingProps) {
  const centered = align === "center";
  return (
    <Reveal className={cn(centered && "text-center", className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
      <h2 className="mt-3 break-words font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
        {title}
      </h2>
      {lede ? (
        <p className={cn("mt-4 max-w-2xl text-muted-foreground", centered && "mx-auto")}>{lede}</p>
      ) : null}
    </Reveal>
  );
}
