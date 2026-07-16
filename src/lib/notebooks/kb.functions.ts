// Server functions used by RAG notebooks to read source documents from the
// platform's Knowledge Base. RLS on knowledge_documents already restricts
// SELECT to sample docs or rows the user owns, so callers can pass any
// document_id they have visibility to (sample docs, or their own KB docs).
//
// The notebooks then chunk + embed + retrieve client-side via LangChain
// against /api/notebooks/ai/v1/embeddings — so the full RAG pipeline runs
// in the cell, but the *source content* lives in a real knowledge base.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const NOTEBOOK_RAG_KB_ID = "c0ffee00-0000-4000-8000-000000000001";
export const NOTEBOOK_RAG_DOCS = {
  langchainPrimer: "c0ffee00-0000-4000-8000-00000000d001",
  eiffelTower: "c0ffee00-0000-4000-8000-00000000d002",
  threeTopics: "c0ffee00-0000-4000-8000-00000000d003",
} as const;

export const notebookListKbDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ knowledgeBaseId: z.string().uuid().optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const kbId = data.knowledgeBaseId ?? NOTEBOOK_RAG_KB_ID;
    const { data: docs, error } = await supabase
      .from("knowledge_documents")
      .select("id, name, knowledge_base_id, is_sample, content")
      .eq("knowledge_base_id", kbId)
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return {
      knowledgeBaseId: kbId,
      documents: (docs ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        isSample: !!d.is_sample,
        length: (d.content ?? "").length,
      })),
    };
  });

export const notebookGetKbDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ documentId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: doc, error } = await supabase
      .from("knowledge_documents")
      .select("id, name, knowledge_base_id, is_sample, content, metadata")
      .eq("id", data.documentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!doc) throw new Error("Document not found or not visible");
    return {
      id: doc.id,
      name: doc.name,
      knowledgeBaseId: doc.knowledge_base_id,
      isSample: !!doc.is_sample,
      content: doc.content ?? "",
    };
  });
