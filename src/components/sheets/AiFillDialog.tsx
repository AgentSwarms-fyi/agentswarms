// Fill with AI: an instruction applied to every value of a column
// (classify, extract, clean up, translate), written into another column.
// Answers typed in the target column already are taken as examples, as
// Flash Fill learns from them; a trial on five rows comes first.

import { useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { colIndex, colLetters, type RangeAddr } from "@/lib/sheets/a1";
import { afterTrial, fillTargetColumn } from "@/lib/sheets/assist";
import { sheetsAiFill } from "@/utils/sheetsAssist.functions";

const BATCH = 50;

export type FillPlan = { row: number; input: string }[];

export function AiFillDialog({
  workbookId,
  token,
  range,
  maxRows,
  read,
  onWrite,
  onClose,
}: {
  workbookId: string;
  token: string | undefined;
  /** The selection: its columns are the input, its rows the rows to fill. */
  range: RangeAddr;
  /** Most rows one fill may write (SHEETS_AI_FILL_MAX_ROWS). */
  maxRows: number;
  /** A cell as shown. */
  read: (row: number, col: number) => string;
  /** Write the answers into a column (one undo step). */
  onWrite: (col: number, values: { row: number; value: string }[]) => void;
  onClose: () => void;
}) {
  const fillFn = useServerFn(sheetsAiFill);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const firstFree = useMemo(() => fillTargetColumn(range, read), [range]);
  const [target, setTarget] = useState(colLetters(firstFree));
  const [instruction, setInstruction] = useState("");
  const [trial, setTrial] = useState<{ row: number; input: string; output: string }[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = useRef(false);

  const targetCol = /^[A-Z]{1,3}$/i.test(target.trim())
    ? colIndex(target.trim().toUpperCase())
    : -1;
  const inputOf = (r: number) => {
    const parts: string[] = [];
    for (let c = range.c0; c <= range.c1; c++) parts.push(read(r, c));
    return parts.filter(Boolean).join(" | ");
  };
  // Rows with an input; those whose target already holds an answer are examples.
  const { plan, examples } = useMemo(() => {
    const plan: FillPlan = [];
    const examples: { input: string; output: string }[] = [];
    if (targetCol < 0) return { plan, examples };
    for (let r = range.r0; r <= range.r1; r++) {
      const input = inputOf(r);
      if (!input) continue;
      const done = read(r, targetCol);
      if (done) {
        if (examples.length < 10) examples.push({ input, output: done });
      } else plan.push({ row: r, input });
    }
    return { plan, examples };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, targetCol]);

  const inside = targetCol >= range.c0 && targetCol <= range.c1;
  const call = async (inputs: string[]) => {
    if (!token) throw new Error("Not signed in");
    const r = await fillFn({
      data: {
        access_token: token,
        workbook_id: workbookId,
        instruction: instruction.trim(),
        examples,
        inputs,
      },
    });
    if (!r.ok) throw new Error(r.error);
    return r.outputs;
  };

  const check = (): string | null => {
    if (!instruction.trim())
      return 'Say what to do with each value, e.g. "the company\'s country" or "positive, negative or neutral"';
    if (targetCol < 0) return "The target is a column letter, such as F";
    if (inside) return "Write into a column outside the selection, so the inputs stay as they are";
    if (!plan.length)
      return "Every selected row either has nothing to work from or already has an answer";
    if (plan.length > maxRows)
      return `That is ${plan.length} rows; one fill does at most ${maxRows} (SHEETS_AI_FILL_MAX_ROWS). Select fewer rows.`;
    return null;
  };

  const runTrial = async () => {
    const p = check();
    if (p) return setProblem(p);
    setProblem(null);
    setProgress({ done: 0, total: Math.min(5, plan.length) });
    try {
      const sample = plan.slice(0, 5);
      const out = await call(sample.map((x) => x.input));
      setTrial(sample.map((x, i) => ({ row: x.row, input: x.input, output: out[i] ?? "" })));
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const runAll = async () => {
    const p = check();
    if (p) return setProblem(p);
    setProblem(null);
    stop.current = false;
    // The trial's answers are written as shown; only the rest are asked (R138).
    const { answers, rest } = afterTrial(plan, trial);
    setProgress({ done: answers.length, total: plan.length });
    try {
      for (let i = 0; i < rest.length; i += BATCH) {
        if (stop.current) break;
        const batch = rest.slice(i, i + BATCH);
        const out = await call(batch.map((x) => x.input));
        batch.forEach((x, k) => answers.push({ row: x.row, value: out[k] ?? "" }));
        setProgress({ done: answers.length, total: plan.length });
      }
      if (answers.length) onWrite(targetCol, answers);
      onClose();
    } catch (e) {
      // What came back before the failure is kept.
      if (answers.length) onWrite(targetCol, answers);
      setProblem(
        `${(e as Error).message}${answers.length ? ` (${answers.length} rows were filled before it stopped)` : ""}`,
      );
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !progress && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="ai-fill-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Fill with AI
          </DialogTitle>
          <DialogDescription>
            From {colLetters(range.c0)}
            {range.c1 > range.c0 ? `–${colLetters(range.c1)}` : ""}, rows {range.r0 + 1}–
            {range.r1 + 1}: {plan.length} to fill
            {examples.length ? `, ${examples.length} already answered (used as examples)` : ""}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void (trial ? runAll() : runTrial());
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="fill-instruction">For each value</Label>
            <Textarea
              id="fill-instruction"
              rows={3}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                setTrial(null);
              }}
              placeholder="Classify the feedback as positive, negative or neutral"
              autoFocus
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="fill-target" className="shrink-0">
              Write into column
            </Label>
            <Input
              id="fill-target"
              className="h-8 w-20 font-mono uppercase"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setTrial(null);
              }}
            />
          </div>
          {trial && (
            <div className="rounded border border-border" data-testid="ai-fill-trial">
              <p className="border-b border-border px-2 py-1 text-xs text-muted-foreground">
                The first {trial.length}, as they would be written:
              </p>
              <table className="w-full text-xs">
                <tbody>
                  {trial.map((t, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td
                        className="max-w-[14rem] truncate px-2 py-1 text-muted-foreground"
                        title={t.input}
                      >
                        {t.input}
                      </td>
                      <td className="px-2 py-1 font-medium">
                        {t.output || <em className="text-muted-foreground">(blank)</em>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {progress && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="ai-fill-progress"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {progress.done} of {progress.total}
              {progress.total > 5 && (
                <button
                  type="button"
                  className="ml-auto underline"
                  onClick={() => (stop.current = true)}
                >
                  Stop
                </button>
              )}
            </div>
          )}
          {problem && <p className="text-sm text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={!!progress}>
              Cancel
            </Button>
            {trial ? (
              <Button type="submit" disabled={!!progress} data-testid="ai-fill-all">
                Fill {plan.length} row{plan.length === 1 ? "" : "s"}
              </Button>
            ) : (
              <Button type="submit" disabled={!!progress} data-testid="ai-fill-try">
                Try on {Math.min(5, plan.length) || 5} rows
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
