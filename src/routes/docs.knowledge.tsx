import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Diagram,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/knowledge")({
  head: () => ({
    meta: [
      { title: "Knowledge Base — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Ingest documents, pages and repositories; how chunking, embedding and retrieval work; graph search; and how to debug a bad answer.",
      },
      { property: "og:title", content: "Knowledge Base — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Give agents documents they can quote instead of facts they invent.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/knowledge" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/knowledge" }],
  }),
  component: KnowledgePage,
});

function KnowledgePage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Knowledge Base"
        description="Collections of documents an agent can search by meaning and quote with citations. This is how you stop an agent inventing your policies."
      />

      <P>
        Open <strong>Data → Knowledge Base</strong>. A <strong>collection</strong> is a named group
        of documents; agents are attached to collections, not to individual files.
      </P>

      <H2 id="sources">What you can ingest</H2>
      <Table
        headers={["Source", "Notes"]}
        rows={[
          [
            "PDF, DOCX, PPTX, XLSX",
            "Text is extracted; scanned image-only PDFs yield nothing without OCR.",
          ],
          [
            "Markdown, TXT, CSV",
            "Ingested directly. Markdown headings help chunking find clean boundaries.",
          ],
          ["Web pages", "Fetched and converted to text. Crawl a site section or a single URL."],
          [
            "GitHub repositories",
            "Source and docs from a repo, so an agent can answer about a codebase.",
          ],
          ["Pasted text", "For a policy or snippet that doesn't live in a file."],
        ]}
      />

      <H2 id="pipeline">What happens on ingest</H2>
      <Diagram caption="Document to retrievable chunk.">{`file ──▶ extract text ──▶ split into chunks ──▶ embed each chunk ──▶ store
                             (few hundred words,      (vector of numbers
                              overlapping)             = position in meaning-space)

question ──▶ embed ──▶ find nearest chunks ──▶ paste into prompt with [1] [2] markers`}</Diagram>
      <P>
        <strong>Chunking</strong> matters more than people expect. Retrieval returns chunks, not
        documents, so if the sentence that answers a question is split across two chunks, neither
        one answers it well. Chunks overlap slightly to soften this.
      </P>
      <Callout kind="why">
        Embeddings match on <em>meaning</em>, not keywords: "how long do I have to send it back"
        finds a paragraph about the "30-day return window" with no shared words. The flip side is
        that meaning-similar but irrelevant text also scores well — which is why a reranker and good
        chunk boundaries matter.
      </Callout>

      <H2 id="using">Attaching it to an agent</H2>
      <Steps
        items={[
          {
            title: "Create a collection and ingest into it",
            body: "Keep unrelated subject matter in separate collections — a mixed collection retrieves worse.",
          },
          {
            title: "Attach it in the Agent Builder",
            body: (
              <>
                Under <strong>Knowledge</strong>. Attach only collections this agent should be able
                to read.
              </>
            ),
          },
          {
            title: "Tell the agent to use it",
            body: (
              <>
                In the system prompt:{" "}
                <em>"Answer only from the provided sources; if they don't cover it, say so."</em>{" "}
                Without this, the model will happily fall back on general knowledge and you won't
                notice.
              </>
            ),
          },
        ]}
      />
      <P>
        At run time relevant excerpts are retrieved automatically and inserted with numbered
        citations, and the agent is instructed to cite them inline as <C>[1]</C>, <C>[2]</C>. The{" "}
        <C>kb_search</C> tool additionally lets the agent search on demand, mid-answer.
      </P>

      <H2 id="graph">Graph search</H2>
      <P>
        Ordinary retrieval finds chunks that resemble the question. <strong>Graph search</strong>{" "}
        also follows relationships extracted between entities across documents, which answers
        questions plain retrieval structurally cannot —{" "}
        <em>"which suppliers are affected by the clause in appendix B?"</em>, where no single chunk
        contains both halves.
      </P>
      <P>
        Enable it per agent with the <C>kb_graph_search</C> tool. It costs more to build and query,
        so reach for it when connecting facts matters more than quoting one passage.
      </P>

      <H2 id="reranking">Reranking</H2>
      <P>
        A reranker takes the first-pass candidates and re-scores them against the question with a
        stronger model. It reliably improves precision on collections where many chunks look
        superficially similar — long contracts, near-duplicate policy versions. Configure it per
        agent; it costs one extra model call per retrieval.
      </P>

      <H2 id="sharing">Sharing and access</H2>
      <P>
        Collections are private to their owner. An administrator can grant a user or group{" "}
        <strong>read-only</strong> access from <DocLink to="/docs/iam">Access control</DocLink>;
        shared collections appear with a <em>Shared</em> badge and cannot be edited by the
        recipient. Because the grant is enforced in the database, an agent's retrieval inherits it
        automatically — there is no separate permission to keep in sync.
      </P>

      <H2 id="debugging">When an answer is wrong</H2>
      <P>Work through it in this order — the cause is nearly always one of these:</P>
      <FieldList
        items={[
          {
            name: "Was anything retrieved?",
            body: (
              <>
                Open the run in <DocLink to="/docs/debugging">Traces</DocLink> and look at the
                retrieved chunks. Empty means the collection isn't attached, or the document never
                produced text (a scanned PDF).
              </>
            ),
          },
          {
            name: "Was the right thing retrieved?",
            body: "If the chunks are on-topic but not the specific passage, the source is probably chunked awkwardly, or the question is phrased very differently from the document. Try a reranker.",
          },
          {
            name: "Did the agent use it?",
            body: "Retrieved but ignored usually means the system prompt doesn't insist on grounding, or another tool's result was more prominent.",
          },
          {
            name: "Are the sources listed?",
            body: "Under the answer, knowledge base sources appear when the answer cites them or when nothing else grounded it. If a web search produced the answer, you'll see links instead — that's correct, not a bug.",
          },
        ]}
      />

      <H3 id="quality">Getting better results</H3>
      <UL>
        <li>
          <strong>Prefer structured documents.</strong> Headings give the splitter meaningful
          boundaries; a wall of unbroken text does not.
        </li>
        <li>
          <strong>Split by subject, not by department.</strong> One collection per coherent topic
          retrieves better than one giant collection of everything.
        </li>
        <li>
          <strong>Remove superseded versions.</strong> Three revisions of the same policy will
          retrieve interchangeably, and the agent has no way to know which is current.
        </li>
        <li>
          <strong>Put numbers in tables.</strong> If the question is really arithmetic, it belongs
          in <DocLink to="/docs/data">Data Catalog</DocLink> — retrieval quotes prose, it does not
          compute.
        </li>
      </UL>

      <NextPrev current="/docs/knowledge" />
    </>
  );
}
