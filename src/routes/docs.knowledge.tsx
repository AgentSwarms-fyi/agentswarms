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
          "Ingest documents, pages, repositories and connected services (Google Drive, Notion, SharePoint, Dropbox); scheduled sync without re-indexing; chunking, embedding, retrieval and reranking; source-based access control; and how to debug a bad answer.",
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
        <strong>Add source</strong> covers one-shot ingestion — files, a web page, a repository.{" "}
        <strong>Connect</strong> links an external service that is synced on a schedule and kept
        deduplicated. Both land documents in the same collection and the same retrieval pipeline.
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

      <H3 id="s-connectors">Connected services — Drive, Notion, SharePoint, Dropbox</H3>
      <P>
        <strong>Connect</strong> opens a wizard for four providers. Credentials are pasted tokens
        (the platform's BYOK pattern — no OAuth consent screens to register), validated against the
        provider at save time, <strong>encrypted at rest</strong>, and never sent back to the
        browser: editing a source shows empty credential fields, and leaving them empty keeps what
        is stored.
      </P>
      <Table
        headers={["Provider", "Credentials", "What syncs", "Mirrors sharing?"]}
        rows={[
          [
            "Google Drive",
            "Access token, or refresh token + OAuth client pair for unattended syncs",
            "A folder (subfolders to depth 5): Google Docs/Sheets/Slides exported as text, plus text-format files",
            "Yes — per-file permissions",
          ],
          [
            "Notion",
            "Internal-integration secret; share the pages with the integration",
            "Listed page IDs and every page of listed databases",
            "No — the API exposes none",
          ],
          [
            "SharePoint",
            "Entra app registration: tenant + client ID + secret (Files.Read.All, admin-consented)",
            "A document library or folder path, text-format files",
            "Yes — per-item permissions",
          ],
          [
            "Dropbox",
            "Access token, or refresh token + app key/secret for unattended syncs",
            "A folder path (or everything); native content hashes make change detection exact",
            "Yes — file members, best-effort",
          ],
        ]}
      />
      <P>
        Per source, listings cap at <strong>500 items</strong> and each item's text at{" "}
        <strong>400k characters</strong>. Anything the connector saw but did not ingest — an
        unsupported binary, a too-deep folder, the cap — is listed on the source card{" "}
        <strong>with its reason</strong>, never silently dropped.
      </P>
      <Callout kind="warn" title="Short-lived tokens and schedules don't mix">
        A pasted access token is fine for a first manual sync, but Google's expire in about an hour
        and Dropbox's eventually rotate — a scheduled sync running at 3am needs the refresh-token
        form. The wizard says which fields serve which purpose.
      </Callout>

      {/* ── SCHEDULED SYNC ── */}
      <H2 id="scheduled-sync">Scheduled sync — indexing without duplicates</H2>
      <P>
        Each connected source has a schedule: <strong>manual, hourly, daily or weekly</strong>.
        Scheduled syncs run on the platform's maintenance pass (the same engine that refreshes BI
        and SaaS data), and a claim on the source's next-run time guarantees that multiple app
        instances never sync the same source twice.
      </P>
      <P>Change detection is two-level, and both levels exist to make an hourly schedule cheap:</P>
      <Steps
        items={[
          {
            title: "Version skip — unchanged files are not downloaded",
            body: (
              <>
                The provider's change marker (modified time, revision, native hash) is stamped on
                each document. Unchanged marker ⇒ the item is skipped{" "}
                <em>without being downloaded</em> — a 400-file folder re-syncs for the price of a
                listing.
              </>
            ),
          },
          {
            title: "Content skip — unchanged text is not re-embedded",
            body: (
              <>
                Providers bump modified times on moves, permission edits and comments. Downloaded
                text is hashed (sha256); if it matches what is stored, the marker is refreshed and
                the document is <em>not re-chunked or re-embedded</em>. Embedding spend follows
                actual content change, nothing else.
              </>
            ),
          },
        ]}
      />
      <P>
        Files deleted at the provider delete their documents (and chunks) here. The source card
        shows each sync's outcome as <C>+added ~updated =unchanged −removed</C>, and a database
        uniqueness constraint on (source, remote item) makes duplicate documents impossible even if
        everything above were wrong.
      </P>
      <Callout kind="info" title="Sync statuses">
        <C>ok</C> is a clean pass. <C>error</C> names the provider's refusal verbatim — a revoked
        token reads "Dropbox 401: invalid_access_token", not "0 documents". <C>embed failed</C>{" "}
        means documents were saved but semantic indexing didn't finish: retrieval falls back to
        keyword search for them until a re-sync succeeds, and the owner gets a notification either
        way.
      </Callout>

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
        Set this per collection under <strong>RAG settings → Embedding</strong>.{" "}
        <strong>OpenRouter is the default</strong> — either through your own integration or, with no
        integration at all, through the operator's <C>OPENROUTER_API_KEY</C>. That keeps embedding
        off the OpenAI quota that chat, document generation and retrieval already share; when that
        quota runs out, knowledge-base search would otherwise go down with it. The operator's OpenAI
        key is the fallback, and any other connected provider exposing an OpenAI-compatible{" "}
        <C>/embeddings</C> endpoint can be selected instead.
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
      <P>
        The OpenRouter default is <C>openai/text-embedding-3-small</C> because it is the{" "}
        <em>same</em> 1536-d space the operator's OpenAI key produces: moving a collection onto
        OpenRouter to get off an exhausted OpenAI quota costs nothing and leaves existing chunks
        searchable. The other options are different spaces, so choosing one means re-indexing.
      </P>
      <Table
        headers={["Model", "Native width", "Notes"]}
        rows={[
          [
            <C key="a">openai/text-embedding-3-small</C>,
            "1536",
            "Default. Same vector space as the built-in OpenAI key.",
          ],
          [<C key="b">openai/text-embedding-3-large</C>, "3072", "Truncates to 1536 on request."],
          [<C key="c">google/gemini-embedding-001</C>, "3072", "Truncates to 1536 on request."],
          [<C key="d">qwen/qwen3-embedding-8b</C>, "4096", "Truncates to 1536 on request."],
          [<C key="e">qwen/qwen3-embedding-4b</C>, "2560", "Truncates to 1536 on request."],
        ]}
      />
      <P>
        Every model in that list was called against OpenRouter's live endpoint and confirmed to
        return 1536 dimensions. That check is not ceremony: OpenRouter does not list embedding
        models in its public <C>/models</C> catalogue, so a plausible-looking id is no evidence the
        model exists. Two NVIDIA nemotron ids used to be offered here and both returned{" "}
        <C>404 No endpoints found</C> — selecting one produced a failed embed with nothing to
        indicate the model had never been available.
      </P>

      {/* ── RETRIEVAL ── */}
      <H2 id="chunk-modes">Chunking modes</H2>
      <P>
        Retrieval and generation want opposite things from a chunk. Matching is most precise when
        chunks are small and about one idea; answering is best when the model can see the whole
        passage. <strong>RAG Settings &rarr; Chunking &rarr; Chunking Mode</strong> decides how that
        tension is resolved for a document.
      </P>
      <Table
        headers={["Mode", "What is embedded", "What the model reads", "Use it when"]}
        rows={[
          [
            "Flat",
            "The chunk",
            "The same chunk",
            "Short documents, FAQs, anything where one chunk is already a complete thought. This is the default and was the only behaviour before.",
          ],
          [
            "Parent-child",
            "Small child chunks",
            "The child's parent",
            "Long reference material — manuals, contracts, policies — where the sentence that matches is meaningless without the section around it.",
          ],
          [
            "Q&A",
            "A generated question",
            "The question and its answer",
            "Support content and policy documents that people query in natural questions. Costs one model call per passage at index time.",
          ],
        ]}
      />
      <P>
        <strong>Parent-child</strong> sets two sizes: the parent is what reaches the model, and the
        existing chunk size becomes the child. A child is capped at half the parent, because a child
        the same size as its parent is flat chunking with extra bookkeeping. Parents do not overlap
        each other; children overlap within a parent.
      </P>
      <P>
        <strong>Q&amp;A</strong> exists because a question and a statement are different kinds of
        text, and that difference is a real part of the distance between their vectors. Asking
        &ldquo;How do I rotate a key?&rdquo; against a paragraph that says &ldquo;Rotation issues a
        replacement&hellip;&rdquo; is a harder match than asking it against the generated question
        &ldquo;How do I rotate a key?&rdquo;. It needs <C>OPENROUTER_API_KEY</C>; if generation
        fails, the run reports it rather than quietly writing flat chunks, so a collection never
        disagrees with the mode shown in its own settings.
      </P>
      <Callout kind="warn" title="Changing the mode does not rewrite existing chunks">
        Re-chunking means paying to embed the whole document again, so it is never automatic. Use
        <strong> Re-index &ldquo;&hellip;&rdquo; with these settings</strong> in the Chunking tab to
        rebuild a collection under the new mode. Documents added afterwards use the new mode
        already.
      </Callout>

      <H2 id="hybrid">Hybrid search and weighting</H2>
      <P>
        Vector search finds meaning and blurs exact strings; an error code, a part number or a
        surname is exactly the kind of token embeddings smooth away. Keyword search is the opposite.
        <strong> RAG Settings &rarr; Retrieval</strong> sets which of them runs, per knowledge base.
      </P>
      <Table
        headers={["Mode", "What runs"]}
        rows={[
          [
            "Semantic",
            "Vector search only. The default, and what every collection did before this existed.",
          ],
          [
            "Hybrid",
            "Vector and Postgres full-text search over the same chunks, merged by weight.",
          ],
          ["Keyword", "Full-text search only."],
        ]}
      />
      <P>
        The <strong>weighting</strong> slider splits the score between them. Each retriever&rsquo;s
        scores are normalised within its own list first, because cosine similarity (roughly
        0.3&ndash;0.9) and text rank (roughly 0.0&ndash;0.3) are not comparable numbers &mdash;
        added raw, the slider would do almost nothing across most of its range. A chunk found by{" "}
        <em>both</em>
        retrievers scores above one found by only one, which is usually the result you want.
      </P>
      <P>
        Changing retrieval mode takes effect immediately and needs no re-embedding: it changes how
        the existing index is queried, not how it was built. Note that keyword search also indexes
        the generated <em>question</em> on Q&amp;A rows, because the answer text often does not
        contain the words someone would search for.
      </P>

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

      <H3 id="access-scopes">Per-source access scopes</H3>
      <P>
        Connected sources add a second, finer layer: <em>within</em> a collection someone can
        already see, which of its synced documents may they retrieve? Each connected source picks
        one of three scopes, enforced at retrieval — vector and keyword paths alike, before any
        reranking model sees the text:
      </P>
      <Table
        headers={["Scope", "Who retrieves the documents"]}
        rows={[
          [
            "Everyone with this KB",
            "Default. Documents behave exactly like uploads — collection visibility decides. Every pre-existing document works this way.",
          ],
          [
            "Only me",
            "The connecting user, full stop — even when the collection itself is shared or granted.",
          ],
          [
            "Match source permissions",
            "Sharing is mirrored from the provider per document: people shared on the original file (by email or domain, at Drive/SharePoint/Dropbox) retrieve it here; everyone else doesn't. A publicly-linked file stays public.",
          ],
        ]}
      />
      <UL>
        <li>
          <strong>Owner always retrieves their own documents</strong>, whatever the scope — a
          restriction you configured cannot lock you out of your own data.
        </li>
        <li>
          <strong>Fails toward deny.</strong> A provider that exposes no sharing info (Notion's API
          does not; a Dropbox plan without member listing) leaves documents owner-only, and the sync
          stats count them so the choice is visible. Tenant-wide links ("anyone in the
          organisation") match nobody but the owner — tenant membership can't be verified from here,
          and a wrong deny is recoverable where a wrong allow is not.
        </li>
        <li>
          <strong>Public embeds are anonymous.</strong> An embedded assistant retrieves only
          default-scope documents (and provider-public ones) — never "Only me" or ACL-restricted
          material, even though the embed runs under its owner's account.
        </li>
      </UL>

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
