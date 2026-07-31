// A lightweight visual thumbnail of a dashboard for the /bi gallery. Renders
// the real widget layout as mini tiles (positioned on the 12-col grid) over the
// dashboard's own theme background, with a simple per-type mini chart in each —
// so a card actually looks like the dashboard it opens, with no screenshotting.
import { useMemo } from "react";
import {
  dashSurfaceStyle,
  parseDashTheme,
  parseLayout,
  parseWidgets,
  WIDGET_ACCENTS,
} from "@/lib/biDashboards";
import type { Json } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

const GRID_COLS = 12;

function MiniChart({ type, color }: { type: string; color: string }) {
  const c = color || "currentColor";
  // Compact glyphs that stay legible at tiny sizes; fill their tile.
  switch (type) {
    case "line":
    case "area":
    case "combo":
      return (
        <svg viewBox="0 0 40 24" preserveAspectRatio="none" className="h-full w-full">
          {type === "area" && (
            <path
              d="M2,20 L10,11 L18,15 L26,6 L34,10 L38,10 L38,22 L2,22 Z"
              fill={c}
              opacity="0.25"
            />
          )}
          <polyline
            points="2,20 10,11 18,15 26,6 34,10 38,8"
            fill="none"
            stroke={c}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "pie":
    case "nightingale":
    case "radar":
    case "funnel":
      return (
        <svg viewBox="0 0 24 24" className="h-[85%]">
          <circle cx="12" cy="12" r="10" fill={c} opacity="0.22" />
          <path d="M12,12 L12,2 A10,10 0 0,1 21,15 Z" fill={c} opacity="0.85" />
        </svg>
      );
    case "kpi":
    case "gauge":
      return (
        <div className="flex w-full flex-col items-center gap-1 px-2">
          <div className="h-2 w-8 rounded-full" style={{ background: c, opacity: 0.9 }} />
          <div className="h-1 w-6 rounded-full bg-current opacity-20" />
        </div>
      );
    case "table":
    case "matrix":
      return (
        <div className="flex w-full flex-col gap-[3px] px-2">
          {[0.9, 0.6, 0.75, 0.5].map((w, i) => (
            <div
              key={i}
              className="h-[3px] rounded-full"
              style={{
                width: `${w * 100}%`,
                background: i === 0 ? c : "currentColor",
                opacity: i === 0 ? 0.8 : 0.22,
              }}
            />
          ))}
        </div>
      );
    case "treemap":
    case "heatmap":
      return (
        <div className="grid h-[80%] w-[80%] grid-cols-3 grid-rows-2 gap-[2px]">
          {[0.9, 0.5, 0.3, 0.6, 0.35, 0.7].map((o, i) => (
            <div key={i} className="rounded-[2px]" style={{ background: c, opacity: o }} />
          ))}
        </div>
      );
    case "text":
      return (
        <div className="flex w-full flex-col gap-[3px] px-2">
          {[1, 0.85, 0.6].map((w, i) => (
            <div
              key={i}
              className="h-[3px] rounded-full bg-current opacity-30"
              style={{ width: `${w * 100}%` }}
            />
          ))}
        </div>
      );
    case "map":
    case "bubblemap":
      return (
        <svg viewBox="0 0 32 24" className="h-[85%]">
          <path d="M6,6 Q10,2 16,5 T28,6 Q30,12 24,16 T12,18 Q4,14 6,6 Z" fill={c} opacity="0.3" />
          <circle cx="14" cy="11" r="2.5" fill={c} />
          <circle cx="22" cy="9" r="1.8" fill={c} />
        </svg>
      );
    case "hbar":
    case "shbar":
      return (
        <div className="flex w-full flex-col justify-center gap-[3px] px-2">
          {[0.9, 0.65, 0.8, 0.45].map((w, i) => (
            <div
              key={i}
              className="h-[3px] rounded-full"
              style={{ width: `${w * 100}%`, background: c, opacity: 0.85 - i * 0.12 }}
            />
          ))}
        </div>
      );
    default:
      // bar / scolumn / waterfall / scatter / boxplot / etc.
      return (
        <div className="flex h-[80%] w-full items-end justify-center gap-[3px] px-1">
          {[0.5, 0.85, 0.35, 0.7, 0.6].map((h, i) => (
            <div
              key={i}
              className="w-[14%] rounded-t-[2px]"
              style={{ height: `${h * 100}%`, background: c, opacity: 0.85 - i * 0.06 }}
            />
          ))}
        </div>
      );
  }
}

export function BiThumbnail({
  widgets: widgetsJson,
  layout: layoutJson,
  theme: themeJson,
  className,
}: {
  widgets: Json;
  layout: Json;
  theme: Json;
  className?: string;
}) {
  const { tiles, rows, surface, hasBg } = useMemo(() => {
    const widgets = parseWidgets(widgetsJson);
    const layout = parseLayout(layoutJson, widgets);
    const theme = parseDashTheme(themeJson);
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const totalRows = Math.max(1, ...layout.map((l) => l.y + l.h));
    const tiles = layout.map((l) => {
      const w = byId.get(l.i);
      const accent = w?.theme?.accent ? WIDGET_ACCENTS[w.theme.accent]?.color : "";
      const type = w?.kind === "text" ? "text" : (w?.chart?.type ?? "bar");
      return { l, accent: accent || "", type };
    });
    return { tiles, rows: totalRows, surface: dashSurfaceStyle(theme), hasBg: !!theme.bg };
  }, [widgetsJson, layoutJson, themeJson]);

  if (tiles.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-border/50 bg-gradient-to-br from-muted/60 to-muted/20 text-[10px] text-muted-foreground",
          className,
        )}
      >
        Empty dashboard
      </div>
    );
  }

  return (
    <div
      className={cn("relative overflow-hidden rounded-lg border border-border/50", className)}
      style={{
        ...surface,
        ...(hasBg
          ? {}
          : {
              backgroundImage: "linear-gradient(135deg, var(--muted) 0%, var(--background) 100%)",
            }),
      }}
    >
      {/* readability wash so tiles pop over busy backgrounds */}
      {hasBg && <div className="absolute inset-0 bg-black/10" />}
      {tiles.map(({ l, accent, type }) => (
        <div
          key={l.i}
          className="absolute p-[2px]"
          style={{
            left: `${(l.x / GRID_COLS) * 100}%`,
            top: `${(l.y / rows) * 100}%`,
            width: `${(l.w / GRID_COLS) * 100}%`,
            height: `${(l.h / rows) * 100}%`,
          }}
        >
          <div className="flex h-full w-full flex-col overflow-hidden rounded-[3px] border border-white/20 bg-white/85 text-neutral-500 shadow-sm dark:bg-neutral-900/80 dark:text-neutral-400">
            <div
              className="h-[3px] w-full shrink-0"
              style={{ background: accent || "var(--primary)" }}
            />
            <div className="flex flex-1 items-center justify-center overflow-hidden">
              <MiniChart type={type} color={accent} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
