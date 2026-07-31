import { cn } from "@/lib/utils";

/* ─── tiny helpers ─── */
const Box = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div
    className={cn(
      "rounded-lg border border-border/60 bg-card px-3 py-2 text-center text-[11px] font-medium leading-tight",
      className,
    )}
  >
    {children}
  </div>
);

const Arrow = ({
  direction = "down",
  className,
}: {
  direction?: "down" | "right" | "left";
  className?: string;
}) => (
  <div className={cn("flex items-center justify-center text-muted-foreground", className)}>
    {direction === "down" && <span className="text-lg leading-none">↓</span>}
    {direction === "right" && <span className="text-lg leading-none">→</span>}
    {direction === "left" && <span className="text-lg leading-none">←</span>}
  </div>
);

const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("text-[10px] text-muted-foreground italic", className)}>{children}</span>
);

/* ─── DIAGRAMS ─── */

function GenAIvsPredictive() {
  return (
    <DiagramShell title="Generative vs Predictive ML">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Box className="border-primary/40 bg-primary/5 font-semibold text-primary">
            Generative AI
          </Box>
          <div className="space-y-1 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Samples from P(next token)
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Non-deterministic
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Creates new content
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" /> Needs eval harnesses
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Box className="border-amber-500/40 bg-amber-500/5 font-semibold text-amber-700 dark:text-amber-400">
            Predictive ML
          </Box>
          <div className="space-y-1 text-[10px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Outputs class / scalar
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Deterministic
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Classifies / predicts
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Standard metrics
            </div>
          </div>
        </div>
      </div>
    </DiagramShell>
  );
}

function TransformerAttention() {
  return (
    <DiagramShell title="Transformer Self-Attention Flow">
      <div className="flex flex-col items-center gap-1">
        <Box className="w-full max-w-xs border-primary/40 bg-primary/5">Input Tokens</Box>
        <Arrow />
        <div className="grid w-full max-w-xs grid-cols-3 gap-1">
          <Box className="border-blue-400/40 bg-blue-400/5 text-blue-600 dark:text-blue-400">Q</Box>
          <Box className="border-violet-400/40 bg-violet-400/5 text-violet-600 dark:text-violet-400">
            K
          </Box>
          <Box className="border-emerald-400/40 bg-emerald-400/5 text-emerald-600 dark:text-emerald-400">
            V
          </Box>
        </div>
        <Arrow />
        <Box className="w-full max-w-xs border-amber-500/30 bg-amber-500/5">
          Attention = softmax(QK<sup>T</sup> / √d) · V
        </Box>
        <Arrow />
        <Box className="w-full max-w-xs border-primary/40 bg-primary/5">Output Embeddings</Box>
        <Label className="mt-1">×N layers, each with multi-head attention + FFN</Label>
      </div>
    </DiagramShell>
  );
}

function ContextWindow() {
  return (
    <DiagramShell title="Context Window Trade-offs">
      <div className="relative h-16 w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20">
        <div className="absolute inset-y-0 left-0 flex w-[20%] items-center justify-center border-r border-dashed border-border/60 bg-primary/5 text-[9px] font-semibold text-primary">
          System
        </div>
        <div className="absolute inset-y-0 left-[20%] flex w-[50%] items-center justify-center border-r border-dashed border-border/60 bg-blue-500/5 text-[9px] font-semibold text-blue-600 dark:text-blue-400">
          User Context / RAG Docs
        </div>
        <div className="absolute inset-y-0 left-[70%] flex w-[30%] items-center justify-center bg-emerald-500/5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">
          Generation Space
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[9px] text-muted-foreground">
        <span>Token 0</span>
        <span className="font-medium text-foreground/70">← "Lost in the middle" zone →</span>
        <span>Token N</span>
      </div>
    </DiagramShell>
  );
}

function TempTopP() {
  return (
    <DiagramShell title="Temperature & Top-p Sampling">
      <div className="grid grid-cols-3 gap-2">
        {[
          {
            label: "Low temp (0.1)",
            desc: "Deterministic, safe",
            color: "bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400",
          },
          {
            label: "Med temp (0.7)",
            desc: "Balanced creativity",
            color: "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
          },
          {
            label: "High temp (1.5)",
            desc: "Very creative, risky",
            color: "bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400",
          },
        ].map((t) => (
          <div key={t.label} className={cn("rounded-lg border p-2 text-center", t.color)}>
            <div className="text-[10px] font-semibold">{t.label}</div>
            <div className="mt-0.5 text-[9px] opacity-80">{t.desc}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-border/40 bg-muted/20 p-2 text-[10px] text-muted-foreground">
        <strong className="text-foreground/80">Top-p (nucleus):</strong> Dynamically truncates the
        token pool to the smallest set whose cumulative probability ≥ p. Lower p → fewer candidate
        tokens → safer output.
      </div>
    </DiagramShell>
  );
}

function RAGPipeline() {
  return (
    <DiagramShell title="RAG Pipeline Architecture">
      <div className="flex flex-col items-center gap-1">
        <Box className="border-primary/40 bg-primary/5">User Query</Box>
        <Arrow />
        <div className="grid w-full grid-cols-2 gap-2">
          <div className="flex flex-col items-center gap-1">
            <Box className="w-full border-blue-400/30 bg-blue-400/5">Embed Query</Box>
            <Arrow />
            <Box className="w-full border-blue-400/30 bg-blue-400/5">Vector Search</Box>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Box className="w-full border-amber-400/30 bg-amber-400/5">Keyword Tokenize</Box>
            <Arrow />
            <Box className="w-full border-amber-400/30 bg-amber-400/5">BM25 Search</Box>
          </div>
        </div>
        <Label>Hybrid retrieval (RRF merge)</Label>
        <Arrow />
        <Box className="border-violet-400/30 bg-violet-400/5">Re-ranker (cross-encoder)</Box>
        <Arrow />
        <Box className="border-emerald-400/30 bg-emerald-400/5">
          LLM with retrieved context → Answer
        </Box>
      </div>
    </DiagramShell>
  );
}

function RAGvsFineTune() {
  return (
    <DiagramShell title="When to use RAG vs Fine-Tuning">
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-border/50">
              <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">
                Criterion
              </th>
              <th className="px-2 py-1.5 text-center font-semibold text-primary">RAG</th>
              <th className="px-2 py-1.5 text-center font-semibold text-amber-600 dark:text-amber-400">
                Fine-Tune
              </th>
            </tr>
          </thead>
          <tbody className="text-foreground/80">
            {[
              ["Data freshness", "✅ Real-time", "❌ Stale at train time"],
              ["Factual grounding", "✅ Cited sources", "⚠️ Hallucination risk"],
              ["Style / format", "⚠️ Prompt-dependent", "✅ Baked-in"],
              ["Cost to update", "✅ Re-index only", "❌ Re-train"],
              ["Latency", "⚠️ Retrieval overhead", "✅ Single forward pass"],
            ].map(([crit, rag, ft]) => (
              <tr key={crit} className="border-b border-border/30">
                <td className="px-2 py-1.5 font-medium">{crit}</td>
                <td className="px-2 py-1.5 text-center">{rag}</td>
                <td className="px-2 py-1.5 text-center">{ft}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DiagramShell>
  );
}

function ChunkingStrategies() {
  return (
    <DiagramShell title="Chunking Strategies Compared">
      <div className="space-y-2">
        {[
          {
            name: "Fixed-size",
            visual: ["████", "████", "████"],
            desc: "Simple, may split sentences",
          },
          {
            name: "Recursive",
            visual: ["██", "██████", "███"],
            desc: "Split on \\n\\n → \\n → sentence",
          },
          {
            name: "Semantic",
            visual: ["█████", "███", "████████"],
            desc: "By embedding similarity shifts",
          },
          {
            name: "Agentic / Late",
            visual: ["Query→Doc→Answer"],
            desc: "Full doc at inference, no pre-chunk",
          },
        ].map((s) => (
          <div key={s.name} className="flex items-center gap-3">
            <div className="w-20 shrink-0 text-[10px] font-semibold text-foreground/80">
              {s.name}
            </div>
            <div className="flex flex-1 gap-1">
              {s.visual.map((v, i) => (
                <div
                  key={i}
                  className="rounded border border-primary/30 bg-primary/5 px-2 py-0.5 text-[9px] font-mono text-primary"
                >
                  {v}
                </div>
              ))}
            </div>
            <div className="shrink-0 text-[9px] text-muted-foreground">{s.desc}</div>
          </div>
        ))}
      </div>
    </DiagramShell>
  );
}

function AgentLoop() {
  return (
    <DiagramShell title="Agent Reasoning Loop (ReAct)">
      <div className="flex flex-col items-center gap-1">
        <Box className="border-primary/40 bg-primary/5">User Goal</Box>
        <Arrow />
        <div className="rounded-xl border-2 border-dashed border-primary/30 p-3">
          <div className="mb-1 text-center text-[9px] font-semibold uppercase tracking-wider text-primary">
            Loop
          </div>
          <div className="flex flex-col items-center gap-1">
            <Box className="w-44 border-blue-400/30 bg-blue-400/5">
              Think (reason about next step)
            </Box>
            <Arrow />
            <Box className="w-44 border-amber-400/30 bg-amber-400/5">Act (call tool / API)</Box>
            <Arrow />
            <Box className="w-44 border-emerald-400/30 bg-emerald-400/5">
              Observe (parse result)
            </Box>
          </div>
          <div className="mt-1 flex justify-end">
            <span className="text-[9px] text-muted-foreground">↻ repeat until done</span>
          </div>
        </div>
        <Arrow />
        <Box className="border-violet-400/30 bg-violet-400/5">Final Answer</Box>
      </div>
    </DiagramShell>
  );
}

function OrchestratorWorker() {
  return (
    <DiagramShell title="Orchestrator-Worker Pattern">
      <div className="flex flex-col items-center gap-1">
        <Box className="border-primary/40 bg-primary/5 font-semibold">Orchestrator Agent</Box>
        <div className="text-[9px] text-muted-foreground">decomposes task, assigns, merges</div>
        <div className="mt-1 grid w-full grid-cols-3 gap-2">
          {["Research Worker", "Code Worker", "Review Worker"].map((w) => (
            <div key={w} className="flex flex-col items-center gap-1">
              <span className="text-muted-foreground">↓</span>
              <Box className="w-full border-blue-400/30 bg-blue-400/5 text-[10px]">{w}</Box>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-1 text-[9px] text-muted-foreground">
          <span>results ↑ merge</span> <Arrow direction="right" />{" "}
          <Box className="border-emerald-400/30 bg-emerald-400/5">Merged Output</Box>
        </div>
      </div>
    </DiagramShell>
  );
}

function PromptInjection() {
  return (
    <DiagramShell title="Prompt Injection Attack Vectors">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2">
            <div className="mb-1 text-[10px] font-semibold text-red-600 dark:text-red-400">
              Direct Injection
            </div>
            <div className="text-[9px] text-muted-foreground">
              User crafts prompt to override system instructions
            </div>
          </div>
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2">
            <div className="mb-1 text-[10px] font-semibold text-red-600 dark:text-red-400">
              Indirect Injection
            </div>
            <div className="text-[9px] text-muted-foreground">
              Malicious instructions hidden in retrieved docs / tools
            </div>
          </div>
        </div>
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="mb-1.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
            Defenses (layered)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[
              "Input sanitization",
              "Output filtering",
              "Privilege separation",
              "Tool allowlists",
              "Human-in-the-loop",
              "Canary tokens",
            ].map((d) => (
              <span
                key={d}
                className="rounded-full border border-emerald-400/30 bg-emerald-400/5 px-2 py-0.5 text-[9px] font-medium text-emerald-700 dark:text-emerald-400"
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      </div>
    </DiagramShell>
  );
}

function LoRA() {
  return (
    <DiagramShell title="LoRA: Low-Rank Adaptation">
      <div className="flex items-center justify-center gap-4">
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-blue-400/40 bg-blue-400/5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
            W<br />
            <span className="text-[8px] font-normal">(frozen)</span>
          </div>
          <Label>d × d</Label>
        </div>
        <span className="text-lg text-muted-foreground">+</span>
        <div className="flex flex-col items-center gap-1">
          <div className="flex gap-0.5">
            <div className="flex h-20 w-5 items-center justify-center rounded border border-primary/40 bg-primary/5 text-[8px] font-bold text-primary">
              A
            </div>
            <div className="flex h-5 w-20 items-center justify-center rounded border border-primary/40 bg-primary/5 text-[8px] font-bold text-primary">
              B
            </div>
          </div>
          <Label>rank r ≪ d</Label>
        </div>
        <span className="text-lg text-muted-foreground">=</span>
        <div className="flex flex-col items-center gap-1">
          <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-emerald-400/40 bg-emerald-400/5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            W′
            <br />
            <span className="text-[8px] font-normal">(adapted)</span>
          </div>
          <Label>~0.1% params trained</Label>
        </div>
      </div>
    </DiagramShell>
  );
}

function EvalHarness() {
  return (
    <DiagramShell title="LLM Evaluation Pipeline">
      <div className="flex flex-col items-center gap-1">
        <div className="grid w-full grid-cols-3 gap-2">
          <Box className="border-blue-400/30 bg-blue-400/5">Test Dataset</Box>
          <Box className="border-violet-400/30 bg-violet-400/5">Golden Answers</Box>
          <Box className="border-amber-400/30 bg-amber-400/5">Eval Rubric</Box>
        </div>
        <Arrow />
        <Box className="w-full border-primary/40 bg-primary/5">Run Model on Test Set</Box>
        <Arrow />
        <div className="grid w-full grid-cols-2 gap-2">
          <Box className="border-emerald-400/30 bg-emerald-400/5">
            <div className="font-semibold">Automated Metrics</div>
            <div className="text-[9px] text-muted-foreground">BLEU, ROUGE, exact match, F1</div>
          </Box>
          <Box className="border-violet-400/30 bg-violet-400/5">
            <div className="font-semibold">LLM-as-Judge</div>
            <div className="text-[9px] text-muted-foreground">GPT-4 / Claude rates quality</div>
          </Box>
        </div>
        <Arrow />
        <Box className="border-amber-500/30 bg-amber-500/5">Regression Dashboard & Alerts</Box>
      </div>
    </DiagramShell>
  );
}

function SystemDesignAgent() {
  return (
    <DiagramShell title="Production Agent System Design">
      <div className="flex flex-col items-center gap-1">
        <div className="grid w-full grid-cols-3 gap-2">
          <Box className="border-primary/40 bg-primary/5">API Gateway</Box>
          <Box className="border-blue-400/30 bg-blue-400/5">Auth / Rate Limit</Box>
          <Box className="border-amber-400/30 bg-amber-400/5">Queue / Async</Box>
        </div>
        <Arrow />
        <Box className="w-full border-violet-400/40 bg-violet-400/5 font-semibold">
          Agent Orchestrator
        </Box>
        <div className="grid w-full grid-cols-2 gap-2 mt-1">
          <div className="flex flex-col items-center gap-1">
            <Arrow />
            <Box className="w-full border-emerald-400/30 bg-emerald-400/5">Tool Registry</Box>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Arrow />
            <Box className="w-full border-blue-400/30 bg-blue-400/5">Knowledge Base</Box>
          </div>
        </div>
        <Arrow />
        <div className="grid w-full grid-cols-3 gap-2">
          <Box className="border-amber-400/30 bg-amber-400/5 text-[9px]">Observability</Box>
          <Box className="border-red-400/30 bg-red-400/5 text-[9px]">Guardrails</Box>
          <Box className="border-emerald-400/30 bg-emerald-400/5 text-[9px]">Human Review</Box>
        </div>
      </div>
    </DiagramShell>
  );
}

function CostLatency() {
  return (
    <DiagramShell title="Cost & Latency Optimization Levers">
      <div className="grid grid-cols-2 gap-2">
        {[
          {
            title: "Reduce Tokens",
            items: ["Shorter prompts", "Summarize context", "Prune few-shot"],
          },
          {
            title: "Cache Aggressively",
            items: ["Semantic cache", "Prompt cache", "KV cache reuse"],
          },
          {
            title: "Model Routing",
            items: ["Small model first", "Escalate on failure", "Task-specific models"],
          },
          {
            title: "Async / Batch",
            items: ["Queue non-urgent", "Batch API calls", "Speculative decode"],
          },
        ].map((g) => (
          <div key={g.title} className="rounded-lg border border-border/50 bg-muted/20 p-2">
            <div className="mb-1 text-[10px] font-semibold text-foreground/80">{g.title}</div>
            <div className="space-y-0.5">
              {g.items.map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-1 text-[9px] text-muted-foreground"
                >
                  <span className="h-1 w-1 rounded-full bg-primary" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </DiagramShell>
  );
}

function MCPProtocol() {
  return (
    <DiagramShell title="Model Context Protocol (MCP)">
      <div className="flex flex-col items-center gap-1">
        <Box className="border-primary/40 bg-primary/5">LLM / Agent</Box>
        <Arrow />
        <Box className="border-violet-400/40 bg-violet-400/5 font-semibold">MCP Client</Box>
        <div className="text-[9px] text-muted-foreground">standardized JSON-RPC</div>
        <Arrow />
        <div className="grid w-full grid-cols-3 gap-2">
          {[
            { name: "DB Server", icon: "🗄️" },
            { name: "API Server", icon: "🌐" },
            { name: "File Server", icon: "📁" },
          ].map((s) => (
            <Box key={s.name} className="border-emerald-400/30 bg-emerald-400/5">
              <div>{s.icon}</div>
              <div className="mt-0.5">{s.name}</div>
            </Box>
          ))}
        </div>
        <Label className="mt-1">Any data source becomes a tool via MCP adapters</Label>
      </div>
    </DiagramShell>
  );
}

function MemoryTypes() {
  return (
    <DiagramShell title="Agent Memory Architecture">
      <div className="grid grid-cols-3 gap-2">
        {[
          {
            name: "Short-term",
            desc: "Current conversation context window",
            color: "border-blue-400/30 bg-blue-400/5",
          },
          {
            name: "Working",
            desc: "Scratchpad for current task reasoning",
            color: "border-violet-400/30 bg-violet-400/5",
          },
          {
            name: "Long-term",
            desc: "Persisted facts, user prefs, past sessions",
            color: "border-emerald-400/30 bg-emerald-400/5",
          },
        ].map((m) => (
          <div key={m.name} className={cn("rounded-lg border p-2 text-center", m.color)}>
            <div className="text-[10px] font-semibold">{m.name}</div>
            <div className="mt-0.5 text-[9px] text-muted-foreground">{m.desc}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 rounded-lg border border-border/40 bg-muted/20 p-2 text-center text-[9px] text-muted-foreground">
        Pattern:{" "}
        <strong className="text-foreground/80">Summarize → Store → Retrieve → Inject</strong> into
        prompt on each turn
      </div>
    </DiagramShell>
  );
}

function GraphRAG() {
  return (
    <DiagramShell title="GraphRAG vs Vector RAG">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Box className="border-primary/40 bg-primary/5 font-semibold">Vector RAG</Box>
          <div className="rounded border border-border/40 p-2 text-[9px] text-muted-foreground">
            Query → embed → nearest neighbors → context → LLM
          </div>
          <div className="text-[9px] text-muted-foreground">
            ✅ Fast, simple | ❌ Misses multi-hop relations
          </div>
        </div>
        <div className="space-y-1.5">
          <Box className="border-violet-400/40 bg-violet-400/5 font-semibold text-violet-600 dark:text-violet-400">
            GraphRAG
          </Box>
          <div className="rounded border border-border/40 p-2 text-[9px] text-muted-foreground">
            Query → entity extraction → knowledge graph traversal → community summaries → LLM
          </div>
          <div className="text-[9px] text-muted-foreground">
            ✅ Multi-hop reasoning | ❌ Higher indexing cost
          </div>
        </div>
      </div>
    </DiagramShell>
  );
}

function HybridSearch() {
  return (
    <DiagramShell title="Hybrid Search: Vector + BM25">
      <div className="flex flex-col items-center gap-1">
        <Box className="border-primary/40 bg-primary/5">Query</Box>
        <div className="grid w-full grid-cols-2 gap-3 mt-1">
          <div className="flex flex-col items-center gap-1">
            <Arrow />
            <Box className="w-full border-blue-400/30 bg-blue-400/5">
              <div className="font-semibold">Vector Search</div>
              <div className="text-[9px] text-muted-foreground">semantic similarity</div>
            </Box>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Arrow />
            <Box className="w-full border-amber-400/30 bg-amber-400/5">
              <div className="font-semibold">BM25 / Keyword</div>
              <div className="text-[9px] text-muted-foreground">exact term matching</div>
            </Box>
          </div>
        </div>
        <Arrow />
        <Box className="border-emerald-400/30 bg-emerald-400/5">Reciprocal Rank Fusion (RRF)</Box>
        <Arrow />
        <Box className="border-violet-400/30 bg-violet-400/5">Re-ranked Top-K Results</Box>
      </div>
    </DiagramShell>
  );
}

function FunctionCalling() {
  return (
    <DiagramShell title="Function / Tool Calling Flow">
      <div className="flex flex-col items-center gap-1">
        <Box className="border-primary/40 bg-primary/5">User Message + Tool Definitions</Box>
        <Arrow />
        <Box className="border-blue-400/30 bg-blue-400/5">LLM decides: call tool or respond</Box>
        <Arrow />
        <div className="grid w-full grid-cols-2 gap-2">
          <div className="flex flex-col items-center gap-1">
            <Box className="w-full border-amber-400/30 bg-amber-400/5">
              <div className="font-semibold">Tool Call</div>
              <div className="text-[9px]">{"{ name, args }"}</div>
            </Box>
            <Arrow />
            <Box className="w-full border-emerald-400/30 bg-emerald-400/5">
              Execute & Return Result
            </Box>
            <Arrow />
            <Box className="w-full border-blue-400/30 bg-blue-400/5">LLM synthesizes answer</Box>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Box className="w-full border-violet-400/30 bg-violet-400/5">
              <div className="font-semibold">Direct Response</div>
              <div className="text-[9px]">No tool needed</div>
            </Box>
          </div>
        </div>
      </div>
    </DiagramShell>
  );
}

function RLHFvsDPO() {
  return (
    <DiagramShell title="RLHF vs DPO Alignment">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Box className="border-primary/40 bg-primary/5 font-semibold">RLHF</Box>
          <div className="flex flex-col items-center gap-1 text-[9px]">
            <span className="rounded border border-border/40 px-2 py-0.5">
              1. Collect human rankings
            </span>
            <Arrow />
            <span className="rounded border border-border/40 px-2 py-0.5">
              2. Train reward model
            </span>
            <Arrow />
            <span className="rounded border border-border/40 px-2 py-0.5">
              3. PPO to optimize policy
            </span>
          </div>
          <div className="text-[9px] text-muted-foreground">
            Complex, unstable, but proven at scale
          </div>
        </div>
        <div className="space-y-1.5">
          <Box className="border-emerald-400/40 bg-emerald-400/5 font-semibold text-emerald-600 dark:text-emerald-400">
            DPO
          </Box>
          <div className="flex flex-col items-center gap-1 text-[9px]">
            <span className="rounded border border-border/40 px-2 py-0.5">
              1. Collect preference pairs
            </span>
            <Arrow />
            <span className="rounded border border-border/40 px-2 py-0.5">
              2. Direct optimization
            </span>
            <Arrow />
            <span className="rounded border border-border/40 px-2 py-0.5">
              No reward model needed
            </span>
          </div>
          <div className="text-[9px] text-muted-foreground">Simpler, stabler, gaining adoption</div>
        </div>
      </div>
    </DiagramShell>
  );
}

/* ─── Wrapper ─── */
function DiagramShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/50 bg-gradient-to-br from-muted/30 to-muted/10 p-4">
      <div className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
        {title}
      </div>
      {children}
    </div>
  );
}

/* ─── Export map ─── */
const DIAGRAM_MAP: Record<string, () => React.ReactNode> = {
  "what-is-genai": GenAIvsPredictive,
  "transformer-attention": TransformerAttention,
  "context-window": ContextWindow,
  "temp-topp": TempTopP,
  "what-is-rag": RAGPipeline,
  "rag-vs-finetune": RAGvsFineTune,
  chunking: ChunkingStrategies,
  "hybrid-search": HybridSearch,
  graphrag: GraphRAG,
  "react-pattern": AgentLoop,
  "what-is-agent": AgentLoop,
  "orchestrator-worker": OrchestratorWorker,
  "when-multi-agent": OrchestratorWorker,
  "prompt-injection": PromptInjection,
  "agent-security": PromptInjection,
  lora: LoRA,
  "rlhf-vs-dpo": RLHFvsDPO,
  "eval-harness": EvalHarness,
  "llm-as-judge": EvalHarness,
  "function-calling": FunctionCalling,
  mcp: MCPProtocol,
  "agent-memory": MemoryTypes,
  "lost-in-middle": ContextWindow,
  "design-support-agent": SystemDesignAgent,
  "design-multi-tenant-rag": RAGPipeline,
  "design-eval-platform": EvalHarness,
  "reduce-latency": CostLatency,
  "cost-control": CostLatency,
};

export function QuestionDiagram({ questionId }: { questionId: string }) {
  const DiagramComponent = DIAGRAM_MAP[questionId];
  if (!DiagramComponent) return null;
  return <DiagramComponent />;
}
