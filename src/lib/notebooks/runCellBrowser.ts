// Client-side notebook cell runner. Cloudflare Workers disallow
// `new Function` / `new AsyncFunction`, so we compile and execute cell
// source in the browser instead. Privileged operations (AI Gateway,
// Firecrawl) are proxied through server functions — secrets never reach
// the client.

import type { CellRunResult } from "./types";
import { notebookFirecrawlSearch, notebookFirecrawlScrape } from "./proxy.functions";
import {
  notebookListKbDocuments,
  notebookGetKbDocument,
  NOTEBOOK_RAG_KB_ID,
  NOTEBOOK_RAG_DOCS,
} from "./kb.functions";
import { supabase } from "@/integrations/supabase/client";

const MAX_LOG_BYTES = 8_000;
const MAX_RESULT_BYTES = 8_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const PDFJS_VERSION = "4.7.76";

// NOTE: The notebook runtime intentionally uses jsDelivr ESM bundles for
// LangChain instead of esm.sh. Current esm.sh builds can resolve a broken
// shared langsmith chunk whose `dist/utils/env.mjs` imports `__version__` from
// `../index.mjs` — an export that does not exist — which crashes cells with:
//   "The requested module '../index.mjs' does not provide an export named '__version__'"
const RUNTIME_IMPORTS = {
  openai: "https://cdn.jsdelivr.net/npm/@langchain/openai@1.4.7/+esm",
  messages: "https://cdn.jsdelivr.net/npm/@langchain/core@1.1.48/messages/+esm",
  tools: "https://cdn.jsdelivr.net/npm/@langchain/core@1.1.48/tools/+esm",
  prompts: "https://cdn.jsdelivr.net/npm/@langchain/core@1.1.48/prompts/+esm",
  runnables: "https://cdn.jsdelivr.net/npm/@langchain/core@1.1.48/runnables/+esm",
  outputParsers: "https://cdn.jsdelivr.net/npm/@langchain/core@1.1.48/output_parsers/+esm",
  documents: "https://cdn.jsdelivr.net/npm/@langchain/core@1.1.48/documents/+esm",
  textSplitters: "https://cdn.jsdelivr.net/npm/@langchain/textsplitters@1.0.1/+esm",
  vectorstores: "https://cdn.jsdelivr.net/npm/@langchain/classic@1.0.34/vectorstores/memory/+esm",
  langgraph: "https://cdn.jsdelivr.net/npm/@langchain/langgraph@1.3.4/+esm",
  pdfjs: `https://esm.sh/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`,
  zod: "https://cdn.jsdelivr.net/npm/zod@4.4.3/+esm",
} as const;

let runtimeModulesPromise: Promise<Record<keyof typeof RUNTIME_IMPORTS, any>> | undefined;

function getRuntimeModules() {
  runtimeModulesPromise ??= Promise.all(
    Object.entries(RUNTIME_IMPORTS).map(async ([key, url]) => [
      key,
      await import(/* @vite-ignore */ url),
    ])
  ).then((entries) => Object.fromEntries(entries) as Record<keyof typeof RUNTIME_IMPORTS, any>);
  return runtimeModulesPromise;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2);
  } catch {
    return String(v);
  }
}
function clamp(s: string, max: number): string {
  // Notebook image cells return base64 data URLs. If we truncate the result
  // string before the viewer extracts the image, browsers can decode only the
  // first rows of the PNG, which looks like a partially generated image.
  if (/data:image\/[a-zA-Z+]+;base64,/.test(s)) return s;
  return s.length <= max ? s : s.slice(0, max) + `… [truncated ${s.length - max} chars]`;
}

// Per-notebook persistent state (across cell runs in the same browser tab)
const notebookState = new Map<string, Record<string, unknown>>();

export async function runCellInBrowser(
  notebookId: string,
  source: string,
  opts?: { timeoutMs?: number }
): Promise<CellRunResult> {
  const start = Date.now();
  const logs: string[] = [];
  let totalLogBytes = 0;
  const log = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
    totalLogBytes += line.length;
    if (totalLogBytes > MAX_LOG_BYTES) return;
    logs.push(line);
  };

  if (!notebookState.has(notebookId)) notebookState.set(notebookId, {});
  const state = notebookState.get(notebookId)!;
  const runtime = await getRuntimeModules();
  runtime.pdfjs.GlobalWorkerOptions.workerSrc =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

  // Auth bearer for the OpenAI-compatible proxy route
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token ?? "";

  const ctx = {
    log,
    state,
    fetch: globalThis.fetch.bind(globalThis),
    // Real LangChain modules — cells import via `ctx.lc.*`
    lc: {
      openai: runtime.openai,
      messages: runtime.messages,
      tools: runtime.tools,
      prompts: runtime.prompts,
      runnables: runtime.runnables,
      outputParsers: runtime.outputParsers,
      documents: runtime.documents,
      textSplitters: runtime.textSplitters,
      vectorstores: runtime.vectorstores,
      langgraph: runtime.langgraph,
      z: runtime.zod.z,
    },
    pdfjs: runtime.pdfjs,
    // OpenAI-compatible endpoint for ChatOpenAI({ configuration: { baseURL: ctx.aiBaseURL } })
    aiBaseURL: `${globalThis.location?.origin ?? ""}/api/notebooks/${encodeURIComponent(notebookId)}/ai/v1`,
    aiApiKey: accessToken, // ChatOpenAI sends this as the Bearer for our proxy
    firecrawl: {
      search: (query: string, options?: Record<string, unknown>) =>
        notebookFirecrawlSearch({ data: { query, options } }),
      scrape: (url: string, options?: Record<string, unknown>) =>
        notebookFirecrawlScrape({ data: { url, options } }),
    },
    // Read from the platform's Knowledge Base. RLS scopes visibility —
    // sample docs are visible to everyone; the user's own KB docs are
    // visible to them. `DOCS` are stable IDs of the Notebook RAG Lab.
    kb: {
      RAG_LAB_KB_ID: NOTEBOOK_RAG_KB_ID,
      DOCS: NOTEBOOK_RAG_DOCS,
      listDocuments: (knowledgeBaseId?: string) =>
        notebookListKbDocuments({ data: { knowledgeBaseId } }),
      getDocument: (documentId: string) =>
        notebookGetKbDocument({ data: { documentId } }),
    },
  };

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (ctx: unknown) => Promise<unknown>;
    const fn = new AsyncFunction("ctx", source);

    const result = await Promise.race<unknown>([
      fn(ctx),
      new Promise((_r, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Cell timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);

    return {
      ok: true,
      logs,
      result: clamp(safeStringify(result ?? null), MAX_RESULT_BYTES),
      durationMs: Date.now() - start,
    };
  } catch (e) {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, logs, error: err, durationMs: Date.now() - start };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function resetNotebookState(notebookId: string) {
  notebookState.delete(notebookId);
}
