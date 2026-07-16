// Types for the Notebooks feature. Notebooks are static, read-only learning
// material — edits to code cells are kept in-memory only.

export type NotebookCellRuntime = "server" | "browser";

export type NotebookMarkdownCell = {
  id: string;
  kind: "markdown";
  source: string;
};

export type NotebookCodeCell = {
  id: string;
  kind: "code";
  /** Display language label (e.g. "ts", "js"). Source is executed as JS. */
  language: "ts" | "js";
  /** Where the cell runs. Server is the default — only server cells can
   * touch secrets (AI Gateway, Firecrawl). */
  runtime: NotebookCellRuntime;
  /** The source the user sees and edits. Must be valid JavaScript at runtime
   * (no TS-only syntax) because we execute it via `new AsyncFunction`. */
  source: string;
  /** Optional pre-baked sample output so the page is useful before Run. */
  sampleOutput?: {
    logs?: string[];
    result?: unknown;
  };
};

export type NotebookCell = NotebookMarkdownCell | NotebookCodeCell;

export type NotebookTag =
  | "langchain"
  | "langgraph"
  | "llamaindex"
  | "firecrawl"
  | "agent"
  | "multi-agent"
  | "rag"
  | "hitl"
  | "real-world"
  | "content"
  | "devops"
  | "legaltech"
  | "fintech"
  | "consumer"
  | "structured-output"
  | "routing"
  | "evaluation";

export type Notebook = {
  id: string;
  title: string;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  tags: NotebookTag[];
  /** Optional sub-section label shown inside a group on the sidebar/catalog,
   *  e.g. "Foundations" or "Advanced RAG". Notebooks that share the same
   *  subgroup are rendered together under a small sub-header. */
  subgroup?: string;
  /** Optional list of integration slugs the notebook needs. Surfaces a
   * CTA if the user hasn't linked them yet. */
  requires?: ("firecrawl" | "lovable-ai")[];
  cells: NotebookCell[];
};

export type NotebookSummary = Omit<Notebook, "cells"> & {
  cellCount: number;
};

export type CellRunResult = {
  ok: boolean;
  logs: string[];
  /** JSON-pretty-printed result returned by the cell. */
  result?: string;
  error?: string;
  durationMs: number;
};
