// The ai_* function reference beside the lakehouse SQL editor: what each one
// takes and returns, with an example that runs as written on the sample
// table. One click puts the example in the editor.
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AI_SQL_FUNCTIONS, AI_SQL_FUNCTION_DOCS } from "@/utils/aiSql/core";

export function AiFunctionsReference({ onInsert }: { onInsert: (sql: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="AI functions you can call in a statement: classify, extract, sentiment, summarize, translate, filter, complete"
        >
          <Sparkles className="mr-1 h-3.5 w-3.5" />
          AI functions
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[32rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">AI functions in SQL</p>
          <p className="text-xs text-muted-foreground">
            Scalar functions answered by a model. Each distinct input costs one call, answers are
            cached, and a statement may make only as many calls as the instance allows — add a LIMIT
            or a WHERE while you try one. The model is optional and last:{" "}
            <code className="font-mono">ai_sentiment(text, 'openrouter/openai/gpt-4o-mini')</code>.
          </p>
        </div>
        <ul className="max-h-80 divide-y overflow-y-auto">
          {AI_SQL_FUNCTIONS.map((fn) => {
            const d = AI_SQL_FUNCTION_DOCS[fn];
            return (
              <li key={fn} className="space-y-1 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <code className="font-mono text-xs font-medium">{d.signature}</code>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{d.returns}</span>
                </div>
                <p className="text-xs text-muted-foreground">{d.description}</p>
                <button
                  type="button"
                  onClick={() => onInsert(d.example)}
                  title="Put this example in the editor"
                  className="block w-full truncate rounded bg-muted px-2 py-1 text-left font-mono text-[11px] hover:bg-muted/70"
                >
                  {d.example}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
