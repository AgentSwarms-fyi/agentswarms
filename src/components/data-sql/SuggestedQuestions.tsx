// Suggested-questions strip for the BI Agent panel.
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, RefreshCw } from "lucide-react";

export function SuggestedQuestions({
  questions,
  loading,
  onPick,
  onRefresh,
}: {
  questions: string[];
  loading: boolean;
  onPick: (q: string) => void;
  onRefresh: () => void;
}) {
  if (loading && questions.length === 0) {
    return (
      <div className="px-3 py-2 flex items-center gap-2 text-[10px] text-slate-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        Generating suggestions…
      </div>
    );
  }
  if (questions.length === 0) return null;
  return (
    <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
          <Sparkles className="h-2.5 w-2.5 text-indigo-500" />
          Try asking
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          title="Refresh suggestions"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {questions.map((q, i) => (
          <Button
            key={i}
            size="sm"
            variant="outline"
            className="h-6 text-[10px] font-normal bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300"
            onClick={() => onPick(q)}
          >
            {q}
          </Button>
        ))}
      </div>
    </div>
  );
}
