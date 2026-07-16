// Full-screen Presentation Viewer.
//   - currentSlide tracked in React state
//   - keyboard nav (←/→, Space to advance, Esc to close)
//   - thin progress bar pinned to the top
//   - glassmorphism floating Prev/Next controls at the bottom
//   - framer-motion fade-and-slide transitions between slides
//
// Rendered as a fixed inset-0 overlay over the dark theme. Self-contained;
// the parent just supplies a Presentation and an onClose handler.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from "lucide-react";
import type { Presentation } from "@/lib/presentations";
import {
  TitleSlide,
  BulletSlide,
  CodeDiagramSlide,
  StatementSlide,
  CompareSlide,
  VisualSlide,
} from "./slides";

export function PresentationViewer({
  presentation,
  onClose,
}: {
  presentation: Presentation;
  onClose: () => void;
}) {
  const [currentSlide, setCurrentSlide] = useState(0);
  // Track direction so the slide-in animation matches navigation direction.
  const [direction, setDirection] = useState(1);
  const total = presentation.slides.length;
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await containerRef.current?.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      // ignore
    }
  }, []);

  const goTo = useCallback(
    (next: number, dir: number) => {
      setDirection(dir);
      setCurrentSlide((prev) => Math.min(Math.max(next, 0), total - 1));
    },
    [total],
  );
  const next = useCallback(() => goTo(currentSlide + 1, 1), [currentSlide, goTo]);
  const prev = useCallback(() => goTo(currentSlide - 1, -1), [currentSlide, goTo]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, onClose]);

  const slide = presentation.slides[currentSlide];
  const progressPct = total > 0 ? ((currentSlide + 1) / total) * 100 : 0;

  // Directional fade-and-slide. `custom={direction}` is resolved by these
  // variant functions (framer-motion only passes `custom` through variants).
  const slideVariants = {
    enter: (d: number) => ({ opacity: 0, x: d > 0 ? 60 : -60 }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: d > 0 ? -60 : 60 }),
  };

  const viewer = (
    <div ref={containerRef} className="fixed inset-0 z-[9999] flex flex-col bg-background">
      {/* Top progress bar */}
      <div className="absolute inset-x-0 top-0 z-20 h-1 bg-border/40">
        <motion.div
          className="h-full bg-gradient-to-r from-primary to-nexus-glow"
          animate={{ width: `${progressPct}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      </div>

      {/* Header: deck title + slide counter + pinned controls */}
      <div className="fixed inset-x-0 top-0 z-[10001] flex items-center justify-between bg-background/95 px-4 py-3 shadow-lg backdrop-blur sm:px-6">
        <p className="truncate text-xs font-medium text-muted-foreground">{presentation.title}</p>
        <div className="flex items-center gap-2">
          <span className="mr-2 text-xs tabular-nums text-muted-foreground">
            {currentSlide + 1} / {total}
          </span>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="grid h-10 w-10 place-items-center rounded-full border border-primary/40 bg-primary text-primary-foreground shadow-xl transition-colors hover:bg-primary/90"
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-full border border-destructive/40 bg-destructive text-destructive-foreground shadow-xl transition-colors hover:bg-destructive/90"
            title="Close presentation (Esc)"
            aria-label="Close presentation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Slide stage */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={currentSlide}
            custom={direction}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.35, ease: "easeInOut" }}
            // top-16 clears the fixed header bar so slide eyebrows/titles aren't hidden
            className="absolute inset-x-0 bottom-0 top-16 mx-auto max-w-6xl"
          >
            {slide.layout === "title" && <TitleSlide slide={slide} />}
            {slide.layout === "bullets" && <BulletSlide slide={slide} />}
            {slide.layout === "code" && <CodeDiagramSlide slide={slide} />}
            {slide.layout === "statement" && <StatementSlide slide={slide} />}
            {slide.layout === "compare" && <CompareSlide slide={slide} />}
            {slide.layout === "visual" && <VisualSlide slide={slide} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Glassmorphism floating controls */}
      <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/40 bg-card/30 px-2 py-2 shadow-2xl backdrop-blur-xl">
          <button
            type="button"
            onClick={prev}
            disabled={currentSlide === 0}
            className="grid h-10 w-10 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-30"
            title="Previous (←)"
            aria-label="Previous slide"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          {/* Dot indicators */}
          <div className="flex items-center gap-1.5 px-2">
            {presentation.slides.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i, i > currentSlide ? 1 : -1)}
                className={`h-1.5 rounded-full transition-all ${
                  i === currentSlide
                    ? "w-5 bg-primary"
                    : "w-1.5 bg-foreground/25 hover:bg-foreground/50"
                }`}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={next}
            disabled={currentSlide === total - 1}
            className="grid h-10 w-10 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-30"
            title="Next (→)"
            aria-label="Next slide"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? viewer : createPortal(viewer, document.body);
}
