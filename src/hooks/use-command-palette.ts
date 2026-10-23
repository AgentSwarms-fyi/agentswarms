import { useEffect, useState } from "react";

/** Global hotkey: Ctrl/⌘-K opens the palette from anywhere in the app. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A control that gives Ctrl+K its own meaning (a spreadsheet's "insert
      // link") claims it first; the palette does not open over it.
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
