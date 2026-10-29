// Ask the ontology, in words. The answer is a plan over the ontology's own
// types, links and metrics, compiled and run as you — and it comes with a
// trust envelope: which certified metric it used, which tables it read, what
// your share hides, which rules the data currently breaks, and whether a
// person has verified this question. A question the ontology cannot answer
// is refused with the reason, never guessed. The owner can verify an answer;
// verified questions answer without a model call and re-run as an
// evaluation suite after every change.
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportFailure } from "@/lib/silentFailureNet";
import {
  AlertTriangle,
  BadgeCheck,
  Bot,
  CheckCircle2,
  CircleSlash,
  Code2,
  Database,
  FlaskConical,
  Loader2,
  Send,
  ShieldAlert,
  Trash2,
  User,
} from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BiModelSelect } from "@/components/bi/BiModelSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useOntology } from "@/components/ontology/OntologyContext";
import { formatPeriod, formatValue, relativeTime, TypeBadge } from "@/components/ontology/theme";
import type { ColumnMeta } from "@/lib/ontology/compile";
import type { AskAnswer, AskRefusal } from "@/utils/ontology/ask.server";
import {
  ontologyAsk,
  ontologyDeleteQuestion,
  ontologyQuestions,
  ontologyRunEval,
  ontologyVerifyAnswer,
  type VerifiedQuestion,
} from "@/utils/ontologyAi.functions";
import {
  allProperties,
  baseTypeOf,
  findObjectType,
  findValueType,
  linksOf,
  pluralTitleOf,
  propertyTitle,
  walksToOne,
  type OntologySpec,
} from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";
import { parseModelChoice } from "@/utils/providers/modelChoice";

type Turn = {
  question: string;
  answer: AskAnswer | AskRefusal | { ok: false; error: string } | null;
};

/** Questions this model can answer, made from its own certified metrics and links. */
export function suggestQuestions(spec: OntologySpec): string[] {
  const out: string[] = [];
  for (const t of spec.objectTypes.filter((x) => x.source)) {
    const m = t.metrics.find((x) => x.certified) ?? t.metrics.find((x) => x.name !== "count");
    if (m) {
      const near = linksOf(spec, t.name).find(({ link, direction }) => walksToOne(link, direction));
      const other = near ? findObjectType(spec, near.other) : undefined;
      // Group by something with few values people compare (a segment, a
      // status), never an identifier, a free-text format like an e-mail, or
      // anything sensitive.
      const groupable = other
        ? allProperties(spec, other).filter((p) => {
            const vt = findValueType(spec, p.type);
            return (
              (baseTypeOf(spec, p.type) ?? "string") === "string" &&
              !other.primaryKey.includes(p.name) &&
              p.name !== other.titleProperty &&
              !vt?.pattern &&
              (p.sensitivity ?? "public") !== "confidential" &&
              p.sensitivity !== "restricted"
            );
          })
        : [];
      const prop = groupable.find((p) => findValueType(spec, p.type)?.enum) ?? groupable[0];
      if (other && prop)
        out.push(
          `${m.label ?? m.name} by ${other.label ?? other.name} ${propertyTitle(prop).toLowerCase()}`,
        );
      const date = allProperties(spec, t).find((p) =>
        ["date", "datetime", "timestamp"].includes(baseTypeOf(spec, p.type) ?? ""),
      );
      if (date) out.push(`${m.label ?? m.name} by month`);
    }
    const en = allProperties(spec, t).find((p) => findValueType(spec, p.type)?.enum);
    if (en) {
      const v = findValueType(spec, en.type)!.enum!;
      out.push(`Which ${pluralTitleOf(t).toLowerCase()} are ${v[v.length > 3 ? 2 : 0]}?`);
    }
  }
  return [...new Set(out)].slice(0, 6);
}

export function AskTab() {
  const o = useOntology();
  const askFn = useServerFn(ontologyAsk);
  const listFn = useServerFn(ontologyQuestions);
  const verifyFn = useServerFn(ontologyVerifyAnswer);
  const deleteFn = useServerFn(ontologyDeleteQuestion);
  const evalFn = useServerFn(ontologyRunEval);
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<VerifiedQuestion[] | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  // Which model plans: null = the server default (the connection's default
  // model, then the instance's). Remembered for this tab only.
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const isOwner = o.detail.role === "owner";
  const suggestions = useMemo(() => suggestQuestions(o.spec), [o.spec]);
  const bottom = useRef<HTMLDivElement>(null);

  const loadVerified = async () => {
    const res = await listFn({ data: { access_token: o.tokenRef.current, id: o.id } });
    if (res.ok) setVerified(res.questions);
  };
  useEffect(() => {
    void loadVerified();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Braced on purpose: Chromium's smooth scrollIntoView returns a Promise,
    // and an effect that returns one hands React a "cleanup" it cannot call.
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, busy]);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setQ("");
    setBusy(true);
    setTurns((t) => [...t, { question, answer: null }]);
    try {
      const choice = parseModelChoice(modelChoice);
      const res = await askFn({
        data: {
          access_token: o.tokenRef.current,
          id: o.id,
          question,
          ...(choice ? { provider: choice.provider, model: choice.model } : {}),
        },
      });
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, answer: res } : x)));
    } catch (e) {
      setTurns((t) =>
        t.map((x, i) =>
          i === t.length - 1 ? { ...x, answer: { ok: false, error: (e as Error).message } } : x,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const verify = async (question: string, a: AskAnswer) => {
    const res = await verifyFn({
      data: { access_token: o.tokenRef.current, id: o.id, question, plan: a.plan },
    });
    if (!res.ok) toast.error(res.error);
    else {
      toast.success("Verified: this question now answers from this plan, without a model call");
      void loadVerified();
    }
  };

  const runEval = async () => {
    setEvaluating(true);
    try {
      const res = await evalFn({ data: { access_token: o.tokenRef.current, id: o.id } });
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(
          `${res.total} verified question${res.total === 1 ? "" : "s"}: ${res.same} unchanged, ${res.changed} changed, ${res.errors} broken`,
        );
        void loadVerified();
      }
    } catch (e) {
      reportFailure("evaluate the verified questions", e);
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="flex min-h-[60vh] flex-col rounded-xl border border-border bg-card">
        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
          {!turns.length && (
            <div className="mx-auto max-w-xl py-8 text-center">
              <Bot className="mx-auto h-8 w-8 text-primary" />
              <h2 className="mt-3 font-display text-xl font-semibold">Ask {o.spec.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Answers come from this ontology&apos;s types, links and certified metrics — planned
                by AI, compiled and run as you, never free-written SQL. If it cannot answer, it says
                why.
              </p>
              {suggestions.length > 0 && (
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void ask(s)}
                      className="rounded-full border border-border px-3 py-1.5 text-sm transition hover:border-primary/50 hover:bg-primary/5"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className="space-y-3">
              <div className="flex items-start gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                  <User className="h-3.5 w-3.5" />
                </span>
                <p className="pt-1 text-sm font-medium">{t.question}</p>
              </div>
              <div className="flex items-start gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  {!t.answer ? (
                    <p className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Planning over the ontology…
                    </p>
                  ) : !t.answer.ok ? (
                    <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                      {t.answer.error}
                    </p>
                  ) : t.answer.kind === "refuse" ? (
                    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
                      <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="font-medium">The ontology cannot answer that</p>
                        <p className="text-muted-foreground">{t.answer.reason}</p>
                        {t.answer.model && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Planned by {t.answer.model}
                          </p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <AnswerCard
                      question={t.question}
                      a={t.answer}
                      canVerify={isOwner}
                      onVerify={verify}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <Textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(q);
              }
            }}
            rows={1}
            placeholder="e.g. Revenue by customer segment last quarter"
            className="min-h-[42px] resize-none"
            aria-label="Your question"
          />
          <div className="w-44 flex-none" title="The model that plans the answer">
            <BiModelSelect value={modelChoice} onChange={setModelChoice} allowUnset />
          </div>
          <Button type="submit" disabled={!q.trim() || busy} aria-label="Ask">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
      </section>

      <aside className="space-y-3">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <BadgeCheck className="h-4 w-4 text-emerald-600" /> Verified questions
            </h3>
            {isOwner && (verified?.length ?? 0) > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => void runEval()}
                disabled={evaluating}
              >
                {evaluating ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FlaskConical className="mr-1 h-3.5 w-3.5" />
                )}{" "}
                Evaluate
              </Button>
            )}
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Answers someone checked. They answer again without a model call, and Evaluate re-runs
            them all: a change to the model that breaks one shows up here.
          </p>
          {!verified ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : !verified.length ? (
            <p className="text-xs text-muted-foreground">
              None yet. {isOwner ? "Verify a good answer from the conversation." : ""}
            </p>
          ) : (
            <ul className="space-y-2">
              {verified.map((v) => (
                <li key={v.id} className="rounded-lg border border-border p-2 text-xs">
                  <button
                    type="button"
                    className="text-left font-medium hover:text-primary"
                    onClick={() => void ask(v.question)}
                  >
                    {v.question}
                  </button>
                  <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                    {v.last_result?.status === "same" ? (
                      <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3" /> unchanged
                      </span>
                    ) : v.last_result?.status === "changed" ? (
                      <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3" /> answer changed
                      </span>
                    ) : v.last_result?.status === "error" ? (
                      <span
                        className="flex items-center gap-1 text-rose-700 dark:text-rose-300"
                        title={v.last_result.error}
                      >
                        <AlertTriangle className="h-3 w-3" /> broken
                      </span>
                    ) : null}
                    <span>{relativeTime(v.last_result?.ran_at ?? v.created_at)}</span>
                    {isOwner && (
                      <button
                        type="button"
                        className="ml-auto hover:text-destructive"
                        onClick={async () => {
                          const res = await deleteFn({
                            data: { access_token: o.tokenRef.current, id: o.id, question_id: v.id },
                          });
                          if (res.ok) void loadVerified();
                        }}
                        aria-label="Remove verified question"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function AnswerCard({
  question,
  a,
  canVerify,
  onVerify,
}: {
  question: string;
  a: AskAnswer;
  canVerify: boolean;
  onVerify: (q: string, a: AskAnswer) => void;
}) {
  const o = useOntology();
  const [showSql, setShowSql] = useState(false);
  const [done, setDone] = useState(false);
  const metricKey = a.kind === "metric" && a.trust.metric ? a.trust.metric.name : null;
  const groupCols = a.columns.filter((c) => c.key !== metricKey);
  const metricFmt = a.trust.metric
    ? findObjectType(o.spec, a.trust.objectTypes[0])?.metrics.find(
        (m) => m.name === a.trust.metric!.name,
      )?.format
    : undefined;
  // A period reads as people name it ("Jan 2024"), as on the Metrics tab.
  const cell = (c: ColumnMeta, v: unknown) =>
    c.grain
      ? formatPeriod(v, c.grain)
      : formatValue(v, c.key === metricKey ? { format: metricFmt } : undefined);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-background p-3">
      <p className="text-sm">{a.explanation}</p>
      {a.kind === "metric" && metricKey && !groupCols.length ? (
        <p className="text-4xl font-semibold tabular-nums">
          {formatValue(a.rows[0]?.[metricKey], { format: metricFmt })}
        </p>
      ) : a.kind === "metric" && metricKey && a.rows.length > 1 && a.rows.length <= 30 ? (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={a.rows.map((r) => ({
                label: groupCols.map((c) => cell(c, r[c.key])).join(" · "),
                value: Number(r[metricKey] ?? 0),
              }))}
            >
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                width={64}
                tickFormatter={(v: number) => formatValue(v)}
              />
              <Tooltip
                formatter={(v: number) => formatValue(v, { format: metricFmt })}
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="value" fill="var(--primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {(a.kind === "objects" || groupCols.length > 0) && (
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-left text-muted-foreground">
              <tr>
                {a.columns.map((c) => (
                  <th key={c.key} className="px-2 py-1.5 font-medium">
                    {propertyTitle({ name: c.property })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.rows.slice(0, 100).map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {a.columns.map((c) => (
                    <td key={c.key} className="px-2 py-1 tabular-nums">
                      {c.masked ? (
                        <span className="italic text-muted-foreground">hidden</span>
                      ) : (
                        cell(c, r[c.key])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {a.total !== null && a.total > a.rows.length && (
            <p className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
              Showing {a.rows.length} of {a.total.toLocaleString()}
            </p>
          )}
        </div>
      )}
      <TrustEnvelope a={a} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" className="h-7" onClick={() => setShowSql((s) => !s)}>
          <Code2 className="mr-1 h-3.5 w-3.5" /> How it was computed
        </Button>
        {canVerify && !a.trust.verified && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={done}
            onClick={() => {
              setDone(true);
              onVerify(question, a);
            }}
          >
            <BadgeCheck className="mr-1 h-3.5 w-3.5" />{" "}
            {done ? "Verified" : "This answer is right — verify it"}
          </Button>
        )}
      </div>
      {showSql && (
        <div className="space-y-2">
          <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-[11px]">
            {JSON.stringify(a.plan, null, 2)}
          </pre>
          <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 text-[11px]">{a.sql}</pre>
        </div>
      )}
    </div>
  );
}

function TrustEnvelope({ a }: { a: AskAnswer }) {
  const o = useOntology();
  const t = a.trust;
  return (
    <div
      className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2.5 text-xs"
      aria-label="How far to trust this answer"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {t.verified ? (
          <Badge className="gap-1 bg-emerald-600 text-[10px] hover:bg-emerald-600">
            <BadgeCheck className="h-3 w-3" /> Verified question
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Bot className="h-3 w-3" /> Planned by AI over the ontology
            {t.model ? ` · ${t.model}` : ""}
          </Badge>
        )}
        {t.metric && (
          <Badge
            variant="outline"
            className={cn(
              "gap-1 text-[10px]",
              t.metric.certified
                ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                : "border-amber-500/40 text-amber-800 dark:text-amber-300",
            )}
          >
            {t.metric.certified ? (
              <BadgeCheck className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            {t.metric.label} {t.metric.certified ? "certified" : "not certified"}
          </Badge>
        )}
        {t.objectTypes.map((n) => (
          <TypeBadge key={n} type={findObjectType(o.spec, n)} />
        ))}
        <span className="text-muted-foreground">
          {t.version ? `version ${t.version}` : `draft revision ${t.revision}`}
        </span>
      </div>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Database className="h-3 w-3" /> Read {t.tables.join(", ") || "—"} as you
        {t.links.length > 0 && <> · through {t.links.join(", ")}</>}
      </p>
      {t.restrictions.length > 0 && (
        <p className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
          <ShieldAlert className="h-3 w-3" /> Your share applied: {t.restrictions.join(" · ")}
        </p>
      )}
      {t.openViolations.length > 0 && (
        <p className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            The data currently breaks{" "}
            {t.openViolations.map((v) => `${v.rule} (${v.violations.toLocaleString()})`).join(", ")}
            {t.lastRuleRunAt ? ` — checked ${relativeTime(t.lastRuleRunAt)}` : ""}.
          </span>
        </p>
      )}
      {t.truncated && (
        <p className="text-amber-800 dark:text-amber-300">The result was cut at the row limit.</p>
      )}
    </div>
  );
}
