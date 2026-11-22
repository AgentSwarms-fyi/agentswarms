import { useEffect } from "react";
import { toast } from "sonner";

const STORAGE_KEY = "agentswarm_seen_langchain_export_announcement";

/**
 * Shows a one-time toast announcing LangChain/LangGraph export support.
 * Call this hook in any page where the feature is relevant (agents, swarms).
 */
export function useLangChainExportAnnouncement() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(STORAGE_KEY)) return;

    // Small delay so it doesn't compete with page load toasts
    const timer = setTimeout(() => {
      toast("New: LangChain and LangGraph export", {
        description:
          "Agents export as LangChain (LCEL) and swarms as LangGraph StateGraphs, in Python or TypeScript.",
        duration: 8000,
      });
      localStorage.setItem(STORAGE_KEY, "1");
    }, 1500);

    return () => clearTimeout(timer);
  }, []);
}
