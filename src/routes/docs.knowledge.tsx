import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  Diagram,
  DocLink,
  DocsHeader,
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
          "Ingest documents, pages and repositories; how chunking, embedding, retrieval and reranking work; graph search; sharing; and how to debug a bad answer.",
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
        of documents; agents attach to collections, not to individual files.
      </P>

      {/* ── INGESTION ── */}
      <H2 id="sources">Adding sources</H2>
      <P>
        <strong>Add source</strong> offers three kinds:
      </P>

      <H3 id="s-file">File upload</H3>
      <P>Accepted extensions, exactly:</P>
      <Code lang="Accepted file types">{`.txt   .md   .markdown   .csv   .tsv   .log
.html  .htm  .xml        .yaml  .yml  .json
.rtf   .pdf  .docx`}</Code>
      <Callout kind="warn" title="A scanned PDF yields nothing">
        Text is extracted, not OCR'd. A PDF that is images of pages produces zero chunks and the
        agent will answer from general knowledge with no sign anything is wrong. After uploading,
        check the document shows a non-zero chunk count — that is the one-second test that catches
        this.
      </Callout>

      <H3 id="s-url">Web page / crawl</H3>
      <P>
        Give a URL and the page is fetched and converted to text. Use it for public documentation
        and policy pages. Pages behind a login cannot be fetched.
      </P>

      <H3 id="s-github">GitHub repository</H3>
      <P>
        Ingests source and docs from a repository so an agent can answer questions about a codebase.
      </P>

      {/* ── PIPELINE ── */}
      <H2 id="pipeline">What happens on ingest</H2>
      <Diagram caption="Document to retrievable chunk.">{`file ──▶ extract text ──▶ split into chunks ──▶ embed each chunk ──▶ store
                             (few hundred words,      (vector = position
                              overlapping)             in meaning-space)

question ──▶ embed ──▶ nearest chunks ──▶ pasted into the prompt as [1] [2] …`}</Diagram>
      <P>
        <strong>Chunking</strong> matters more than people expect. Retrieval returns chunks, not
        documents — so if the sentence answering a question is split across two chunks, neither
        answers it well. Chunks overlap slightly to soften this.
      </P>
      <Callout kind="why">
        Embeddings match on <em>meaning</em>, not keywords: "how long do I have to send it back"
        finds a paragraph about the "30-day return window" with no shared words. The flip side is
        that meaning-similar but irrelevant text also scores well — which is why chunk boundaries
        and reranking matter.
      </Callout>

      <H3 id="embedding-provider">Which model does the embedding</H3>
      <P>
        Set this per collection under <strong>RAG settings → Embedding</strong>. When you have{" "}
        <strong>OpenRouter</strong> connected it is the default, so embedding does not compete for
        the OpenAI quota that chat, document generation and retrieval already share — when that
        quota runs out, knowledge-base search goes down with it. The built-in operator OpenAI key is
        the fallback, and any other connected provider with an OpenAI-compatible <C>/embeddings</C>{" "}
        endpoint can be selected instead.
      </P>
      <Callout kind="warn" title="Changing the model means re-embedding">
        Vectors from two different models are not comparable — searching model A's chunks with model
        B's query vector does not error, it quietly returns wrong matches. So the provider and model
        are recorded on each document when it is embedded, and the question is always embedded with
        whatever that document used. Switching a collection to a new model therefore only affects
        documents embedded from then on: use <strong>Back-fill embeddings</strong> to move the
        existing ones across.
      </Callout>
      <Callout kind="info">
        The vector store is fixed at <strong>1536 dimensions</strong>. A model must be able to emit
        that width — the OpenAI <C>text-embedding-3-*</C> models truncate to any size on request. If
        a model returns a different width the embed fails with a message saying so rather than
        writing unusable vectors.
      </Callout>

      {/* ── RETRIEVAL ── */}
      <H2 id="retrieval">Retrieval settings — the real numbers</H2>
      <Table
        headers={["Setting", "Default", "Range", "Notes"]}
        rows={[
          [
            "top-K",
            "5",
            "1 – 8 (hard cap)",
            "How many chunks are retrieved and pasted into the prompt. Asking for more than 8 is clamped.",
          ],
          [
            "Candidate pool with a reranker",
            "3 × top-K, max 20",
            "—",
            "With a reranker configured, a wider first pass is fetched and then re-scored down to top-K. This is where the accuracy gain comes from.",
          ],
          [
            "Snippet radius",
            "280 characters",
            "—",
            "How much text either side of a match is shown in the citation snippet under the answer.",
          ],
        ]}
      />

      <H3 id="reranking">Reranking</H3>
      <P>
        Configured per agent on the <strong>Knowledge</strong> tab: a <strong>Provider</strong> and
        a <strong>Re-rank model</strong> (for example <C>llama-nemotron-rerank-vl-1b-v2</C>).
      </P>
      <UL>
        <li>
          <strong>Cost</strong> — one extra model call per retrieval.
        </li>
        <li>
          <strong>When it pays</strong> — collections with many near-identical passages: long
          contracts, several revisions of one policy, product manuals for a family of similar
          products.
        </li>
        <li>
          <strong>When it doesn't</strong> — a small collection of clearly distinct documents. The
          first pass is already right.
        </li>
      </UL>

      {/* ── ATTACHING ── */}
      <H2 id="using">Attaching a collection to an agent</H2>
      <Steps
        items={[
          {
            title: "Create the collection and ingest into it",
            body: "Keep unrelated subject matter in separate collections — a mixed collection retrieves measurably worse.",
          },
          {
            title: "Agent Builder → Knowledge → link it",
            body: (
              <>
                Linking auto-enables the <C>kb_search</C> tool.
              </>
            ),
          },
          {
            title: "Add the grounding instruction to the system prompt",
            body: "Without this the model happily falls back on general knowledge and you will not notice.",
          },
          {
            title: "Turn on Citation Check",
            body: (
              <>
                Guardrails tab. It flags an answer that cites nothing when sources were available —
                see <DocLink to="/docs/guardrails">Guardrails</DocLink>.
              </>
            ),
          },
        ]}
      />
      <Code lang="The grounding block, minimum viable">{`Answer only from the provided sources. Cite them inline as [1], [2].
If the sources do not contain the answer, reply exactly:
"I don't have that in my documentation."
Never fill a gap with general knowledge.`}</Code>
      <P>
        Retrieval happens automatically before each turn, with numbered citations inserted. The{" "}
        <C>kb_search</C> tool additionally lets the agent search on demand, mid-answer, when its
        first read wasn't enough.
      </P>

      {/* ── GRAPH ── */}
      <H2 id="graph">Graph search</H2>
      <P>
        Ordinary retrieval finds chunks resembling the question. <strong>Graph search</strong> also
        follows relationships extracted between entities across documents, answering questions plain
        retrieval structurally cannot —{" "}
        <em>"which suppliers are affected by the clause in appendix B?"</em>, where no single chunk
        contains both halves.
      </P>
      <Steps
        items={[
          {
            title: "Build the graph",
            body: "Knowledge → Graph, on the collection. This is a separate, slower pass over the documents.",
          },
          {
            title: "Enable the tool",
            body: (
              <>
                Agent Builder → Tools → <C>kb_graph_search</C>.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn">
        Enabling <C>kb_graph_search</C> without building the graph first returns nothing — and the
        agent will treat "nothing" as "no information exists" rather than as a configuration
        problem.
      </Callout>

      {/* ── SHARING ── */}
      <H2 id="sharing">Sharing and access</H2>
      <P>
        Collections are private to their owner. An administrator can grant a user or group{" "}
        <strong>read-only</strong> access from <DocLink to="/docs/iam">Access control</DocLink>;
        shared collections show a <em>Shared</em> badge and cannot be edited by the recipient.
      </P>
      <P>
        Because the grant is enforced in the database, an agent's retrieval inherits it
        automatically — there is no second permission to keep in sync.
      </P>

      {/* ── DEBUGGING ── */}
      <H2 id="debugging">When an answer is wrong</H2>
      <P>Work through these in order. The cause is nearly always one of them.</P>
      <Table
        headers={["#", "Check", "What it means"]}
        rows={[
          [
            "1",
            "Does the document show a non-zero chunk count?",
            "Zero means extraction produced nothing — almost always a scanned PDF.",
          ],
          [
            "2",
            "Open the run in Traces: was anything retrieved?",
            "Empty means the collection isn't linked to this agent, or the query embedded far from everything in it.",
          ],
          [
            "3",
            "Are the retrieved chunks on-topic but not the right passage?",
            "Chunking or phrasing. Try a reranker; consider re-uploading a better-structured source.",
          ],
          [
            "4",
            "Retrieved correctly but ignored?",
            "The system prompt doesn't require grounding, or another tool's result was more prominent.",
          ],
          [
            "5",
            "Are knowledge sources listed under the answer?",
            "They appear when the answer cites them, or when nothing else grounded it. If a web search answered instead, you will see links — that is correct, not a bug.",
          ],
        ]}
      />

      <H3 id="quality">Getting better results</H3>
      <UL>
        <li>
          <strong>Prefer structured documents.</strong> Headings give the splitter meaningful
          boundaries; an unbroken wall of text does not.
        </li>
        <li>
          <strong>Split by subject, not by department.</strong> One collection per coherent topic
          retrieves better than one collection of everything.
        </li>
        <li>
          <strong>Delete superseded versions.</strong> Three revisions of one policy retrieve
          interchangeably and the agent has no way to know which is current. This is the single most
          common cause of confidently outdated answers.
        </li>
        <li>
          <strong>Put numbers in tables.</strong> If the question is really arithmetic it belongs in{" "}
          <DocLink to="/docs/data">Data Catalog</DocLink> — retrieval quotes prose, it does not
          compute.
        </li>
        <li>
          <strong>Name documents descriptively.</strong> The document name appears in the citation a
          reader sees, so <C>refund-policy-2026.pdf</C> beats <C>final_v3.pdf</C>.
        </li>
      </UL>

      <NextPrev current="/docs/knowledge" />
    </>
  );
}
