// Blog content model + posts. Static, version-controlled (mirrors the pattern of
// presentations.ts / buildAlongs.ts). Posts published by the team are authored by
// "AgentSwarms Authors"; user-submitted posts are a future roadmap item.
//
// A post is an ordered list of typed blocks rendered by BlogContent.tsx. Diagram
// blocks reference animated React components in components/blog/blogVisuals.tsx.

export type BlogBlock =
  | { type: "lead"; text: string }
  | { type: "heading"; text: string; id: string }
  | { type: "subheading"; text: string }
  | { type: "paragraph"; text: string } // supports **bold**, *italic*, `code`
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "callout"; tone: "info" | "warn" | "success" | "tip"; title?: string; text: string }
  | { type: "quote"; text: string; cite?: string }
  | { type: "code"; language?: string; code: string }
  | { type: "diagram"; visual: string; caption?: string }
  | { type: "divider" };

export type BlogPost = {
  slug: string;
  title: string;
  subtitle: string;
  excerpt: string;
  author: string; // always "AgentSwarms Authors" for now
  authorRole: string;
  date: string; // ISO yyyy-mm-dd
  readingTime: string;
  tags: string[];
  cover: { gradient: string; icon: string; motif: string };
  blocks: BlogBlock[];
  references?: { label: string; url: string }[];
};

const ragDocChange: BlogPost = {
  slug: "when-your-documents-change-keeping-rag-honest",
  title: "Keeping RAG Honest When Your Documents Change",
  subtitle:
    "Your RAG demo was perfect. Then someone edited a doc, deleted a page, and shipped a new policy — and your assistant kept citing the old one. Here's how to build a retrieval layer that doesn't quietly rot.",
  excerpt:
    "RAG is only as fresh as its index. Why retrieval rots as docs change, how to detect drift with content hashing, and re-indexing strategies that scale.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-22",
  readingTime: "16 min read",
  tags: ["RAG", "Production", "Observability"],
  cover: {
    gradient: "from-sky-500/30 via-primary/20 to-nexus-glow/30",
    icon: "refresh",
    motif: "docs",
  },
  blocks: [
    {
      type: "lead",
      text: "The demo was flawless. We dropped a folder of policy PDFs into a knowledge base, wired up retrieval, and the assistant answered everything with crisp citations. Two weeks later, support escalated a ticket: the bot had confidently quoted a refund window that legal had changed a month earlier. Nobody touched the code. The documents had moved on without us.",
    },
    {
      type: "paragraph",
      text: "This is the failure almost nobody teaches. Every RAG tutorial ends at *“…and then it answers from your documents.”* But documents are not a fixed thing you index once. They're alive — edited, versioned, deprecated, deleted, reorganized. The moment your corpus changes and your index doesn't, your beautifully grounded assistant starts grounding itself in the past.",
    },
    {
      type: "paragraph",
      text: "If you only remember one sentence from this post, make it this one: **a RAG system is only as fresh as its index, and your index does not update itself.** Everything below is about closing the gap between what your documents say *now* and what your vector store *thinks* they say.",
    },
    {
      type: "heading",
      text: "The quiet failure mode",
      id: "the-quiet-failure",
    },
    {
      type: "paragraph",
      text: "Most production incidents are loud — a 500, a stack trace, a pager. Stale retrieval is the opposite. Nothing throws. The pipeline runs, the vector search returns chunks, the model writes a fluent, well-cited answer. It's just *wrong*, because the chunk it cited describes a world that no longer exists. The system is behaving exactly as designed; the design simply assumed the documents would hold still.",
    },
    {
      type: "diagram",
      visual: "doc-lifecycle",
      caption:
        "A document's journey through a RAG pipeline — and where it goes stale. Press play: the source gets edited, but the chunk sitting in the vector store still holds the old text. Retrieval happily returns it.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Why it's so easy to miss",
      text: "Staleness has no error signal. Your dashboards stay green, latency is fine, costs look normal. The only symptom is a slow erosion of answer quality that you won't notice until a user — or worse, a customer — does.",
    },
    {
      type: "heading",
      text: "Documents change in more ways than you think",
      id: "how-documents-change",
    },
    {
      type: "paragraph",
      text: "“The docs changed” hides at least four distinct events, and each one needs a different response from your indexing layer:",
    },
    {
      type: "list",
      items: [
        "**Edits** — a paragraph is rewritten, a number is updated. The document's identity is the same; its content isn't. You need to re-chunk and re-embed the affected parts.",
        "**New versions** — v2 of a contract supersedes v1, but v1 may still be legally relevant. Now you have a versioning problem, not just a freshness one.",
        "**Deletions** — a page is removed or a product is sunset. Its chunks must *leave* the index, or your assistant will keep citing a ghost.",
        "**Reorganizations** — content is split, merged, or moved between files. Chunk boundaries shift, IDs you relied on disappear, and naïve diffing sees the whole corpus as “new.”",
      ],
    },
    {
      type: "paragraph",
      text: "Deletions are the one teams forget. Adding fresh content feels like progress, so re-ingestion pipelines tend to *upsert* and call it a day. But a vector store that only ever grows is a vector store that never forgets — and in retrieval, a confidently-returned deleted chunk is indistinguishable from a current one.",
    },
    {
      type: "heading",
      text: "Step one: detect what actually changed",
      id: "detecting-change",
    },
    {
      type: "paragraph",
      text: "Re-embedding your entire corpus on every change is simple and, for a few thousand documents, perfectly fine. It stops being fine the moment you have millions of chunks and an embedding bill to match. The scalable move is to **only touch what changed** — which means you need a cheap, reliable way to know what changed.",
    },
    {
      type: "paragraph",
      text: "The workhorse here is **content hashing**. For every chunk (or every document, then every chunk), compute a stable hash of its normalized text. Store that hash alongside the vector as metadata. On the next ingestion run, hash the incoming content and compare:",
    },
    {
      type: "diagram",
      visual: "change-detection",
      caption:
        "Content-hash diffing. Edit a document on the left and watch its hash change — only the chunks whose hash moved get re-embedded; unchanged chunks are skipped; chunks that vanished from the source get tombstoned. Try editing or deleting one.",
    },
    {
      type: "code",
      language: "typescript",
      code: `// A minimal change-detection pass over one document's chunks.
import { createHash } from "node:crypto";

const hash = (text: string) =>
  createHash("sha256").update(text.trim().replace(/\\s+/g, " ")).digest("hex");

async function reconcile(docId: string, freshChunks: string[]) {
  // What's currently indexed for this document?
  const existing = await store.list({ filter: { docId } }); // [{ id, contentHash }]
  const existingByHash = new Map(existing.map((c) => [c.contentHash, c]));

  const seen = new Set<string>();
  for (const text of freshChunks) {
    const h = hash(text);
    seen.add(h);
    if (existingByHash.has(h)) continue;      // unchanged → skip (no re-embed)
    const vector = await embed(text);          // changed or new → embed
    await store.upsert({ id: \`\${docId}:\${h}\`, vector, text, contentHash: h, docId });
  }

  // Anything indexed but no longer present in the source was deleted.
  for (const c of existing) {
    if (!seen.has(c.contentHash)) await store.delete(c.id); // tombstone
  }
}`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "Normalize before you hash",
      text: "Whitespace, smart quotes, and trailing newlines will wreck your diff — every chunk will look “changed” after a harmless reformat. Normalize aggressively (collapse whitespace, standardize quotes) so the hash reflects *meaning*, not formatting noise.",
    },
    {
      type: "paragraph",
      text: "Keep a small **ingestion manifest** per source: the document's own version or last-modified timestamp, plus the set of chunk hashes you produced. On the next run you can skip untouched documents entirely before you even chunk them, and you have an audit trail of exactly what the index believed at any point in time.",
    },
    {
      type: "heading",
      text: "Step two: choose a re-indexing strategy",
      id: "reindexing-strategies",
    },
    {
      type: "paragraph",
      text: "Once you know *what* changed, you have to decide *how* to apply it. There's no single right answer — it's a trade between simplicity, cost, and how much you can tolerate a half-updated index serving live traffic.",
    },
    {
      type: "diagram",
      visual: "reindex-strategies",
      caption:
        "The three strategies you'll actually choose between. Toggle each one to see how it touches the index, what it costs, and what users see while it runs.",
    },
    {
      type: "list",
      items: [
        "**Full rebuild** — re-chunk and re-embed everything from scratch into a clean index. Dead simple, immune to drift, and easy to reason about. It's also the most expensive and slowest, so it works best on small corpora or on a nightly cadence.",
        "**Incremental** — use your hash diff to re-embed only changed and new chunks, and delete the gone ones, in place. Cheap and fast. The catch: while it runs, your index is momentarily inconsistent (some chunks updated, some not), which can produce briefly weird answers.",
        "**Versioned / blue-green** — build the updated index *beside* the live one, validate it, then flip traffic over atomically. The gold standard for anything user-facing.",
      ],
    },
    {
      type: "paragraph",
      text: "For most teams the pragmatic path is **incremental updates for routine edits**, with a **periodic full rebuild** as a safety net to wash out any drift, fragmentation, or chunking-logic changes that incremental updates can accumulate over time.",
    },
    {
      type: "heading",
      text: "Versioned indexes: never serve a half-built index",
      id: "versioned-indexes",
    },
    {
      type: "paragraph",
      text: "The single highest-leverage practice for a serious RAG system is to treat your index like you treat application deploys: **immutable, versioned, and swapped atomically.** You don't edit production in place while users are hitting it — you build the new version, run it through checks, and cut over.",
    },
    {
      type: "diagram",
      visual: "versioned-index",
      caption:
        "Blue/green indexing. Queries keep hitting v1 while v2 is built and validated in the background. When v2 passes its evals, an alias flips and every new query goes to v2 — with zero downtime and an instant rollback if something looks off.",
    },
    {
      type: "paragraph",
      text: "Most managed vector stores support this directly through **aliases or namespaces**: your application queries a stable name (say, `kb-current`) that points at a concrete underlying index (`kb-2026-05-22`). Re-indexing builds a new concrete index, you validate it, then you re-point the alias. Rollback is just pointing it back. No user ever sees a partially-updated state.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Carry metadata like your life depends on it",
      text: "Every chunk should travel with its source id, document version, last-updated timestamp, and content hash. This is what makes incremental diffing, deletions, version filtering (“only answer from the current contract”), and debugging a bad answer possible. Thin metadata is the root cause of most “why did it retrieve *that*?” mysteries.",
    },
    {
      type: "heading",
      text: "The chunk that lost its context",
      id: "contextual-embeddings",
    },
    {
      type: "paragraph",
      text: "Even with a perfectly fresh index, there's a subtler failure that gets worse as documents grow and change: a chunk, ripped out of its document and embedded on its own, often loses the context that made it meaningful. A sentence like *“The figure rose 18% in this period”* is useless in isolation — which figure, which period, which company?",
    },
    {
      type: "paragraph",
      text: "**Contextual embeddings** (popularized by Anthropic's contextual retrieval work) fix this cheaply: before embedding a chunk, prepend a short, document-aware blurb that situates it. You generate that blurb once per chunk with a fast, cheap model — and because the surrounding document rarely changes when a single chunk does, you can cache it and only regenerate context for chunks whose neighborhood actually moved.",
    },
    {
      type: "diagram",
      visual: "contextual-embeddings",
      caption:
        "Same chunk, two embeddings. On the left, the raw chunk embeds into an ambiguous region and loses to better-worded competitors. On the right, a one-line generated context is prepended before embedding — and the same query now lands it cleanly. Toggle the context on and off.",
    },
    {
      type: "code",
      language: "typescript",
      code: `// Prepend a short, generated context before embedding each chunk.
const context = await llm.complete({
  model: "fast-cheap-model",
  prompt: \`Document: \${docTitle}
Here is a chunk from it:
"""\${chunk}"""
In one sentence, situate this chunk within the document so it stands alone.\`,
});

const enriched = \`\${context}\\n\\n\${chunk}\`;
const vector = await embed(enriched); // embed the context + chunk together
await store.upsert({ id, vector, text: chunk, context, contentHash: hash(chunk) });`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "Pair it with hybrid search",
      text: "Contextual embeddings raise recall, but exact terms (error codes, SKUs, names) still belong to keyword search. Blending dense vectors with a classic keyword index (BM25) and a reranker on top is the most reliable retrieval stack we know of — and it's resilient to the wording drift that comes with edited docs.",
    },
    {
      type: "heading",
      text: "You can't fix what you can't see",
      id: "observability",
    },
    {
      type: "paragraph",
      text: "Because staleness is silent, you have to go looking for it. Treat retrieval like any other production system and instrument it:",
    },
    {
      type: "list",
      items: [
        "**Log every retrieval** — the query, the chunks returned, their scores, their source ids and versions. When an answer is wrong, you want to replay exactly what the model saw.",
        "**Track which chunks get cited** — chunks that are retrieved but never useful are noise; chunks that are cited constantly are load-bearing and deserve extra care when their source changes.",
        "**Watch the freshness gap** — alert when a source's last-modified time is newer than the index's last-ingested time for that source. That single metric catches most staleness before a user does.",
        "**Sample and review** — periodically pull real queries and eyeball the retrieved context. Drift hides in the long tail.",
      ],
    },
    {
      type: "heading",
      text: "Re-indexing without an eval is a coin flip",
      id: "evaluation",
    },
    {
      type: "paragraph",
      text: "Here's the trap: re-indexing *feels* safe, so teams ship it blind. But a chunking tweak, a new embedding model, or a botched deletion can quietly tank retrieval quality — and you've now baked that regression into your fresh, confident-looking index.",
    },
    {
      type: "paragraph",
      text: "The fix is to gate every re-index behind an evaluation, exactly like you'd gate a code deploy behind tests. Maintain a **golden set** — a few dozen representative questions with known-good answers and the chunks that should be retrieved. Run it against the candidate index *before* you flip the alias. If retrieval recall or answer faithfulness drops, the new index doesn't ship.",
    },
    {
      type: "diagram",
      visual: "reindex-eval-gate",
      caption:
        "The re-index gate. A candidate index only goes live if it clears the golden-set eval. Watch a good rebuild pass and a regression get caught and rolled back.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Make the loop boring",
      text: "Detect change → re-embed only what moved → build a new versioned index → run the golden-set eval → flip the alias if it passes → keep the freshness metric green. None of these steps is exotic. The teams whose RAG stays trustworthy are simply the ones who made this loop automatic and unglamorous.",
    },
    {
      type: "heading",
      text: "A practical playbook",
      id: "playbook",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Attach rich metadata to every chunk from day one: source id, version, updated_at, and content_hash. You can't add this retroactively without a full rebuild.",
        "Normalize text, then hash each chunk. Diff against the index to find edits, additions, and — critically — deletions.",
        "Re-embed only what changed; tombstone what's gone. Keep a periodic full rebuild as a drift-washing safety net.",
        "Build re-indexes into a new versioned index; never mutate the live one in place.",
        "Gate the cutover on a golden-set eval. Flip the alias only if quality holds.",
        "Use contextual embeddings + hybrid search + a reranker so retrieval survives wording drift.",
        "Instrument retrieval and alert on the freshness gap. Silence is not success.",
      ],
    },
    {
      type: "heading",
      text: "Where this lands in AgentSwarms",
      id: "agentswarms",
    },
    {
      type: "paragraph",
      text: "We built the Knowledge Base in AgentSwarms with exactly these failure modes in mind. Documents are chunked and embedded for you, chunk inserts are idempotent (so a re-ingestion run won't duplicate or corrupt your index), and the UI surfaces an `embedding_failed` status so a silent half-indexed document doesn't slip by. You can feel the whole retrieval loop end-to-end — including what a broken one looks like — in the Failure-Mode Labs.",
    },
    {
      type: "callout",
      tone: "info",
      title: "A note on scope",
      text: "AgentSwarms is a learning and prototyping platform, not a production RAG runtime. The point of this post isn't to sell you our index — it's to give you the mental model and the playbook so that whatever you run in production stays honest as your documents change.",
    },
    {
      type: "paragraph",
      text: "Your documents will keep changing. That's not a bug in your knowledge base — it's the whole reason it exists. Build the loop that keeps up with them, and your assistant stops being a snapshot of last month and starts being a reliable window into what's true right now.",
    },
  ],
  references: [
    {
      label: "Your Chunks Failed Your RAG in Production — Towards Data Science",
      url: "https://towardsdatascience.com/your-chunks-failed-your-rag-in-production/",
    },
    {
      label: "RAG in Practice: Versioning, Observability & Evaluation — Towards AI",
      url: "https://pub.towardsai.net/rag-in-practice-exploring-versioning-observability-and-evaluation-in-production-systems-85dc28e1d9a8",
    },
    {
      label: "RAG in Production — Arpit Bhayani",
      url: "https://arpitbhayani.me/blogs/rag-production/",
    },
    {
      label: "Contextual Retrieval (Contextual Embeddings) — Anthropic Cookbook",
      url: "https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide",
    },
  ],
};

const failureModes: BlogPost = {
  slug: "7-failure-modes-that-kill-multi-agent-systems",
  title: "7 Failure Modes That Kill Multi-Agent Systems",
  subtitle:
    "Gartner thinks 40%+ of agentic AI projects will be canceled by 2027. Here's the field guide to the seven ways swarms actually die — and how to fix each one in a swarm you can run in your browser.",
  excerpt:
    "Most multi-agent systems don't fail loudly. They drift, loop, and quietly degrade. We walk the seven failure modes that kill swarms in production — hallucination snowballs, runaway loops, goal drift, silent quality decay — and the concrete fix for each, with broken swarms you can repair.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-27",
  readingTime: "15 min read",
  tags: ["Multi-Agent", "Production"],
  cover: {
    gradient: "from-rose-500/30 via-amber-500/15 to-primary/20",
    icon: "bug",
    motif: "fail",
  },
  blocks: [
    {
      type: "lead",
      text: "Here's the uncomfortable verdict up front: most multi-agent systems that look brilliant in a demo will fall apart the first week real users touch them — and not with a stack trace. They drift. They loop. They confidently agree with each other about something that isn't true. Gartner expects more than 40% of agentic AI projects to be canceled by the end of 2027, and it's rarely the model's fault. It's the system around it.",
    },
    {
      type: "paragraph",
      text: "We built **Failure-Mode Labs** into AgentSwarms for exactly this reason: you learn agentic AI far faster by fixing a swarm that's broken than by reading another happy-path tutorial. This post is the field guide that goes with them — the seven failure modes we see over and over, what each one looks like at 2am, and the concrete fix.",
    },
    {
      type: "diagram",
      visual: "failure-taxonomy",
      caption:
        "The seven failure modes, each with its symptom and fix. Click through them — then we'll go deep on the three that cause the most pain.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Why a taxonomy helps",
      text: "Researchers cataloguing real multi-agent failures (the MAST work) found they cluster into a handful of recurring patterns — specification gaps, inter-agent misalignment, and verification failures. You don't need to fear infinite novelty; you need a checklist.",
    },
    {
      type: "heading",
      text: "1. The hallucination snowball",
      id: "hallucination-snowball",
    },
    {
      type: "paragraph",
      text: "In a single agent, a hallucination is a wrong answer. In a swarm, it's contagious. Agent A invents a number; Agent B treats A's output as ground truth and builds an analysis on it; Agent C writes a confident report citing the analysis. Nobody lied on purpose — each agent just trusted the last one. By the end, three agents agree on something that was never real.",
    },
    {
      type: "diagram",
      visual: "hallucination-snowball",
      caption:
        "Watch a false claim propagate through a peer-to-peer chain — then add a skeptic and watch it break the cascade. Counter-intuitively, a swarm with some built-in doubt is more accurate than one where every agent is agreeable.",
    },
    {
      type: "paragraph",
      text: "The fix is to **never let an agent's output be treated as fact without grounding**. Make each agent cite the tool result it's relying on. Add a dedicated verifier or critic agent whose only job is to challenge claims. And resist the urge to make every agent maximally agreeable — a little skepticism in the population measurably raises the swarm's collective accuracy, because it interrupts the cascade before it sets.",
    },
    {
      type: "heading",
      text: "2. The runaway loop",
      id: "runaway-loop",
    },
    {
      type: "paragraph",
      text: "This is the one that shows up on your bill. A critic agent and a worker agent get into a polite infinite argument — the critic always finds one more nit, the worker always revises, and the loop never emits a stop signal. Nothing errors. The run just spins, burning a full round of model calls every iteration, until a timeout (or a finance alert) finally kills it.",
    },
    {
      type: "diagram",
      visual: "runaway-loop-cost",
      caption:
        "Add iterations and watch the cost climb, then bound the loop. Every reflection pass is another full round of LLM calls — an unbounded loop is a runaway bill waiting to happen.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Two controls, always",
      text: "Every loop needs both a hard max-iteration cap AND an explicit stop condition (a DONE token, a passing eval score). The cap is your safety net; the stop condition is the intended exit. Ship neither and you've shipped a money fire.",
    },
    {
      type: "paragraph",
      text: "Here's the shape of the bug we see most. A reflection loop is written as `while not critic.satisfied(): worker.revise()`. In testing, the critic is satisfied after two passes and everyone's happy. In production, a user submits a genuinely ambiguous task, the critic is *never* fully satisfied, and the loop runs until the request times out 90 seconds and 60 model calls later. Multiply by a few hundred such requests a day and you've found the line item that gets the project its budget review.",
    },
    {
      type: "code",
      language: "typescript",
      code: `// The same loop, made safe. Two independent exits, plus a record of why it ended.
async function reflect(task: string) {
  let draft = await worker.run(task);
  let reason = "max_iters";
  for (let i = 0; i < 4; i++) {              // (1) hard cap — the safety net
    const { score, critique } = await critic.grade(draft);
    if (score >= 0.85) { reason = "passed"; break; }   // (2) the intended exit
    draft = await worker.revise(draft, critique);
  }
  // Always emit WHY the loop stopped — you'll want this in the trace later.
  return { draft, stoppedBecause: reason };
}`,
    },
    {
      type: "heading",
      text: "3. Goal drift",
      id: "goal-drift",
    },
    {
      type: "paragraph",
      text: "Over a long, multi-step task, agents forget what they were doing. The original objective slides out of the context window, each step optimizes for the local sub-task, and ten steps later the swarm is enthusiastically solving a problem nobody asked about. It's the agentic version of opening a browser tab to look something up and resurfacing an hour later having reorganized your bookmarks.",
    },
    {
      type: "list",
      items: [
        "**Re-inject the goal** into the context on every step — cheap insurance against drift.",
        "**Plan-and-execute** beats pure ReAct here: commit to a written plan up front, then check each step against it.",
        "**A supervisor/orchestrator** that owns the goal and dispatches scoped sub-tasks keeps workers from wandering.",
      ],
    },
    {
      type: "paragraph",
      text: "A concrete example. Ask a research agent to *“find three peer-reviewed sources on GLP-1 side effects and summarize them.”* Step one, it searches and finds a promising review article. Step two, the article mentions a related drug, so it searches *that*. Step three, it's comparing dosing schedules. Step seven, it's written a small essay on pharmacology and cited zero peer-reviewed sources. Every individual step was reasonable; the chain lost the plot. Re-injecting *“Reminder: your task is to return exactly three peer-reviewed sources with summaries”* on each turn is the cheapest fix that exists, and it works.",
    },
    {
      type: "heading",
      text: "The other four (and their fixes)",
      id: "the-rest",
    },
    {
      type: "list",
      items: [
        "**Tool misuse** — the agent calls the wrong tool, or the right tool with malformed arguments. Fix with tight JSON schemas, server-side argument validation, and one or two few-shot examples per tool.",
        "**Context loss** — a key fact falls out of the window mid-task and the agent silently proceeds without it. Fix by externalizing state to a scratchpad/store and summarizing history instead of truncating it.",
        "**Silent quality degradation** — output slips from great to mediocre with no signal. Fix with continuous evals and an LLM-as-judge gate that alerts on score drift, not just on errors.",
        "**Scope creep** — the agent 'helpfully' does more than it was asked, touching things it shouldn't. Fix with a constrained system prompt, deny-by-default tools, and a strict output schema.",
      ],
    },
    {
      type: "heading",
      text: "What actually works: structure beats vibes",
      id: "what-works",
    },
    {
      type: "paragraph",
      text: "The teams that make multi-agent systems reliable aren't using a magic framework — they're adding *structure*. PwC reported pushing a workflow's accuracy from roughly 10% to 70% not by swapping models but by wrapping the work in structured validation loops with dedicated judge agents. The pattern is boring and it works: generate, verify, gate, and only then proceed.",
    },
    {
      type: "code",
      language: "typescript",
      code: `// The validation loop that turns a flaky worker into a reliable one.
let draft = await worker.run(task);
for (let i = 0; i < MAX_ITERS; i++) {        // (1) hard cap
  const verdict = await judge.grade(draft, rubric);
  if (verdict.score >= BAR) break;            // (2) explicit stop condition
  draft = await worker.revise(draft, verdict.critique); // grounded in feedback
}
return draft;`,
    },
    {
      type: "callout",
      tone: "success",
      title: "Try it, don't just read it",
      text: "Each failure above maps to a deliberately-broken swarm in the AgentSwarms Failure-Mode Labs — a hallucinating RAG agent, a runaway loop, a dead-branch router. Open one, run it, watch it fail, then fix it and watch the platform verify your repair. That loop is the fastest way to build real intuition for what breaks.",
    },
    {
      type: "heading",
      text: "A 60-second triage when your swarm misbehaves",
      id: "triage",
    },
    {
      type: "paragraph",
      text: "When something's wrong at 2am, you don't have time to theorize. Open the trace and walk this checklist — it maps symptoms to the seven modes fast:",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Run cost or step count exploded?** → runaway loop. Find the loop, check it has a cap and a stop condition.",
        "**Answer is confidently wrong?** → hallucination snowball. Trace back to the first unsupported claim and add a verifier there.",
        "**Agent solved the wrong problem?** → goal drift. Check whether the objective survived in the later prompts.",
        "**A tool call errored or returned junk?** → tool misuse. Inspect the exact arguments the model emitted against the schema.",
        "**Quality dropped with no error?** → silent degradation. Diff a good run's trace against a bad one; check your eval scores over time.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "The trace is your microscope",
      text: "Almost every multi-agent bug is invisible in the final output and obvious in the trace. The single highest-leverage thing you can do for reliability is capture every Thought, Action, and Observation per run — so 'why did it do that?' has an answer you can read instead of guess.",
    },
    {
      type: "paragraph",
      text: "Multi-agent systems don't fail because the idea is bad. They fail because we ship the demo and skip the seven boring controls above. Add a verifier, bound your loops, re-inject the goal, validate tool args, externalize state, run evals, and scope every agent — and you've quietly moved from the 40% Gartner expects to cancel into the minority that ships.",
    },
  ],
  references: [
    {
      label: "Over 40% of agentic AI projects will be canceled by end of 2027 — Gartner",
      url: "https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027",
    },
    {
      label: "MAST: a taxonomy of multi-agent system failure modes",
      url: "https://arxiv.org/abs/2503.13657",
    },
    {
      label: "2025 Stack Overflow Developer Survey — AI sentiment",
      url: "https://survey.stackoverflow.co/2025/",
    },
  ],
};

const frameworkCompare: BlogPost = {
  slug: "langgraph-vs-crewai-vs-autogen-2026",
  title: "LangGraph vs CrewAI vs AutoGen: 2026 Benchmark",
  subtitle:
    "Everyone publishes the feature grid. Almost nobody runs the same swarm through all three and reports what actually happened to the success rate and the bill. Here's that.",
  excerpt:
    "We ran the same researcher → writer → reviewer pipeline through LangGraph, CrewAI, and AutoGen and looked at the two numbers that matter: did it finish the task, and what did it cost? A builder's benchmark with an opinionated verdict and a decision flowchart — not another feature table.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-26",
  readingTime: "14 min read",
  tags: ["Frameworks", "Multi-Agent"],
  cover: {
    gradient: "from-violet-500/30 via-primary/20 to-sky-500/25",
    icon: "scale",
    motif: "compare",
  },
  blocks: [
    {
      type: "lead",
      text: "The verdict first, because you're busy: if you're shipping something that has to stay up, use **LangGraph**. If you want a working prototype before lunch, use **CrewAI**. If you're doing open-ended, debate-style reasoning or red-teaming, **AutoGen** earns its extra cost. Everything below is the evidence — the same swarm run through all three, judged on the only two questions that survive contact with production: did it finish the task, and what did it cost?",
    },
    {
      type: "paragraph",
      text: "Most comparisons you'll find are feature tables rewritten from each project's README. That's not useful — every framework can technically do everything. What's useful is watching the *same* researcher → writer → reviewer pipeline behave differently in each one as the task gets harder.",
    },
    {
      type: "heading",
      text: "Does it actually finish the task?",
      id: "success-rate",
    },
    {
      type: "diagram",
      visual: "framework-benchmark",
      caption:
        "Task success rate by complexity (directional, from public benchmarks cross-checked against our own template runs). On simple tasks they're all fine. The interesting story is what happens as the step count climbs.",
    },
    {
      type: "paragraph",
      text: "On simple tasks, it's a coin toss — they all clear 88%+. The gap opens on **complex, 8-plus-step tasks**, where explicit-state-machine frameworks pull ahead: LangGraph's success rate holds up best because every transition is something you defined, not something the model improvised. The conversational frameworks lose ground precisely where they're most flexible — freedom to chat is also freedom to wander.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Why the state machine wins on hard tasks",
      text: 'When the path is long, implicit control flow ("agents figure out who talks next") accumulates small errors. Explicit control flow ("node A always hands to node B unless this condition") doesn\'t drift. The trade is more upfront wiring for more reliability later.',
    },
    {
      type: "subheading",
      text: "The task we actually ran",
    },
    {
      type: "paragraph",
      text: "To keep this honest, here's the workload: a three-stage pipeline — a Researcher gathers facts on a topic, a Writer drafts a 300-word brief from only those facts, and a Reviewer checks the draft against the facts and sends it back if it drifts. *Simple* = a well-known topic with abundant sources. *Medium* = a niche topic needing 2–3 searches. *Complex* = a multi-part question where the reviewer rejects the first draft at least once, forcing a real revision loop. Same prompts, same mid-tier model, same topics across all three frameworks.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Read benchmarks like a skeptic",
      text: "Any single benchmark is a snapshot of one workload, on one model, on one day. Treat these numbers as directional, not gospel — the durable insight is the shape (explicit control flow scales better with task length), not the exact percentages. Re-run them on your own task before you bet a roadmap on them.",
    },
    {
      type: "heading",
      text: "What does it cost to run?",
      id: "cost",
    },
    {
      type: "paragraph",
      text: "Success rate is half the story. The other half shows up on your invoice. The frameworks differ wildly in how many model calls they fire for the same job, and AutoGen's conversational pattern is the outlier.",
    },
    {
      type: "diagram",
      visual: "framework-cost",
      caption:
        "LLM calls per task, and the resulting relative cost. AutoGen's agents talk to each other to reach an answer — powerful for emergent reasoning, but it can fire 20+ calls where a tight LangGraph flow fires a handful, landing around 5–6× the token bill.",
    },
    {
      type: "paragraph",
      text: "This is the trade nobody puts in the feature table: AutoGen's chattiness is the *source* of its strength (emergent, multi-perspective reasoning) and the *source* of its cost. For a debate or a red-team, those extra calls are the point. For a high-volume production pipeline, they're a budget you'll regret.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Estimate it before you commit",
      text: "Before you pick a framework, model the cost: iterations × agents × calls-per-step × token price. AgentSwarms' Multi-Agent Token Cost Calculator does this in a few clicks — run your real architecture through it and the framework choice often makes itself.",
    },
    {
      type: "heading",
      text: "The same swarm, three ways",
      id: "code",
    },
    {
      type: "paragraph",
      text: "The mental models are genuinely different. LangGraph is a graph of nodes sharing explicit state. CrewAI is roles and tasks assigned to a crew. AutoGen is agents in a conversation. Here's the shape of each:",
    },
    {
      type: "code",
      language: "python",
      code: `# LangGraph — an explicit state graph; you own every edge.
graph = StateGraph(State)
graph.add_node("research", research_fn)
graph.add_node("write", write_fn)
graph.add_node("review", review_fn)
graph.add_edge("research", "write")
graph.add_conditional_edges("review", lambda s: "write" if s.needs_revision else END)

# CrewAI — roles, goals, tasks; readable and opinionated.
crew = Crew(agents=[researcher, writer, reviewer],
            tasks=[research_task, write_task, review_task],
            process=Process.sequential)

# AutoGen — agents that collaborate by conversing.
chat = GroupChat(agents=[researcher, writer, reviewer], max_round=12)
manager = GroupChatManager(groupchat=chat)`,
    },
    {
      type: "heading",
      text: "The gotcha with each (that the README won't tell you)",
      id: "gotchas",
    },
    {
      type: "list",
      items: [
        "**CrewAI** — fastest to a working crew, but the same high-level abstractions that make it quick make it fiddly when you need non-standard control flow. You'll fight the framework the moment your process isn't 'sequential' or 'hierarchical'.",
        "**LangGraph** — the most control and the steepest learning curve. You think in nodes, edges, and a shared state object, and there's real ceremony. The payoff is that nothing happens that you didn't draw.",
        "**AutoGen / AG2** — brilliant for emergent, conversational problem-solving, but the group chat is hard to make *deterministic*, and the call count (and bill) is hard to predict. Great for research, dangerous for a tight SLA.",
      ],
    },
    {
      type: "subheading",
      text: "Don't forget the operational story",
    },
    {
      type: "paragraph",
      text: "Frameworks are judged on day one by their API and on day ninety by their operations. Before you commit, ask the unglamorous questions: How do I trace a run? Can I checkpoint and resume a long task? How do I deploy and version it? LangGraph leans hardest into this (checkpointing, a platform, first-class observability); CrewAI and AutoGen lean on the surrounding ecosystem. Whatever you pick, you'll still need your own evals, guardrails, and cost tracking — the framework gives you orchestration, not production-readiness.",
    },
    {
      type: "heading",
      text: "So which one?",
      id: "decision",
    },
    {
      type: "diagram",
      visual: "framework-decision",
      caption:
        "The honest decision tree. Pick by what you're optimizing for — durability, speed-to-prototype, emergent reasoning, or interoperability — not by GitHub stars.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Prototype framework-agnostically first",
      text: "In AgentSwarms you can wire the researcher → writer → reviewer swarm on a visual canvas, get the architecture right, then export it to LangGraph, CrewAI, or the OpenAI Agents SDK. Decide the shape before you marry a framework's API.",
    },
    {
      type: "paragraph",
      text: "The framework wars will keep shifting — AutoGen's AG2 rebrand, CrewAI's explosive growth, LangGraph's enterprise lock-in. But the decision rule is stable: optimize for the constraint that actually bites you. Most teams over-index on success rate and forget cost until the bill arrives. Look at both, and the choice gets easy.",
    },
  ],
  references: [
    {
      label: "Agent framework benchmark (success rate by complexity) — Pooya Golchian",
      url: "https://github.com/pooyagolchian",
    },
    { label: "LangGraph documentation", url: "https://langchain-ai.github.io/langgraph/" },
    { label: "CrewAI documentation", url: "https://docs.crewai.com/" },
    { label: "AutoGen / AG2", url: "https://microsoft.github.io/autogen/" },
  ],
};

const agenticRag: BlogPost = {
  slug: "agentic-rag-vs-traditional-rag",
  title: "Agentic RAG vs Traditional RAG: Key Differences",
  subtitle:
    "Traditional RAG retrieves once and hopes. Agentic RAG can notice it retrieved garbage and try again. Here's the difference, with working architectures — and an honest take on when the upgrade isn't worth it.",
  excerpt:
    "Vanilla RAG is a straight line: embed, retrieve, stuff, generate. Agentic RAG adds a brain that can route, grade its own retrieval, and self-correct. We compare the three architectures with working code, show when NOT to upgrade, and cover the RAG-poisoning attack that should keep you up at night.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-25",
  readingTime: "13 min read",
  tags: ["RAG", "Multi-Agent"],
  cover: {
    gradient: "from-emerald-500/25 via-primary/20 to-nexus-glow/30",
    icon: "network",
    motif: "rag",
  },
  blocks: [
    {
      type: "lead",
      text: "The one-line difference: traditional RAG retrieves once and answers from whatever it got, even if that's noise. Agentic RAG can look at what it retrieved, decide it's not good enough, and go again — route to a different source, rewrite the query, or escalate. That single capability — self-awareness about retrieval quality — is what separates a search box from an agent. It's also why agentic RAG is slower, pricier, and not always the right call.",
    },
    {
      type: "heading",
      text: "Three architectures on a spectrum",
      id: "spectrum",
    },
    {
      type: "diagram",
      visual: "rag-evolution",
      caption:
        "Toggle between vanilla, router, and multi-agent RAG. Each step adds intelligence — and latency and cost. The right choice depends entirely on how varied and high-stakes your questions are.",
    },
    {
      type: "list",
      items: [
        "**Vanilla RAG** — query → embed → top-k → stuff → generate. One shot. Brilliant for a narrow, well-curated corpus where retrieval rarely misses.",
        "**Router (single-agent) RAG** — an agent first decides *where* to look (the docs? the SQL DB? the web?), then retrieves. One smart hop, modest extra cost.",
        "**Multi-agent RAG** — a planner, a retriever, a grader, and a writer collaborate, with a self-correction loop. Most capable, most expensive, highest latency.",
      ],
    },
    {
      type: "heading",
      text: "The move that makes it 'agentic': self-correction",
      id: "self-correction",
    },
    {
      type: "paragraph",
      text: "The defining feature of agentic RAG is a **grader** that checks whether the retrieved chunks are actually relevant *before* the model answers. If they're not, the system rewrites the query and retrieves again — instead of confidently generating from irrelevant context. It's the difference between a student who re-reads the question when confused and one who bluffs.",
    },
    {
      type: "diagram",
      visual: "rag-self-correction",
      caption:
        "Step the retrieve → grade → (rewrite ↺) → generate loop. The grader is the whole point: it gives retrieval a second chance instead of letting one bad search poison the answer.",
    },
    {
      type: "code",
      language: "python",
      code: `# The self-correcting retrieval loop, in spirit.
query = user_question
for attempt in range(MAX_RETRIES):
    chunks = retrieve(query, top_k=5)
    grade = grader.score(question=user_question, chunks=chunks)  # relevant?
    if grade.relevant:
        break
    query = rewriter.improve(user_question, chunks)  # try a sharper query
return generate(user_question, chunks)  # answer, grounded + cited`,
    },
    {
      type: "code",
      language: "python",
      code: `# The grader is just a focused LLM call with a strict, narrow job.
GRADER_PROMPT = """You are a retrieval grader. Given a question and a
retrieved chunk, answer with ONLY 'yes' or 'no': is this chunk relevant
and sufficient to help answer the question? Be strict — 'somewhat' is 'no'."""

def grade(question, chunks):
    votes = [llm(GRADER_PROMPT, q=question, chunk=c) for c in chunks]
    return sum(v == "yes" for v in votes) >= 2   # need a couple of solid hits`,
    },
    {
      type: "heading",
      text: "How do you know agentic actually won?",
      id: "measuring",
    },
    {
      type: "paragraph",
      text: "This is the step everyone skips: agentic RAG *feels* smarter, so teams ship it without checking that it's actually more accurate than the vanilla pipeline it replaced. Don't. Measure both on the same questions and look at the numbers that separate retrieval failures from generation failures:",
    },
    {
      type: "list",
      items: [
        "**Context recall** — did retrieval surface the chunks that actually contain the answer? This is where agentic routing/self-correction should win.",
        "**Context precision** — of what was retrieved, how much was on-target noise vs signal?",
        "**Faithfulness** — is the final answer grounded in the retrieved context, or did the model embellish?",
        "**Answer relevance** — does the answer address the question that was asked?",
        "**Latency & cost per answer** — the price you paid for any accuracy gain. If agentic adds 2× cost for 3% recall, it lost.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Hybrid search + a reranker first",
      text: "Before you reach for a planner and a grader, try the cheaper upgrade: blend dense vector search with keyword/BM25 and run a reranker over the top results. It often closes most of the gap with agentic RAG at a fraction of the latency — and it stacks underneath agentic RAG when you do need both.",
    },
    {
      type: "heading",
      text: "When NOT to upgrade",
      id: "when-not",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Agentic RAG is not a free upgrade",
      text: "A static HR-handbook Q&A bot answering 'how many vacation days do I get?' does not need a planner, a grader, and three model calls per question. You'd be trading 3× the latency and cost for accuracy the corpus didn't need. Reach for agentic RAG when questions are varied, multi-hop, or span multiple sources — not by default.",
    },
    {
      type: "paragraph",
      text: "A good rule: start vanilla, measure where retrieval fails, and add exactly the agency that fixes those failures. Add a router when questions span sources. Add a grader when retrieval quality is your bottleneck. Add full multi-agent orchestration only when the task genuinely needs planning. Every layer you add is latency and tokens you'll pay for on every single query.",
    },
    {
      type: "heading",
      text: "The security postscript nobody mentions",
      id: "poisoning",
    },
    {
      type: "paragraph",
      text: "Here's the thing that should worry you more than latency: your retrieval corpus is an attack surface. **RAG poisoning** research has shown that a handful of carefully crafted documents — around five — can manipulate a system's answers roughly 90% of the time. If your corpus ingests anything user-editable (a wiki, support tickets, scraped pages), an attacker can plant instructions that your agent will dutifully retrieve and obey.",
    },
    {
      type: "diagram",
      visual: "rag-poisoning",
      caption:
        "A single poisoned document in the corpus hijacks the answer. Add a provenance/trust filter that only retrieves from vetted sources and the attack is contained. Treat retrieved content as untrusted input, always.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Build the pieces hands-on",
      text: "AgentSwarms ships the building blocks: a RAG Chunking Visualizer and Semantic Chunker to get retrieval right, a GraphRAG Triplet Extractor for multi-hop, and a Synthetic RAG Eval Dataset Generator so you can actually measure whether your fancy agentic pipeline beats the vanilla one. Measure before you upgrade.",
    },
    {
      type: "paragraph",
      text: "Agentic RAG is genuinely better when your questions are hard — and genuinely wasteful when they're not. The skill isn't building the most sophisticated pipeline; it's knowing the smallest amount of agency that makes your answers reliably correct, and stopping there.",
    },
  ],
  references: [
    { label: "Agentic RAG survey & patterns", url: "https://arxiv.org/abs/2501.09136" },
    { label: "RAG poisoning / corpus attacks research", url: "https://arxiv.org/abs/2402.07867" },
    {
      label: "Contextual Retrieval — Anthropic",
      url: "https://www.anthropic.com/news/contextual-retrieval",
    },
  ],
};

const mcpPlaybook: BlogPost = {
  slug: "mcp-production-playbook-2026",
  title: "The MCP Server You Actually Ship: 2026 Playbook",
  subtitle:
    "The Model Context Protocol went from an Anthropic proposal to a de-facto standard in about a year. Most tutorials stop at 'hello world'. This one takes you to a server you can ship — with auth, audit, and the confused-deputy fix.",
  excerpt:
    "MCP solves the n×m integration mess that was strangling agent tooling. We cover what it actually is (and isn't), how the JSON-RPC handshake works, why it wraps but doesn't replace REST — and the security work that separates a demo MCP server from one you'd put in production, including the confused-deputy attack.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-24",
  readingTime: "14 min read",
  tags: ["MCP & Tools", "Production"],
  cover: {
    gradient: "from-sky-500/30 via-primary/20 to-violet-500/25",
    icon: "plug",
    motif: "mcp",
  },
  blocks: [
    {
      type: "lead",
      text: "The Model Context Protocol earned its hype by killing a specific, miserable problem: every agent framework had its own way to describe tools, so connecting M apps to N tools meant writing M×N bespoke integrations. MCP makes it M+N. Build to one protocol once, and every MCP-aware agent can use your server. That's the whole pitch — and it's a good one. But the gap between a tutorial MCP server and one you'd actually ship is almost entirely security, and that's where this playbook lives.",
    },
    {
      type: "heading",
      text: "The math that explains the adoption",
      id: "the-math",
    },
    {
      type: "diagram",
      visual: "mcp-integration-math",
      caption:
        "Without a standard, every app needs a custom connector to every tool — n×m. MCP collapses that to n+m: one protocol, one integration per side. Toggle the hub to feel the difference.",
    },
    {
      type: "paragraph",
      text: "This isn't a small saving. MCP server downloads went from roughly 100K in late 2024 to over 8M by spring 2025, with hundreds of public servers and tens of millions of monthly SDK downloads by early 2026. When a standard makes integration linear instead of combinatorial, adoption tends to look like a hockey stick — and this one did.",
    },
    {
      type: "heading",
      text: "How it works under the hood",
      id: "how-it-works",
    },
    {
      type: "diagram",
      visual: "mcp-handshake",
      caption:
        "The MCP conversation is JSON-RPC 2.0: initialize (negotiate capabilities) → tools/list (advertise) → tools/call (invoke with typed args) → result. It runs over stdio for local servers or streamable HTTP for remote ones. Step through it.",
    },
    {
      type: "list",
      items: [
        "**Tools** — actions the agent can invoke (send_email, query_db), each with a typed JSON schema.",
        "**Resources** — read-only data the server exposes (files, records) the agent can pull into context.",
        "**Prompt templates** — reusable, parameterized prompts the server offers to clients.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "MCP wraps REST, it doesn't replace it",
      text: "Your MCP server almost always calls your existing REST/GraphQL APIs under the hood. MCP is the standardized, model-friendly *interface* — a translation layer that turns 'here are my endpoints' into 'here are my tools, described in a way any agent understands'. You're not rewriting your backend.",
    },
    {
      type: "paragraph",
      text: "Concretely, a minimal server is barely any code — the SDK handles the protocol, you just declare tools:",
    },
    {
      type: "code",
      language: "python",
      code: `from mcp.server.fastmcp import FastMCP

mcp = FastMCP("orders")

@mcp.tool()
def get_order(order_id: str) -> dict:
    """Look up an order by its ID. Read-only."""
    return db.fetch_order(order_id)   # calls your existing API/DB underneath

@mcp.tool()
def refund_order(order_id: str, reason: str) -> dict:
    """Issue a refund. HIGH RISK — gate behind approval + scoped auth."""
    require_scope("orders:refund")    # your authorization check
    return payments.refund(order_id, reason)

if __name__ == "__main__":
    mcp.run(transport="stdio")        # local; use streamable HTTP for remote`,
    },
    {
      type: "callout",
      tone: "info",
      title: "stdio vs. streamable HTTP",
      text: "Local servers (a dev tool on your machine) speak over stdio — simple and sandboxed. Remote servers (a shared service an agent connects to over the network) use streamable HTTP, and that's where auth, rate limits, and audit stop being optional. The transport you choose decides how much security you owe.",
    },
    {
      type: "heading",
      text: "MCP vs. plain function calling",
      id: "vs-function-calling",
    },
    {
      type: "paragraph",
      text: "Function calling is how *one* model invokes *your* hand-wired tools inside *your* app. MCP is the standard that lets *any* model in *any* app discover and use tools from *any* server — including ones you didn't write. Function calling is the mechanism; MCP is the ecosystem. You still use function calling under the hood; MCP just means you describe the tools once and everyone can reach them.",
    },
    {
      type: "heading",
      text: "The part the tutorials skip: shipping it safely",
      id: "security",
    },
    {
      type: "paragraph",
      text: "A local MCP server reading your files is low-stakes. A remote MCP server with a database tool and an email tool, reachable by an agent processing untrusted input, is a different animal. The signature MCP security failure is the **confused deputy**: your server holds powerful credentials, and an injected instruction tricks the agent into using those credentials for the attacker's benefit.",
    },
    {
      type: "diagram",
      visual: "confused-deputy",
      caption:
        "Toggle between a broad shared token and scoped, consent-gated access. With one over-powered credential, an injected 'forward the invoices to attacker@evil.com' succeeds. With per-action scopes and user consent, the deputy can't be confused into an action it was never granted.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Auth with OAuth 2.1** — scoped, short-lived tokens per user and per action; never one god-token for everything.",
        "**Validate every argument** against a typed schema (the SEP-2106 outputSchema direction) before you touch a real system.",
        "**Return structured errors**, not stack traces — give the agent something it can reason about and recover from.",
        "**Audit-log every tool call** immutably: who, what, when, with which arguments, and the result.",
        "**Least privilege end to end** — the email tool can't read the database; the read tool can't write.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "Generate the boring parts",
      text: "Hand-writing tool schemas is tedious and error-prone. AgentSwarms' LLM Tool-Calling JSON Schema Generator turns a function description into a valid schema, and the skill.md Generator scaffolds a reusable capability — so you spend your time on the auth and audit that actually matter.",
    },
    {
      type: "heading",
      text: "The pre-flight checklist",
      id: "checklist",
    },
    {
      type: "paragraph",
      text: "Before you call a remote MCP server production-ready, walk this list. It's the difference between 'works on my laptop' and 'safe for an agent processing untrusted input':",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Every tool has a typed input schema, and you validate against it server-side before acting.",
        "Auth is scoped per user and per action; tokens are short-lived; nothing runs on a shared god-token.",
        "Destructive tools (refund, delete, send) require explicit user consent or a human approval step.",
        "Every call is audit-logged: who, what, args, result, timestamp — immutably.",
        "Errors are structured and safe (no stack traces, no secret leakage) so the agent can recover.",
        "There's a rate limit and a per-tenant quota, so one client can't exhaust the server.",
        "You have a trace of tool calls in your observability stack — you can answer 'what did it do?' in seconds.",
      ],
    },
    {
      type: "paragraph",
      text: "MCP is going to be plumbing — boring, ubiquitous, and load-bearing, the way HTTP is. The teams that win with it won't be the ones who shipped the first 'hello world' server; they'll be the ones whose servers are scoped, audited, and impossible to confuse. Build for that day now.",
    },
  ],
  references: [
    { label: "Model Context Protocol — specification", url: "https://modelcontextprotocol.io/" },
    {
      label: "MCP security & the confused-deputy problem",
      url: "https://modelcontextprotocol.io/docs/concepts/security",
    },
    {
      label: "Anthropic: introducing the Model Context Protocol",
      url: "https://www.anthropic.com/news/model-context-protocol",
    },
  ],
};

const interviewQuestions: BlogPost = {
  slug: "agentic-ai-interview-questions-2026",
  title: "50 Agentic AI Interview Questions Asked in 2026",
  subtitle:
    "Tiered from junior to staff, with the senior-architect answers — and a runnable lab for the concepts that are easier to show than to say. The questions that separate 'I read a blog' from 'I've shipped this'.",
  excerpt:
    "A tiered bank of the agentic AI interview questions actually being asked in 2026 — junior (ReAct, tool calling, RAG), mid (orchestration, MCP, evaluation), and senior/staff (observability for non-deterministic systems, injection defense, knowing when NOT to use agents). With the answers interviewers are listening for.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-23",
  readingTime: "16 min read",
  tags: ["Career"],
  cover: {
    gradient: "from-amber-500/25 via-primary/20 to-emerald-500/25",
    icon: "clipboard",
    motif: "interview",
  },
  blocks: [
    {
      type: "lead",
      text: "Agentic-AI interviews have a tell. Junior questions ask whether you can wire a loop. Senior questions ask whether you can keep a non-deterministic system from quietly destroying itself in production. If you only prepare definitions, you'll pass the first round and faceplant in the system-design one. This is the tiered question bank we'd study from — with the answers the interviewer is actually listening for.",
    },
    {
      type: "diagram",
      visual: "interview-tiers",
      caption:
        "The same topics get harder by level. Junior: 'what is it?' Mid: 'how do the patterns compare?' Senior/Staff: 'how do you operate it safely when it's non-deterministic?' Tap through the tiers.",
    },
    {
      type: "heading",
      text: "Junior: do you understand the primitives?",
      id: "junior",
    },
    {
      type: "list",
      items: [
        "**Walk me through the ReAct loop.** Thought → Action → Observation, repeated until the agent can answer. The point they want: each action is grounded in a *real* observation, not a guess.",
        "**In tool calling, who runs the code?** Your code does — the model only emits a JSON request. This separation is what keeps keys and side-effects under your control.",
        "**Why does RAG reduce hallucination?** It turns a closed-book memory test into an open-book exam: the model answers from retrieved facts, and can say 'not in the docs' instead of inventing.",
        "**What's a system prompt vs a user prompt?** The system prompt sets persona and unbreakable rules and outranks the user turn — though, crucially, it's not a security boundary.",
      ],
    },
    {
      type: "heading",
      text: "Mid: can you choose and combine patterns?",
      id: "mid",
    },
    {
      type: "list",
      items: [
        "**Orchestrator–workers vs peer-to-peer — when each?** Orchestrator when steps need central control and accountability; peer-to-peer for emergent, debate-style reasoning. Expect a follow-up on cost.",
        "**How is MCP different from function calling, and why standardize?** Function calling is one model calling your tools; MCP is a protocol so any agent can use any server — n+m instead of n×m integrations.",
        "**How do you evaluate a non-deterministic agent?** Golden datasets + LLM-as-judge against a rubric, scored per dimension, calibrated against human labels, run in CI. 'I'd eyeball it' is a fail.",
        "**When does a single agent become a swarm?** When one agent's tool list and instructions bloat its context and hurt tool choice — split into scoped specialists with a router.",
      ],
    },
    {
      type: "heading",
      text: "Senior / Staff: can you run it in production?",
      id: "senior",
    },
    {
      type: "paragraph",
      text: "This is where offers are won or lost. Senior answers aren't longer — they're about trade-offs, failure modes, and operations. A few that come up constantly:",
    },
    {
      type: "list",
      items: [
        "**Design observability for a system where the same input gives different runs.** Per-run traces (nested spans), continuous evals, and alerting on quality/cost/latency drift — because you can't reproduce a bug you can't see, and you can't unit-test non-determinism.",
        "**Architect a prompt-injection defense for an agent with DB and email tools.** Deterministic input/output guardrails, least privilege per tool, human-in-the-loop on risky actions, and treating all retrieved/tool content as untrusted. 'Tell the model not to' is not an answer.",
        "**How do you govern cost across a swarm?** Bounded loops, right-sized model routing, per-tenant rate limits, and cost tracked per resolved task — not per call.",
        "**When would you argue AGAINST using agents?** The senior signal. If a single prompt or a deterministic workflow solves it, an agent adds latency, cost, and failure modes for nothing. Knowing when not to reach for agents is the most senior answer there is.",
      ],
    },
    {
      type: "heading",
      text: "A model answer, in full",
      id: "model-answer",
    },
    {
      type: "paragraph",
      text: "One-liners get you through the screen; structured answers get you the offer. Here's what a strong response to *“When would you argue against using agents?”* actually sounds like — notice it leads with a decision rule, names the costs, and ends with a concrete example:",
    },
    {
      type: "quote",
      text: "“My default is the simplest thing that works, and an agent is rarely the simplest thing. I'd argue against agents whenever the task is deterministic or the path is known in advance — because an agent trades reliability for flexibility I don't need. Every agent adds non-determinism, latency, token cost, and new failure modes like loops and drift. For example, 'extract these five fields from an invoice' doesn't need an agent — it needs a single structured-output prompt, which is cheaper, faster, testable, and can't wander. I reach for agents only when the path genuinely depends on what the system discovers at runtime, and even then I start with one agent before a swarm.”",
    },
    {
      type: "callout",
      tone: "tip",
      title: "The shape of a senior answer",
      text: "Decision rule → the trade-offs you're weighing → a concrete example → what you'd do instead. If your answer is a list of buzzwords, you sound like you read a blog. If it's a trade-off with an example, you sound like you've shipped this and felt the pain.",
    },
    {
      type: "heading",
      text: "Framework-specific questions",
      id: "framework-specific",
    },
    {
      type: "paragraph",
      text: "If a framework is on your résumé, expect to defend it. The interviewer is checking that you understand its *mental model*, not just its API:",
    },
    {
      type: "list",
      items: [
        "**LangGraph** — 'What is the state object and why is it explicit?' (A shared, typed state passed along edges; explicitness is what makes loops, branches, and checkpoints debuggable.) 'How do you resume a long run after a crash?' (Checkpointing.)",
        "**CrewAI** — 'Explain roles, goals, tasks, and the difference between a sequential and hierarchical process.' (Roles give agents persona/scope; a hierarchical process adds a manager that delegates.)",
        "**AutoGen / AG2** — 'How does a group chat decide who speaks next, and how do you stop it running forever?' (A speaker-selection policy + a max-round cap — the same bounded-loop discipline as everywhere else.)",
      ],
    },
    {
      type: "code",
      language: "python",
      code: `# A favorite live question: "Sketch a ReAct loop from scratch."
# They're watching for the observe-then-reason ordering and a stop condition.
messages = [system_prompt, user_question]
for _ in range(MAX_STEPS):                 # bounded — always
    step = llm(messages, tools=TOOLS)
    if step.final_answer:
        return step.final_answer           # the intended exit
    result = run_tool(step.tool_call)      # YOUR code executes, not the model
    messages.append(observation(result))   # feed the real result back in
return "Couldn't finish within the step budget."  # graceful give-up`,
    },
    {
      type: "heading",
      text: "The system-design round",
      id: "system-design",
    },
    {
      type: "paragraph",
      text: "Increasingly there's a dedicated agentic system-design interview: 'Design a customer-support agent platform.' They're checking whether you reach for the right building blocks and name the trade-offs unprompted.",
    },
    {
      type: "diagram",
      visual: "agent-system-design",
      caption:
        "The blocks a strong answer puts on the whiteboard. Reveal them one at a time — if you can name these and the trade-offs between them, you're interviewing at the senior level.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Show, don't just tell",
      text: "The candidates who stand out demonstrate. Every concept here maps to something runnable in AgentSwarms — build the ReAct loop in the Agent Builder, wire a router-and-critic swarm on the canvas, or fix a Failure-Mode Lab live. 'Let me show you' beats 'I think' in every interview. Pair this with the /interview-questions page for the full bank.",
    },
    {
      type: "paragraph",
      text: "Interview content ages well, but agentic AI moves fast — frameworks rebrand, protocols standardize, new failure modes get named. The durable prep isn't memorizing today's answers; it's building enough real swarms that the answers are just things you've seen happen. Go break a few on purpose. That's what the senior engineers across the table did.",
    },
  ],
  references: [
    {
      label: "AgentSwarms — Interview Questions",
      url: "https://agentswarms.fyi/interview-questions",
    },
    { label: "2025 Stack Overflow Developer Survey", url: "https://survey.stackoverflow.co/2025/" },
    {
      label: "OWASP Top 10 for LLM Applications",
      url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
    },
  ],
};

const devopsForAgents: BlogPost = {
  slug: "devops-for-agentic-ai-open-source-playbook",
  title: "DevOps for Agentic AI: An Open-Source Playbook",
  subtitle:
    "Shipping a prompt change is a deploy. Shipping a model swap is a deploy. Even rebuilding a knowledge base is a deploy. Here's how to do all of that the way you'd ship any production system — with eval gates, canaries, traces, cost caps, and a one-click rollback — using only open-source tools.",
  excerpt:
    "Why agentic AI needs its own brand of DevOps, how to plan before you build, what the over-time pipeline actually looks like, the open-source stack to assemble it from, the gotchas that take teams down, and a gamified maturity self-assessment. The longest, most practical DevOps-for-agents read we could write.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-28",
  readingTime: "22 min read",
  tags: ["DevOps & Infrastructure", "Frameworks"],
  cover: {
    gradient: "from-violet-500/30 via-primary/20 to-emerald-500/25",
    icon: "workflow",
    motif: "devops",
  },
  blocks: [
    {
      type: "lead",
      text: "Most teams shipping agentic AI in 2026 are shipping it the way we shipped websites in 2008: a clever person changes a prompt, eyeballs an output, and pushes to prod. It works until it doesn't — until the day a one-line edit drops accuracy across the long tail, or a stuck reflection loop quintuples your invoice, or an unannounced model deprecation breaks the whole product over a weekend. This post is the playbook we wish we'd had earlier: how to give your agentic system the same discipline we give any other piece of production software, using only open-source pieces, and how to do it without the ceremony killing your velocity.",
    },
    {
      type: "paragraph",
      text: "If you want the verdict in one breath: **a prompt change is a deploy, a model swap is a deploy, even rebuilding a knowledge base is a deploy** — so treat every one of them with versioning, an eval gate, a canary, traces, a cost budget, and a one-click rollback. Skip any of those and you don't have DevOps for agents; you have a wish.",
    },
    {
      type: "heading",
      text: "Why agentic systems need their own brand of DevOps",
      id: "why-different",
    },
    {
      type: "paragraph",
      text: "Classic CI/CD assumes deterministic software. You change a function, the tests either pass or they don't, and the same input gives the same output forever. Agentic systems break every one of those assumptions at once — and the standard pipeline silently lets every problem through because none of them throw a 500.",
    },
    {
      type: "list",
      items: [
        "**Non-determinism is the default.** The same input takes a different path through the swarm, costs a different number of tokens, and can produce a different answer.",
        "**Failures are silent.** A confident, wrong answer doesn't trip a health check — your logs stay green while quality erodes.",
        "**Behaviour is defined in places git has never seen.** A prompt edited live in a UI, a model swap in a config file, a re-chunked KB — all change behaviour without a code commit.",
        "**Cost is unbounded by default.** A loop you forgot to cap, multiplied by a viral post, is a money fire that nothing in your normal stack alerts on.",
        "**The inputs aren't all yours.** Retrieved documents, tool outputs, and user messages can carry injections that change what your agent does.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "The bottom line",
      text: "Classic DevOps measures whether your code is correct. Agentic DevOps has to measure whether your system is *useful* — and 'useful' is fuzzy, drifting, and only visible if you instrument for it. The whole pipeline is built around closing that gap.",
    },
    {
      type: "heading",
      text: "The loop, end to end",
      id: "the-loop",
    },
    {
      type: "diagram",
      visual: "agent-devops-loop",
      caption:
        "The six-stage loop that turns agentic prototypes into production systems. Click each — every stage has a uniquely agentic twist (a golden eval dataset isn't optional, shadow + canary isn't optional, a 100% deploy isn't an option).",
    },
    {
      type: "paragraph",
      text: "We'll walk each stage in turn, but the order matters: plan dictates what you build, build dictates what you evaluate, evals decide what you deploy, observation decides what you improve, and improvement reshapes the plan. Skip the plan stage and you'll spend the next year retrofitting the others.",
    },
    {
      type: "heading",
      text: "Stage 1 · plan, before you write a line of code",
      id: "plan",
    },
    {
      type: "paragraph",
      text: "The single most common reason agentic projects stall isn't model quality — it's that nobody decided what 'good' meant before they started building. Plan stage is unglamorous, takes a week, and saves you six months of going-in-circles. Do these four things on day one:",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Write the success rubric.** What does a great answer look like? What's a non-negotiable failure? Faithfulness, latency, cost-per-resolved-task, refusal correctness — pick the small set that matters.",
        "**Build the golden dataset.** 40–200 representative inputs with known-good answers (or known-good behaviour). This becomes the bar every deploy clears. It costs you a person-week and it's worth ten of them.",
        "**Set the budgets.** Per-agent cost per request, per-tenant rate limits, max iterations on every loop, model fallback tiers. Budgets are how you survive a viral day.",
        "**Decide who owns what.** Every agent, prompt, tool, and knowledge base needs a name on it. Ownership ambiguity is the failure mode behind every untraceable regression.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Borrow from MLOps, not DevOps",
      text: "Classic DevOps treats code as the asset. Agentic DevOps has to treat the agent — prompt + model + tools + guardrails + KB — as the asset. Mentally cross out 'application' and write 'agent' on every pipeline diagram, and a lot of the planning falls into place.",
    },
    {
      type: "heading",
      text: "Stage 2 · what to actually version",
      id: "versioning",
    },
    {
      type: "paragraph",
      text: "If a piece of your system can change the agent's behaviour and it isn't in git, you don't have DevOps — you have folklore. Every bug report you can't reproduce is a thing that wasn't versioned. The goal is one SHA you can roll back to that fully defines how the agent behaved.",
    },
    {
      type: "diagram",
      visual: "versioning-checklist",
      caption:
        "Tick each artifact you put under version control. Reproducibility climbs as you lock down more of the behaviour-defining surface. Anything left unlocked is a back-channel that can change behaviour without a commit.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "The biggest single gap we see",
      text: "Most teams version prompts and forget the *agent definition* — which model, which tools, which temperatures, which guardrail settings. A prompt without its agent definition is half the picture. Make the agent a single declarative artifact (a YAML or JSON file) checked into the same repo as the rest of the code.",
    },
    {
      type: "code",
      language: "yaml",
      code: `# agents/refund-triage.v3.yaml — one file, one agent, in git.
agent:
  name: refund-triage
  version: 3
  model:
    provider: ollama          # or openai, anthropic, vertex, …
    name: llama3.1:70b
    temperature: 0.1
    max_tokens: 512
  system_prompt: prompts/refund-triage.v3.md
  tools:
    - read_orders             # scoped: read-only on orders table
    - send_email              # behind a human-approval gate
  guardrails:
    pii_redaction: true
    output_schema: schemas/triage_output.json
  retrieval:
    knowledge_base: kb/support-policies@2026-05-21
  budgets:
    max_iterations: 3
    max_tokens_per_run: 4000
    daily_usd: 50`,
    },
    {
      type: "heading",
      text: "Stage 3 · build the pipeline (the gamified version)",
      id: "pipeline",
    },
    {
      type: "paragraph",
      text: "Here's the question every team should be able to answer in one breath: *what stages does a change pass through before it touches a user?* If the answer is 'a prompt swap and a deploy', you've already lost. Play with the toggles below — the score is hand-tuned, but the direction is honest: an eval gate plus a canary plus a rollback dwarfs any single stage alone.",
    },
    {
      type: "diagram",
      visual: "pipeline-builder",
      caption:
        "Toggle the stages you actually have in your pipeline today and watch the safety score climb. Stop adding stages when it stops adding score per week of effort — the goal is enough discipline to ship safely, not the maximum possible discipline.",
    },
    {
      type: "paragraph",
      text: "A reasonable open-source pipeline for a smallish team looks like this: a GitHub Actions workflow runs unit tests on tool adapters, then runs the agent against the golden set, then opens a PR comment with the eval scorecard. On merge to main, a shadow deploy runs the new agent on real traffic without serving its output. A few hours later, a canary deploy promotes it to 5–10%. KPIs stay healthy for a day, it promotes to 100%. KPIs slip, it rolls back automatically. None of this requires a vendor — every piece below is open source.",
    },
    {
      type: "code",
      language: "yaml",
      code: `# .github/workflows/agent-ci.yml
name: agent-ci
on: [pull_request]

jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Python
        uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt
      - name: Unit tests (tools + adapters)
        run: pytest tests/ -q
      - name: Eval gate (golden set, RAGAS + custom rubric)
        run: |
          python evals/run.py \\
            --agent agents/refund-triage.v3.yaml \\
            --dataset evals/golden/refund-triage.jsonl \\
            --judge ollama:llama3.1:70b \\
            --threshold faithfulness=0.85,answer_relevance=0.8
      - name: Cost gate
        run: python evals/cost_gate.py --max-per-run 0.05
      - name: Post scorecard as PR comment
        if: always()
        run: python evals/post_pr_comment.py`,
    },
    {
      type: "heading",
      text: "Stage 4 · the eval gate (and why it has to be more than vibes)",
      id: "eval-gate",
    },
    {
      type: "paragraph",
      text: "The eval gate is the single highest-leverage thing in this whole pipeline. Without it, a prompt change is just a deploy with your fingers crossed. With it, you catch the regressions that look fine in spot-checks but tank on the long tail.",
    },
    {
      type: "diagram",
      visual: "eval-gate-deploy",
      caption:
        "Three classes of change, one pipeline. A healthy change sails through. A quality regression dies at the eval gate (before any user sees it). A subtle cost regression sneaks past the gate but is caught by the canary and auto-rolled back. The trick is having both layers.",
    },
    {
      type: "list",
      items: [
        "**Reference-free metrics** (faithfulness, answer relevance) catch grounding regressions even when you don't have a single right answer.",
        "**Reference-based metrics** (exact-match, similarity vs. a known-good answer) catch the cases where you do.",
        "**LLM-as-judge** is great for nuance but needs to be calibrated against human labels first — otherwise you're trusting one black box to grade another.",
        "**Live evals** sample a percentage of production traffic and re-grade it, catching drift the offline set will never see.",
        "**Don't ship a single number.** Score per dimension, with a threshold each. 'Overall 4.2/5' hides the fact that faithfulness dropped from 4.8 to 3.6 while tone improved.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Open-source evals worth knowing",
      text: "RAGAS for RAG metrics (faithfulness, context recall/precision, answer relevance). DeepEval for unit-test-style assertions. promptfoo for prompt regression tests and side-by-side comparisons. Pair them with Langfuse (self-hosted, OSS) or LangSmith (hosted) for traces and online evals. You can stand a full eval pipeline up in a weekend.",
    },
    {
      type: "code",
      language: "python",
      code: `# evals/run.py — a tiny but real eval gate.
from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy, context_precision
import json, sys

dataset = [json.loads(l) for l in open("evals/golden/refund-triage.jsonl")]

# Run the agent on every golden input, collect (q, contexts, answer).
runs = [run_agent(d["question"]) for d in dataset]

scores = evaluate(
    dataset=[{**d, **r} for d, r in zip(dataset, runs)],
    metrics=[faithfulness, answer_relevancy, context_precision],
)

# Hard fail if any metric drops below the threshold for THIS change.
THRESHOLDS = {"faithfulness": 0.85, "answer_relevancy": 0.80, "context_precision": 0.75}
failed = {k: scores[k] for k, t in THRESHOLDS.items() if scores[k] < t}
if failed:
    print("EVAL GATE FAILED:", failed); sys.exit(1)
print("EVAL GATE PASSED:", scores)`,
    },
    {
      type: "heading",
      text: "Stage 5 · deploy — shadow, then canary, then promote",
      id: "deploy",
    },
    {
      type: "paragraph",
      text: "The 100% flip is the great original sin of agentic deploys. The model you tested in CI isn't the model you're shipping — it's the same weights interacting with real distribution, real load, real noise. Stage the rollout and you get to find that out at low blast radius.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Shadow (0% serving).** The new agent runs on real traffic, but its output is logged and graded, never returned to the user. Catches the issues the golden set missed.",
        "**Canary (5–10%).** A slice of real users gets the new agent. KPIs are watched in real time. A regression triggers an automatic rollback.",
        "**Promote (100%).** Only after both phases pass. The previous version stays warm for an instant rollback for the next 24 hours.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "The OSS rollout stack",
      text: "Argo Rollouts and Flagger both do canary / blue-green for any service, including agent runtimes. Pair with OpenFeature for per-user / per-tenant flag-gated rollouts when you need finer control than a percentage.",
    },
    {
      type: "heading",
      text: "Stage 6 · observe (the four signals)",
      id: "observe",
    },
    {
      type: "paragraph",
      text: "Once an agent is live, observability stops being optional and starts being the only way you'll ever debug it. You need four kinds of signal, and the agentic ones aren't optional:",
    },
    {
      type: "list",
      items: [
        "**Logs** — the raw event records you grep when something's weird.",
        "**Metrics** — the aggregated numbers you alert on (latency, cost, error rate, refusal rate).",
        "**Traces** — every span of every run: which agent ran, which tool was called, with what args, what came back, how many tokens. Non-negotiable for agents.",
        "**Live evals** — a sample of production runs re-graded automatically against your rubric. The only way to catch a quality drift before users do.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "The open-source observability stack",
      text: "Langfuse (self-hostable, AGPL) and Phoenix from Arize (OSS) cover traces + online evals. OpenLLMetry / OpenTelemetry-LLM exports spans to whatever backend you already run — Grafana, Tempo, Jaeger, anything. Helicone proxies LLM calls and gives you metrics + cost out of the box. Pick one trace tool and one cost/metric tool; you don't need all of them.",
    },
    {
      type: "heading",
      text: "Stage 7 · improve (the loop closes)",
      id: "improve",
    },
    {
      type: "paragraph",
      text: "The single highest-leverage improvement loop is this: every real failure in production should automatically become a candidate test case in your golden set. A user complaint, a low live-eval score, a manual flag — all funnel into a triage queue, get reviewed once a week, and the chosen ones get a known-good answer and join the gate. Within months, your eval set is no longer a hand-picked sample; it's a living record of what your system has been wrong about. That's when the pipeline starts learning.",
    },
    {
      type: "heading",
      text: "Best practices, in plain English",
      id: "best-practices",
    },
    {
      type: "list",
      items: [
        "**One agent = one declarative artifact.** Model, prompt path, tools, guardrails, budgets — all in one file under git. The file's SHA is the version.",
        "**Three environments minimum.** Dev (fast iteration, no real users), staging (golden-set evals + shadow on real traffic), prod. Same agent definition flows through all three.",
        "**Secrets live in a vault.** Never in the prompt, never on the client, never in the trace. Vault, AWS/GCP Secret Manager, Doppler, Infisical — pick one and use it.",
        "**Trace IDs everywhere.** A request ID that propagates from the user's click through the gateway, orchestrator, every tool call, and every LLM call — so 'what did it do?' takes seconds, not hours.",
        "**Cost is a metric.** Track $/resolved-task, not $/request. A swarm that takes 6 calls to get one resolution is cheaper than one that takes 2 and is wrong.",
        "**Pin model versions.** `claude-3.5-sonnet-20240620`, not `claude-3.5-sonnet`. The implicit upgrade is the bug you'll spend the longest debugging.",
        "**Multi-provider fallback in CI.** Run a small slice of evals against your backup model once a week. The day you actually need it is the worst day to discover it doesn't work.",
        "**Treat retrieval as code.** The chunker, the embedder, the index — all versioned. KB rebuilds go through the same eval gate as code changes.",
        "**Human-in-the-loop on risky actions.** Refunds, deletes, sends — an Approval node, not a hope.",
        "**Document the model of failure.** When you fix something, write down what broke, how you caught it, and what test would have caught it earlier. That document is your real on-call runbook.",
      ],
    },
    {
      type: "heading",
      text: "Failure modes & gotchas",
      id: "gotchas",
    },
    {
      type: "paragraph",
      text: "These are the ones that have actually taken teams down. Click through each — every one has a fix that, in hindsight, was a one-week project nobody had time for.",
    },
    {
      type: "diagram",
      visual: "devops-failure-modes",
      caption:
        "Eight DevOps gotchas specific to agentic systems. Click each card to see the symptom and the fix. Almost every one is invisible in a normal CI run — they only show up if you've added the agentic-specific guard for them.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "The gotcha behind half of them",
      text: "Most of these failures share a root cause: the agent's behaviour depends on something that wasn't under version control. A prompt edited in a UI, a model that auto-upgraded, a KB re-ingested without an SHA. Make every behaviour-defining piece an artifact in git and you've already prevented most of the list.",
    },
    {
      type: "heading",
      text: "Cost & sustainability",
      id: "cost",
    },
    {
      type: "paragraph",
      text: "Cost isn't a finance problem — it's a reliability problem in disguise. An agent that costs $0.02 per request at $1k/day MRR will quietly cost $400/day when traffic 20×s. Without a cap, that day is also the day the model gets rate-limited and your latency triples. Build the cost gate before you ship, not after the bill arrives.",
    },
    {
      type: "diagram",
      visual: "cost-runaway",
      caption:
        "Drag traffic and average loop iterations to see today's bill. Toggle the cost cap and watch how much the cap denies on a bad day. Cost caps aren't just a budget tool — they're how you survive a Reddit hug of death without paging engineering.",
    },
    {
      type: "list",
      items: [
        "**A daily $ budget per agent**, with an alert at 70% and a hard stop at 100%.",
        "**Per-tenant rate limits** so one customer can't burn the budget for everyone.",
        "**Cheaper models for the easy cases.** A small model triages; the strong model only handles what the small one flags.",
        "**Cache aggressively.** Embeddings, identical prompts, prefix caches — anything stable.",
        "**Bound every loop.** Three iterations is usually enough; ten is usually a bug.",
      ],
    },
    {
      type: "heading",
      text: "The open-source stack we'd reach for",
      id: "stack",
    },
    {
      type: "paragraph",
      text: "You can do all of this with open-source primitives. Here's the minimal stack that earns its keep:",
    },
    {
      type: "list",
      items: [
        "**Source of truth** — Git (your repo) + GitHub Actions / GitLab CI / Argo Workflows for the pipeline runner.",
        "**Agent framework** — LangGraph (state machines), CrewAI (role-based), or AutoGen/AG2 (conversational). Each is OSS; pick by control vs. speed.",
        "**Evals in CI** — RAGAS for RAG metrics, DeepEval for assertions, promptfoo for prompt regression. Add Inspect (UK AI Safety Institute) for safety evals.",
        "**Tracing & online evals** — Langfuse (self-hostable) or Arize Phoenix. OpenLLMetry/OpenTelemetry to ship spans to your existing backend.",
        "**Cost & gateway** — LiteLLM as a model router with budgets; Helicone as a logging proxy; or Portkey for both.",
        "**Rollouts** — Argo Rollouts or Flagger for canary/blue-green, OpenFeature for per-tenant flags.",
        "**Secrets & policy** — Vault / Infisical for secrets; OPA / Cedar for authorization policies on tool calls.",
        "**Vector store & KB** — Qdrant, Weaviate, or pgvector. Version the ingest pipeline (chunker + embedder + index name); rebuilds get an SHA.",
        "**Local serving** — vLLM, SGLang, or Ollama for self-hosted inference; pair with a fallback to a hosted API for headroom.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Pick one of each, not all of them",
      text: "The temptation is to stack every tool. Don't. One framework, one trace tool, one evals tool, one router. The maturity gain comes from running the loop, not from running it on more vendors.",
    },
    {
      type: "heading",
      text: "The maturity ladder (an honest self-assessment)",
      id: "maturity",
    },
    {
      type: "paragraph",
      text: "Most teams don't sit at one tier — they're advanced on tracing and primitive on rollouts, or vice versa. This is the self-check we use. Tick what you actually do today, not what you mean to do.",
    },
    {
      type: "diagram",
      visual: "devops-maturity",
      caption:
        "An honest tier from Crawl → Walk → Run → Fly. The next-tier move usually isn't a tool — it's a *practice* you keep skipping. Pick one unchecked box, fix it this sprint, re-score next month.",
    },
    {
      type: "heading",
      text: "A reasonable 30 / 60 / 90-day plan",
      id: "plan-90",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Days 1–30 — get to honest.** Write the success rubric, build a 40-question golden set, put every prompt and agent definition under git. Add a basic trace for every run. You're not deploying anything new — you're making the current system visible.",
        "**Days 31–60 — build the gate.** A CI job that runs the agent against the golden set on every PR and blocks regressions. A cost cap. A shadow deploy that runs the new agent on real traffic without serving it. You can now ship changes safely, even if slowly.",
        "**Days 61–90 — automate the loop.** Canary + auto-rollback. Live evals on a sample of production traffic. A weekly triage of low-scoring runs that promotes the best ones into the golden set. The pipeline now improves on its own; your job becomes watching the trend lines.",
      ],
    },
    {
      type: "heading",
      text: "What Microsoft got right (and where we go open-source)",
      id: "microsoft",
    },
    {
      type: "paragraph",
      text: "Microsoft's recent piece on CI/CD for AI agents on Foundry frames the problem the same way we do — agents are deployable artifacts that need versioning, evals, and staged rollouts. The mechanics they describe (an agent definition, an eval gate before promotion, an environment progression from dev to prod) are exactly the right primitives. Where their playbook leans on Foundry, Azure DevOps, and Bicep, this one leans on git, GitHub Actions, Langfuse, RAGAS, Argo Rollouts, vLLM, and friends — same loop, different substrate. Read theirs alongside this one; the overlap is the part that's actually load-bearing.",
    },
    {
      type: "callout",
      tone: "success",
      title: "The shortest possible summary",
      text: "Version everything that defines behaviour. Gate every change on an eval. Roll out in stages. Trace every run. Cap every cost. Feed real failures back into the gate. That loop, run boringly for six months, is the whole game.",
    },
    {
      type: "paragraph",
      text: "DevOps for agents isn't a different discipline — it's the same discipline that turned web apps from artisanal to reliable, applied to a kind of software that's harder to test and easier to break. The teams shipping reliable agentic systems in 2026 aren't smarter; they're just running this loop. Pick the one unchecked box that scared you most on the maturity widget above, and fix it this week. Then the next one. That's the entire path from cowboy mode to production-grade.",
    },
  ],
  references: [
    {
      label: "CI/CD for AI Agents on Microsoft Foundry — Microsoft Tech Community",
      url: "https://techcommunity.microsoft.com/blog/educatordeveloperblog/cicd-for-ai-agents-on-microsoft-foundry/4522218",
    },
    { label: "Langfuse — open-source LLM observability & evals", url: "https://langfuse.com/" },
    { label: "RAGAS — automated RAG evaluation framework", url: "https://docs.ragas.io/" },
    { label: "promptfoo — prompt regression testing", url: "https://www.promptfoo.dev/" },
    {
      label: "Argo Rollouts — progressive delivery for Kubernetes",
      url: "https://argoproj.github.io/rollouts/",
    },
    {
      label: "OpenLLMetry — OpenTelemetry for LLM apps",
      url: "https://github.com/traceloop/openllmetry",
    },
  ],
};

const cloudCicdGuide: BlogPost = {
  slug: "deploying-agents-cicd-bedrock-azure-gcp",
  title: "Deploy Agents to Bedrock, Azure & Google Cloud — One Open-Source CI/CD Pipeline",
  subtitle:
    "A hands-on, copy-paste implementation guide. We take a single example agent and ship it — with keyless auth, an eval gate, containers, canaries, and tracing — to Amazon Bedrock AgentCore, Azure AI Foundry, and Vertex AI Agent Engine, using only open-source tooling. Every command, every config file, start to finish.",
  excerpt:
    "The companion build guide to our DevOps playbook. First-time setup for each cloud's agent runtime, then a unified GitHub Actions pipeline that deploys the same containerized agent to AWS, Azure, and GCP — with OIDC, eval gates, progressive rollout, and OpenTelemetry tracing. No long-lived keys, no vendor lock-in on the pipeline.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-30",
  readingTime: "29 min read",
  tags: ["DevOps & Infrastructure", "Production"],
  cover: {
    gradient: "from-orange-500/25 via-sky-500/20 to-emerald-500/25",
    icon: "cloud",
    motif: "cloud",
  },
  blocks: [
    {
      type: "lead",
      text: "You prototyped an agent. It works on your laptop. Now your boss wants it in production — on the company's cloud, behind the company's auth, with a deploy story that survives an audit. And the awkward part: nobody on the team agrees on *which* cloud, or the company runs all three. This guide is the answer we wish existed when we hit that wall: one open-source CI/CD pipeline that takes a single example agent and ships it to Amazon Bedrock AgentCore, Azure AI Foundry, and Google Cloud's Vertex AI Agent Engine — keyless, eval-gated, canaried, and traced. We'll do the first-time setup for each cloud step by step, then unify it into one workflow.",
    },
    {
      type: "paragraph",
      text: "This is the build-it companion to our earlier read, *DevOps for Agentic AI: An Open-Source Playbook*. That post argued the *why* and the *what* — a prompt change is a deploy, gate everything on evals, trace every run. This one is the *how*, all the way down to the YAML. If you haven't read the playbook, skim it first; we lean on its vocabulary here.",
    },
    {
      type: "paragraph",
      text: "The one idea that makes three-cloud deployment tractable: **build the agent once as a container, and make the cloud the *last mile*, not the architecture.** Everything before the deploy step — versioning, the eval gate, the image build — is identical across clouds. Only the final `deploy` command and the IAM trust glue differ. Get that shape right and adding a third cloud is an afternoon, not a rewrite.",
    },
    {
      type: "callout",
      tone: "info",
      title: "What you'll have at the end",
      text: "A repo with one agent definition, one Dockerfile, one eval suite, and a GitHub Actions workflow whose matrix deploys the same image to AWS, Azure, and GCP — each via short-lived OIDC credentials, each behind a canary, each emitting OpenTelemetry traces to your own Langfuse. Pick one cloud and follow only its section if that's all you need.",
    },
    {
      type: "heading",
      text: "The three platforms, decoded",
      id: "platforms-decoded",
    },
    {
      type: "paragraph",
      text: "Each major cloud now ships a *managed agent runtime* — a place to run an agent's reasoning loop without you babysitting servers, wired to that cloud's models, memory, tools, and tracing. They use wildly different names for the same handful of primitives. Here's the Rosetta Stone; flip between clouds and notice the rows never change, only the product names:",
    },
    {
      type: "diagram",
      visual: "cloud-platform-map",
      caption:
        "The same seven primitives across all three clouds. Tab between AWS, Azure, and Google Cloud. Build against the concepts in the left column and the per-cloud differences shrink to a thin adapter.",
    },
    {
      type: "subheading",
      text: "Amazon Bedrock AgentCore",
    },
    {
      type: "paragraph",
      text: "AgentCore is a set of composable services: **Runtime** (a serverless, session-isolated place to run *any* framework — Strands, LangGraph, CrewAI — as a container), **Gateway** (turns APIs and Lambdas into MCP tools), **Identity**, **Memory**, **Observability**, plus managed Browser and Code-Interpreter tools. You bring a container that speaks a simple HTTP contract; AgentCore runs it, scales it to zero, and isolates each session in its own microVM. It's framework-agnostic by design, which is exactly what you want for a portable pipeline.",
    },
    {
      type: "subheading",
      text: "Azure AI Foundry Agent Service",
    },
    {
      type: "paragraph",
      text: "Foundry is Microsoft's umbrella for building and running agents. The **Agent Service** gives you hosted agents with threads, tools (via Connections, Logic Apps, or OpenAPI specs), and knowledge — and for custom code you containerize the agent and run it on **Azure Container Apps**, which gives you revisions and built-in traffic splitting for canaries. Auth is **Microsoft Entra** managed identity end to end; tracing flows to **Application Insights**.",
    },
    {
      type: "subheading",
      text: "Google Cloud Vertex AI Agent Engine",
    },
    {
      type: "paragraph",
      text: "Vertex AI **Agent Engine** is a managed runtime for agents you build with the open-source **Agent Development Kit (ADK)** — though it also accepts LangGraph and others. You hand it your agent object plus a requirements list; it packages, deploys, and gives you sessions and a Memory Bank. For full control you can deploy the same container to **Cloud Run** instead. Auth is **IAM service accounts**; from CI you use **Workload Identity Federation** so no key ever leaves Google.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Don't let the runtime pick your framework",
      text: "All three accept a plain container that exposes an HTTP endpoint. If you keep your agent framework-neutral and containerized, the managed runtime becomes an implementation detail you can switch — which is the whole point of building the pipeline this way.",
    },
    {
      type: "heading",
      text: "The portable pipeline",
      id: "portable-pipeline",
    },
    {
      type: "paragraph",
      text: "Before any cloud-specific work, here's the pipeline every deploy flows through. Six of its eight stages are byte-for-byte identical no matter where you ship; only **Deploy** and the **Auth** glue change. Click through it:",
    },
    {
      type: "diagram",
      visual: "cicd-pipeline-flow",
      caption:
        "Commit → build → eval gate → package → keyless auth → deploy → canary → observe. Everything left of 'Deploy' is cloud-agnostic and runs once. That's why a third cloud is cheap to add.",
    },
    {
      type: "paragraph",
      text: "And here's the reference architecture that pipeline produces. The shape is constant — developer → CI with an eval gate → keyless OIDC → registry → managed runtime wired to a model, tools, and tracing. Flip between clouds and only the box labels change:",
    },
    {
      type: "diagram",
      visual: "cloud-architecture-diagram",
      caption:
        "One architecture, three label sets. The dashed boundary is the cloud; everything inside it is managed for you. The arrow from CI into the cloud is a short-lived credential, never a stored key.",
    },
    {
      type: "heading",
      text: "First-time foundations (do these once)",
      id: "foundations",
    },
    {
      type: "paragraph",
      text: "Resist the urge to `git push` straight at a cloud. There are eight foundations you set up *once*, and they save you from the failure modes that take down first deploys. Tick them off — the widget is honest about which ones carry the most weight:",
    },
    {
      type: "diagram",
      visual: "first-deploy-checklist",
      caption:
        "Your first-deploy readiness score. The two heaviest — keyless OIDC and an eval gate in CI — are also the two most often skipped under deadline pressure. Don't.",
    },
    {
      type: "subheading",
      text: "1 · One repo, one shape",
    },
    {
      type: "paragraph",
      text: "Everything that defines the agent's behaviour lives in one repository. The agent is a *single declarative artifact* (a YAML file), the prompt is a versioned file beside it, the eval suite is in the repo, and the cloud wiring is Terraform. Here's the layout we'll build:",
    },
    {
      type: "code",
      language: "text",
      code: `refund-triage/
├── agent/
│   ├── refund-triage.v3.yaml      # the agent definition — model, tools, guardrails
│   ├── agent.py                   # framework-neutral entrypoint (HTTP handler)
│   └── prompts/refund-triage.v3.md
├── evals/
│   ├── golden.jsonl               # 80 representative cases with known-good answers
│   └── run.py                     # promptfoo + RAGAS gate, exits non-zero on regression
├── Dockerfile                     # builds ONE image for all three clouds
├── infra/
│   ├── aws/    (ecr.tf, iam-oidc.tf, agentcore.tf)
│   ├── azure/  (acr.bicep, containerapp.bicep, federated-cred.tf)
│   └── gcp/    (artifact-registry.tf, wif.tf, agent-engine.tf)
└── .github/workflows/deploy.yml   # the one pipeline, matrixed over clouds`,
    },
    {
      type: "subheading",
      text: "2 · The agent as a declarative artifact",
    },
    {
      type: "paragraph",
      text: "If a thing can change the agent's behaviour and it isn't in git, you don't have CI/CD — you have folklore. The model, its temperature, the tools, the guardrails: all of it goes in one file with a version number.",
    },
    {
      type: "code",
      language: "yaml",
      code: `# agent/refund-triage.v3.yaml
agent:
  name: refund-triage
  version: 3
  model:
    # 'provider' is resolved per-cloud at deploy time → Bedrock | Foundry | Vertex
    family: claude-sonnet        # mapped to the closest model on each cloud
    temperature: 0.1
    max_tokens: 512
  system_prompt: prompts/refund-triage.v3.md
  tools:
    - read_orders                # read-only on the orders table
    - issue_refund               # behind a human-approval gate
  guardrails:
    pii_redaction: true
    max_iterations: 6            # hard loop cap — your cost circuit-breaker
  budgets:
    usd_per_request: 0.05`,
    },
    {
      type: "subheading",
      text: "3 · One Dockerfile, three destinations",
    },
    {
      type: "paragraph",
      text: "All three runtimes accept a container that listens on a port and answers an invoke request. Build it once; the registry it lands in is the only variable. The contract AgentCore expects is the strictest (a `/invocations` POST and a `/ping` health check on port 8080), so we satisfy that and it works everywhere.",
    },
    {
      type: "code",
      language: "dockerfile",
      code: `# Dockerfile — one image for AWS, Azure, and GCP
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent/ ./agent/
# Agent listens on 8080: POST /invocations  +  GET /ping
ENV PORT=8080
EXPOSE 8080
CMD ["python", "-m", "agent.agent"]`,
    },
    {
      type: "subheading",
      text: "4 · The eval gate (cloud-independent)",
    },
    {
      type: "paragraph",
      text: "This is the stage that earns its keep. Before any cloud sees the image, the golden dataset runs in CI. A regression on faithfulness or a budget breach exits non-zero and the deploy never happens. Because it runs against the local container, it's identical for every cloud — write it once.",
    },
    {
      type: "code",
      language: "python",
      code: `# evals/run.py — runs in CI, exits 1 on regression (blocks the deploy)
import json, sys
from ragas import evaluate
from ragas.metrics import faithfulness, answer_correctness

cases = [json.loads(l) for l in open("evals/golden.jsonl")]
results = run_agent_over(cases)          # hits the local container
score = evaluate(results, metrics=[faithfulness, answer_correctness])

THRESHOLDS = {"faithfulness": 0.85, "answer_correctness": 0.80}
failed = [m for m, t in THRESHOLDS.items() if score[m] < t]
if failed:
    print(f"❌ Eval gate failed: {failed} below threshold")
    sys.exit(1)
print("✅ Eval gate passed — clear to deploy")`,
    },
    {
      type: "subheading",
      text: "5 · Keyless auth — the foundation that matters most",
    },
    {
      type: "paragraph",
      text: "Never put a long-lived cloud key in a GitHub secret. Instead, your CI job mints a short-lived OIDC token that *describes* it (this repo, this branch), and the cloud — having been told to trust exactly that — hands back temporary credentials. The key never exists, so it can never leak. Watch the handshake:",
    },
    {
      type: "diagram",
      visual: "oidc-handshake",
      caption:
        "Keyless deploys. GitHub mints a scoped, short-lived token; the cloud's STS verifies it against a trust policy and returns minutes-long credentials. Same pattern on all three clouds — only the verb differs.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "The one mistake that undoes it all",
      text: "When you configure the trust policy, scope the `subject` to a specific repo *and* branch (e.g. `repo:acme/refund-triage:ref:refs/heads/main`). A wildcard here means any repo in your org — or worse, any repo on GitHub — could assume your deploy role. Tighten it before you wire anything else.",
    },
    {
      type: "divider",
    },
    {
      type: "heading",
      text: "The worked example",
      id: "worked-example",
    },
    {
      type: "paragraph",
      text: "Our example is **refund-triage**: a customer-support agent that reads an order, decides whether a refund request meets policy, and either drafts an approval (behind a human gate) or a polite denial with the reason. It uses one read-only tool and one gated write tool — small enough to follow, real enough to expose every deployment concern. We'll ship *this* agent to all three clouds. Pick your cloud below, or read all three.",
    },
    {
      type: "heading",
      text: "Deploy to Amazon Bedrock AgentCore",
      id: "deploy-aws",
    },
    {
      type: "paragraph",
      text: "AgentCore Runtime takes your container from ECR and runs it serverlessly. The first-time setup is three things: an ECR repository, an execution role the runtime assumes (to call Bedrock models and write logs), and the GitHub→AWS trust so CI is keyless.",
    },
    {
      type: "subheading",
      text: "Step 1 — ECR + OIDC trust + execution role (Terraform)",
    },
    {
      type: "code",
      language: "hcl",
      code: `# infra/aws/iam-oidc.tf — trust GitHub Actions, keyless
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      # scope to ONE repo + branch — never a wildcard
      values   = ["repo:acme/refund-triage:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "ci_deployer" {
  name               = "agentcore-ci-deployer"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_ecr_repository" "agent" {
  name                 = "refund-triage"
  image_tag_mutability = "IMMUTABLE"   # tags are commit SHAs, never reused
}`,
    },
    {
      type: "paragraph",
      text: "Attach a *least-privilege* policy to `ci_deployer` — permission to push to this one ECR repo and to call the AgentCore control-plane APIs, nothing more. Separately, create an **execution role** the runtime itself assumes at request time, scoped to `bedrock:InvokeModel` on the specific model and `logs:PutLogEvents`. Two roles, two jobs: one deploys, one runs.",
    },
    {
      type: "subheading",
      text: "Step 2 — package & launch with the starter toolkit",
    },
    {
      type: "paragraph",
      text: "The open-source `bedrock-agentcore-starter-toolkit` wraps the build-push-deploy dance. Locally, the very first time, you'd run it interactively to confirm it works before wiring CI:",
    },
    {
      type: "code",
      language: "bash",
      code: `pip install bedrock-agentcore-starter-toolkit

# Generates the runtime config from your entrypoint + execution role
agentcore configure \\
  --entrypoint agent/agent.py \\
  --execution-role arn:aws:iam::123456789012:role/refund-triage-exec \\
  --name refund-triage

# Builds the container, pushes to ECR, deploys to AgentCore Runtime
agentcore launch

# Smoke-test the deployed agent
agentcore invoke '{"prompt": "Customer wants a refund on order 5512, 40 days late"}'`,
    },
    {
      type: "subheading",
      text: "Step 3 — the AWS deploy job",
    },
    {
      type: "code",
      language: "yaml",
      code: `# .github/workflows/deploy.yml (AWS branch of the matrix)
permissions:
  id-token: write      # REQUIRED for OIDC
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/agentcore-ci-deployer
      aws-region: us-east-1                       # no keys — pure OIDC
  - name: Deploy to AgentCore
    run: |
      pip install bedrock-agentcore-starter-toolkit
      agentcore configure --entrypoint agent/agent.py \\
        --execution-role $EXEC_ROLE_ARN --name refund-triage --non-interactive
      agentcore launch --tag $GITHUB_SHA`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "AgentCore canaries",
      text: "AgentCore Runtime supports endpoint versions. Deploy the new version as a non-default endpoint, send a slice of traffic, watch CloudWatch + your Langfuse, then promote it to default. That's your canary — see the rollout widget further down.",
    },
    {
      type: "heading",
      text: "Deploy to Azure AI Foundry",
      id: "deploy-azure",
    },
    {
      type: "paragraph",
      text: "On Azure we run the container on **Azure Container Apps** (which gives revisions + traffic splitting for free) and register it as a custom agent in a **Foundry project**. First-time setup: an Azure Container Registry, an Entra app registration with a *federated credential* for GitHub, and a resource group.",
    },
    {
      type: "subheading",
      text: "Step 1 — federated credential (keyless GitHub→Entra)",
    },
    {
      type: "code",
      language: "bash",
      code: `# One-time: create an app registration and federate it to GitHub
APP_ID=$(az ad app create --display-name refund-triage-ci --query appId -o tsv)
az ad sp create --id $APP_ID

az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:acme/refund-triage:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# Grant the SP least-privilege on the resource group only
az role assignment create --assignee $APP_ID \\
  --role "Contributor" --scope /subscriptions/$SUB/resourceGroups/rg-agents`,
    },
    {
      type: "subheading",
      text: "Step 2 — build in ACR and deploy to Container Apps",
    },
    {
      type: "paragraph",
      text: "`az acr build` builds the image *in the cloud* (no local Docker needed in CI), and `az containerapp up` creates or updates the app with a fresh revision. The first manual run confirms the contract before you automate:",
    },
    {
      type: "code",
      language: "bash",
      code: `# Build the same Dockerfile, in ACR, tagged with the commit
az acr build -r acmeagents -t refund-triage:$GITHUB_SHA .

# Create/update the Container App — system-assigned identity, external ingress
az containerapp up \\
  --name refund-triage \\
  --resource-group rg-agents \\
  --image acmeagents.azurecr.io/refund-triage:$GITHUB_SHA \\
  --ingress external --target-port 8080 \\
  --system-assigned

# Register the running endpoint as a custom tool/agent in your Foundry project
# (via the azure-ai-projects SDK or the Foundry portal Connections tab)`,
    },
    {
      type: "subheading",
      text: "Step 3 — the Azure deploy job",
    },
    {
      type: "code",
      language: "yaml",
      code: `# .github/workflows/deploy.yml (Azure branch of the matrix)
permissions:
  id-token: write
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: azure/login@v2
    with:
      client-id: \${{ secrets.AZURE_CLIENT_ID }}        # the app reg, not a key
      tenant-id: \${{ secrets.AZURE_TENANT_ID }}
      subscription-id: \${{ secrets.AZURE_SUBSCRIPTION_ID }}
  - name: Build & deploy
    run: |
      az acr build -r acmeagents -t refund-triage:$GITHUB_SHA .
      az containerapp up --name refund-triage --resource-group rg-agents \\
        --image acmeagents.azurecr.io/refund-triage:$GITHUB_SHA \\
        --ingress external --target-port 8080 --system-assigned`,
    },
    {
      type: "callout",
      tone: "info",
      title: "Azure canaries are revisions",
      text: "Container Apps keeps multiple *revisions* live and lets you split traffic between them by percentage. Deploy v2 with `--revision-suffix $GITHUB_SHA`, set it to 10% traffic, watch App Insights, then shift to 100%. The rollout widget below maps to this directly.",
    },
    {
      type: "heading",
      text: "Deploy to Google Cloud Vertex AI",
      id: "deploy-gcp",
    },
    {
      type: "paragraph",
      text: "On GCP you have two clean paths: hand the agent to **Agent Engine** (fully managed, ADK-native) or run the container on **Cloud Run** (revisions + traffic tags, like Container Apps). We'll show Agent Engine for the managed path. First-time setup: an Artifact Registry repo, a service account, and **Workload Identity Federation** so GitHub is keyless.",
    },
    {
      type: "subheading",
      text: "Step 1 — Workload Identity Federation (keyless GitHub→GCP)",
    },
    {
      type: "code",
      language: "bash",
      code: `# One-time: a pool + provider that trusts your GitHub repo
gcloud iam workload-identity-pools create github \\
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-provider \\
  --location=global --workload-identity-pool=github \\
  --issuer-uri="https://token.actions.githubusercontent.com" \\
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \\
  --attribute-condition="assertion.repository=='acme/refund-triage'"

# Let the GitHub identity impersonate a least-privilege deploy SA
gcloud iam service-accounts add-iam-policy-binding \\
  agent-deployer@PROJECT.iam.gserviceaccount.com \\
  --role=roles/iam.workloadIdentityUser \\
  --member="principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/github/attribute.repository/acme/refund-triage"`,
    },
    {
      type: "subheading",
      text: "Step 2 — build, then deploy to Agent Engine",
    },
    {
      type: "code",
      language: "bash",
      code: `# Build the same Dockerfile via Cloud Build → Artifact Registry
gcloud builds submit \\
  --tag us-docker.pkg.dev/PROJECT/agents/refund-triage:$GITHUB_SHA`,
    },
    {
      type: "code",
      language: "python",
      code: `# infra/gcp/deploy_agent_engine.py — managed runtime, ADK-native
import vertexai
from vertexai import agent_engines
from agent.agent import root_agent          # your ADK / LangGraph app object

vertexai.init(
    project="PROJECT", location="us-central1",
    staging_bucket="gs://acme-agent-staging",
)

remote = agent_engines.create(
    agent_engine=root_agent,
    requirements=["google-cloud-aiplatform[agent_engines,adk]"],
    display_name="refund-triage",
)
print("Deployed:", remote.resource_name)   # capture for the canary step`,
    },
    {
      type: "subheading",
      text: "Step 3 — the GCP deploy job",
    },
    {
      type: "code",
      language: "yaml",
      code: `# .github/workflows/deploy.yml (GCP branch of the matrix)
permissions:
  id-token: write
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: projects/123/locations/global/workloadIdentityPools/github/providers/github-provider
      service_account: agent-deployer@PROJECT.iam.gserviceaccount.com
  - uses: google-github-actions/setup-gcloud@v2
  - name: Build & deploy
    run: |
      gcloud builds submit --tag us-docker.pkg.dev/PROJECT/agents/refund-triage:$GITHUB_SHA
      python infra/gcp/deploy_agent_engine.py`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "Cloud Run if you want raw control",
      text: "Prefer `gcloud run deploy --no-traffic --tag $GITHUB_SHA` then `gcloud run services update-traffic --to-tags $GITHUB_SHA=10`. That gives you the exact same revision-based canary as Azure Container Apps, with the same container — handy if you want one mental model across Azure and GCP.",
    },
    {
      type: "divider",
    },
    {
      type: "heading",
      text: "One pipeline, three targets",
      id: "unified-pipeline",
    },
    {
      type: "paragraph",
      text: "Now stitch it together. The build and eval-gate jobs run *once*; the deploy job fans out over a matrix of clouds, and each matrix leg uses only its own OIDC login. Crucially, `deploy` `needs` the eval gate — a red gate blocks all three clouds at once. That single dependency edge is the most important line in the file.",
    },
    {
      type: "code",
      language: "yaml",
      code: `# .github/workflows/deploy.yml — the whole shape
name: ship-agent
on:
  push: { branches: [main] }

permissions: { id-token: write, contents: read }

jobs:
  build-and-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t refund-triage:$GITHUB_SHA .
      - name: Eval gate (cloud-independent)
        run: python evals/run.py        # exits 1 on regression → blocks deploy

  deploy:
    needs: build-and-gate               # ← no green gate, no deploy. Anywhere.
    runs-on: ubuntu-latest
    strategy:
      matrix:
        cloud: [aws, azure, gcp]
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to \${{ matrix.cloud }}
        run: ./deploy/\${{ matrix.cloud }}.sh $GITHUB_SHA`,
    },
    {
      type: "callout",
      tone: "success",
      title: "Why this scales to a fourth cloud",
      text: "Adding OCI, a private vLLM cluster, or anything else is now: write one `deploy/<name>.sh`, add one line to the matrix, configure one OIDC trust. The build, the eval gate, the image, and the agent definition don't move. That's the entire payoff of treating the cloud as the last mile.",
    },
    {
      type: "heading",
      text: "Progressive rollout, everywhere",
      id: "rollout",
    },
    {
      type: "paragraph",
      text: "A green eval gate means the change is good *on your golden set* — not that it's good on live traffic. So no deploy goes straight to 100%. Each cloud has a native primitive for shifting a percentage of traffic to the new version; your job is to watch the KPIs at each step and roll back automatically if they dip. Play with the ramp:",
    },
    {
      type: "diagram",
      visual: "progressive-rollout",
      caption:
        "The canary ramp with auto-rollback. Tick 'simulate a regression' then promote — traffic snaps back to v1 the moment KPIs dip. AgentCore endpoint versions, Azure revisions, and Cloud Run traffic tags all implement exactly this.",
    },
    {
      type: "list",
      ordered: false,
      items: [
        "**AWS** — deploy the new build as a non-default AgentCore endpoint version; route a slice with your gateway/router; promote to default when CloudWatch + Langfuse stay healthy.",
        "**Azure** — `az containerapp revision` with a traffic weight (`--traffic-weight latest=10`); App Insights watches the canary; shift to 100% or back to 0%.",
        "**GCP** — `gcloud run services update-traffic --to-tags $SHA=10` (Cloud Run), or stage a new Agent Engine version behind your router; Cloud Trace + evals decide promotion.",
      ],
    },
    {
      type: "heading",
      text: "Observability that spans clouds",
      id: "observability",
    },
    {
      type: "paragraph",
      text: "If your traces live in three different consoles, you'll debug in none of them. The fix: instrument the agent *once* with OpenTelemetry (via **OpenLLMetry**), and fan the spans out to both your own **Langfuse** — your single pane of glass across all clouds — and each cloud's native backend. Because the instrumentation is in the container, it travels with the image to every target.",
    },
    {
      type: "code",
      language: "python",
      code: `# agent/agent.py — instrument once, traces flow everywhere
from traceloop.sdk import Traceloop

Traceloop.init(
    app_name="refund-triage",
    # OTLP endpoint → your own Langfuse, identical on every cloud
    api_endpoint="https://langfuse.acme.dev/api/public/otel",
)
# Each cloud ALSO captures spans natively:
#   AWS   → AgentCore Observability → CloudWatch / X-Ray
#   Azure → Application Insights
#   GCP   → Cloud Trace
# Same OTel spans, two destinations. Debug in Langfuse, audit in the cloud console.`,
    },
    {
      type: "callout",
      tone: "warn",
      title: "Tag every span with the deployed SHA",
      text: "Put `git.sha`, `agent.version`, and `cloud` on every span. When a user reports a bad answer, you want to know in one query exactly which image, which prompt version, and which cloud served it. Untagged traces are the difference between a five-minute fix and a five-hour hunt.",
    },
    {
      type: "heading",
      text: "Cloud-specific gotchas",
      id: "gotchas",
    },
    {
      type: "list",
      items: [
        "**Model access isn't automatic.** On AWS you must *enable* a Bedrock model in the region; on Azure you deploy a model to your Foundry project; on GCP you enable the Vertex API and request quota. A perfect pipeline still fails if the model isn't switched on in the region you deploy to.",
        "**Cold starts are real.** Scale-to-zero runtimes (AgentCore, Cloud Run, Container Apps min-replicas=0) save money but add first-request latency. Set a minimum instance count for latency-sensitive agents.",
        "**Region availability differs.** The newest agent runtimes and models roll out region by region. Pin your deploy region to one where *both* the runtime and your chosen model are GA — don't assume `us-east-1` parity across clouds.",
        "**Egress and data residency.** Calling your own Langfuse or a third-party tool from inside the runtime crosses a network boundary. Check egress rules and, for regulated data, that the runtime region matches your residency requirements.",
        "**Least-privilege is per-cloud.** An over-broad `Contributor`, `roles/editor`, or `*` IAM policy is the most common audit finding. Scope the deploy identity to the one registry + one runtime it touches, and the *execution* identity to the one model it calls.",
        "**Immutable image tags.** Tag images with the commit SHA and never reuse a tag. `latest` is how you ship a different artifact than the one you evaluated.",
      ],
    },
    {
      type: "heading",
      text: "Your first deploy, in an afternoon",
      id: "afternoon",
    },
    {
      type: "paragraph",
      text: "You don't need all three clouds on day one. Here's the honest minimum path to one real, gated, traced deploy:",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Hour 1** — Lay out the repo: agent YAML, `agent.py`, Dockerfile, and 20 golden cases (you'll grow them later). Get the container running and answering locally.",
        "**Hour 2** — Pick *one* cloud. Set up its registry, the OIDC trust (scoped to your repo + branch), and a least-privilege deploy role. This is the part that feels slow and is worth every minute.",
        "**Hour 3** — Write `evals/run.py` and the single-cloud deploy job. Push to a branch, watch the gate run, then watch the deploy. Smoke-test the live agent.",
        "**Hour 4** — Add OpenLLMetry, point it at Langfuse, tag spans with the SHA, and wire one cost/latency alert. Now you can *see* what you shipped.",
        "**Next week** — Add the canary step, grow the golden set from real traffic, and only *then* fan the matrix out to a second cloud. The second one takes an hour because everything but the deploy script already exists.",
      ],
    },
    {
      type: "heading",
      text: "How this relates to the vendor playbooks",
      id: "vendor-playbooks",
    },
    {
      type: "paragraph",
      text: "Microsoft, AWS, and Google each publish their own CI/CD-for-agents guidance, and they're worth reading — they frame the problem the same way we do: an agent is a deployable artifact that needs versioning, an eval gate, and staged rollout. Where the vendor guides lean on Foundry + Azure DevOps + Bicep, or CodePipeline + CDK, or Cloud Build + Vertex pipelines, this guide deliberately keeps the *pipeline* open-source and portable — git, GitHub Actions, Docker, promptfoo, RAGAS, Langfuse, OpenLLMetry, Terraform — so the only thing that's cloud-specific is the last-mile deploy. Read the vendor docs for the deepest per-cloud features; use this shape so you're never locked into one.",
    },
    {
      type: "callout",
      tone: "success",
      title: "The shortest possible summary",
      text: "Build the agent once as a container. Gate every change on a cloud-independent eval suite. Authenticate with keyless OIDC, never a stored key. Push the SHA-tagged image to the cloud's registry, deploy to its managed runtime, canary before 100%, and emit one set of OpenTelemetry spans to your own Langfuse. The cloud is the last mile — keep it that way and three targets cost barely more than one.",
    },
    {
      type: "paragraph",
      text: "Deploying agents to Bedrock, Azure, and Vertex isn't three projects — it's one pipeline with three thin adapters. The teams shipping reliably across clouds in 2026 aren't writing three pipelines; they're writing one, gating it hard, and letting the matrix do the fan-out. Start with one cloud this afternoon, get the gate and the trace green, and the second and third clouds will feel like a formality.",
    },
  ],
  references: [
    {
      label: "Amazon Bedrock AgentCore — developer guide",
      url: "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html",
    },
    {
      label: "Azure AI Foundry Agent Service — documentation",
      url: "https://learn.microsoft.com/en-us/azure/ai-foundry/agents/",
    },
    {
      label: "Vertex AI Agent Engine — Google Cloud docs",
      url: "https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview",
    },
    {
      label: "Agent Development Kit (ADK) — open-source agent framework",
      url: "https://google.github.io/adk-docs/",
    },
    {
      label: "OpenID Connect in GitHub Actions — keyless cloud auth",
      url: "https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect",
    },
    { label: "Langfuse — open-source LLM observability & evals", url: "https://langfuse.com/" },
    {
      label: "OpenLLMetry — OpenTelemetry instrumentation for LLM apps",
      url: "https://github.com/traceloop/openllmetry",
    },
    {
      label: "CI/CD for AI Agents on Microsoft Foundry — Microsoft Tech Community",
      url: "https://techcommunity.microsoft.com/blog/educatordeveloperblog/cicd-for-ai-agents-on-microsoft-foundry/4522218",
    },
  ],
};

const gpuForLlms: BlogPost = {
  slug: "which-gpu-runs-which-llm-the-complete-guide",
  title: "Which GPU Runs Which LLM? The Complete Hardware Guide",
  subtitle:
    "From a 3B model on a laptop to a 405B model on a GPU cluster — how to read VRAM, use the llmfit tool to check what fits, benchmark honestly, pick the right card for your use case, and decide whether to rent or buy. With interactive calculators you can drive yourself.",
  excerpt:
    "VRAM is the gatekeeper of local LLMs. Learn the memory math, quantization, and the llmfit tool; see which GPU runs which model; benchmark with the right tools; compare desktop vs datacenter cards; and weigh cost, availability, and buy-vs-rent — all with hands-on interactive diagrams.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-30",
  readingTime: "22 min read",
  tags: ["DevOps & Infrastructure"],
  cover: {
    gradient: "from-emerald-500/30 via-primary/20 to-violet-500/25",
    icon: "cpu",
    motif: "network",
  },
  blocks: [
    {
      type: "lead",
      text: "Everyone asks the same question the moment they try to run a model locally: *will this LLM actually run on my GPU?* It feels like it should be simple. It is — once you understand the single number that governs almost everything, learn to estimate it in your head, and know the one free tool that does the arithmetic for you. This is the complete, hands-on guide to matching large language models to the hardware that runs them.",
    },
    {
      type: "paragraph",
      text: "We'll go from a 3-billion-parameter model on a laptop all the way to a 405-billion-parameter model on a rack of datacenter GPUs. Along the way you'll drive interactive calculators, see exactly which card runs which model, learn to benchmark without fooling yourself, understand why a $1,600 desktop card and a $28,000 datacenter card aren't really competing, and work out whether you should rent or buy. Let's start with the number that decides everything.",
    },
    {
      type: "heading",
      text: "The one number that decides everything: VRAM",
      id: "vram-decides-everything",
    },
    {
      type: "paragraph",
      text: "A GPU has its own dedicated memory — **VRAM** (video RAM). To generate text, the model's weights, its working memory for the conversation (the *KV cache*), and some runtime overhead must **all fit in VRAM at the same time**. If they don't, one of two things happens: the model refuses to load, or your framework spills the overflow into ordinary system RAM and inference slows to a crawl — often 10–50× slower. VRAM isn't one factor among many. It's the gate. Everything else is a tiebreaker.",
    },
    {
      type: "callout",
      tone: "info",
      title: "The mental model",
      text: "Compute (how fast the GPU does math) sets your *speed*. VRAM (how much fits) sets whether you can run the model *at all*. Beginners obsess over speed; the first real question is always capacity.",
    },
    {
      type: "paragraph",
      text: "So before anything else, learn to estimate how much VRAM a model needs. Drag the sliders below — change the model size, the context length, and the *quantization* (we'll explain that next) and watch the requirement light up the GPUs that can hold it.",
    },
    {
      type: "diagram",
      visual: "vram-calculator",
      caption:
        "Interactive VRAM estimator. VRAM ≈ weights + KV cache + ~15% overhead. Weights scale with model size and precision; the KV cache grows with context length. Watch a 70B model fall off a 24GB card the moment you raise the context window.",
    },
    {
      type: "subheading",
      text: "The back-of-the-envelope formula",
    },
    {
      type: "paragraph",
      text: "You can do the core estimate in your head. Each parameter takes a fixed number of bytes depending on precision: **2 bytes at FP16, 1 byte at INT8, half a byte at INT4**. Multiply by the parameter count, then add roughly 20% for the KV cache and runtime overhead:",
    },
    {
      type: "code",
      language: "text",
      code: `VRAM (GB) ≈ params(billions) × bytes_per_param × 1.2

bytes_per_param:  FP16 = 2   INT8 = 1   INT4 = 0.5

Examples (rule of thumb):
  7B  @ FP16 ≈ 7  × 2   × 1.2 ≈ 17 GB
  7B  @ INT4 ≈ 7  × 0.5 × 1.2 ≈  4 GB
  70B @ FP16 ≈ 70 × 2   × 1.2 ≈ 168 GB
  70B @ INT4 ≈ 70 × 0.5 × 1.2 ≈ 42 GB`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "The 2× shortcut",
      text: "For a quick gut-check: an FP16 model needs about **2 GB of VRAM per billion parameters**, and an INT4 model needs about **0.5 GB per billion**. A 13B model at INT4 → ~7–8 GB → fits a humble 12GB card. Memorize those two anchors and you can size almost anything instantly.",
    },
    {
      type: "paragraph",
      text: "Two subtleties the rule of thumb hides. First, the **KV cache** grows with how much text the model is holding in context — a 128K-token conversation can add many gigabytes on top of the weights, which is why long-context use cases need far more headroom than the weights alone suggest. Second, **training and fine-tuning need much more** than inference: optimizer states and gradients can triple or quadruple the requirement. Everything in this guide is about *inference* unless we say otherwise.",
    },
    {
      type: "heading",
      text: "Quantization: the lever that changes everything",
      id: "quantization",
    },
    {
      type: "paragraph",
      text: "If VRAM is the gate, **quantization** is the key that opens it. Models are trained in 16-bit precision, but you don't have to *run* them that way. Quantization stores each weight in fewer bits — 8, 4, even 3 — shrinking the model dramatically with a surprisingly small hit to quality. It is the single most important technique for running big models on small cards.",
    },
    {
      type: "diagram",
      visual: "quantization-ladder",
      caption:
        "Climb down the precision ladder. Each step roughly halves the memory. INT4 (the popular Q4_K_M format) keeps ~93% of quality while using a quarter of the memory of FP16 — the sweet spot most local setups land on.",
    },
    {
      type: "list",
      items: [
        "**FP16 / BF16 (2 bytes)** — the reference. Matches the published weights exactly. Use when you have the VRAM and want maximum fidelity.",
        "**INT8 (1 byte)** — half the memory, ~1–2% quality drop. A safe, almost-free win.",
        "**INT4 (0.5 bytes)** — a quarter of the memory, ~5–7% quality drop. This is what makes a 70B model run on a single 48GB card. The community default (Q4_K_M) for local inference.",
        "**INT3 / INT2** — squeeze-territory. Real degradation; reserve for when nothing else fits.",
      ],
    },
    {
      type: "callout",
      tone: "warn",
      title: "GGUF, AWQ, GPTQ — what are these?",
      text: "These are quantization *formats* you'll see on Hugging Face. GGUF is the format llama.cpp/Ollama use (great for CPU + GPU, the `Q4_K_M` naming). AWQ and GPTQ are GPU-optimized 4-bit formats common with vLLM. Same idea — fewer bits — different packaging for different runtimes.",
    },
    {
      type: "heading",
      text: "Which GPU runs which model?",
      id: "which-gpu-which-model",
    },
    {
      type: "paragraph",
      text: "Now the headline question. Combine the VRAM math with quantization and you get a clear map of what runs where. Toggle the precision in the matrix below: green means it fits on a single card, amber means you need to split it across two-to-four GPUs, and red means it takes a whole server.",
    },
    {
      type: "diagram",
      visual: "gpu-model-matrix",
      caption:
        "The fit matrix. Flip between FP16, INT8, and INT4 and watch the board change. At INT4 a single 48GB L40S swallows a 70B model; at FP16 that same model needs four GPUs. Quantization is the great equalizer.",
    },
    {
      type: "subheading",
      text: "A rough tiering you can memorize",
    },
    {
      type: "list",
      items: [
        "**8–12 GB (RTX 3060, 4070, laptop GPUs)** — 3B–8B models at INT4. Great for learning, chat, and code assistants.",
        "**16–24 GB (RTX 4080, 4090, A10, L4)** — up to ~14B comfortably, 32B at INT4 with a short context. The hobbyist and small-prod sweet spot.",
        "**32–48 GB (RTX 5090, L40S)** — 32B at good precision, 70B at INT4. Serious single-card territory.",
        "**80 GB (A100, H100)** — 70B at FP16-ish quality, or high-throughput serving of smaller models with big batches.",
        "**141–192 GB (H200, B200) and multi-GPU** — 100B+ models, MoE giants like Mixtral and DeepSeek, and 405B with several cards linked by NVLink.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Mixture-of-Experts (MoE) is sneaky",
      text: "Models like Mixtral 8x7B or DeepSeek only *activate* a fraction of their parameters per token, so they're fast — but **all** the experts must still sit in VRAM. A '47B active' MoE can still demand the memory of a 90B+ dense model. Size by total parameters, not active ones.",
    },
    {
      type: "heading",
      text: "The fastest way to check: the llmfit tool",
      id: "llmfit",
    },
    {
      type: "paragraph",
      text: "You don't have to do this arithmetic by hand. **llmfit** is a free, open-source command-line tool that detects your hardware (RAM, CPU, and GPU VRAM across NVIDIA, AMD, Apple Silicon, and Intel Arc) and tells you exactly which models will run well — and at what quantization. It's the single fastest way to answer 'can my machine run this?'",
    },
    {
      type: "code",
      language: "bash",
      code: `# Install (pick one)
brew install llmfit                              # macOS / Linux
curl -fsSL https://llmfit.axjns.dev/install.sh | sh
uv tool install -U llmfit                         # via Python/uv
scoop install llmfit                              # Windows

# See what llmfit detected about your machine
llmfit system

# Rank models that fit your hardware perfectly
llmfit fit --perfect -n 5

# Get coding-focused recommendations as JSON
llmfit recommend --json --use-case coding --limit 3

# Plan the requirements for a specific model + context
llmfit plan "Qwen/Qwen3-4B" --context 8192

# Pretend you have a different GPU before you buy it
llmfit --memory=24G --ram=64G fit --perfect -n 5`,
    },
    {
      type: "paragraph",
      text: "The clever part is **dynamic quantization**: instead of a yes/no answer, llmfit walks down the precision ladder (Q8_0 → Q6_K → Q5_K → Q4_K_M → Q3_K_M → Q2_K) and reports the *highest-quality* quant that still fits your memory. It scores every model 0–100 across four dimensions — **quality, speed, fit, and context** — and weights them by your use case (chat favors speed, reasoning favors quality). The interactive terminal below shows the same `llmfit fit` command run on three different machines.",
    },
    {
      type: "diagram",
      visual: "llmfit-demo",
      caption:
        "The same one-liner, three machines. Switch between a 16GB laptop, a 24GB workstation, and an 80GB server and watch llmfit re-rank the shortlist — always picking the best quantization that actually fits.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Use the --memory flag before you spend money",
      text: "The single most useful trick: `llmfit --memory=48G fit --perfect` simulates a GPU you don't own yet. Plan your purchase against the exact models you want to run, instead of guessing from a spec sheet.",
    },
    {
      type: "paragraph",
      text: "llmfit is the CLI workhorse, but a few browser-based calculators are worth bookmarking too — they're handy for sharing a link or sizing a model you can't download yet:",
    },
    {
      type: "list",
      items: [
        "**LLMfit.io** — web VRAM and generation-speed estimator for Llama, Mistral, Qwen, and DeepSeek.",
        "**NyxKrage's LLM Model VRAM Calculator (Hugging Face Space)** — paste a HF model name, pick the quant and context, get the number.",
        "**APXML 'Can You Run This LLM?'** — covers NVIDIA and Apple Silicon side by side.",
        "**gpu_poor (GitHub)** — estimates memory *and* breaks down weights vs KV cache vs activations for both training and inference.",
      ],
    },
    {
      type: "heading",
      text: "Choosing the right GPU for your use case",
      id: "choosing-gpu",
    },
    {
      type: "paragraph",
      text: "'Which GPU should I buy?' has no single answer — it depends entirely on what you're doing. Running a quantized model for fun has wildly different requirements than serving thousands of users or fine-tuning on your own data. Pick your use case below and see where it points.",
    },
    {
      type: "diagram",
      visual: "gpu-selector-flow",
      caption:
        "Start from the job, not the GPU. Learning locally, serving a product, fine-tuning with LoRA, and full training each have a different right answer — and the gap between them is enormous.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Define the workload** — inference or training? One user or many concurrent? How big is the model you actually need (often smaller than you think)?",
        "**Set the context length** — long documents and agent histories balloon the KV cache. Budget VRAM for your worst-case context, not your average.",
        "**Pick a precision** — can you accept INT4? That alone may drop you from a datacenter card to a consumer one.",
        "**Add headroom** — leave 15–20% of VRAM free for the cache and runtime, or you'll hit out-of-memory errors under load.",
        "**Then choose the card** — the smallest, cheapest GPU that clears all of the above with headroom wins.",
      ],
    },
    {
      type: "heading",
      text: "Desktop GPUs vs datacenter GPUs",
      id: "desktop-vs-datacenter",
    },
    {
      type: "paragraph",
      text: "Here's a question that confuses almost everyone: if an RTX 4090 has 24GB of fast memory for $1,600, why does an H100 with 80GB cost $28,000? Surely that's a 17× markup for ~3× the memory? The answer is that they aren't built for the same job — and a lot of what you pay for on a datacenter card is invisible on a spec sheet.",
    },
    {
      type: "diagram",
      visual: "desktop-vs-datacenter",
      caption:
        "Press the button to reveal what the datacenter premium actually buys. NVLink for splitting huge models, ECC memory for correctness over long runs, MIG for sharing one card across tenants, FP8 for speed — and crucially, a license that permits 24/7 datacenter operation.",
    },
    {
      type: "list",
      items: [
        "**Memory & bandwidth** — datacenter cards use HBM (high-bandwidth memory): an H100 moves ~3.35 TB/s vs a 4090's ~1 TB/s. Bandwidth, not raw compute, is usually what caps token generation speed.",
        "**NVLink** — datacenter GPUs link directly at 900 GB/s so a model can be split across many cards as if they were one. Consumer cards are stuck talking over slower PCIe.",
        "**ECC memory** — error-correcting memory catches bit-flips that would silently corrupt a multi-day training run. Consumer cards skip it.",
        "**MIG (Multi-Instance GPU)** — one A100/H100 can be carved into up to 7 isolated GPUs to serve many tenants. Consumer cards can't.",
        "**Licensing & duty cycle** — NVIDIA's driver EULA restricts consumer GeForce cards in datacenters, and consumer cards aren't designed to run pinned at 100% 24/7. Datacenter cards are.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "The practical takeaway",
      text: "Building locally, learning, or serving modest traffic? A desktop RTX card is a phenomenal deal — don't pay the datacenter tax you don't need. Running a 24/7 service, splitting a 100B+ model, or multi-tenant serving? That's exactly what the expensive cards are for.",
    },
    {
      type: "heading",
      text: "Benchmarking: measure, don't guess",
      id: "benchmarking",
    },
    {
      type: "paragraph",
      text: "Once a model fits, the next question is *how fast*. But 'fast' isn't one number, and the headline 'tokens per second' on a vendor slide is almost always measured at a batch size that makes the marketing look good. To benchmark honestly you need to know which metrics matter and how they trade off.",
    },
    {
      type: "list",
      items: [
        "**TTFT (time to first token)** — how long until the user sees *anything*. Dominated by the prefill of the prompt; this is what makes a chatbot feel responsive.",
        "**ITL / TPOT (inter-token latency)** — the delay between each streamed token. Drives how fast the text appears to type.",
        "**Throughput (total tokens/sec)** — how many tokens the server produces across *all* users at once. This sets your cost per token.",
        "**p95 / p99 latency** — the slow tail. Averages hide the users who waited 4 seconds; the tail is what they remember.",
      ],
    },
    {
      type: "paragraph",
      text: "The crucial insight is the **throughput-vs-latency tradeoff**. Batching more requests together raises total throughput (and lowers your cost per token) but makes each individual user wait longer. Benchmarking is the art of finding the batch size where both are acceptable. Drag the slider and watch the two pull against each other:",
    },
    {
      type: "diagram",
      visual: "benchmark-metrics",
      caption:
        "Batch size is the master dial of serving. Larger batches push total throughput up and cost/token down, but per-user latency and TTFT climb. There's no free lunch — only a sweet spot for your workload.",
    },
    {
      type: "subheading",
      text: "Tools that benchmark honestly",
    },
    {
      type: "list",
      items: [
        "**vLLM's `benchmark_serving.py`** — the de facto standard for measuring real serving throughput and latency under concurrent load.",
        "**NVIDIA GenAI-Perf** — vendor tool for TTFT, ITL, and throughput across batch sizes and concurrency levels.",
        "**llmfit bench** — quick inference benchmarks plus community-contributed numbers right in the CLI.",
        "**llmperf / LLMPerf (Ray)** — load-tests an API endpoint the way real traffic would.",
        "**MLPerf Inference** — the industry's standardized, audited benchmark for comparing hardware apples-to-apples.",
      ],
    },
    {
      type: "code",
      language: "bash",
      code: `# Benchmark real serving throughput + latency with vLLM
python -m vllm.entrypoints.openai.api_server \\
  --model meta-llama/Llama-3.1-8B-Instruct &

python benchmarks/benchmark_serving.py \\
  --model meta-llama/Llama-3.1-8B-Instruct \\
  --dataset-name sharegpt \\
  --request-rate 10 \\
  --num-prompts 500
# → reports TTFT, TPOT, and throughput at your target load`,
    },
    {
      type: "callout",
      tone: "warn",
      title: "Benchmark your workload, not theirs",
      text: "A number measured with 2,000-token prompts and batch size 256 tells you nothing about your 200-token chat at batch size 4. Always benchmark with prompt lengths, output lengths, and concurrency that match how you'll actually use the model.",
    },
    {
      type: "heading",
      text: "Cost, availability, and buy vs rent",
      id: "cost-and-availability",
    },
    {
      type: "paragraph",
      text: "GPUs are expensive and, for the top end, genuinely scarce. Understanding both the sticker price and the rental economics is what separates a sustainable setup from a surprise invoice. Here's the rough 2026 landscape, then an interactive way to find your own breakeven.",
    },
    {
      type: "list",
      items: [
        "**RTX 4090 (24GB)** — ~$1,600 to buy; ~$0.30–0.70/hr in the cloud. The price-performance king for local work.",
        "**RTX 5090 (32GB)** — ~$2,000 to buy; limited cloud availability as of mid-2026.",
        "**L40S (48GB)** — ~$1/hr cloud; a popular inference-serving workhorse.",
        "**A100 80GB** — ~$15k to buy; ~$1.07–3.40/hr cloud. The mature, widely-available datacenter standard.",
        "**H100 80GB** — ~$28k to buy; ~$2.00–3.90/hr on specialist clouds, but $8–12/hr on hyperscalers like AWS/GCP/Azure.",
        "**H200 (141GB) / B200 (192GB)** — the frontier; ~$2–4/hr where available, but supply is tight and often reserved.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Availability is a real constraint",
      text: "Specialist clouds (RunPod, Lambda, Vast.ai, Spheron) are typically 60–85% cheaper than the big three hyperscalers for the same card. Spot/preemptible instances cut another 50–80% but can be reclaimed at any moment — perfect for fault-tolerant batch jobs, risky for a live service.",
    },
    {
      type: "paragraph",
      text: "The big decision is **buy vs rent**, and it comes down to *utilization*. A GPU you use a few hours a week should almost always be rented. A GPU pinned near 24/7 usually justifies buying — or a long-term cloud reservation. The crossover point is the whole game. Pick a card and slide your monthly usage to find it:",
    },
    {
      type: "diagram",
      visual: "gpu-cost-explorer",
      caption:
        "Buy-vs-rent breakeven. Cloud cost scales linearly with hours used; ownership is a fixed monthly amortization. Below the breakeven hours, renting wins; above it, owning does. For bursty experimentation, the cloud is almost always cheaper.",
    },
    {
      type: "heading",
      text: "A worked example, end to end",
      id: "worked-example",
    },
    {
      type: "paragraph",
      text: "Let's make it concrete. Say you're building a customer-support assistant. You've decided a **14B model** gives you the quality you need, you'll serve it to a **handful of concurrent users**, and your prompts plus retrieved context run to about **8K tokens**. What hardware do you need?",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Size the model.** 14B at INT4 ≈ 14 × 0.5 × 1.2 ≈ 8.4 GB of weights. Add ~2 GB for an 8K KV cache and overhead → ~11 GB total.",
        "**Check the fit.** That clears a 16GB card with headroom — but for *concurrent* users you want room for a bigger batch and a larger KV cache, so step up to a **24GB** card.",
        '**Confirm with llmfit.** `llmfit --memory=24G plan "Qwen/Qwen2.5-14B" --context 8192` confirms it fits at a high-quality quant (Q5_K or Q8_0).',
        "**Decide buy vs rent.** Pre-launch with spiky traffic? Rent a 4090 or L4 at ~$0.30–0.70/hr. Steady 24/7 production? An owned 4090, or a reserved L40S for ECC + datacenter licensing.",
        "**Benchmark before launch.** Run `benchmark_serving.py` at your real prompt sizes and target request rate, then tune batch size for an acceptable TTFT.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "The result",
      text: "A 14B support assistant runs happily on a single 24GB GPU you can rent for under a dollar an hour — no datacenter card required. Sizing it correctly saved you from over-buying an 80GB H100 by 30×.",
    },
    {
      type: "heading",
      text: "The cheat sheet",
      id: "cheat-sheet",
    },
    {
      type: "list",
      items: [
        "**VRAM is the gate.** It decides *if* a model runs; compute decides *how fast*.",
        "**~2 GB per billion params at FP16, ~0.5 GB at INT4.** Memorize this and you can size anything.",
        "**Quantization is the key.** INT4 keeps ~93% of quality at a quarter of the memory — it's how big models reach small cards.",
        "**Context inflates the KV cache.** Long conversations and documents need real extra headroom.",
        "**Use llmfit.** `llmfit fit --perfect` answers 'what runs on my machine?' in one command — and `--memory` simulates hardware before you buy.",
        "**Match the GPU to the job.** Desktop cards are unbeatable value for local work; datacenter cards earn their price on NVLink, ECC, MIG, and 24/7 licensing.",
        "**Benchmark your own workload.** TTFT, throughput, and the p99 tail — at your real prompt sizes and concurrency.",
        "**Rent for bursty, buy for sustained.** Find the breakeven hours and let utilization decide.",
      ],
    },
    {
      type: "paragraph",
      text: "The mystique around 'do I need a fancy GPU for AI?' evaporates once you can do the memory math. A model is just weights that have to fit, plus a cache that grows with context. Estimate the number, check it with llmfit, pick the smallest card that clears it with headroom, and benchmark before you trust it. That's the whole craft — and now it's yours.",
    },
    {
      type: "quote",
      text: "The right GPU isn't the biggest one you can afford. It's the smallest one that runs your model with headroom to spare.",
    },
    {
      type: "divider",
    },
    {
      type: "paragraph",
      text: "Want to put a model you've sized to work? Spin up a swarm in the AgentSwarms canvas and wire it to your chosen model — local or hosted — then watch the live cost-and-token meter confirm your math in real time.",
    },
  ],
  references: [
    {
      label: "llmfit — find what runs on your hardware (GitHub)",
      url: "https://github.com/AlexsJones/llmfit",
    },
    { label: "LLMfit.io — local LLM VRAM & speed calculator", url: "https://llmfit.io/" },
    {
      label: "LLM Model VRAM Calculator (Hugging Face Space)",
      url: "https://huggingface.co/spaces/NyxKrage/LLM-Model-VRAM-Calculator",
    },
    {
      label: "APXML — Can You Run This LLM? VRAM calculator",
      url: "https://apxml.com/tools/vram-calculator",
    },
    {
      label: "gpu_poor — GPU memory estimator (GitHub)",
      url: "https://github.com/RahulSchand/gpu_poor",
    },
    {
      label: "vLLM — benchmarking serving throughput & latency",
      url: "https://docs.vllm.ai/en/latest/contributing/benchmarks.html",
    },
    {
      label: "NVIDIA GenAI-Perf — LLM benchmarking tool",
      url: "https://github.com/triton-inference-server/perf_analyzer",
    },
    {
      label: "MLPerf Inference — standardized hardware benchmarks",
      url: "https://mlcommons.org/benchmarks/inference-datacenter/",
    },
    {
      label: "Spheron — GPU cloud pricing comparison 2026",
      url: "https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026",
    },
    {
      label: "NVIDIA H100 — datacenter GPU architecture & specs",
      url: "https://www.nvidia.com/en-us/data-center/h100/",
    },
  ],
};

const agentCostControl: BlogPost = {
  slug: "cost-control-in-multi-agent-systems",
  title: "When Agents Burn Money: Cost Control in Multi-Agent Systems",
  subtitle:
    "A single agent stuck between tool calls can quietly spend more in a weekend than your whole team does in a month. Here's why multi-agent costs spiral, what a runaway actually looks like, and the guardrails — and tools — that stop the bleeding.",
  excerpt:
    "Multi-agent costs don't add up — they multiply. Why loops and fan-out send spend geometric, how a stuck agent racks up a five-figure bill, and the enforcement, dedup, and observability tooling that keeps it bounded.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-05-31",
  readingTime: "21 min read",
  tags: ["Production", "Observability"],
  cover: {
    gradient: "from-amber-500/30 via-rose-500/20 to-primary/25",
    icon: "scale",
    motif: "network",
  },
  blocks: [
    {
      type: "lead",
      text: "Someone on a team we know shipped a tidy little multi-agent workflow on a Friday. Four agents, a couple of tools, a plan that looked airtight in the demo. They went home. The agents did not. One of them hit a verification step that never quite passed, asked a teammate agent to help, got handed the task back, and the two of them settled into a polite, infinite conversation. Eleven days later someone opened the billing console. The number was $47,000.",
    },
    {
      type: "paragraph",
      text: "That story has been told enough times now that it's practically folklore, but the details barely matter because the shape is always the same. Nothing crashed. No alert that mattered fired in time. The system did *exactly* what it was told to do — keep working until the task is done — and the task was never done. The only thing that grew was the bill.",
    },
    {
      type: "paragraph",
      text: "We've spent a lot of words on this site teaching people how to make agents *work*. This post is about the other half of the job, the half nobody demos: making them work *affordably*, and making sure that when they go wrong — and they will — they fail cheap instead of failing expensive. If you take one idea away, make it this: **in an agentic system, cost is not a billing concern you reconcile at month-end. It's a reliability property you design in from the first line.**",
    },
    {
      type: "heading",
      text: "Agent costs don't add up. They multiply.",
      id: "costs-multiply",
    },
    {
      type: "paragraph",
      text: "Here's the mental model that gets everyone in trouble. We spent two years with chatbots, and chatbots taught us that cost scales *linearly*: one user message, one model response, a predictable handful of tokens. Double the users, double the bill. Easy to reason about, easy to budget.",
    },
    {
      type: "paragraph",
      text: "Agents broke that intuition. An agent doesn't answer once — it reasons, calls a tool, reads the result, reasons again, maybe spawns a helper, maybe retries. Every one of those decision points can branch, and every branch can carry the *entire conversation so far* with it. So spend doesn't accumulate one message at a time. It compounds at every step.",
    },
    {
      type: "diagram",
      visual: "cc-cost-scaling",
      caption:
        "Drag the slider. A chatbot's cost grows linearly with interactions (blue). An agentic workflow grows geometrically (red), because each decision can spawn sub-agents, recursive calls, and branching logic that compound at every step.",
    },
    {
      type: "paragraph",
      text: "The numbers people report bear this out. A multi-step agent routinely consumes **5× to 50× the tokens** of a single chatbot turn for the same nominal task, and a single careless top-level request can trigger a workflow that burns 100× what you'd expect. The reason is structural, not a bug you can patch: autonomy means the system decides how much work to do, and a confused system decides to do *a lot*.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Why this is suddenly everyone's problem",
      text: "The State of FinOps 2026 found that 98% of FinOps practices now manage some form of AI spend — up from 31% just two years earlier. Inference, not training, is now the dominant line item. Agentic workloads are the reason the curve bent.",
    },
    {
      type: "heading",
      text: "The anatomy of a spiral: stuck between tool calls",
      id: "anatomy-of-a-spiral",
    },
    {
      type: "paragraph",
      text: "The classic blow-up isn't a sudden explosion — it's a slow, steady drip that never stops. An agent operates in a loop: think, act, observe, repeat, until some condition says *done*. The danger lives in that last clause. If the stop condition is never satisfied — a tool keeps returning something the model doesn't accept, a verification step keeps failing, a goal is subtly impossible — there's nothing else in the loop that says *give up*. The agent just keeps calling.",
    },
    {
      type: "diagram",
      visual: "cc-loop-meter",
      caption:
        "Press play. This is a loop with no guardrail: each iteration re-reads the history, calls another tool, and adds to the bill. Notice there's no point where it stops on its own — in production, it doesn't.",
    },
    {
      type: "paragraph",
      text: "What makes it expensive rather than merely annoying is the thing that makes agents work at all: **they send the whole conversation back to the model on every step.** The transcript of past reasoning and tool results is the agent's working memory, so it travels with each call. That means iteration 30 isn't paying for one step's worth of tokens — it's paying to re-read everything that happened in steps 1 through 29, again.",
    },
    {
      type: "diagram",
      visual: "cc-context-accumulation",
      caption:
        "The context tax. The agent doesn't pay for each step in isolation — it re-sends the growing transcript every single call, so your real input-token bill is the cumulative area under this curve, not the height of the last bar.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "The part people miss",
      text: "A loop that adds 3K tokens of context per step looks cheap per step. But because you re-pay for the whole transcript each time, fifteen quiet iterations can cost more than the entire successful run you were budgeting for. Slow drips drown you.",
    },
    {
      type: "heading",
      text: "Four ways a multi-agent system bleeds money",
      id: "failure-modes",
    },
    {
      type: "paragraph",
      text: "“It got stuck” hides several distinct failure modes, and they don't all have the same fix. It's worth being able to name them, because the guardrail that stops one won't always stop another.",
    },
    {
      type: "diagram",
      visual: "cc-failure-modes",
      caption:
        "Tap through the common cost-spiral failure modes. Each one bleeds money differently — a stuck loop needs an iteration cap, a retry storm needs backoff and a budget, fan-out needs depth limits.",
    },
    {
      type: "subheading",
      text: "The fan-out problem",
    },
    {
      type: "paragraph",
      text: "Multi-agent architectures love delegation: an orchestrator breaks a job into pieces and hands each to a sub-agent. That's powerful, and it's also where geometric cost lives. If the orchestrator spawns three workers, and each of those is itself allowed to spawn three more, you're two levels deep and already running thirteen agents. Let that recursion go one level further unchecked and you're funding an army.",
    },
    {
      type: "diagram",
      visual: "cc-fanout",
      caption:
        "Slide the orchestration depth. Each agent that spawns sub-agents — which spawn their own — multiplies token consumption exponentially. Unbounded delegation depth is one careless request away from dozens of workers.",
    },
    {
      type: "subheading",
      text: "The retry storm and the ping-pong",
    },
    {
      type: "paragraph",
      text: "Two cheaper-looking failures round out the set. A **retry storm** happens when a flaky tool or a rate limit triggers naïve retries — and because each retry re-sends the full context, ten retries cost ten full calls, not ten cheap pings. **Tool ping-pong** is the multi-agent version of a stuck loop: two agents hand the same subtask back and forth, each politely deferring to the other, neither ever converging. Both look like progress in the logs. Neither is.",
    },
    {
      type: "heading",
      text: "Why your budget alert won't save you",
      id: "alerts-vs-enforcement",
    },
    {
      type: "paragraph",
      text: "Most teams' first instinct is to add a billing alert: “email me when we cross $500.” It feels responsible. It is almost useless for this problem. An alert is a *detection* mechanism, and it fires *after* the money is spent. By the time a human reads it — overnight, over a weekend, during a long meeting — the runaway has had hours to keep running.",
    },
    {
      type: "diagram",
      visual: "cc-budget-vs-alert",
      caption:
        "The distinction that matters most. A budget alert tells you about spend after it happens. Budget enforcement is checked before the next call completes and refuses to make it. One bounds your worst case; the other just narrates it.",
    },
    {
      type: "quote",
      text: "A token budget alert is not budget enforcement. The first tells you the house is on fire. The second is the sprinkler.",
      cite: "paraphrasing the now-famous “$47,000 agent loop” write-up",
    },
    {
      type: "paragraph",
      text: "The fix is to move the check *before* the call, not after the invoice. Before the agent makes its next model request, you ask: would this push us past the limit we set? If yes, the call doesn't happen. The run halts, escalates, or returns its best partial answer. Your maximum loss becomes the ceiling you chose — a number you decided on purpose, instead of one the agent discovered for you.",
    },
    {
      type: "heading",
      text: "Building the guardrails",
      id: "building-guardrails",
    },
    {
      type: "paragraph",
      text: "There's no single switch for this. Cost control in agents is defense in depth: a small stack of independent limits, any one of which can stop a runaway, layered so that the failure of one doesn't mean the failure of all. Here's the stack we reach for, roughly in order of how much grief each one saves you.",
    },
    {
      type: "diagram",
      visual: "cc-guardrail-stack",
      caption:
        "Toggle the guardrails. You don't need all of them, but you need at least one hard limit that can actually halt the loop. Alerts and dashboards are not on this list because they can't stop anything.",
    },
    {
      type: "subheading",
      text: "1. A hard iteration cap",
    },
    {
      type: "paragraph",
      text: "The simplest and most important guardrail: every agent run gets a maximum number of steps. If it hasn't finished in, say, 15 iterations, it stops — with an error, a partial result, or an escalation to a human, but it *stops*. This single limit turns “infinite” into “bounded,” which is most of the battle.",
    },
    {
      type: "code",
      language: "python",
      code: `MAX_ITERS = 15
MAX_USD = 0.50            # hard ceiling per run
spent = 0.0

for step in range(MAX_ITERS):
    # estimate the cost of the NEXT call before making it
    projected = spent + estimate_cost(messages, model)
    if projected > MAX_USD:
        return halt(reason="cost_ceiling", spent=spent)

    resp = model.call(messages)
    spent += resp.usage.cost_usd        # track real spend per step

    if resp.is_final_answer:
        return resp
    messages = append_tool_result(messages, run_tool(resp))

# loop exhausted without finishing — fail cheap, don't fail expensive
return halt(reason="max_iters", spent=spent)`,
    },
    {
      type: "subheading",
      text: "2. Token and dollar budgets, enforced pre-call",
    },
    {
      type: "paragraph",
      text: "An iteration cap bounds *steps*, but steps aren't all equal — one call with a 200K-token context costs far more than ten small ones. So pair the step cap with a **token budget** (prompt + completion summed across the whole run) and, better still, a **dollar ceiling** checked before each call, exactly as in the snippet above. Gateways make this easy to enforce centrally rather than re-implementing it in every agent.",
    },
    {
      type: "subheading",
      text: "3. A global timeout",
    },
    {
      type: "paragraph",
      text: "Wall-clock time is a backstop for everything you didn't anticipate. A strict global timer — kill the entire chain after N seconds — catches the slow hang, the tool that never returns, the recursion you didn't bound. It's blunt, and that's the point: it doesn't need to understand *why* things went wrong to stop them.",
    },
    {
      type: "subheading",
      text: "4. Repeat-action detection",
    },
    {
      type: "paragraph",
      text: "A loop has a tell: the agent keeps doing the same thing. Before executing an action, compare it against the last few steps. If it's about to call the same tool with the same arguments it used two steps ago, it isn't making progress — it's spinning. Block the duplicate, inject a nudge, or terminate. This catches stuck loops *semantically*, often well before the iteration cap would.",
    },
    {
      type: "diagram",
      visual: "cc-dedup",
      caption:
        "A simple dedup layer in action: repeated identical tool calls get blocked instead of billed. Comparing each proposed action against a short history is cheap and catches the most common loop signature.",
    },
    {
      type: "subheading",
      text: "5. Budget pressure: tell the model it's running out",
    },
    {
      type: "paragraph",
      text: "A subtler technique that works surprisingly well: don't just cut the agent off silently — *warn it* as it approaches the limit. Inject a system message a few iterations before the cap (“you have 3 steps left, wrap up and give your best answer; do not call more tools”). Models respond to this. It turns a hard, wasteful termination into a graceful landing, and often produces a usable answer instead of an error.",
    },
    {
      type: "code",
      language: "python",
      code: `remaining = MAX_ITERS - step
if remaining <= 3:
    messages.append({
        "role": "system",
        "content": (
            f"You have {remaining} steps left. Stop calling tools. "
            "Give your best final answer now with what you already know."
        ),
    })`,
    },
    {
      type: "subheading",
      text: "6. Context management",
    },
    {
      type: "paragraph",
      text: "Because the transcript is what makes long runs expensive, managing it is a cost lever, not just a quality one. After a few iterations, summarize or drop stale tool results so the context stops growing without bound. Retrieve only what the next step needs instead of carrying everything forward. And cap delegation depth so the fan-out tree can't recurse forever. None of these are exotic — they're hygiene — but skipping them is what turns a working agent into an expensive one.",
    },
    {
      type: "heading",
      text: "Tools that do the heavy lifting",
      id: "tools",
    },
    {
      type: "paragraph",
      text: "You don't have to build all of this from scratch, and you shouldn't. There's a healthy ecosystem now — much of it open source — split roughly into two camps: **observability** tools that show you where the money goes (so you can find the spirals), and **gateway/proxy** tools that sit in front of your model calls and *enforce* limits centrally. The strongest setups pair one of each.",
    },
    {
      type: "diagram",
      visual: "cc-tools-landscape",
      caption:
        "A non-exhaustive map of the cost-control tooling. Gateways (Helicone, Portkey, LiteLLM) can enforce budgets and cache; observability tools (Langfuse, Opik, Phoenix, OpenLLMetry) trace per-run token and dollar cost so spirals are visible.",
    },
    {
      type: "list",
      items: [
        "**LiteLLM** — a unified gateway across providers with **per-key and per-team budgets, rate limits, and spend caps** built in. The most direct way to enforce a hard dollar ceiling without touching agent code.",
        "**Portkey** — gateway focused on routing, fallbacks, load balancing, and budget limits with minimal overhead; good when you want resilience and cost control in one hop.",
        "**Helicone** — a proxy that adds **caching** (don't pay twice for the same call) plus cost tracking; the cache alone can meaningfully cut spend on repetitive workloads.",
        "**Langfuse** (MIT) — the most full-featured open-source observability tool; traces every call with token and cost breakdowns, and ingests cost data directly from LiteLLM.",
        "**Opik** (Apache-2.0) and **Phoenix** (Arize) — open-source tracing and evaluation; self-hostable when prompts and data can't leave your infrastructure.",
        "**OpenLLMetry** — OpenTelemetry-based instrumentation, so your LLM spans flow into the same observability backend as the rest of your stack.",
        "**Portal26 Agentic Token Controls** and similar commercial entrants — purpose-built to cap runaway *agent* spend specifically, a sign the market now treats this as a first-class problem.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Open source or managed?",
      text: "Self-host (Langfuse, Opik, LiteLLM proxy) when data residency matters or per-request pricing hurts at scale. Reach for the managed cloud tiers when time-to-value and zero-maintenance beat everything. Either way: a gateway for enforcement, an observability tool for visibility.",
    },
    {
      type: "divider",
    },
    {
      type: "heading",
      text: "Cost-control best practices",
      id: "best-practices",
    },
    {
      type: "paragraph",
      text: "Pulling it together, here's the checklist we'd want on the wall before any multi-agent system touches a real budget. Tick them off below — the ones that aren't checked are exactly the ways your next bill surprises you.",
    },
    {
      type: "diagram",
      visual: "cc-best-practices",
      caption:
        "The working checklist. Notice that none of these are about making the agent smarter — they're about bounding what it can spend when it isn't.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Design limits in from day one.** Cost controls bolted on after launch always arrive after the first scary invoice. Treat a missing iteration cap like a missing null check.",
        "**Enforce, don't alert.** Check budgets *before* the next call and refuse it. Keep the alerts too — but never rely on them to stop a runaway.",
        "**Cap iterations, tokens, dollars, and time.** Four independent limits. Any one can save you; together they're hard to defeat.",
        "**Detect loops semantically.** Block repeated identical actions and ping-pong between agents before the iteration cap even bites.",
        "**Bound delegation depth.** Limit how many levels of sub-agents can spawn, or fan-out will do your budget's math for you.",
        "**Manage the context.** Summarize or trim history between steps; retrieve only what's needed. The transcript is the meter.",
        "**Route by difficulty.** Send routine steps to a cheap model; reserve the frontier tier for the reasoning that actually needs it.",
        "**Make every run observable.** Log per-run token and dollar cost and trace it. You can't control what you can't see — and the spiral you can see is the spiral you can stop.",
      ],
    },
    {
      type: "paragraph",
      text: "The uncomfortable truth under all of this is that an autonomous system will, eventually, do something you didn't plan for. That's not a reason to avoid agents — it's the whole reason guardrails exist. You don't get to guarantee an agent never gets stuck. You *do* get to guarantee that when it does, it costs you fifty cents and a log line instead of a weekend and $47,000. That choice is yours to make, and the only wrong time to make it is after the fact.",
    },
    {
      type: "callout",
      tone: "success",
      title: "The one-sentence version",
      text: "You can't stop an agent from ever going wrong — but with a hard limit before every call, you can decide in advance exactly how much it's allowed to cost when it does.",
    },
  ],
  references: [
    {
      label: "The $47,000 Agent Loop: Why Token Budget Alerts Aren't Budget Enforcement (dev.to)",
      url: "https://dev.to/waxell/the-47000-agent-loop-why-token-budget-alerts-arent-budget-enforcement-389i",
    },
    {
      label: "AI Agents Burn 50x More Tokens Than Chats (LeanOps)",
      url: "https://leanopstech.com/blog/agentic-ai-cost-runaway-token-budget-2026/",
    },
    {
      label:
        "Portal26 launches Agentic Token Controls to cap runaway AI agent spend (SiliconANGLE)",
      url: "https://siliconangle.com/2026/04/23/portal26-launches-agentic-token-controls-cap-runaway-ai-agent-spend/",
    },
    {
      label: "Agent Iteration Budgets (LiteLLM docs)",
      url: "https://docs.litellm.ai/docs/a2a_iteration_budgets",
    },
    {
      label: "How to Prevent Infinite Loops and Spiraling Costs in Autonomous Agents (Codieshub)",
      url: "https://codieshub.com/for-ai/prevent-agent-loops-costs",
    },
    {
      label: "Agentic Resource Exhaustion: The “Infinite Loop” Attack of the AI Era (Medium)",
      url: "https://medium.com/@instatunnel/agentic-resource-exhaustion-the-infinite-loop-attack-of-the-ai-era-76a3f58c62e3",
    },
    {
      label: "Beyond Max Tokens: Stealthy Resource Amplification via Tool Calling Chains (arXiv)",
      url: "https://arxiv.org/pdf/2601.10955",
    },
    {
      label: "AI Agent Cost Optimization in 2026: How to Cut Token Spend by 60% (NiteAgent)",
      url: "https://niteagent.com/blog/ai-agent-cost-optimization-2026/",
    },
    {
      label:
        "The Hidden Economics of AI Agents: Token Costs and Latency Trade-offs (Stevens Online)",
      url: "https://online.stevens.edu/blog/hidden-economics-ai-agents-token-costs-latency/",
    },
    {
      label: "Token & Cost Tracking (Langfuse docs)",
      url: "https://langfuse.com/docs/observability/features/token-and-cost-tracking",
    },
    {
      label: "7 best free and open source LLM observability tools (PostHog)",
      url: "https://posthog.com/blog/best-open-source-llm-observability-tools",
    },
    {
      label: "Langfuse vs Helicone vs Portkey: LLM Observability Compared (BuildMVPFast)",
      url: "https://www.buildmvpfast.com/blog/llm-observability-stack-langfuse-helicone-portkey-2026",
    },
    {
      label:
        "AI Agent Token Budget Management: How Claude Code Prevents Runaway API Costs (MindStudio)",
      url: "https://www.mindstudio.ai/blog/ai-agent-token-budget-management-claude-code",
    },
  ],
};

const memoryManagement: BlogPost = {
  slug: "memory-management-in-agentic-ai",
  title: "Memory Management in Agentic AI: From STM to LTM in Production",
  subtitle:
    "Why your demo agent feels brilliant and your production agent feels like a goldfish — a beginner-to-advanced field guide to short-term and long-term memory, the strategies that actually work, and how to wire them up in CrewAI, LangChain, LangGraph, OpenAI Agents SDK, and Strands.",
  excerpt:
    "Memory is what turns a clever chatbot into an agent that knows you. A practical, institutional-grade walkthrough: the four memory types, the strategies (buffer, window, summary, vector, hybrid), how to test memory in AgentSwarms, and production-ready snippets for CrewAI, LangChain, LangGraph, OpenAI Agents SDK, and Strands.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-02",
  readingTime: "18 min read",
  tags: ["Memory", "Production", "Frameworks"],
  cover: {
    gradient: "from-violet-500/30 via-primary/20 to-fuchsia-500/30",
    icon: "brain",
    motif: "memory",
  },
  blocks: [
    {
      type: "lead",
      text: "A user told your agent, in the very first message, that they live in Bangalore and prefer answers in metric. Twelve turns later they ask about the weather, and the agent confidently quotes Fahrenheit for somewhere in Texas. Nothing crashed. The model is fine. The agent simply forgot — because nobody told it how to remember.",
    },
    {
      type: "paragraph",
      text: "Memory is the unglamorous engineering that separates a chatbot that performs well in a demo from an agent that *feels like it knows you* in production. It is also where most teams quietly under-invest. They pick a framework, ship the default `ConversationBufferMemory`, and discover at scale that 'just keep the whole conversation in the prompt' is neither cheap nor correct.",
    },
    {
      type: "paragraph",
      text: "This guide is the field manual we wish we'd had — beginner-friendly enough to start from zero, deep enough to make real production decisions. We'll define the memory types properly, walk the strategies you'll actually choose between, show how to test memory inside AgentSwarms, and finish with concrete, working snippets for CrewAI, LangChain, LangGraph, OpenAI Agents SDK, and Strands.",
    },
    {
      type: "heading",
      text: "Memory is not one thing",
      id: "memory-types",
    },
    {
      type: "paragraph",
      text: "Cognitive scientists distinguish between *working memory* (what you're holding in mind right now) and *long-term memory* (what you can recall later). Agentic AI inherited this distinction almost verbatim — and then split long-term into three useful sub-types. The reason that matters: each type has a different cost, a different lifetime, and a different mechanism. Treating them as one bucket is how you end up paying gateway prices to remember someone's favorite color.",
    },
    {
      type: "diagram",
      visual: "memory-hierarchy",
      caption:
        "Tap through the four memory types. STM lives in the prompt window. Long-term splits into episodic (what happened), semantic (stable facts), and procedural (learned how-tos). Each costs and behaves differently.",
    },
    {
      type: "list",
      items: [
        "**Short-term (working) memory** — the recent conversation, held inside the model's context window. Free to write, expensive to keep large, vanishes when the session ends.",
        "**Episodic memory** — durable records of *what happened*: past conversations, decisions made, tickets filed. Stored outside the model, recalled on demand.",
        "**Semantic memory** — stable facts: the user's name, their preferences, your company's VAT rate. Small, hot, often injected into the system prompt verbatim.",
        "**Procedural memory** — learned routines and tool-use patterns. Usually expressed as updated system prompts, few-shot examples, or skill libraries that the agent reaches for automatically.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "The line that helps most teams",
      text: "If a fact is true for the rest of this conversation, it's STM. If it's true the next time this user opens the app, it's LTM. Knowing which one you're building decides the storage, the recall, and the bill.",
    },
    {
      type: "heading",
      text: "Why pure short-term memory fails at scale",
      id: "context-decay",
    },
    {
      type: "paragraph",
      text: "The simplest possible memory is to shove the whole transcript back into the prompt every turn. It works beautifully in a demo and falls over in production for two boring reasons: context windows are finite, and tokens cost money. Even a 200K-token window fills surprisingly fast once you add a system prompt, tool definitions, retrieved documents, and a verbose multi-agent dialogue. And every token of history is a token you pay for, every turn.",
    },
    {
      type: "diagram",
      visual: "context-window-decay",
      caption:
        "Drag the slider. Early in the conversation, the model can still see the user's flight number. Past a certain length, naïve sliding-window STM drops it — and the agent has to ask again. Memory is what keeps that fact alive.",
    },
    {
      type: "paragraph",
      text: "There is also a quality problem that papers like *Lost in the Middle* made famous: when the prompt is long, models pay disproportionate attention to the beginning and the end, and quietly under-weight the middle. So even when the relevant fact is technically in the window, longer context can make recall *worse*, not better. The fix is the same in both cases: stop trying to remember everything in the prompt.",
    },
    {
      type: "heading",
      text: "Short-term memory: the four strategies you'll actually choose between",
      id: "stm-strategies",
    },
    {
      type: "paragraph",
      text: "Every framework's STM offerings are variations on the same four ideas. Pick deliberately — the right one depends on conversation length, latency budget, and how much you mind paying for tokens you'll never use again.",
    },
    {
      type: "diagram",
      visual: "stm-strategies",
      caption:
        "Toggle the four strategies. The Hybrid (window + rolling summary) is the production default for a reason — it's cheap, predictable, and degrades gracefully.",
    },
    {
      type: "list",
      items: [
        "**Full buffer** — keep every turn verbatim. Use only for short flows (<10 turns) or evaluation runs where you want zero loss.",
        "**Sliding window** — keep the last N turns, drop older ones. Predictable token cost; risks dropping the one fact the user mentioned on turn 2.",
        "**Rolling summary** — periodically compress older turns into a paragraph. Lossy but durable; pay for one extra LLM call to save many.",
        "**Hybrid (window + summary)** — the default in serious systems. Recent turns verbatim, everything before rolled into a running summary. Cheap, robust, and the model still gets the important details from earlier.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Use a small, cheap model for summaries",
      text: "Your STM summarizer doesn't need GPT-5. A flash-tier model produces perfectly good rolling summaries at a fraction of the cost. AgentSwarms uses `gemini-3-flash-preview` for exactly this — it is the difference between a memory subsystem you'd ship and one you'd quietly disable.",
    },
    {
      type: "heading",
      text: "Long-term memory: extract, store, recall, inject",
      id: "ltm-pipeline",
    },
    {
      type: "paragraph",
      text: "Long-term memory is a small data pipeline glued to the end of every turn. It runs in the background, costs almost nothing per turn, and is what makes the difference between *“an assistant”* and *“my assistant.”*",
    },
    {
      type: "diagram",
      visual: "ltm-recall-flow",
      caption:
        "The five-step loop every production LTM implementation runs. Most platforms — including AgentSwarms — wire this up for you; understanding it is what lets you tune it.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Extract.** After each assistant turn, a small structured-output prompt scans the exchange for durable items — facts, preferences, decisions, instructions — and emits a list. Skip greetings, restatements, and anything that looks like raw PII.",
        "**Store.** Embed each item and write it to a per-user, per-agent table with metadata (kind, score, usage_count, created_at). Keep a hard cap (a few hundred items per agent is plenty).",
        "**Recall.** On the next user prompt, tokenize the query, retrieve top-K relevant items by embedding similarity (or hybrid keyword + vector), and rank by overlap + recency + usage_count.",
        "**Inject.** Prepend a `=== WHAT YOU REMEMBER ABOUT THIS USER ===` block to the system prompt. Keep it short; the model treats it as context, not as an instruction to recite.",
        "**Feedback.** Bump `usage_count` and `last_used_at` on items you actually surfaced. Frequently-useful facts rise; stale ones sink and get pruned.",
      ],
    },
    {
      type: "code",
      language: "typescript",
      code: `// The shape of a production-grade LTM item. Note the metadata — it's what
// makes recall, ranking, decay, and audit possible.
type MemoryItem = {
  id: string;
  user_id: string;       // scope: never leak across users
  agent_id: string;      // scope: an agent only remembers what it learned
  kind: "fact" | "preference" | "episodic" | "instruction";
  content: string;       // "user prefers metric units"
  embedding: number[];   // for semantic recall
  keywords: string[];    // for hybrid recall + fast filter
  score: number;         // human/model assigned importance
  usage_count: number;   // bumped on every recall
  last_used_at: string | null;
  created_at: string;
};`,
    },
    {
      type: "callout",
      tone: "warn",
      title: "Scope memory tightly",
      text: "Memory is per (user, agent). Never share an LTM store across users — that's a privacy incident waiting to happen. Cross-agent sharing is fine only when the agents are part of the same product surface; otherwise namespace by agent id.",
    },
    {
      type: "heading",
      text: "Best practices that separate working memory from broken memory",
      id: "best-practices",
    },
    {
      type: "list",
      items: [
        "**Decide the lifetime first.** STM vs LTM is not a tooling question — it's a product question. *Will this still be true tomorrow?*",
        "**Default to hybrid STM.** Last N turns verbatim + rolling summary. Resist the urge to ship a pure buffer.",
        "**Make extraction picky.** Greetings, acknowledgements, and PII-shaped strings should never reach the store. Use a strict JSON schema and a low temperature.",
        "**Cap and decay.** Hard cap per agent (e.g. 200 items). Prune by `score × recency × usage_count` — old, never-used items should die.",
        "**Hybrid recall beats pure vector.** Combine keyword overlap with embedding similarity; rerank with recency. Pure cosine search loses to user IDs, SKUs, and proper nouns.",
        "**Treat memory as state, not magic.** Version it, snapshot it, let users view and delete it. GDPR's *right to erasure* is not optional.",
        "**Evaluate it.** Maintain a small golden set of recall questions. Gate releases on it like any other regression test.",
        "**Log every injection.** When a memory item lands in the prompt, log which one and why. The first time the agent says something weird, you'll want that trace.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Memory is a privacy contract",
      text: "Anything an agent remembers, the user can ask you to forget. Build the delete-by-user flow on day one, not after the first support ticket. AgentSwarms exposes this in the agent settings; in your own stack, a simple `DELETE FROM memory_items WHERE user_id = $1` cron-friendly endpoint is the minimum.",
    },
    {
      type: "heading",
      text: "Testing memory inside AgentSwarms",
      id: "test-in-agentswarms",
    },
    {
      type: "paragraph",
      text: "The fastest way to build intuition for memory is to watch it work — and watch it fail. AgentSwarms exposes the whole pipeline so you can prod it without writing infrastructure.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Open the Playground** and pick (or create) an agent. In the agent's settings, expand **Memory** — toggle STM strategy (window / summary / hybrid) and enable Long-term memory.",
        "**Have a multi-turn conversation.** Tell the agent two or three things about yourself: a preference, a fact, a small task you want it to remember. Send a few unrelated turns after.",
        "**Watch the trace.** Each request inspector on the right shows the system prompt the model actually saw — including any `[WHAT YOU REMEMBER]` block and the rolling summary. If a fact is there, the model has it. If it isn't, that's your bug.",
        "**Open a fresh conversation.** Ask the agent something that requires one of the earlier facts. Recall should fire, the trace should show the injected item, and the answer should land.",
        "**Try to break it.** Tell the agent contradictory things. Use throwaway facts. Ask after a long delay. The Failure-Mode Labs include a *context-loss* lab specifically for this.",
        "**Wipe and re-run.** Clearing memory from the agent settings should make the next turn forget — a one-click verification that nothing is leaking from a hidden cache.",
      ],
    },
    {
      type: "diagram",
      visual: "memory-eval-gate",
      caption:
        "A tiny golden recall set. Flip 'after memory tuning' to watch Recall@1 jump. Gate your deploys on this, the same way you gate code on tests — silent recall regressions are how memory subsystems quietly rot.",
    },
    {
      type: "heading",
      text: "Production patterns by framework",
      id: "framework-patterns",
    },
    {
      type: "paragraph",
      text: "Every serious agent framework now ships memory primitives — but they make very different defaults. Tap through them; the one-line summary under each is what you'd tell a teammate in code review.",
    },
    {
      type: "diagram",
      visual: "framework-memory-matrix",
      caption:
        "Memory model by framework. LangGraph's Store + checkpointer split is the most production-ready out of the box; CrewAI's defaults get you running fastest; LangChain gives you the most levers; OpenAI Agents SDK and Strands lean on you to wire the LTM yourself.",
    },
    {
      type: "subheading",
      text: "LangChain — explicit, composable, batteries-mostly-included",
    },
    {
      type: "paragraph",
      text: "LangChain's modern memory story lives in the LangGraph integration; the classic memory classes (`ConversationBufferMemory`, `ConversationSummaryMemory`, `ConversationBufferWindowMemory`, `VectorStoreRetrieverMemory`) still work and remain a clear way to learn the moving parts.",
    },
    {
      type: "code",
      language: "python",
      code: `# Hybrid STM (window + summary) with vector-backed LTM in classic LangChain.
from langchain.memory import (
    ConversationSummaryBufferMemory,
    VectorStoreRetrieverMemory,
)
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_community.vectorstores import Chroma

llm = ChatOpenAI(model="gpt-5-mini", temperature=0)

# STM: keep recent turns verbatim, summarize older ones above a token budget.
stm = ConversationSummaryBufferMemory(
    llm=llm,
    max_token_limit=1500,
    memory_key="chat_history",
    return_messages=True,
)

# LTM: per-user vector store of durable facts.
store = Chroma(
    collection_name=f"ltm_user_{user_id}",
    embedding_function=OpenAIEmbeddings(),
)
ltm = VectorStoreRetrieverMemory(
    retriever=store.as_retriever(search_kwargs={"k": 5}),
    memory_key="long_term_memory",
)

# Use both: inject \`{chat_history}\` and \`{long_term_memory}\` into your prompt.`,
    },
    {
      type: "subheading",
      text: "LangGraph — first-class persistent memory",
    },
    {
      type: "paragraph",
      text: "LangGraph splits memory cleanly: a **checkpointer** persists per-thread state (your STM) and a **Store** persists cross-thread, namespaced facts (your LTM). This is the architecture closest to what you'd build yourself for production.",
    },
    {
      type: "code",
      language: "python",
      code: `from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.postgres import PostgresStore
from langgraph.prebuilt import create_react_agent

# Checkpointer = STM (thread-scoped conversation state).
checkpointer = PostgresSaver.from_conn_string(POSTGRES_URL)
# Store = LTM (cross-thread, namespaced by user).
store = PostgresStore.from_conn_string(POSTGRES_URL)

agent = create_react_agent(
    "openai:gpt-5-mini",
    tools=[...],
    checkpointer=checkpointer,
    store=store,
)

# Namespacing is how you scope memory:
namespace = ("user", user_id, "preferences")
store.put(namespace, "units", {"value": "metric"})

# In a tool the agent can call to recall:
hits = store.search(namespace, query="what units does the user prefer", limit=3)`,
    },
    {
      type: "subheading",
      text: "CrewAI — memory on by default",
    },
    {
      type: "paragraph",
      text: "CrewAI's pragmatic choice is to enable memory and give you knobs. A crew with `memory=True` automatically uses short-term memory for the current run plus long-term memory across runs, with an entity store for proper nouns.",
    },
    {
      type: "code",
      language: "python",
      code: `from crewai import Crew, Agent, Task
from crewai.memory.storage.rag_storage import RAGStorage

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    memory=True,  # turns on STM + LTM + entity memory
    memory_config={
        "provider": "openai",
        "config": {"model": "text-embedding-3-small"},
        "user_memory": {"user_id": user_id},  # scope LTM per user
    },
    embedder={"provider": "openai", "config": {"model": "text-embedding-3-small"}},
)

# Inspect / reset between runs:
crew.reset_memories(command_type="short")  # or "long", "entity", "all"`,
    },
    {
      type: "subheading",
      text: "OpenAI Agents SDK — sessions for STM, BYO for LTM",
    },
    {
      type: "code",
      language: "python",
      code: `from agents import Agent, Runner, SQLiteSession

agent = Agent(name="Assistant", instructions="...")

# Sessions = STM. Same session_id ⇒ same conversation across calls.
session = SQLiteSession(session_id=f"user_{user_id}", db_path="sessions.db")

await Runner.run(agent, "I prefer metric.", session=session)
await Runner.run(agent, "What units do I prefer?", session=session)
# Returns "metric" — the SDK rehydrated the conversation from the session.

# LTM is on you: wire a vector store and inject recalled facts into
# \`instructions\` before each Runner.run().`,
    },
    {
      type: "subheading",
      text: "Strands — conversation managers + memory tools",
    },
    {
      type: "code",
      language: "python",
      code: `from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager
from strands_tools import memory  # built-in long-term memory tool

agent = Agent(
    model="bedrock/anthropic.claude-3.5-sonnet",
    # STM: keep last N turns, summarize older ones.
    conversation_manager=SummarizingConversationManager(
        summary_ratio=0.3,
        preserve_recent_messages=10,
    ),
    # LTM: tool-call into a vector backend.
    tools=[memory],
    system_prompt="Use the memory tool to recall facts about the user.",
)

agent("I live in Bangalore and prefer metric units.")
# → agent calls memory.store(...) on its own.
agent("What's the weather where I live?")
# → agent calls memory.retrieve(...) and answers in metric.`,
    },
    {
      type: "heading",
      text: "A production checklist",
      id: "production-checklist",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "STM strategy chosen deliberately (default: window + rolling summary).",
        "LTM extraction prompt is picky and rejects PII-shaped strings.",
        "Every memory item carries `user_id`, `agent_id`, `kind`, `score`, `usage_count`, timestamps.",
        "Hard cap per (user, agent); pruning runs on a schedule.",
        "Hybrid recall (keyword overlap + embedding similarity + recency).",
        "System prompt injection is logged per turn — you can replay what the model saw.",
        "Golden recall set runs on every deploy; regressions block the release.",
        "User-facing memory viewer + one-click wipe; delete-by-user endpoint exists.",
        "Token costs for STM summarization and LTM extraction are tracked separately in your observability.",
        "Failure-mode lab in your dev loop: an agent with memory disabled is a useful baseline.",
      ],
    },
    {
      type: "heading",
      text: "The takeaway",
      id: "takeaway",
    },
    {
      type: "paragraph",
      text: "Memory is what makes an agent feel less like a tool and more like a colleague — and it is one of the highest-leverage subsystems you will build. The mechanics are not exotic: a small pipeline, a hybrid recall step, a strict scope, and an honest eval. Pick the right type, ship the right strategy, gate it on a golden set, and treat what the agent remembers with the same seriousness you treat anything else you store about a user.",
    },
    {
      type: "paragraph",
      text: "Open the Playground, turn memory on, and have a real conversation with your agent. The first time it answers a question by remembering something you said three days ago, you'll understand why this is the work worth doing.",
    },
  ],
  references: [
    {
      label: "Lost in the Middle: How Language Models Use Long Contexts — Liu et al.",
      url: "https://arxiv.org/abs/2307.03172",
    },
    {
      label: "LangGraph: Memory (Checkpointers & Store)",
      url: "https://langchain-ai.github.io/langgraph/concepts/memory/",
    },
    {
      label: "LangChain Memory (classic)",
      url: "https://python.langchain.com/docs/versions/migrating_memory/",
    },
    {
      label: "CrewAI — Memory",
      url: "https://docs.crewai.com/concepts/memory",
    },
    {
      label: "OpenAI Agents SDK — Sessions",
      url: "https://openai.github.io/openai-agents-python/sessions/",
    },
    {
      label: "Strands Agents — Conversation Managers & Memory Tool",
      url: "https://strandsagents.com/latest/user-guide/concepts/agents/conversation-management/",
    },
    {
      label: "Anthropic — Contextual Retrieval",
      url: "https://www.anthropic.com/news/contextual-retrieval",
    },
  ],
};

const pydanticAgentic: BlogPost = {
  slug: "pydantic-the-contract-layer-of-agentic-ai",
  title: "Pydantic: The Contract Layer Your Agents Are Missing",
  subtitle:
    "Language models emit text. Your program wants objects it can trust. Pydantic is the validating border between the two — and once you've felt the difference, you stop letting an agent touch a tool without it. A walk from your first BaseModel to self-healing, type-safe agents.",
  excerpt:
    "LLMs generate plausible text, not reliable data. Pydantic turns that text into typed, validated objects — and that single change quietly removes a whole class of agent bugs. We go from type hints to structured outputs, self-correcting validators, discriminated-union routing, and PydanticAI — then weigh the honest alternatives (msgspec, attrs, Zod, provider-native JSON).",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-02",
  readingTime: "18 min read",
  tags: ["Structured Outputs", "Frameworks", "Python"],
  cover: {
    gradient: "from-cyan-500/30 via-primary/20 to-emerald-500/25",
    icon: "clipboard",
    motif: "schema",
  },
  blocks: [
    {
      type: "lead",
      text: 'The bug took three of us most of a morning. An invoicing agent had been quietly approving the wrong amounts for two days, and the trace looked fine — the model had clearly *said* the number. The problem was buried 40 lines downstream: the model had returned the total as the string `"1,250.00"`, our code had happily concatenated it, and `"1,250.00" + "49.00"` is not a number you want on an invoice. Nothing threw. The types were a lie we\'d agreed to believe.',
    },
    {
      type: "paragraph",
      text: "We fixed it in the most boring way possible: we made that LLM call return a **Pydantic model** instead of a dict. The amount became a `Decimal` field, the comma-string was rejected at the boundary, and the bug — along with a dozen of its cousins we hadn't found yet — simply stopped being possible. This post is about why that small move is one of the highest-leverage things you can do when building agents, and how far it scales: from your first model to agents that fix their own mistakes.",
    },
    {
      type: "callout",
      tone: "info",
      title: "If you remember one sentence",
      text: "An LLM doesn't return data — it returns text that looks like data. Pydantic is what turns that text into something your program is allowed to trust, and it does it loudly, at the boundary, instead of silently three functions later.",
    },
    {
      type: "heading",
      text: "The boundary problem",
      id: "boundary-problem",
    },
    {
      type: "paragraph",
      text: 'Every agent has the same seam running through it: on one side is a language model producing tokens; on the other is ordinary code that expects integers, dates, enums, and well-formed objects. The model is *astonishingly* good at producing things that look right and *occasionally, unpredictably* wrong in ways that matter. It will give you `"three"` where you wanted `3`, `"yes"` where you wanted `true`, a `kelvin` it invented for a units field, or valid JSON wrapped in an apologetic paragraph.',
    },
    {
      type: "paragraph",
      text: "The naive approach — `json.loads()` the reply and reach into the dict — works in the demo and rots in production. It pushes the failure as far as possible from its cause: the data is wrong *now*, but you find out later, somewhere else, in a stack trace that points at the wrong line.",
    },
    {
      type: "diagram",
      visual: "pyd-text-to-typed",
      caption:
        "The same messy model output, two ways. Toggle between hand-parsing it (and hoping) and validating it with Pydantic — which fails loudly at the boundary, before anything downstream runs on bad data.",
    },
    {
      type: "heading",
      text: "Start here: what Pydantic actually is",
      id: "what-it-is",
    },
    {
      type: "paragraph",
      text: "Strip away the agent context and Pydantic is a simple idea: **declare the shape of your data with Python type hints, and have those hints enforced at runtime.** You write a class; Pydantic validates, coerces, and gives you a real typed object back — or a precise error explaining what was wrong.",
    },
    {
      type: "code",
      language: "python",
      code: `from typing import Literal
from pydantic import BaseModel, Field, ValidationError

class WeatherQuery(BaseModel):
    city: str
    units: Literal["c", "f"] = "c"
    days: int = Field(ge=1, le=7)        # 1 to 7, enforced
    alerts: bool = False

# The string an LLM might emit:
raw = '{"city": "Paris", "units": "c", "days": 3, "alerts": "yes"}'

q = WeatherQuery.model_validate_json(raw)
# q.days is the int 3; q.alerts is coerced to the bool True
print(q.city, q.days, q.alerts)   # Paris 3 True

# And when the model misbehaves:
try:
    WeatherQuery.model_validate_json('{"city": "Paris", "days": 14}')
except ValidationError as e:
    print(e)   # days: Input should be less than or equal to 7`,
    },
    {
      type: "paragraph",
      text: 'That\'s the whole beginner story. Each annotation is a *contract*: `days` isn\'t documented as an int, it\'s **required** to be one (between 1 and 7), and `units` literally cannot be anything but `"c"` or `"f"`. The type hint stops being a comment and becomes an enforced gate.',
    },
    {
      type: "diagram",
      visual: "pyd-anatomy",
      caption:
        "Anatomy of a model. Click each field to see exactly what its type and constraints reject — and the readable error you get back. This is the contract the model has to satisfy.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Use Pydantic v2 — and know why",
      text: "Pydantic v2 rewrote the validation core in Rust (pydantic-core), making it roughly 5–50× faster than v1 depending on the workload. The API moved too: it's `model_validate`, `model_validate_json`, and `model_json_schema` now (the v1 `parse_obj` / `.json()` names are deprecated). If a tutorial uses the old names, it's pre-2023.",
    },
    {
      type: "heading",
      text: "From parsing to contracts: structured outputs",
      id: "structured-outputs",
    },
    {
      type: "paragraph",
      text: "Here's where it gets interesting for agents. A Pydantic model isn't just a validator you run *after* the model replies — it can shape what the model is *allowed* to reply in the first place. Every modern LLM API accepts a JSON Schema (as a tool definition or a `response_format`) and will constrain its generation to match. And Pydantic emits that schema for you.",
    },
    {
      type: "code",
      language: "python",
      code: `print(WeatherQuery.model_json_schema())
# {
#   "properties": {
#     "city":   {"type": "string"},
#     "units":  {"enum": ["c", "f"], "default": "c"},
#     "days":   {"type": "integer", "minimum": 1, "maximum": 7},
#     "alerts": {"type": "boolean", "default": false}
#   },
#   "required": ["city", "days"], ...
# }`,
    },
    {
      type: "paragraph",
      text: "So a single class definition does triple duty: it documents the shape, it tells the LLM how to answer, and it validates the answer when it comes back. You never hand-write the JSON Schema, and you never hand-write the parser. That elimination of two error-prone, hand-maintained artifacts is a bigger deal than it sounds.",
    },
    {
      type: "diagram",
      visual: "pyd-schema-bridge",
      caption:
        "One model, three jobs. Step through how a Pydantic class becomes the JSON Schema that constrains the LLM, then validates the reply back into a typed object. Define once, enforce everywhere.",
    },
    {
      type: "subheading",
      text: "The Instructor pattern",
    },
    {
      type: "paragraph",
      text: "You can wire this up by hand, but the library most teams reach for is **Instructor**. It patches your LLM client so that you pass a `response_model` and get a validated Pydantic instance straight back — schema generation, the API call, parsing, and validation all handled.",
    },
    {
      type: "code",
      language: "python",
      code: `import instructor
from pydantic import BaseModel

class Review(BaseModel):
    sentiment: Literal["positive", "negative", "neutral"]
    rating: int = Field(ge=1, le=10)
    summary: str

client = instructor.from_provider("openai/gpt-4o-mini")

review = client.chat.completions.create(
    response_model=Review,            # <- a Pydantic model, not a string
    messages=[{"role": "user", "content": "Summarise this review: ..."}],
)
# 'review' is a fully validated Review instance. review.rating is guaranteed 1–10.`,
    },
    {
      type: "heading",
      text: "Validators turn a parser into a guardrail",
      id: "validators",
    },
    {
      type: "paragraph",
      text: "Types catch *shape* errors. But a lot of what you actually care about is *semantic*: a discount that can't exceed the price, an end date after a start date, a SKU that has to exist in your catalogue. Pydantic lets you attach custom checks with `@field_validator` (one field) and `@model_validator` (the whole object, after the fields are parsed).",
    },
    {
      type: "code",
      language: "python",
      code: `from pydantic import BaseModel, field_validator, model_validator

class Booking(BaseModel):
    nights: int
    price_per_night: float
    discount: float = 0.0

    @field_validator("discount")
    @classmethod
    def discount_in_range(cls, v: float) -> float:
        if not 0 <= v <= 1:
            raise ValueError("discount must be a fraction between 0 and 1")
        return v

    @model_validator(mode="after")
    def discount_not_above_total(self):
        if self.discount * self.nights * self.price_per_night > 1000:
            raise ValueError("discount exceeds the policy cap of $1000")
        return self`,
    },
    {
      type: "callout",
      tone: "info",
      title: "Good LLM validation is just good validation",
      text: "There's nothing LLM-specific about a validator that says 'a refund can't exceed the order total.' It's the same business rule you'd enforce on a web form. The shift in mindset is treating the model's output as untrusted user input — because that's exactly what it is.",
    },
    {
      type: "heading",
      text: "The advanced move: self-healing agents",
      id: "self-healing",
    },
    {
      type: "paragraph",
      text: "Now combine the two ideas — structured outputs and validators — and something genuinely powerful falls out. When validation fails, you don't have to crash. You have a precise, human-readable description of *what was wrong*. Feed that error straight back to the model as the next prompt, and it will usually fix its own mistake.",
    },
    {
      type: "paragraph",
      text: "This is the heart of Instructor's `max_retries`: a failed `ValidationError` becomes a corrective message, the model tries again with the feedback, and you only see the result once it passes. Your validators effectively become the agent's quality bar — and the agent climbs to meet it.",
    },
    {
      type: "diagram",
      visual: "pyd-self-heal",
      caption:
        "The self-correction loop. Toggle retries on and off: with a retry budget, a ValidationError isn't fatal — it's fed back as the next prompt, and the model reads its own mistake and fixes it.",
    },
    {
      type: "code",
      language: "python",
      code: `from pydantic import field_validator

class Answer(BaseModel):
    rating: int = Field(ge=1, le=10)
    summary: str

    @field_validator("summary")
    @classmethod
    def must_be_grounded(cls, v: str) -> str:
        if len(v) < 20:
            # This message is shown to the model on retry — write it FOR the model.
            raise ValueError("summary too short; cite at least one concrete detail")
        return v

answer = client.chat.completions.create(
    response_model=Answer,
    max_retries=2,        # on failure, re-ask with the validation error appended
    messages=[...],
)`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "Write error messages for the model, not just the log",
      text: "Once a validator's error can become a prompt, its wording matters. 'Invalid input' helps no one. 'rating must be an integer from 1 to 10; you returned 11' tells the model exactly how to correct itself on the next pass. Your error strings are now part of your prompt engineering.",
    },
    {
      type: "heading",
      text: "Routing with discriminated unions",
      id: "discriminated-unions",
    },
    {
      type: "paragraph",
      text: "Agents constantly have to choose *which* of several things to do — search, send an email, issue a refund — each with completely different arguments. The fragile way is a free-form `action` string plus a bag of optional fields, validated by hand. The robust way is a **discriminated union**: a set of typed models tagged by a literal field, and Pydantic routes the model's output to exactly the right one.",
    },
    {
      type: "code",
      language: "python",
      code: `from typing import Literal, Union
from pydantic import BaseModel, Field
from decimal import Decimal

class SearchAction(BaseModel):
    action: Literal["search"]
    query: str
    top_k: int = 5

class RefundAction(BaseModel):
    action: Literal["refund"]
    order_id: str
    amount: Decimal

class AgentStep(BaseModel):
    # The 'action' field discriminates which payload this must be.
    step: Union[SearchAction, RefundAction] = Field(discriminator="action")

# A refund with amount="a lot" can never parse into RefundAction —
# the malformed tool call is impossible by construction.`,
    },
    {
      type: "paragraph",
      text: "This is more than tidy code. It means a malformed tool call — the right action name with the wrong arguments — *cannot* reach your execution layer, because it never validates into the corresponding model. The agent's intent and its arguments are checked together, as a unit.",
    },
    {
      type: "diagram",
      visual: "pyd-router",
      caption:
        "A tagged union as a type-safe router. Pick the action the model chose and watch Pydantic validate it against exactly one payload shape — and reject a refund whose amount isn't a real number.",
    },
    {
      type: "heading",
      text: "Where Pydantic sits in a whole agent",
      id: "where-it-sits",
    },
    {
      type: "paragraph",
      text: "Once you start seeing the model's output as untrusted input, you notice the same boundary repeating all over an agent. It's not one feature — it's a posture you apply everywhere untyped data tries to get in.",
    },
    {
      type: "diagram",
      visual: "pyd-agent-stack",
      caption:
        "The boundaries Pydantic guards in a real agent. Click each one — the tool-argument edge is the highest-value place to start, because that's where a hallucinated call turns into a real-world side effect.",
    },
    {
      type: "list",
      items: [
        "**Tool arguments** — validate the model's proposed call *before* any API or database is touched. This single guard prevents the largest category of agent damage.",
        "**Tool results** — parse third-party responses into models so an upstream schema change fails fast instead of silently corrupting state.",
        "**Final output** — hand downstream systems a validated object, not a hopeful string.",
        "**State & memory** — typed scratchpads and plans, so a corrupt step can't quietly poison the next.",
      ],
    },
    {
      type: "heading",
      text: "PydanticAI: when the model becomes the type",
      id: "pydantic-ai",
    },
    {
      type: "paragraph",
      text: "In late 2024 the Pydantic team shipped **PydanticAI**, an agent framework built on exactly this philosophy — they describe the goal as bringing 'the FastAPI feeling' to GenAI. It reached v1.0 in September 2025 and has iterated hard since. The pitch: an agent whose inputs, outputs, tools, and dependencies are all validated by Pydantic models, with errors surfaced at development time rather than in production.",
    },
    {
      type: "code",
      language: "python",
      code: `from dataclasses import dataclass
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext

@dataclass
class Deps:                       # typed dependencies, injected — testable & swappable
    customer_id: str
    db: "Database"

class SupportReply(BaseModel):    # the agent's validated output type
    answer: str
    escalate: bool
    refund_amount: float = 0.0

agent = Agent(
    "openai:gpt-4o",
    deps_type=Deps,
    output_type=SupportReply,     # the run is guaranteed to end as a SupportReply
    system_prompt="You are a support agent. Be precise and cite balances.",
)

@agent.tool
async def get_balance(ctx: RunContext[Deps]) -> float:
    return await ctx.deps.db.balance(ctx.deps.customer_id)

result = agent.run_sync("Can I get a refund?", deps=Deps("c-42", db))
print(result.output.refund_amount)   # a float — validated, typed, safe`,
    },
    {
      type: "paragraph",
      text: "Notice what the types buy you. `output_type=SupportReply` means the *entire run* is guaranteed to terminate as a validated `SupportReply` — if the model returns something malformed, PydanticAI retries or raises a typed exception. `deps_type=Deps` means your tools receive typed dependencies you can swap for fakes in a test, no monkey-patching required. The framework is, essentially, this whole blog post turned into a product.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Observability comes along for the ride",
      text: "Because everything is typed and structured, PydanticAI integrates cleanly with Logfire (also from the Pydantic team) for tracing — you can watch each validated step, retry, and tool call. Structured data in, structured traces out. That's not a coincidence; it's the payoff of typing the boundaries.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Streaming + validation aren't mutually exclusive",
      text: "Pydantic can validate partial objects as they stream, so you get the responsiveness of token-by-token output and the safety of a typed result. You don't have to choose between a fast UI and a validated one.",
    },
    {
      type: "heading",
      text: "The honest costs and gotchas",
      id: "costs",
    },
    {
      type: "paragraph",
      text: "This isn't a free lunch, and pretending otherwise does you a disservice. A few things to keep in your peripheral vision:",
    },
    {
      type: "list",
      items: [
        "**Validation has a cost.** It's fast, but it's not free — in a hot loop over millions of objects, Pydantic's flexibility shows up on the profile. For pure high-throughput (de)serialization without rich validation, a leaner tool can win (more on that next).",
        "**Over-strict schemas can hurt the model.** A schema with 40 required fields, deep nesting, and exotic constraints can confuse the LLM into worse outputs or constant retries. Keep schemas as flat and as forgiving as correctness allows; validate hard only where it matters.",
        '**Coercion can surprise you.** Pydantic will helpfully turn `"3"` into `3` and `"yes"`-ish values into booleans. Usually a feature; occasionally a foot-gun. Reach for strict mode when you want a string to *stay* a string.',
        "**Retries cost tokens.** Self-healing is wonderful until a pathological input loops to your `max_retries` ceiling on every request. Cap retries, and log how often you're hitting the ceiling — it's a quality signal.",
      ],
    },
    {
      type: "heading",
      text: "So is there an alternative to Pydantic?",
      id: "alternatives",
    },
    {
      type: "paragraph",
      text: "Yes — several, and a couple are genuinely better for specific jobs. The point isn't that Pydantic is the only tool; it's that it's the right *default*, and knowing when to deviate is the mark of someone who actually understands the trade-off.",
    },
    {
      type: "diagram",
      visual: "pyd-alternatives",
      caption:
        "The realistic landscape. Pick a library to see where it's strong and where it isn't. Directional scores, honest verdicts — there's a right answer for each situation, and it isn't always Pydantic.",
    },
    {
      type: "list",
      items: [
        "**msgspec** — 2–5× faster than Pydantic v2 for (de)serialization, built on rigid typed Structs. The pick when raw speed in a high-throughput service is your bottleneck. The trade: thinner validation, fewer conveniences, smaller ecosystem.",
        "**dataclasses / TypedDict** — standard library, zero dependencies, and *no runtime validation*. Your IDE checks the hints; the running program does not. Fine for trusted internal data, dangerous as a guard against what an LLM hands you.",
        "**attrs + cattrs** — mature, fast, flexible class-building with separate structuring. Less batteries-included for the JSON-Schema-for-LLMs workflow; you wire more of the glue yourself.",
        "**marshmallow** — battle-tested serialization/validation from the web-API era. Verbose (schema as a separate class) and predates the structured-output pattern, but solid where it already lives.",
        "**Zod** — if your agent is in **TypeScript**, this is the answer, not a compromise. Schema-first, superb type inference, and first-class support in the JS LLM SDKs. It's the Pydantic of that world.",
        "**Provider-native structured outputs** — OpenAI and Anthropic can constrain generation to a JSON Schema directly. Powerful and worth using — but you still need something to *define* the schema and validate edge cases after the fact. In Python, that something is almost always Pydantic.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "The verdict",
      text: "Use Pydantic v2 by default for Python agents — the ecosystem assumes it and the ergonomics are unmatched. Drop to msgspec when a profiler tells you to. Use Zod if you're in TypeScript. And lean on provider-native outputs as a complement, not a replacement — they constrain the model, but Pydantic still defines and verifies the contract.",
    },
    {
      type: "heading",
      text: "A practical playbook",
      id: "playbook",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Make every LLM call that feeds code return a Pydantic model, not a string or a bare dict. This one habit removes the most bugs.",
        "Let the model generate your JSON Schema (`model_json_schema()`); never hand-maintain it.",
        "Validate tool arguments before execution — it's the highest-value boundary in the whole agent.",
        "Encode business rules as validators, and write their error messages *for the model*, because they become retry prompts.",
        "Give the agent a small retry budget so validation errors self-heal — then log how often you hit the ceiling.",
        "Use discriminated unions for action/tool selection so malformed calls can't parse.",
        "Keep schemas flat and forgiving; validate hard only where correctness genuinely matters.",
        "Reach for msgspec or provider-native outputs only when a real constraint (speed, platform) tells you to.",
      ],
    },
    {
      type: "heading",
      text: "Where this lands in AgentSwarms",
      id: "agentswarms",
    },
    {
      type: "paragraph",
      text: "This thinking is baked into the platform. The **LLM Tool-Calling JSON Schema Generator** turns a function description into a valid schema (the same artifact Pydantic would emit), so the tool-argument boundary is typed from the start. And when you export a swarm or an agent to LangGraph, CrewAI, the OpenAI Agents SDK, or Strands, the generated code uses typed, validated tool signatures rather than free-form dictionaries — the structured-output discipline travels with your design.",
    },
    {
      type: "callout",
      tone: "info",
      title: "A note on scope",
      text: "AgentSwarms is a learning and prototyping platform, not a production runtime. The aim here isn't to sell you a validator — it's to give you the mental model so that whatever you ship treats the model's output as what it is: untrusted text, one validation away from being something you can trust.",
    },
    {
      type: "paragraph",
      text: "Language models will keep getting better at sounding right. They will not stop occasionally being wrong in ways that matter — that's the nature of the thing. The teams that build agents you can rely on aren't the ones with the cleverest prompts; they're the ones who put a validating border at every seam and refused to let an unverified string become an action. Pydantic is the cheapest, most boring, most effective way to draw that border. Draw it early.",
    },
  ],
  references: [
    { label: "Pydantic AI — documentation", url: "https://ai.pydantic.dev/" },
    { label: "PydanticAI on GitHub", url: "https://github.com/pydantic/pydantic-ai" },
    {
      label: "How to Use Pydantic for LLMs: Schema, Validation & Prompts — Pydantic",
      url: "https://pydantic.dev/articles/llm-intro",
    },
    {
      label: "Instructor — structured outputs, validation & retries",
      url: "https://python.useinstructor.com/",
    },
    {
      label: "Good LLM Validation Is Just Good Validation — Instructor",
      url: "https://python.useinstructor.com/blog/2023/10/23/good-llm-validation-is-just-good-validation/",
    },
    {
      label:
        "The Complete Guide to Using Pydantic for Validating LLM Outputs — MachineLearningMastery",
      url: "https://machinelearningmastery.com/the-complete-guide-to-using-pydantic-for-validating-llm-outputs/",
    },
    {
      label: "Benchmarks: msgspec vs Pydantic v2 — msgspec docs",
      url: "https://jcristharif.com/msgspec/benchmarks.html",
    },
  ],
};

const hermesSelfImproving: BlogPost = {
  slug: "hermes-self-improving-agents-memory-skills-subagents",
  title: "The Agent That Remembers: Inside Hermes and Self-Improving Agents",
  subtitle:
    "Most agents wake up with amnesia every session and a system prompt frozen at write-time. Hermes — Nous Research's open-source, self-improving agent — does the opposite: it carries memory across sessions, turns its own successful runs into portable skills, and fans work out to sandboxed sub-agents. Here's how each piece actually works, and whether it's ready for your stack.",
  excerpt:
    "A static system prompt is a ceiling; a stateless agent is Groundhog Day. Hermes breaks both. We unpack its evolving cross-session memory (and how it persists without blowing up the context window), the agentskills.io standard that turns winning trajectories into searchable, portable markdown tools, and its parallel sandboxed sub-agents — plus an honest enterprise-feasibility scorecard.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-03",
  readingTime: "17 min read",
  tags: ["Multi-Agent", "Memory", "Frameworks"],
  cover: {
    gradient: "from-amber-500/30 via-primary/20 to-violet-500/25",
    icon: "brain",
    motif: "hermes",
  },
  blocks: [
    {
      type: "lead",
      text: "Watch someone use a coding assistant for a week and you'll notice a quiet tax. Every morning they re-explain the same things: this is the stack, this is the convention, no, *don't* be verbose, here's the project we discussed yesterday. The model is brilliant and amnesiac — it solves the problem in front of it and then forgets you exist. Tomorrow you start over. The thing that should be getting better at working with you simply *can't*, because nothing it learns survives the session.",
    },
    {
      type: "paragraph",
      text: "That's the gap **Hermes** is built to close. Released open-source by Nous Research in early 2026 — and improbably popular, north of 50,000 GitHub stars within weeks — it's an agent designed around a single thesis: an agent should *accumulate*. It should remember across sessions, turn the things that worked into reusable skills, and parallelize hard work across sandboxed helpers. This post is a tour of how it does each of those, with an honest read on where it's genuinely useful and where you should keep your guard up.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Self-improving, concretely",
      text: "Strip away the marketing and a 'self-improving agent' is one with a loop: it observes what happened, notices a pattern worth keeping, writes that pattern down where its future self will find it, and is faster next time. Hermes is interesting because it makes all three steps — observe, persist, retrieve — first-class and automatic.",
    },
    {
      type: "heading",
      text: "The two ceilings: static prompts and stateless sessions",
      id: "the-ceilings",
    },
    {
      type: "paragraph",
      text: "Two design choices quietly cap what most agents can become. The first is the **static system prompt**: a block of instructions frozen the moment you wrote it. It can't notice that you always want TypeScript over JavaScript, or that last week's deploy needed a specific incantation. The second is the **stateless session**: when the conversation ends, the agent's working knowledge evaporates. Together they guarantee a cold start, forever.",
    },
    {
      type: "diagram",
      visual: "hrm-static-vs-evolving",
      caption:
        "The same three sessions, two ways. Toggle between a static-prompt agent (a stranger every time) and one with evolving memory (it picks up where you left off). The difference compounds across a week.",
    },
    {
      type: "heading",
      text: "Angle 1 — Evolving memory vs static system prompts",
      id: "evolving-memory",
    },
    {
      type: "paragraph",
      text: "The obvious objection to 'just remember everything' is that you can't. Context windows are finite and expensive; dumping every past transcript into the prompt is both impossible past a point and ruinous before it. Hermes' answer is that memory isn't one thing — it's a small **stack of layers**, each with a different job and a different loading strategy.",
    },
    {
      type: "diagram",
      visual: "hrm-memory-layers",
      caption:
        "Hermes' four memory layers. Click each one — the trick is that only the tiny top layer is always in context; everything else is fetched on demand, so the window stays lean.",
    },
    {
      type: "list",
      items: [
        "**Prompt memory** (`MEMORY.md` + `USER.md`) — a tiny, always-loaded brief capped at roughly 3,575 characters across both files. The cap is the point: it forces the agent to keep only what's genuinely durable, like a sticky note rather than a diary.",
        "**Session archive** (SQLite + FTS5) — every session is written to a local database and full-text indexed. Rather than re-reading old chats, the agent *searches* them in about 10ms and pulls back only what's relevant.",
        "**Skills** (`~/.hermes/skills/`) — procedural memory as markdown files (more on these next).",
        "**User model** (Honcho, optional) — a passive, opt-in model of your preferences and style built up over time.",
      ],
    },
    {
      type: "subheading",
      text: "Who decides what's worth keeping? The agent does.",
    },
    {
      type: "paragraph",
      text: "The clever bit is *curation*. At intervals during a session, Hermes fires a **periodic nudge** — an internal, system-level prompt that asks the agent to look back at what just happened and decide whether anything is worth persisting. Memory isn't a transcript dump; it's an editorial act the agent performs on itself. When a conversation grows long, a separate sentinel triggers compression: an auxiliary model extracts the keep-worthy facts into that tight character budget and summarizes the middle, while a lineage chain in SQLite preserves traceability.",
    },
    {
      type: "code",
      language: "markdown",
      code: `# MEMORY.md  (always loaded · ~3,575 char budget shared with USER.md)

## Project: agentswarms
- Stack: TanStack Start + Supabase; deploys via Lovable git push.
- Conventions: run prettier + tsc before pushing; never commit routeTree.gen.ts.

## Decisions
- 2026-06-01: chose Strands SDK export over a custom runtime.

## Preferences
- Terse answers. Show the diff, skip the preamble.`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "The real innovation is restraint",
      text: "It would be easy to build an agent that hoards everything. The hard, useful thing is an agent that keeps almost nothing in always-on context and gets very good at fetching the rest. The character cap isn't a limitation to route around — it's the mechanism that keeps the agent's 'working memory' sharp.",
    },
    {
      type: "subheading",
      text: "Persistence without a bloated context window",
    },
    {
      type: "paragraph",
      text: "This is the question that matters for anyone who's watched their token bill climb: *how do you remember a month of work without paying for a month of tokens on every call?* Hermes' answer is three mechanisms working together — **search instead of load** (FTS5 over the archive), **summarize before inject** (an LLM condenses a hit before it enters context), and **progressive disclosure** for skills (only short summaries load until one is actually needed). The result is a context footprint that stays nearly flat as your history grows.",
    },
    {
      type: "diagram",
      visual: "hrm-context-budget",
      caption:
        "Add more history with the +/− control. The naive 'load everything' approach grows linearly and eventually overflows the window; Hermes stays nearly flat by searching, summarizing, and loading skills only on demand.",
    },
    {
      type: "heading",
      text: "Angle 2 — The agentskills.io standard",
      id: "agentskills",
    },
    {
      type: "paragraph",
      text: "Remembering *facts* is half the story. The bigger lever is remembering *how to do things*. When Hermes works through a gnarly task — scrape this site, reshape the data, recover from that rate-limit — the sequence of steps that finally worked is valuable. Most agents discard it. Hermes captures it as a **skill**.",
    },
    {
      type: "paragraph",
      text: "Skills follow **agentskills.io**, an open standard for packaging agent capabilities that Anthropic published in late 2025 and that's since been adopted across 20+ platforms. A skill is just a folder with a `SKILL.md` file: YAML frontmatter that says *what this is and when to use it*, followed by a markdown playbook that says *what to actually do*. Optionally it carries `scripts/`, `references/`, and `assets/` alongside.",
    },
    {
      type: "diagram",
      visual: "hrm-skill-capture",
      caption:
        "From trajectory to tool. Step through how a successful multi-step run gets distilled into a portable SKILL.md — the final step shows the actual file shape.",
    },
    {
      type: "paragraph",
      text: "Capture isn't indiscriminate. A skill is created when the run clears a meaningful bar — **five or more tool calls, a recovery from an error, a user correction, or a non-obvious workflow that worked.** Those are precisely the moments where hard-won procedure is worth saving. Importantly, Hermes captures both **code** trajectories and **browser** trajectories, so 'how I automated that web form' becomes as reusable as 'how I parsed that log format.'",
    },
    {
      type: "code",
      language: "markdown",
      code: `---
name: scrape-and-reshape
description: Scrape an HTML table and emit clean, typed CSV. Use when the user
  wants tabular data off a web page.
version: 1.0.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [web, data, automation]
    category: scraping
    requires_toolsets: [terminal, browser]
---

## Steps
1. Open the URL with the browser tool; wait for the table to render.
2. Extract rows; coerce numeric columns, strip thousands separators.
3. Validate row count against the page's stated total before writing.
4. Emit CSV to ./out/ and report the path.`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "Edits prefer patches, not rewrites",
      text: "When a skill needs to improve, Hermes defaults to a targeted patch — swapping an old string for a new one — rather than regenerating the whole file. It's safer (less chance of clobbering a working step), cheaper in tokens, and leaves a cleaner history of how the skill evolved.",
    },
    {
      type: "paragraph",
      text: "Two properties make this more than a private cache. First, **portability**: because the format is a shared standard, a skill Hermes wrote can run unchanged in other compatible agents — Claude, Codex, Cursor, and the rest — with no conversion step. Your procedural memory isn't trapped in one tool. Second, **progressive disclosure**: only the skill's name and one-line summary sit in context by default; the full body loads only when the agent judges it relevant. That's why a library of a hundred-plus skills doesn't translate into a hundred-plus skills' worth of tokens on every turn.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "A skill is executable instructions — treat shared ones as code",
      text: "Hermes ships a security scanner that checks community skills for exfiltration, injection, and supply-chain tricks, and that's a good baseline. But a skill is a set of instructions an agent will follow with real tools. Review third-party skills before enabling them, exactly as you'd review a dependency you're about to npm install.",
    },
    {
      type: "heading",
      text: "Angle 3 — Parallel, sandboxed sub-agents",
      id: "sub-agents",
    },
    {
      type: "paragraph",
      text: "Some tasks are naturally several tasks. 'Research these five competitors,' 'run this pipeline across four datasets,' 'check each of these endpoints' — a single thread plods through them one at a time, and the wall-clock is the *sum*. Hermes can instead spin up **isolated sub-agents**, each with its own conversation, its own sandboxed terminal, and its own Python **RPC** session, dispatch the sub-tasks in parallel, and aggregate the results when they return.",
    },
    {
      type: "diagram",
      visual: "hrm-parallel",
      caption:
        "Sequential vs parallel. Adjust the sub-task count and toggle the mode: sequential wall-clock is the sum of every step; with sub-agents it's bounded by the slowest one, and the main thread never blocks.",
    },
    {
      type: "paragraph",
      text: "The 'isolated' part is doing real work. Each sub-agent's execution runs in a Docker sandbox with a read-only root filesystem, dropped Linux capabilities, namespace isolation, and PID limits — so one helper running untrusted code can't trample the host or its siblings. The main thread becomes a coordinator: it delegates, the children grind in isolation, and the orchestrator stitches the answers back together without ever stalling on a single long step.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Parallelism isn't free — fan out on purpose",
      text: "Every sub-agent is its own set of model calls, so a wide fan-out multiplies cost and adds coordination overhead. The win shows up when sub-tasks are genuinely independent and individually slow. For a quick three-step chain, a single thread is cheaper and simpler — reach for sub-agents when the work is embarrassingly parallel, not by reflex.",
    },
    {
      type: "heading",
      text: "Putting it together: the flywheel",
      id: "flywheel",
    },
    {
      type: "paragraph",
      text: "Memory, skills, and sub-agents aren't three separate features — they're one loop. A request comes in, relevant history and skills are retrieved, the agent reasons and acts (fanning out if it helps), a periodic nudge prompts it to write down what it learned, and the result is persisted so the next pass starts smarter. That's the self-improvement flywheel.",
    },
    {
      type: "diagram",
      visual: "hrm-flywheel",
      caption:
        "The loop that makes it 'self-improving.' Click through each step — the Document stage is the one most agents skip, and it's the one that compounds.",
    },
    {
      type: "callout",
      tone: "info",
      title: "The honest numbers",
      text: "Nous reports an agent using its own accumulated skills completing repeated research tasks roughly 40% faster than a fresh instance, with no prompt tuning. The reflection machinery isn't free: expect on the order of 15–25% extra tokens for the privilege. Whether that trade pays off is a direct function of how repetitive your workload is.",
    },
    {
      type: "heading",
      text: "Where it earns its keep — use cases",
      id: "use-cases",
    },
    {
      type: "list",
      items: [
        "**Recurring research & monitoring** — multi-week topic tracking where the agent's skills and memory sharpen with each pass; the 40% speed-up lands hardest here.",
        "**Scheduled automation** — a built-in cron scheduler drives daily summaries, data pulls, or CI/CD notifications that benefit from cross-session knowledge.",
        "**A genuinely personal assistant** — connect Telegram, Discord, or WhatsApp and the agent maintains context across channels; start on your phone, continue at your desk.",
        "**Pipeline fan-out** — independent, slow sub-tasks (per-dataset processing, per-competitor research) handled by parallel sub-agents.",
        "**Training-data generation** — batch trajectory generation (via the Atropos RL framework) for fine-tuning, turning the agent's runs into datasets.",
      ],
    },
    {
      type: "heading",
      text: "Is it ready for the enterprise? An honest scorecard",
      id: "enterprise",
    },
    {
      type: "paragraph",
      text: "This is where excitement meets procurement. Hermes has real structural advantages for serious use — and real gaps you'd have to engineer around. Pretending otherwise helps no one, so here's the balanced view.",
    },
    {
      type: "diagram",
      visual: "hrm-feasibility",
      caption:
        "Enterprise feasibility, dimension by dimension. Click each — green where it shines (self-hosting, sandboxing, no lock-in), amber-to-red where you'll do extra work (auditability, stability, cross-domain transfer).",
    },
    {
      type: "paragraph",
      text: "The green column is legitimately strong. It's **MIT-licensed and self-hostable**, so your data and the agent's memory can stay entirely inside your perimeter — a rare and valuable property for regulated teams. Execution is **sandboxed by default** with sensible Docker hardening. And because skills ride the **open agentskills.io standard**, you're not locked in: the procedural memory you accumulate is portable.",
    },
    {
      type: "paragraph",
      text: "The cautions are just as real. Memory is **opaque** — it's hard to audit exactly what the agent has learned or why it did something, which is a problem for compliance-heavy contexts until you wrap it in your own logging. Improvement is **domain-specific**: gains on one task class don't transfer to another, so plan for per-domain skill libraries rather than one omniscient agent. The codebase is **young and fast-moving** (several minor versions in its first couple of months), so pin versions and expect churn. And community skills, while scanned, are still **executable instructions** that warrant review.",
    },
    {
      type: "callout",
      tone: "success",
      title: "The verdict",
      text: "Hermes is a capable tool to adopt with eyes open, not a turnkey enterprise platform. If your workload is repetitive, your data needs to stay in-house, and you have the engineering maturity to add auditing and version discipline around it, the memory-and-skills model can pay for itself. If you need an SLA, deep auditability, and frozen APIs today, treat it as a preview of where the field is heading.",
    },
    {
      type: "heading",
      text: "Best practices if you run it",
      id: "best-practices",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Curate `MEMORY.md` like a sticky note, not a diary — the character cap is a feature; respect it.",
        "Let skills accumulate on real work, then prune ruthlessly. A bloated, contradictory skill library hurts retrieval quality.",
        "Review every community/third-party skill before enabling it — it's executable instruction, full stop.",
        "Fan out to sub-agents only for genuinely independent, slow sub-tasks; a single thread is cheaper for short chains.",
        "Budget for the reflection overhead (~15–25% tokens) and measure whether your workload is repetitive enough to earn it back.",
        "Pin the version. The project moves fast; reproducibility beats living on the edge.",
        "Wrap it in your own logging/observability if you need auditability — don't rely on the built-in memory being inspectable.",
        "Keep skills organized by domain, since learnings don't transfer across task types.",
      ],
    },
    {
      type: "heading",
      text: "Where this lands in AgentSwarms",
      id: "agentswarms",
    },
    {
      type: "paragraph",
      text: "The patterns Hermes productizes are exactly the ones we teach hands-on. Memory layering, procedural skills, and sub-agent fan-out are design decisions you can prototype on the swarm canvas before committing to a runtime — wire an orchestrator that dispatches to parallel workers, see where context accumulation bites in the Failure-Mode Labs, and export the architecture to a framework when the shape is right. The point isn't to rebuild Hermes; it's to understand the moving parts well enough to choose them deliberately.",
    },
    {
      type: "callout",
      tone: "info",
      title: "A note on scope",
      text: "AgentSwarms is a learning and prototyping platform, not a production agent runtime. We don't run Hermes for you — this post is here so that when you do reach for a self-improving agent, you know what its memory is actually doing, why its skills are portable, and what you're signing up for operationally.",
    },
    {
      type: "paragraph",
      text: "The era of the amnesiac assistant is ending. The agents that matter next won't just be smarter in the moment — they'll be the ones that remember the last moment, keep what worked, and arrive at tomorrow's problem already knowing something about it. Hermes is an early, opinionated, refreshingly open bet on that future. Run it with curiosity and a little caution, and it'll show you what an agent that *accumulates* actually feels like.",
    },
  ],
  references: [
    {
      label: "Hermes Agent — Nous Research (GitHub)",
      url: "https://github.com/NousResearch/hermes-agent",
    },
    {
      label: "Inside Hermes Agent: How a Self-Improving AI Agent Actually Works",
      url: "https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving",
    },
    {
      label: "Hermes Agent: Complete Guide to the Self-Improving AI (2026) — NxCode",
      url: "https://www.nxcode.io/resources/news/hermes-agent-complete-guide-self-improving-ai-2026",
    },
    {
      label: "Agent Skills — the open standard (agentskills.io / Anthropic)",
      url: "https://github.com/agentskills/agentskills",
    },
    {
      label: "Agent Skills Explained: How SKILL.md Files Work — Firecrawl",
      url: "https://www.firecrawl.dev/blog/agent-skills",
    },
    {
      label: "awesome-hermes-agent — curated skills & resources",
      url: "https://github.com/0xNyk/awesome-hermes-agent",
    },
  ],
};

const productionSystemDesign: BlogPost = {
  slug: "production-system-design-for-agentic-ai",
  title: "Designing Agentic AI for Production: The Six Pillars",
  subtitle:
    "A demo agent needs a good prompt. A production agent needs an identity, a threat model, and a pager. Here's the system-design checklist that separates the two — ending with a real LangGraph swarm deployed on AWS Bedrock AgentCore.",
  excerpt:
    "Most agentic AI projects die in the gap between 'works in the notebook' and 'survives Monday morning traffic'. We walk the six pillars of production agent design — identity, security, scalability, high availability, observability, and cost control — then deploy a LangGraph multi-agent system on AWS Bedrock AgentCore, mapping every pillar to a concrete service.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-04",
  readingTime: "18 min read",
  tags: ["Production", "Architecture", "Security"],
  cover: {
    gradient: "from-sky-500/30 via-primary/20 to-violet-500/25",
    icon: "cloud",
    motif: "prod",
  },
  blocks: [
    {
      type: "lead",
      text: "Here's the moment that humbles every team building with agents: the demo is flawless. The agent researches, reasons, calls its tools, writes a beautiful answer. You ship it. And then real traffic arrives — concurrent users, hostile inputs, a model provider having a bad afternoon, a reflection loop that won't quit — and the thing that looked like magic starts behaving like what it actually is: a distributed system that happens to think.",
    },
    {
      type: "paragraph",
      text: "That's the reframe this whole post rests on. **An agent in production is not a prompt. It's a distributed system.** The prompt is maybe 10% of the work. The other 90% — the part nobody films for the launch video — is identity, security, scale, failover, observability, and cost. Get those wrong and it doesn't matter how clever your prompt was; you've shipped a liability with a chat interface.",
    },
    {
      type: "paragraph",
      text: "We're going to walk six pillars, one at a time, with the specific failure each one prevents. Then we'll do the thing most articles skip: take a concrete LangChain/LangGraph multi-agent system and actually deploy it on **AWS Bedrock AgentCore**, mapping each pillar to a real service you can provision. Let's start with the map.",
    },
    {
      type: "diagram",
      visual: "psd-six-pillars",
      caption:
        "The six pillars of a production agent. Click each one for the question it answers — and the failure that shows up if you skip it. None of these are optional once real users arrive.",
    },
    {
      type: "heading",
      text: "Pillar 1 — Identity: an agent is not its user",
      id: "identity",
    },
    {
      type: "paragraph",
      text: "The first mistake almost everyone makes is letting the agent borrow the human's identity. The user is logged in, the agent runs 'as them', and it inherits every permission that person has. It feels convenient. It's the single most dangerous shortcut in the stack.",
    },
    {
      type: "paragraph",
      text: "Agents are a new class of actor — **non-human identities** — and they're multiplying faster than the humans they serve. Each one needs its *own* identity: a workload credential, a narrowly scoped role, and short-lived tokens it can't hoard. When something goes wrong, you need the audit log to say *which agent* did *what*, distinct from any human. And when an agent is inevitably compromised, the blast radius should be the two tools it was granted — not everything its operator could touch.",
    },
    {
      type: "diagram",
      visual: "psd-agent-identity",
      caption:
        "Toggle between an agent that borrows the user's credentials and one with its own scoped identity. The scoped agent simply doesn't hold the keys to the dangerous tools — so a hijack can't reach them.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "The identity checklist",
      text: "One identity per agent (or per agent role), not per human. Scope permissions to the specific tools it needs. Issue short-lived, automatically-rotated tokens. Support delegation/on-behalf-of so you can prove the chain of 'the user asked → this agent acted'. And log the agent identity on every tool call.",
    },
    {
      type: "heading",
      text: "Pillar 2 — Security: assume every input is hostile",
      id: "security",
    },
    {
      type: "paragraph",
      text: "Traditional apps trust their own code and distrust user input. Agents blow that model up, because the 'input' now includes the contents of every document, web page, and tool result the agent reads — any of which can contain instructions. Prompt injection isn't an edge case; it's the default condition of an agent that touches the outside world.",
    },
    {
      type: "paragraph",
      text: "The clearest way to reason about the worst case is Simon Willison's **lethal trifecta**: an agent becomes capable of leaking your data the moment it simultaneously has (1) access to private data, (2) exposure to untrusted content, and (3) a way to communicate externally. Any two are survivable. All three together means a single poisoned document can read your secrets and ship them out the door.",
    },
    {
      type: "diagram",
      visual: "psd-lethal-trifecta",
      caption:
        "Toggle the three conditions. Exfiltration only becomes possible when all three are present at once — so the defensive move is to break at least one leg for any given agent.",
    },
    {
      type: "list",
      items: [
        "**Least privilege, enforced server-side** — the model can *ask* to call any tool; your server decides whether it's allowed, validates the arguments against a strict schema, and refuses anything out of scope.",
        "**Guardrails on both ends** — filter inputs (injection, jailbreaks, PII) and outputs (leaked secrets, unsafe content) with a dedicated layer, not vibes in the system prompt.",
        "**Sandbox anything that executes** — code interpreters and browsers run in isolated, ephemeral environments with no standing access to your network.",
        "**Treat tool results as untrusted** — a web page or a retrieved chunk is data, not instructions. Keep it out of the privileged instruction channel.",
        "**Human approval for irreversible actions** — refunds, deletes, sends, payments. The agent proposes; a policy (or a person) disposes.",
      ],
    },
    {
      type: "heading",
      text: "Pillar 3 — Scalability: keep agents stateless",
      id: "scalability",
    },
    {
      type: "paragraph",
      text: "The fastest way to build an agent that can't scale is to keep its state — conversation history, scratchpad, plan — in memory on the process that's serving it. It works beautifully for one user. Then traffic arrives, you try to add a second instance, and you discover every session is glued to the box that started it.",
    },
    {
      type: "paragraph",
      text: "Production agents are **stateless compute over externalized state**. The agent process holds nothing durable; conversation and working memory live in a shared store (a database, a cache, a managed memory service). Any worker can resume any session. Long-running tasks go on a queue and run asynchronously instead of holding a request open for ten minutes. Now scaling is just adding workers.",
    },
    {
      type: "diagram",
      visual: "psd-scalability",
      caption:
        "Drag the load up. Stateless workers backed by a shared store absorb it — any node serves any session. In-memory state pins each session to one node, and that node is your bottleneck.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Don't forget the model is a resource too",
      text: "You can scale your own compute infinitely and still hit a wall: provider rate limits and token throughput. Budget for them — request-level rate limiting, queue backpressure, and caching of repeated calls — or your 'scalable' system just moves the bottleneck to the model API.",
    },
    {
      type: "heading",
      text: "Pillar 4 — High availability: plan for the bad afternoon",
      id: "availability",
    },
    {
      type: "paragraph",
      text: "Models fail. Providers rate-limit, regions degrade, a deploy goes sideways. The question isn't whether your dependencies will have a bad afternoon — it's what your agents do when they inevitably do. A system with no answer to that question is a system that goes fully dark the first time a single upstream hiccups.",
    },
    {
      type: "diagram",
      visual: "psd-ha-failover",
      caption:
        "Click a region to take it down and watch traffic reroute to the healthy ones. The same idea applies one layer up: a primary model that 429s should fail over to a secondary, not stall the whole fleet.",
    },
    {
      type: "list",
      items: [
        "**Model failover** — a prioritized list of models/providers, so a 429 or outage on the primary degrades to a secondary instead of failing the request.",
        "**Retries with backoff + idempotency** — transient errors get retried, but tool calls carry idempotency keys so a retry doesn't double-charge a card or send two emails.",
        "**Circuit breakers** — when a dependency is clearly down, stop hammering it; fail fast and shed load rather than pile up timeouts.",
        "**Checkpoint long tasks** — a multi-step agent should persist its state between steps so a crash resumes instead of restarting from zero.",
        "**Graceful degradation** — when the fancy path is unavailable, return a smaller, honest answer rather than an error page.",
      ],
    },
    {
      type: "heading",
      text: "Pillar 5 — Observability: you can't debug what you can't see",
      id: "observability",
    },
    {
      type: "paragraph",
      text: "Agent bugs are almost never visible in the final output and almost always obvious in the trace. 'Why did it call that tool?' 'Why did the answer drift?' 'Where did the cost come from?' — these have answers you can *read* only if you captured every Thought, Action, and Observation along the way. Skip instrumentation and your debugging strategy becomes re-running the agent and hoping.",
    },
    {
      type: "diagram",
      visual: "psd-observability-trace",
      caption:
        "A real agent trace is a waterfall of spans. Click any one: it carries the model, tokens, cost, and latency. This is the difference between 'the agent was slow' and 'the researcher's synthesis step burned 4k tokens on a 520ms call'.",
    },
    {
      type: "paragraph",
      text: "Lean on the emerging standard rather than rolling your own: the **OpenTelemetry GenAI semantic conventions** define how to trace LLM and agent calls, so your traces speak the same language as the rest of your infra. Capture spans per step, attach token/cost/latency as attributes, and — crucially — run **evaluations in production**, not just pre-launch. Quality drifts silently; an eval gate on a sample of live traffic is how you catch it before a customer does.",
    },
    {
      type: "heading",
      text: "Pillar 6 — Cost control: bound the loops before the bill does",
      id: "cost",
    },
    {
      type: "paragraph",
      text: "The unique financial risk of agents is that they decide how much work to do. A chatbot answers once. An agent can loop, fan out to sub-agents, and re-read a growing context on every turn — each iteration a fresh round of token spend. The failure mode isn't a crash; it's a quietly enormous invoice.",
    },
    {
      type: "list",
      items: [
        "**Hard caps on every loop** — a max-iteration limit is the safety net; an explicit stop condition (a DONE token, a passing eval) is the intended exit. Ship both.",
        "**Model routing** — use a cheap, fast model for routing, classification, and simple steps; reserve the expensive model for the work that needs it.",
        "**Cache aggressively** — identical sub-calls, repeated retrievals, and prompt prefixes are free money left on the table.",
        "**Per-tenant attribution + budgets** — tag every call with who it was for, and alert (or cut off) when a tenant blows past their budget.",
        "**Bound the context** — summarize history instead of letting it grow unbounded; a context window that only grows is a cost curve that only grows.",
      ],
    },
    {
      type: "callout",
      tone: "tip",
      title: "Estimate before you ship",
      text: "Model the cost before launch: iterations × agents × calls-per-step × token price × volume. AgentSwarms' Multi-Agent Token Cost Calculator does this in a few clicks — and the number it spits out often changes the architecture you were about to build.",
    },
    {
      type: "divider",
    },
    {
      type: "heading",
      text: "Putting it together: a LangGraph swarm on AWS Bedrock AgentCore",
      id: "agentcore",
    },
    {
      type: "paragraph",
      text: "Theory is cheap. Let's deploy something. Our system is a classic LangGraph multi-agent pipeline: a **supervisor** routes work to a **researcher** (which searches the web and reads documents), an **analyst** (which reasons over the findings), and a **writer** (which produces the final brief). It has tools, it has memory, and it can loop. In other words, it has every production concern we just listed.",
    },
    {
      type: "paragraph",
      text: "AWS released **Bedrock AgentCore** to handle exactly this gap — the infrastructure between a working agent and a production one. The key thing to understand is that it's **framework-agnostic and model-agnostic**: AgentCore doesn't replace LangGraph, it *hosts* it. Your LangGraph code runs unchanged inside a managed runtime, and you opt into the surrounding services pillar by pillar.",
    },
    {
      type: "diagram",
      visual: "psd-agentcore-map",
      caption:
        "Each pillar maps to a concrete AgentCore service. Click a pillar to see which one covers it. The point: you don't hand-build identity, sandboxing, and tracing — you compose them.",
    },
    {
      type: "subheading",
      text: "Step 1 — Wrap the LangGraph app for the Runtime",
    },
    {
      type: "paragraph",
      text: "**AgentCore Runtime** is the serverless host. It gives each session an isolated microVM (so one user's agent can't touch another's), scales from zero to many, and supports long-running tasks up to eight hours — which matters the moment your agent does real multi-step work. You don't rewrite your agent; you wrap its entrypoint:",
    },
    {
      type: "code",
      language: "python",
      code: `# app.py — your existing LangGraph swarm, wrapped for AgentCore Runtime.
from bedrock_agentcore import BedrockAgentCoreApp
from my_swarm import build_graph   # your LangGraph StateGraph, unchanged

app = BedrockAgentCoreApp()
graph = build_graph()              # supervisor -> researcher / analyst / writer

@app.entrypoint
def invoke(payload, context):
    # 'context' carries the session + agent identity injected by the Runtime.
    result = graph.invoke(
        {"messages": [("user", payload["prompt"])]},
        config={"configurable": {"session_id": context.session_id}},
    )
    return {"output": result["messages"][-1].content}

if __name__ == "__main__":
    app.run()   # local dev; in prod the Runtime calls the entrypoint`,
    },
    {
      type: "paragraph",
      text: "That's the whole adapter. The Runtime handles the HTTP surface, session isolation, scaling, and the long-running execution — **Pillars 3 and 4** (scalability and availability) are now largely AWS's problem, not yours.",
    },
    {
      type: "subheading",
      text: "Step 2 — Give the agent its own identity",
    },
    {
      type: "paragraph",
      text: "**AgentCore Identity** issues the agent a workload identity and provides a credential vault for outbound auth (OAuth tokens for the SaaS tools it calls). Your researcher agent gets *its own* identity to call the web-search API — not your personal key baked into an env var. That's **Pillar 1**, handled by the platform instead of by you copy-pasting tokens.",
    },
    {
      type: "subheading",
      text: "Step 3 — Expose tools through the Gateway",
    },
    {
      type: "paragraph",
      text: "**AgentCore Gateway** turns your existing APIs and Lambda functions into MCP-compatible tools with authentication and authorization built in. Instead of wiring raw API keys into the agent, you register the tool once, and the Gateway enforces who can call what. Combined with **Bedrock Guardrails** on the model's input and output and the sandboxed **Code Interpreter** / **Browser** tools, that's **Pillar 2** (security) composed from managed pieces:",
    },
    {
      type: "code",
      language: "bash",
      code: `# Register an existing Lambda as a governed, MCP-compatible tool.
agentcore gateway create-target \\
  --gateway-id my-swarm-gw \\
  --name web_search \\
  --target-type lambda \\
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:web-search \\
  --auth-type oauth        # the Gateway enforces auth on every call

# The agent now sees 'web_search' as a tool — but can only invoke it
# within the scopes its workload identity was granted.`,
    },
    {
      type: "subheading",
      text: "Step 4 — Persist memory, then turn on the lights",
    },
    {
      type: "paragraph",
      text: "**AgentCore Memory** gives you managed short-term (within-session) and long-term (across-session) memory, so your agents stay stateless while their memory lives in a durable service — the externalized-state pattern from Pillar 3, as a managed dependency. And **AgentCore Observability** emits OpenTelemetry traces straight into CloudWatch: every step, tool call, token count, and latency, with no custom instrumentation. That's **Pillars 5 and 6** — you can finally see what the swarm did and what it cost.",
    },
    {
      type: "code",
      language: "bash",
      code: `# Configure and deploy. The toolkit provisions the execution role,
# container, and wiring; observability is on by default.
agentcore configure --entrypoint app.py --name my-swarm
agentcore launch        # builds, deploys to the Runtime, returns an ARN

# Invoke the deployed swarm
agentcore invoke '{"prompt": "Brief me on the EU AI Act timeline"}'`,
    },
    {
      type: "callout",
      tone: "success",
      title: "What you composed",
      text: "Identity → AgentCore Identity. Security → Gateway + Guardrails + sandboxed tools. Scalability & availability → Runtime. State → Memory. Observability & cost visibility → Observability. Your LangGraph code barely changed; the production concerns became configuration.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "What AgentCore does NOT do for you",
      text: "It hosts and secures the agent; it does not make the agent good. You still own your evals, your guardrail policies and prompts, your cost budgets and alerts, and the actual reasoning quality of the swarm. The platform removes the undifferentiated heavy lifting — not the thinking.",
    },
    {
      type: "heading",
      text: "The pre-production checklist",
      id: "checklist",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "Each agent has its own scoped identity and short-lived credentials — not the user's keys.",
        "Every tool validates arguments server-side; irreversible actions require approval.",
        "You've broken the lethal trifecta for any agent that reads untrusted content.",
        "State is externalized; agents are stateless and horizontally scalable.",
        "Model failover, retries with idempotency, and loop caps are in place.",
        "Every run emits a trace with per-step tokens, cost, and latency.",
        "An eval runs on live traffic and alerts on quality drift.",
        "Spend is attributed per tenant with budgets and alerts.",
      ],
    },
    {
      type: "paragraph",
      text: "None of these pillars is exotic. They're the same disciplines we've always applied to distributed systems — identity, least privilege, statelessness, redundancy, observability, cost governance — pointed at a new kind of component that reasons and acts. The teams whose agents survive production aren't the ones with the cleverest prompts. They're the ones who treated the agent like the system it actually is.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Practice the failure modes first",
      text: "AgentSwarms is a learning and prototyping platform: design your swarm on the visual canvas, watch it fail in the Failure-Mode Labs, and export it to LangGraph when the shape is right. Get the architecture correct here, then deploy it on a runtime like AgentCore with the six pillars already in mind.",
    },
  ],
  references: [
    { label: "Amazon Bedrock AgentCore — AWS", url: "https://aws.amazon.com/bedrock/agentcore/" },
    {
      label: "Bedrock AgentCore Developer Guide",
      url: "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/",
    },
    {
      label: "The lethal trifecta for AI agents — Simon Willison",
      url: "https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/",
    },
    {
      label: "OpenTelemetry GenAI semantic conventions",
      url: "https://opentelemetry.io/docs/specs/semconv/gen-ai/",
    },
    {
      label: "OWASP Top 10 for LLM Applications",
      url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
    },
  ],
};

const useCaseFeasibility: BlogPost = {
  slug: "agentic-ai-use-case-feasibility-framework",
  title: "Should You Even Build an Agent? A Feasibility Framework",
  subtitle:
    "The most expensive agent is the one you should never have built. A mental model for telling agent-shaped problems from workflow-shaped ones — and the ROI math that decides whether it survives at scale.",
  excerpt:
    "Most agentic AI projects fail before a line of code is written: the problem was wrong. This is a feasibility framework — a 2×2 mental model, a candidate scorecard, an honest ROI calculator, and the accuracy-compounding trap that kills long agent chains at scale. Learn to say 'no, use a workflow' as confidently as 'yes, build the agent'.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-04",
  readingTime: "16 min read",
  tags: ["Strategy", "Architecture", "Production"],
  cover: {
    gradient: "from-amber-500/25 via-primary/20 to-emerald-500/25",
    icon: "brain",
    motif: "feasibility",
  },
  blocks: [
    {
      type: "lead",
      text: "Gartner expects more than 40% of agentic AI projects to be canceled by the end of 2027. When you read the post-mortems, the cause is rarely the model and rarely the framework. It's that the problem was never agent-shaped to begin with. Someone had a hammer that could reason, and everything started looking like a nail.",
    },
    {
      type: "paragraph",
      text: "So before any architecture diagram, the highest-leverage skill in this entire field is *triage* — looking at a problem and knowing whether it wants an agent, a workflow, a single model call, or just some boring deterministic code. This post is a framework for that decision. By the end you should be able to say 'no, use a workflow' with the same confidence as 'yes, build the agent' — and to defend either with numbers.",
    },
    {
      type: "heading",
      text: "First, resist the jump to agents",
      id: "spectrum",
    },
    {
      type: "paragraph",
      text: "There's a spectrum of automation, and agents sit at the far, expensive end. Most problems are solved better — cheaper, faster, more reliably — somewhere to the left. The instinct to reach straight for a multi-agent system is the source of most wasted budgets.",
    },
    {
      type: "diagram",
      visual: "fz-automation-spectrum",
      caption:
        "Slide from left to right. Each step up the ladder buys capability and pays for it in cost, latency, and unpredictability. The engineering discipline is to start as far left as the problem allows — and only move right when you've proven you have to.",
    },
    {
      type: "paragraph",
      text: "Anthropic's guidance on building effective agents makes the same point bluntly: find the simplest solution possible, and only increase complexity when it demonstrably improves outcomes. A single well-prompted LLM call with retrieval solves a startling fraction of 'we need an agent' requests. The agent is the answer only when the path itself is unpredictable.",
    },
    {
      type: "heading",
      text: "The core trade: determinism for flexibility",
      id: "the-trade",
    },
    {
      type: "paragraph",
      text: "Here's the one sentence to anchor on: **an agent trades determinism for flexibility.** A workflow does the same thing every time — predictable, debuggable, cheap. An agent decides what to do at runtime — flexible enough to handle messy, open-ended tasks, but harder to predict, test, and bound. You take that trade *only* when the flexibility is worth more than the determinism you're giving up.",
    },
    {
      type: "paragraph",
      text: "That single trade explains the whole feasibility question. If a problem has a knowable, fixed path, paying for an agent's flexibility is pure waste — you bought unpredictability you didn't need. If the path genuinely varies per input and can't be enumerated in advance, a rigid workflow will keep falling off the edges, and the agent's flexibility earns its cost. Two dimensions decide it.",
    },
    {
      type: "diagram",
      visual: "fz-feasibility-quadrant",
      caption:
        "The feasibility 2×2: how variable is the path, and how costly is a mistake? Click each quadrant. Only one of the four is a clean 'build an agent' — and the high-stakes corner needs guardrails and a human before it's anything at all.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Read the quadrant honestly",
      text: "Teams love to place their use case in the top-right 'sophisticated' corner because it feels ambitious. Most real problems live bottom-left (just automate it) or top-left (workflow + validation). Be ruthless: the goal is the cheapest thing that works, not the most impressive thing you can justify.",
    },
    {
      type: "heading",
      text: "The candidate scorecard",
      id: "scorecard",
    },
    {
      type: "paragraph",
      text: "The 2×2 gives you intuition; this gives you a checklist. A problem is a genuine agent candidate when most of these are true at once. Toggle them and watch the verdict move — and notice how quickly 'it would be cool' collapses into 'use a workflow' when the signals aren't there.",
    },
    {
      type: "diagram",
      visual: "fz-candidate-scorecard",
      caption:
        "Toggle the signals that are true for your use case. Five or more and the flexibility of an agent earns its keep. Two or fewer and you're about to over-engineer something a simpler tool would nail.",
    },
    {
      type: "paragraph",
      text: "Two of these signals deserve special weight. **'There's a way to verify the output'** is close to a hard requirement — an agent you can't check is an agent you can't trust at scale, because you'll never know when it quietly went wrong. And **'wrong answers are recoverable'** is what keeps you out of the danger zone: an agent acting irreversibly with no review is a risk, not a feature, no matter how capable it is.",
    },
    {
      type: "heading",
      text: "When the answer is just 'no'",
      id: "when-not",
    },
    {
      type: "callout",
      tone: "warn",
      title: "Red flags that should stop a project",
      text: "High-volume, perfectly deterministic transactions (use code). Tasks requiring 100% accuracy with no verification step (the model will eventually be confidently wrong). Hard real-time, sub-100ms latency budgets (agents loop and think — they're slow). Trivially simple single-step tasks (a single LLM call or a regex wins). Zero-tolerance regulatory actions with no human in the loop. If your use case is mostly these, the feasible answer is 'not an agent'.",
    },
    {
      type: "paragraph",
      text: "Saying no here isn't pessimism — it's what makes the yeses credible. A team that has a clear list of things agents are *bad* at is a team you can trust when they say a particular problem is a fit.",
    },
    {
      type: "heading",
      text: "The ROI math nobody runs until it's too late",
      id: "roi",
    },
    {
      type: "paragraph",
      text: "A use case can be perfectly agent-shaped and still lose money at scale. Feasibility isn't just 'can an agent do this?' — it's 'does it pay?' once you multiply by volume. The economics are simple enough to put in a calculator, and sobering enough that most teams should run it *before* the build, not after the invoice.",
    },
    {
      type: "diagram",
      visual: "fz-roi-calculator",
      caption:
        "Move the sliders to your numbers. Value created = volume × success rate × value per success. Cost = volume × cost per task. The success rate is the variable that quietly flips the whole thing — drag it down a few points and watch a 'no-brainer' go underwater.",
    },
    {
      type: "paragraph",
      text: "Notice what the calculator teaches: at low volume almost anything pencils out, which is why pilots look great. At high volume, two things dominate — your cost per task (driven by model choice, steps, and retries) and your success rate (because failures are tasks you paid for *and* have to redo or escalate). A pilot that looked profitable at 500 tasks a month can invert at 200,000.",
    },
    {
      type: "heading",
      text: "The accuracy trap that ambushes you at scale",
      id: "accuracy",
    },
    {
      type: "paragraph",
      text: "Here's the one that ambushes good teams. A single step that's 95% accurate sounds excellent. But agents chain steps, and accuracy *compounds* — multiplies — down the chain. Ten steps at 95% each isn't 95%; it's 0.95 to the tenth power, about 60%. The model didn't get worse. The chain did.",
    },
    {
      type: "diagram",
      visual: "fz-accuracy-compounding",
      caption:
        "Set the chain length and per-step accuracy, then read the end-to-end success — and what it means at 10,000 runs a day. This is why long, fully-autonomous agent chains at scale are a verification problem, not a model problem.",
    },
    {
      type: "callout",
      tone: "info",
      title: "What this implies for design",
      text: "If your honest per-step accuracy is in the low 90s, you cannot run a long autonomous chain at scale without verification gates between steps — a checker, a grader, a human checkpoint — to stop errors from compounding. Either keep chains short, add verification, or pick a use case where a 60% end-to-end success is genuinely acceptable.",
    },
    {
      type: "heading",
      text: "Where agents actually win at scale",
      id: "where-agents-win",
    },
    {
      type: "paragraph",
      text: "None of this is an argument against agents — it's an argument for aiming them well. When the math works, agents win in three recognizable ways: they **augment** expensive human experts (drafting, research, triage that a person then approves), they deliver **consistency** at a volume humans can't sustain, and they **unlock** tasks that were simply uneconomical to do by hand at all. The common thread is that the value per task is high enough, and the work variable enough, that flexibility beats a script.",
    },
    {
      type: "paragraph",
      text: "And the smart way to get there is not to bet the company on full autonomy on day one. It's to climb a ladder.",
    },
    {
      type: "diagram",
      visual: "fz-adoption-ladder",
      caption:
        "Crawl, walk, run. Start assistive with a human approving every action; earn autonomy on the slice you've proven; scale only the validated path. The teams that skip straight to 'run' are the ones in Gartner's cancellation statistic.",
    },
    {
      type: "heading",
      text: "The whole framework in one decision",
      id: "decision",
    },
    {
      type: "paragraph",
      text: "Put it together and the feasibility question collapses into a short walk: Is the path fixed? Can you verify the output? Is the task worth the cost? Answer those honestly and the recommendation falls out — often it's 'use a workflow', sometimes it's 'not yet', and exactly when it should be, it's 'build the agent'.",
    },
    {
      type: "diagram",
      visual: "fz-decision-tree",
      caption:
        "Walk the tree for a real use case. Most paths don't end at 'build the agent' — and that's the point. The ones that do are the projects worth your team's time.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Prototype the decision, don't argue about it",
      text: "The fastest way to settle 'is this agent-shaped?' is to build the smallest version and measure it. In AgentSwarms you can stand up a swarm on the visual canvas, run it against real inputs, and watch the traces and cost — then decide with evidence instead of opinions. Cheap to try, cheaper than a canceled six-month project.",
    },
    {
      type: "paragraph",
      text: "Agentic AI is genuinely transformative for the problems it fits — and a money pit for the ones it doesn't. The framework above won't pick the problem for you, but it will stop you from building the agent you'll regret. In a field where 40% of projects get canceled, knowing which 60% to start is most of the battle.",
    },
  ],
  references: [
    {
      label: "Over 40% of agentic AI projects will be canceled by 2027 — Gartner",
      url: "https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027",
    },
    {
      label: "Building effective agents — Anthropic",
      url: "https://www.anthropic.com/engineering/building-effective-agents",
    },
    {
      label: "Agents vs. workflows — when to use which",
      url: "https://www.anthropic.com/engineering/building-effective-agents",
    },
    { label: "What is agentic AI? — AWS", url: "https://aws.amazon.com/what-is/agentic-ai/" },
  ],
};

const typescriptNotebooks: BlogPost = {
  slug: "why-we-built-typescript-notebooks-for-agentic-ai",
  title: "Why We Built TypeScript Notebooks (and Skipped Python)",
  subtitle:
    "Reading about agents teaches you nothing. Running them teaches you everything. Here's why we put 50+ runnable TypeScript notebooks in the browser, how to learn from them, and the honest reason there's no Python kernel in sight.",
  excerpt:
    "We shipped 50+ runnable TypeScript notebooks for learning agentic AI — real LangChain, LangGraph, Vercel AI SDK and OpenAI Agents code that executes in your browser with one click, no install. This is why runnable beats readable, how to actually learn from them, the real reason we couldn't do Python notebooks (and why that turned out to be a feature), and how it sets our agentic-AI education apart.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-05",
  readingTime: "12 min read",
  tags: ["Learning", "TypeScript", "Production"],
  cover: {
    gradient: "from-primary/25 via-sky-500/20 to-emerald-500/25",
    icon: "cpu",
    motif: "notebooks",
  },
  blocks: [
    {
      type: "lead",
      text: "You can read every tutorial ever written about AI agents and still not understand them. We know this because we did it, and then we watched learners do it. The concepts slide off. Tool calling, ReAct, handoffs, RAG, guardrails — they stay abstract until the moment you run one, change a line, and watch the behaviour move. So we stopped writing things to read and started shipping things to run.",
    },
    {
      type: "paragraph",
      text: "AgentSwarms now has **50+ runnable TypeScript notebooks**: real LangChain, LangGraph, the Vercel AI SDK, the OpenAI Agents SDK, and LlamaIndex.TS — not screenshots, not pseudo-code, but actual library code that executes when you click a button. No install. No kernel. No API key to paste. You open a notebook, press run, and an agent does something in your browser tab.",
    },
    {
      type: "diagram",
      visual: "nb-run-cell",
      caption:
        "A notebook cell, for real. Press ▶ and watch a tiny LangGraph swarm run and stream its output below the code — exactly the way it works in the product. There was nothing to set up before you clicked.",
    },
    {
      type: "heading",
      text: "Why runnable beats readable",
      id: "runnable-beats-readable",
    },
    {
      type: "paragraph",
      text: "A static code block is a photo of a meal. It tells you what the dish looked like; it doesn't feed you. The gap between *seeing* `agent.invoke()` and *running* it — then breaking it, then fixing it — is the entire gap between recognizing agentic AI and understanding it. Recognition is what you get from videos and docs. Understanding is what you get from your hands on a live cell.",
    },
    {
      type: "diagram",
      visual: "nb-learning-loop",
      caption:
        "The loop the notebooks are built around: read the short explanation, run the cell, edit it, break it on purpose, fix it. Click through each stage — the 'break it' step is the one that actually wires the concept into your head.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "The fastest path to intuition is sabotage",
      text: "Delete a guardrail and watch the injection land. Unbound a loop and watch the token count explode. Drop the retrieval step and watch the model hallucinate. You learn what a control is *for* by removing it and feeling the consequence — which is exactly what an editable, runnable cell lets you do safely.",
    },
    {
      type: "heading",
      text: "How to actually learn from them",
      id: "how-to-use",
    },
    {
      type: "paragraph",
      text: "The notebooks reward an active reader, not a passive one. A few ways learners get the most out of them:",
    },
    {
      type: "list",
      items: [
        "**Follow a track, in order.** Start with LangChain fundamentals or standalone agents, then climb to multi-agent LangGraph. Each notebook assumes the last one clicked.",
        "**Never run a cell without changing it.** Read it, run it once to see the baseline, then change exactly one thing — the prompt, the model, a tool — and re-run. One variable at a time is how you learn what each piece does.",
        "**Use them as a cookbook.** Building a refund agent, a contract analyzer, a router? There's probably a real-world notebook that's 80% of your starting point. Copy the shape, keep the patterns.",
        "**Pair them with the canvas and labs.** Prototype the architecture visually, run the code version in a notebook, then break a swarm on purpose in the Failure-Mode Labs. Three angles on the same idea.",
        "**Learn the TS agent ecosystem specifically.** This is where you'll find LangGraph.js, the Vercel AI SDK, and the OpenAI Agents TS SDK taught hands-on — a stack almost no course covers.",
      ],
    },
    {
      type: "diagram",
      visual: "nb-tracks",
      caption:
        "The notebook curriculum, by track. Click any one to see what it covers. It spans the canonical LangChain course, bite-size standalone agents, multi-agent systems, the major TS SDKs, a full evals track, and real-world builds.",
    },
    {
      type: "heading",
      text: "“But where are the Python notebooks?”",
      id: "no-python",
    },
    {
      type: "paragraph",
      text: "Let's be straight about this, because it's the first question every experienced practitioner asks. Python is the lingua franca of machine learning, and most agent tutorials you've seen are Jupyter notebooks on Colab. We don't have those, and it's not an oversight — it's a consequence of *where* AgentSwarms runs.",
    },
    {
      type: "paragraph",
      text: "AgentSwarms is a web platform that runs on edge infrastructure (Cloudflare Workers), with no per-user Python servers to spin up and no GPUs to rent. There's no Python runtime in that picture, and the browser can't run Python natively. The technically-possible workaround — Pyodide, Python compiled to WebAssembly — is heavy to load and, more importantly, still can't run the real agent frameworks people actually deploy. A 'Python notebook' on our platform would be a slow, fake Python that couldn't import the libraries that make Python worth using. That's a worse lie than not offering it.",
    },
    {
      type: "callout",
      tone: "info",
      title: "An honest note on scope",
      text: "Python absolutely still matters — for data work, for research, and for Python-only frameworks like CrewAI, AutoGen, and DSPy. We're not pretending otherwise. For those, AgentSwarms leans on read-and-export: study the pattern here, then export runnable code to take to your own Python environment. Use the right tool in the right place.",
    },
    {
      type: "heading",
      text: "Why TypeScript-in-the-browser turned out to be the better classroom",
      id: "the-upside",
    },
    {
      type: "paragraph",
      text: "Here's the part we didn't expect: the constraint made the learning experience *better*, not worse. Running TypeScript directly in the browser removes the single biggest reason people bounce off tutorials — the setup.",
    },
    {
      type: "diagram",
      visual: "nb-setup-friction",
      caption:
        "Press 'Race to first output'. The Python-notebook path is open Colab, connect a runtime, pip install, paste a key, wait for the kernel… The TS-notebook path is: click run. Every removed step is a learner who didn't quit before they started.",
    },
    {
      type: "list",
      items: [
        "**Zero setup.** Nothing to install, no kernel to connect, no runtime queue, no `pip install` that breaks on a dependency conflict. The cell just runs.",
        "**Instant feedback.** Click, and output appears below the code in the same second. Tight loops are how skills form.",
        "**It's where agents actually ship.** A huge share of production agents run on the edge, in serverless functions, and in the browser — in JavaScript and TypeScript. LangChain.js, LangGraph.js, the Vercel AI SDK, and the OpenAI Agents TS SDK are first-class citizens here, not afterthoughts. You're learning the deployment language, not just a teaching language.",
        "**Real libraries, not toys.** The cells import genuine LangChain and LangGraph and run them live. You're reading and editing the same APIs you'd use in a real project.",
        "**Your keys stay safe.** You never paste a provider API key into a cell.",
      ],
    },
    {
      type: "diagram",
      visual: "nb-secret-proxy",
      caption:
        "How the cells call models without ever exposing a secret. Your browser holds only a session token; an authenticated proxy injects the real model key server-side. Click to see where the key actually lives — never in the cell.",
    },
    {
      type: "heading",
      text: "How this differs from the rest of agentic-AI education",
      id: "differentiation",
    },
    {
      type: "paragraph",
      text: "There's no shortage of ways to learn about AI agents — video courses, Colab notebooks, framework docs. They're good at what they do. But for *agentic AI specifically*, they share the same blind spots, and that's where AgentSwarms is built differently.",
    },
    {
      type: "diagram",
      visual: "nb-platform-compare",
      caption:
        "An honest comparison across the things that matter for learning agents. Tap any row for the detail — and note we give the others credit where it's due: instructor-led courses still win on depth, and Colab on raw Python and GPUs.",
    },
    {
      type: "list",
      items: [
        "**The TypeScript agent ecosystem, taught hands-on.** LangGraph.js, the Vercel AI SDK, the OpenAI Agents SDK in TS — barely covered anywhere else, fully runnable here.",
        "**Zero friction to the first run.** No install means a beginner reaches a working agent in seconds, not after a setup tutorial they never finish.",
        "**We teach the failure modes.** A whole evals track and the Failure-Mode Labs exist precisely because every other course stops at the happy path — and the happy path is not where production lives.",
        "**It's a platform, not a playlist.** Notebooks sit beside a visual swarm canvas, a model playground, and interactive decks. You can read a concept, run it, build it, and break it without leaving the site.",
        "**You can start for free, immediately.** Real model calls run through a built-in gateway — no 'bring your own paid API key' wall before lesson one.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "Go run one right now",
      text: "The fastest way to understand any of this is to stop reading and press a button. Open the Notebooks section, pick the LangChain fundamentals or a standalone agent, and run the first cell. Then change one line and run it again. That second run is where the learning starts.",
    },
    {
      type: "paragraph",
      text: "We didn't set out to make a statement about Python versus TypeScript. We set out to remove every excuse between a curious person and a running agent. Taking Python off the table forced us to lean all the way into in-browser, zero-install, production-relevant TypeScript — and that turned out to be exactly the classroom agentic AI needed. The best way to learn to build agents is to build them. Now you can, in the next tab.",
    },
  ],
  references: [
    { label: "AgentSwarms Notebooks", url: "https://agentswarms.fyi/notebooks" },
    { label: "LangChain.js documentation", url: "https://js.langchain.com/" },
    { label: "LangGraph.js", url: "https://langchain-ai.github.io/langgraphjs/" },
    { label: "Vercel AI SDK", url: "https://sdk.vercel.ai/docs" },
    { label: "OpenAI Agents SDK (TypeScript)", url: "https://openai.github.io/openai-agents-js/" },
    { label: "Pyodide — Python in the browser via WebAssembly", url: "https://pyodide.org/" },
  ],
};

const word2vecFoundations: BlogPost = {
  slug: "word2vec-the-foundational-root-of-llms",
  title: "Word2Vec: The Foundational Root of Modern LLMs",
  subtitle:
    "Long before GPT-4 and Claude, a small 2013 paper from Mikolov and colleagues at Google quietly rewrote how machines understand language. This is the story of word2vec — from the linguistics it stole, through every matrix multiplication, all the way to the attention blocks of today's frontier models. With interactive math you can poke at.",
  excerpt:
    "A from-scratch, beginner-to-advanced tour of word2vec: the distributional hypothesis, one-hot to dense vectors, CBOW vs Skip-gram, the softmax bottleneck and negative sampling, vector arithmetic that does analogies — and the straight line from that 2013 idea to the embedding and attention layers of modern LLMs.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-08",
  readingTime: "22 min read",
  tags: ["Foundations", "Embeddings", "LLMs", "Mathematics"],
  cover: {
    gradient: "from-indigo-500/30 via-primary/20 to-nexus-glow/30",
    icon: "vector",
    motif: "embeddings",
  },
  blocks: [
    {
      type: "lead",
      text: "In 2013, a small team at Google led by Tomáš Mikolov published two short papers that, with the benefit of hindsight, did something enormous: they taught a computer that the relationship between *king* and *queen* is the same kind of relationship as the one between *man* and *woman* — using nothing but raw text and a few hundred lines of code. Every embedding layer in every LLM you use today is a direct descendant of that idea.",
    },
    {
      type: "paragraph",
      text: "If you've ever wondered *why* a transformer's first move is to look up each token in a giant matrix and turn it into a vector — and what that vector actually means — the answer is word2vec. This post is the long-form, beginner-friendly, but math-honest tour. We'll start with the linguistics, walk through every matrix multiplication, derive the loss, fix the bottleneck that almost killed the idea, and end at the embedding + attention stack of a modern LLM. Sliders, animations, and one piece of vector arithmetic you can drag with your mouse included.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "How to read this post",
      text: "Each major section has an interactive visual. The math is presented gently first, then formally. If a formula feels heavy, scroll past it and play with the visual underneath — the intuition almost always survives the equations.",
    },

    {
      type: "heading",
      text: "Part 1 — The idea that made it possible",
      id: "distributional-hypothesis",
    },
    {
      type: "subheading",
      text: "“You shall know a word by the company it keeps.”",
    },
    {
      type: "paragraph",
      text: "That sentence is from the British linguist J.R. Firth in 1957, and it is the single most important sentence in the history of NLP. It's called the **distributional hypothesis**, and it says: the meaning of a word is captured, statistically, by the other words that tend to appear near it.",
    },
    {
      type: "paragraph",
      text: "Take two sentences: *“She poured the **wine** into the glass.”* and *“She poured the **water** into the glass.”* The words *wine* and *water* never have to be defined for you to feel they belong to a similar neighborhood: both are pourable, both end up in glasses, both follow *“she poured the.”* If we collected millions of sentences and tallied which words live next to which, two words with similar neighborhoods would, by definition, mean similar things.",
    },
    {
      type: "diagram",
      visual: "w2v-context-window",
      caption:
        "A center word and a sliding context window of size k. word2vec's training data is just every (center, context) pair you can find. Press play, or drag the window size, to see the pairs the model would actually learn from.",
    },
    {
      type: "paragraph",
      text: "Notice what's *not* in those pairs: no dictionary, no parser, no part-of-speech tags, no grammar rules. Just raw co-occurrence. The bet word2vec makes is that this is enough — that meaning is a statistical artefact of context, and a model with no linguistic knowledge whatsoever can recover it by getting good at predicting which word shows up next to which.",
    },

    {
      type: "heading",
      text: "Part 2 — From words to vectors (the matrix math)",
      id: "onehot-to-dense",
    },
    {
      type: "paragraph",
      text: "A neural network does not eat strings. It eats numbers. So the first job is to turn each word in our vocabulary into a number — and then into a *vector* of numbers, because a single number can't express anything as rich as meaning.",
    },
    {
      type: "subheading",
      text: "Step 1: one-hot vectors (the dumb way)",
    },
    {
      type: "paragraph",
      text: "Suppose our vocabulary has V = 10,000 words. We assign each word an index 0 … V−1, and represent it as a vector of length V that's zero everywhere except a single 1 at its index. So the word *king* might be `[0, 0, …, 1, …, 0]` with the 1 at position 4,217.",
    },
    {
      type: "paragraph",
      text: "This is mathematically clean but useless as a representation: every pair of words is exactly the same distance apart. *king* and *queen* are as “similar” as *king* and *banana*. We need to compress these huge sparse vectors into small dense ones where geometry actually carries meaning.",
    },
    {
      type: "subheading",
      text: "Step 2: an embedding matrix is just a lookup table dressed as math",
    },
    {
      type: "paragraph",
      text: "We create a matrix **E** of shape `V × d`, where d is small — say 300. Row i of **E** is the d-dimensional embedding vector for word i. To get the embedding for word *king*, we compute **x · E**, where **x** is its one-hot vector. Because **x** is zero everywhere except position 4,217, this matrix multiplication picks out exactly row 4,217 of **E**. That's it — “looking up an embedding” is a one-hot times matrix product.",
    },
    {
      type: "diagram",
      visual: "w2v-onehot-matmul",
      caption:
        "Pick a word — watch its one-hot vector multiply the embedding matrix E and pluck out a single row. This is what every embedding layer in every transformer does on its very first step.",
    },
    {
      type: "code",
      language: "python",
      code: `# A V×d embedding matrix is literally a learnable lookup table.
import numpy as np
V, d = 10_000, 300
E = np.random.randn(V, d) * 0.01     # random init, will be learned

word_to_id = {"king": 4217, "queen": 4218, "man": 901, "woman": 902}

def embed(word: str) -> np.ndarray:
    one_hot = np.zeros(V)
    one_hot[word_to_id[word]] = 1.0
    return one_hot @ E                # equivalent to E[word_to_id[word]]

print(embed("king").shape)            # (300,)`,
    },
    {
      type: "callout",
      tone: "info",
      title: "Why d = 300 and not 10,000?",
      text: "Compression forces the model to *invent* structure. With only 300 dimensions to work with, the network can't memorise — it has to discover that certain directions in vector space correspond to gender, tense, plurality, sentiment, etc. The dimensions aren't labelled, but they emerge.",
    },

    {
      type: "heading",
      text: "Part 3 — The two training games: CBOW and Skip-gram",
      id: "cbow-skipgram",
    },
    {
      type: "paragraph",
      text: "We now have a giant matrix **E** of random numbers. We need a training signal that nudges similar-meaning words toward similar rows. word2vec frames this as a self-supervised game with the corpus as the only teacher.",
    },
    {
      type: "list",
      items: [
        "**CBOW (Continuous Bag-of-Words)** — given the surrounding context words, predict the center word. Fast, smooths over noise, works well on frequent words.",
        "**Skip-gram** — given the center word, predict each of the surrounding context words. Slower per step, but much better at rare words and at capturing fine-grained relationships. This is the variant most people mean when they say “word2vec”.",
      ],
    },
    {
      type: "diagram",
      visual: "w2v-cbow-skipgram",
      caption:
        "Toggle between CBOW and Skip-gram. Both share the same embedding matrix E, but the direction of the arrows — what predicts what — is flipped. That single architectural choice changes everything about training dynamics.",
    },
    {
      type: "subheading",
      text: "The forward pass, in honest math",
    },
    {
      type: "paragraph",
      text: "Skip-gram has *two* matrices to learn: an **input** embedding matrix **E** (shape V×d) for center words, and an **output** embedding matrix **U** (shape V×d) for context words. Most people don't realise there are two — but the asymmetry matters, and at the end we usually throw **U** away and keep only **E** as “the embeddings”.",
    },
    {
      type: "paragraph",
      text: "Given a center word c, we compute its center embedding **v_c = E[c]**. To score how likely each candidate word w is to be a context word, we take the dot product **u_w · v_c**, where **u_w = U[w]**. A higher dot product means more similar in direction, which we interpret as more likely. To turn V raw scores into a proper probability distribution, we apply softmax:",
    },
    {
      type: "code",
      language: "text",
      code: `P(w | c) = exp(u_w · v_c) / Σ_{w' ∈ V} exp(u_{w'} · v_c)`,
    },
    {
      type: "paragraph",
      text: "The training loss for a single (center, context) pair is just the negative log-likelihood of the true context word: `L = −log P(w_true | c)`. Sum this over every (center, context) pair in the corpus, run SGD, and the gradients gently rotate the rows of **E** and **U** so that words appearing in similar contexts end up with similar directions.",
    },
    {
      type: "callout",
      tone: "info",
      title: "The geometry, in one line",
      text: "Two words are 'similar' if their embedding vectors point in similar directions — measured by cosine similarity, which is just the normalised dot product. Length doesn't matter; angle does.",
    },

    {
      type: "heading",
      text: "Part 4 — The softmax problem (and the trick that fixed it)",
      id: "negative-sampling",
    },
    {
      type: "paragraph",
      text: "Look back at that softmax denominator. It's a sum over **every word in the vocabulary**. For V = 100,000 words, every single training step requires 100,000 dot products and exponentials — and then a backward pass updating every output row **u_w'**. With billions of (center, context) pairs in a real corpus, this is computationally hopeless. This is why earlier neural language models from Bengio (2003) had been famously slow.",
    },
    {
      type: "diagram",
      visual: "w2v-softmax-cost",
      caption:
        "Drag the vocabulary size slider. The orange bar is the cost of a full softmax per training step; the green bar is negative sampling with k = 5 negatives. The gap is the reason word2vec could train on billions of words on commodity hardware in 2013.",
    },
    {
      type: "subheading",
      text: "Negative sampling: turn one giant classification into many tiny ones",
    },
    {
      type: "paragraph",
      text: "Mikolov's second paper introduced **negative sampling**, the trick that made word2vec practical. Instead of asking *“which of these 100,000 words is the right context word?”*, we ask a much cheaper binary question: *“is this pair (center, candidate) a real one from the corpus, or did I make it up?”*",
    },
    {
      type: "paragraph",
      text: "For each true (c, w) pair, we sample k ≈ 5–20 random *negative* words from the vocabulary (weighted by a smoothed unigram distribution, P(w)^0.75, which down-weights very frequent words). We then train the model to push the dot product up for the real pair and down for the negatives, using a sigmoid loss instead of softmax:",
    },
    {
      type: "code",
      language: "text",
      code: `L = −log σ(u_w · v_c)   −   Σ_{i=1..k} log σ(−u_{w_i} · v_c)
                ↑                            ↑
        the true context word        k random negatives`,
    },
    {
      type: "paragraph",
      text: "Each step now touches only k+1 output rows instead of all V — a 1000× speedup on a 100k-word vocabulary with k=10. This single change is what turned a clever idea into a paper everybody could reproduce on a laptop. (The other common trick, **hierarchical softmax**, uses a Huffman tree to reduce the cost to O(log V); negative sampling won in practice because it's simpler and trains faster on big corpora.)",
    },
    {
      type: "callout",
      tone: "tip",
      title: "Why this matters for LLMs",
      text: "The exact same problem — a softmax over a vocabulary of 50k–250k tokens — shows up in every transformer's output layer. Modern LLMs pay the full cost there because they only do it once per output token, but the lineage of tricks (sampled softmax, sub-word tokenisation, speculative decoding) all trace back to the same scaling pressure Mikolov first hit.",
    },

    {
      type: "heading",
      text: "Part 5 — The magic trick: vector arithmetic",
      id: "vector-arithmetic",
    },
    {
      type: "paragraph",
      text: "Once you've trained the model, something startling falls out for free. The embeddings turn out to encode *relationships* as approximately constant **vector offsets**. The classic example:",
    },
    {
      type: "code",
      language: "text",
      code: `vec("king") − vec("man") + vec("woman") ≈ vec("queen")`,
    },
    {
      type: "paragraph",
      text: "Equivalently: the vector that takes you from *man* to *king* is almost the same vector that takes you from *woman* to *queen*. That vector means, roughly, *“add royalty.”* The model was never told what royalty is — it discovered the direction from co-occurrence statistics alone. The same trick works for verb tense (*walk → walked* parallel to *swim → swam*), country/capital pairs (*Paris − France + Italy ≈ Rome*), and dozens of other linguistic regularities.",
    },
    {
      type: "diagram",
      visual: "w2v-analogy",
      caption:
        "An interactive 2D projection of real word2vec-style embeddings. Pick an analogy template — watch the model walk king → −man → +woman and land near queen. Try the country–capital and tense templates too.",
    },
    {
      type: "subheading",
      text: "Why does this work? A handwave that turns out to be true",
    },
    {
      type: "paragraph",
      text: "Intuitively: if *king* and *queen* differ only in gender, and *man* and *woman* also differ only in gender, then both differences must point in roughly the same direction in vector space — the *gender axis*. Subtracting cancels everything they have in common (royalty, humanity, age, etc.) and leaves only the gender component. Adding *woman* then re-applies that component to *king*, landing on *queen*.",
    },
    {
      type: "paragraph",
      text: "Formally, Levy & Goldberg (2014) showed that the skip-gram-with-negative-sampling objective is implicitly factorising a shifted PMI (pointwise mutual information) matrix of word co-occurrences. The arithmetic works because PMI of (king, royal) and PMI of (queen, royal) are similar; PMI of (king, male) and PMI of (queen, female) are also similar; and when you subtract and add, the consistent components survive.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "An honest caveat",
      text: "Real corpora encode real human biases. The same vector arithmetic that gives you king−man+woman = queen also gives you doctor−man+woman = nurse on many corpora. word2vec is a mirror; whatever is in the text comes out in the geometry. This was one of the earliest, cleanest demonstrations of dataset bias in ML.",
    },

    {
      type: "heading",
      text: "Part 6 — From word2vec to modern LLMs",
      id: "to-llms",
    },
    {
      type: "paragraph",
      text: "Word2vec's central trick — *learn an embedding matrix so that prediction-from-context works* — is alive in every model on the OpenAI, Anthropic, and Google leaderboards. What changed?",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Tokens instead of words.** Modern tokenisers (BPE, WordPiece, SentencePiece) split text into sub-words like `▁agent`, `▁swarm`. The embedding matrix becomes a token-vector matrix, but the shape is identical: vocab_size × d.",
        "**Context-dependent vectors.** Word2vec gives each word a single static vector — *bank* (river) and *bank* (money) collide. Transformers solve this with **self-attention**: each token's output vector is a weighted sum of every other token's vector in the sequence, so the representation of *bank* literally depends on whether *river* or *deposit* is nearby.",
        "**Deeper stacks.** Word2vec is one shallow layer of embeddings + one projection. A transformer is dozens of attention + feed-forward layers operating on those same starting vectors. The first matrix lookup is pure word2vec; everything after is post-processing.",
        "**Much bigger d and V.** Frontier LLMs use vocabularies of 100k–250k tokens and embedding dimensions of 4k–18k. Same shape, three orders of magnitude bigger.",
      ],
    },
    {
      type: "diagram",
      visual: "w2v-to-transformers",
      caption:
        "The straight line from word2vec to transformers. The embedding-matrix lookup at the start is unchanged from 2013. Attention is the new piece that fixes the one-vector-per-word problem.",
    },
    {
      type: "subheading",
      text: "Where word2vec lives today",
    },
    {
      type: "paragraph",
      text: "Beyond being the conceptual ancestor of every LLM embedding layer, word2vec — and its close cousins **GloVe** and **FastText** — are still the right tool for plenty of jobs:",
    },
    {
      type: "list",
      items: [
        "**Lightweight semantic search** when you need millions of vectors on a CPU and don't want to pay for a transformer encoder.",
        "**RAG candidate retrieval** where dense retrievers like BGE, E5, and OpenAI's embedding APIs are direct descendants — same `text → vector` interface, much better quality, courtesy of a transformer encoder trained on the same kind of contrastive objective negative sampling pioneered.",
        "**Recommender systems**: item2vec, user2vec, prod2vec — same algorithm, products instead of words.",
        "**Graph embeddings**: node2vec, DeepWalk — random walks on a graph become 'sentences', then it's just skip-gram again.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "If you build agents, you build on word2vec",
      text: "Every time your agent retrieves a memory by embedding similarity, every time your RAG pipeline finds a relevant chunk, every time a transformer attends to a token — you are using a refined, scaled-up version of the same idea Mikolov shipped in 2013. The matrix has gotten bigger; the trick is the same.",
    },

    {
      type: "heading",
      text: "Part 7 — A reading order if you want to go deeper",
      id: "deeper",
    },
    {
      type: "list",
      items: [
        "**Mikolov et al., 2013a** — *Efficient Estimation of Word Representations in Vector Space.* Introduces CBOW and Skip-gram. Six pages, no fluff.",
        "**Mikolov et al., 2013b** — *Distributed Representations of Words and Phrases and their Compositionality.* Introduces negative sampling, sub-sampling of frequent words, and the phrase-detection trick.",
        "**Levy & Goldberg, 2014** — *Neural Word Embedding as Implicit Matrix Factorization.* The “oh, that's what's really happening” paper.",
        "**Pennington, Socher & Manning, 2014** — *GloVe.* A different objective (global co-occurrence factorisation) reaching almost identical embeddings — a strong sanity check on the whole programme.",
        "**Devlin et al., 2018** — *BERT.* The moment context-dependent embeddings replaced static ones as the default.",
        "**Vaswani et al., 2017** — *Attention Is All You Need.* The architecture that made BERT and everything after possible.",
      ],
    },

    {
      type: "heading",
      text: "Wrapping up",
      id: "wrap",
    },
    {
      type: "paragraph",
      text: "Word2vec is one of those rare ideas where the implementation is short enough to read in an afternoon, the math is honest enough to actually understand, and the consequences are large enough that you're still using it — in disguise — every time you talk to an LLM. If this post was your first encounter, the best follow-up is to open a notebook and train one yourself on a few megabytes of text. You will be surprised how quickly *king − man + woman* starts pointing at *queen* in a vector space you built with your own hands.",
    },
    {
      type: "paragraph",
      text: "And the next time someone tells you transformers are a totally new paradigm, you can smile and remember: the very first thing every one of them does is multiply a one-hot vector by a learned matrix. Mikolov already shipped that in 2013.",
    },
  ],
  references: [
    {
      label:
        "Mikolov et al. (2013) — Efficient Estimation of Word Representations (arXiv:1301.3781)",
      url: "https://arxiv.org/abs/1301.3781",
    },
    {
      label:
        "Mikolov et al. (2013) — Distributed Representations / Negative Sampling (arXiv:1310.4546)",
      url: "https://arxiv.org/abs/1310.4546",
    },
    {
      label: "Levy & Goldberg (2014) — Word Embedding as Implicit Matrix Factorization",
      url: "https://papers.nips.cc/paper/5477-neural-word-embedding-as-implicit-matrix-factorization",
    },
    {
      label: "Pennington, Socher & Manning (2014) — GloVe",
      url: "https://nlp.stanford.edu/projects/glove/",
    },
    {
      label: "Vaswani et al. (2017) — Attention Is All You Need",
      url: "https://arxiv.org/abs/1706.03762",
    },
    { label: "Devlin et al. (2018) — BERT", url: "https://arxiv.org/abs/1810.04805" },
    {
      label: "Original word2vec C source — Google Code archive",
      url: "https://code.google.com/archive/p/word2vec/",
    },
    {
      label: "AgentSwarms Notebooks — embeddings build-alongs",
      url: "https://agentswarms.fyi/notebooks",
    },
  ],
};

const securingAgenticAi: BlogPost = {
  slug: "securing-agentic-ai-layered-defense",
  title: "Securing Agentic AI: A Layered Defense Playbook",
  subtitle:
    "Agents aren't chatbots with extra steps — they read untrusted text, hold credentials, call tools, write to memory, and reach the public internet. Securing one means securing seven layers at once. Here's how to do it, with reference architectures for AWS Bedrock AgentCore, Azure AI Foundry Agents, and Gemini Enterprise / Vertex Agent Engine, plus the open-source stack that fills the gaps.",
  excerpt:
    "A layer-by-layer security playbook for production agents — identity, prompt, model, tools, memory, network, governance — with reference architectures for Bedrock AgentCore, Azure AI Foundry, and Vertex Agent Engine, and an open-source toolkit to harden the rest.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-09",
  readingTime: "22 min read",
  tags: ["Security", "Production", "AWS", "Azure", "GCP"],
  cover: {
    gradient: "from-rose-500/30 via-primary/20 to-indigo-500/30",
    icon: "network",
    motif: "security",
  },
  blocks: [
    {
      type: "lead",
      text: "A 2024-era chatbot had one attack surface: the prompt. A 2026-era agent has at least seven. It authenticates as a workload identity, reads documents an attacker may have written, decides which tools to call, mutates a long-lived memory store, talks to external APIs, runs sandboxed code, and leaves an audit trail you'll either trust in court or won't. Every one of those is a separate trust boundary, and they fail in ways the classic AppSec playbook doesn't cover.",
    },
    {
      type: "paragraph",
      text: "This post is the playbook we wish we'd had on day one of shipping agents to enterprises. We'll move top-down through the layers, name the threats at each, list the controls that close them, then translate the abstract picture into concrete reference architectures on the three platforms most readers are deploying on: **AWS Bedrock AgentCore**, **Azure AI Foundry Agent Service**, and **Google Vertex AI Agent Engine / Gemini Enterprise**. We'll end with the open-source and third-party stack that picks up where managed services stop.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "How to read this post",
      text: "If you ship to one cloud, skim the other two — the patterns translate. If you're an early-stage team, jump to the **Layered defense** section and the **Open-source stack** at the end. If you're an enterprise architect, the reference diagrams are designed to drop into a threat model.",
    },

    { type: "heading", text: "Why agents are a new attack surface", id: "why-different" },
    {
      type: "paragraph",
      text: "Three properties make agentic systems different — and harder — from a security standpoint:",
    },
    {
      type: "list",
      items: [
        "**They mix trust levels in the same context window.** A system prompt (trusted), a user message (semi-trusted), retrieved documents (often untrusted), tool outputs (untrusted), and conversation memory (variable) all become one flat string the model reasons over. The model has no built-in mechanism to keep them apart.",
        "**They hold credentials and act on them.** Unlike a stateless chatbot, an agent calls APIs, writes to databases, sends email, executes code. A successful injection isn't just a wrong answer — it's an unauthorized transaction.",
        "**They learn, remember, and self-modify.** Long-term memory, skills, sub-agent spawning and self-evaluation mean today's safe agent can quietly drift into tomorrow's compromised one without a code change.",
      ],
    },
    {
      type: "paragraph",
      text: "Simon Willison crystallized the worst-case as the **lethal trifecta**: any agent that simultaneously has (1) access to private data, (2) exposure to untrusted content, and (3) the ability to communicate externally can be turned into a data-exfiltration tool by a single well-crafted document. The whole layered model below is, in essence, a discipline for never letting all three line up at once — or, if they must, ringing them with so many tripwires the attack still fails.",
    },
    {
      type: "paragraph",
      text: "We covered this from the architecture side in [Production System Design for Agentic AI](/blog/production-system-design-for-agentic-ai) and from the failure-mode side in [7 Failure Modes That Kill Multi-Agent Systems](/blog/7-failure-modes-that-kill-multi-agent-systems). This post is the security-first companion.",
    },

    { type: "heading", text: "The seven layers of agent security", id: "layers" },
    {
      type: "paragraph",
      text: "Pick a layer and the diagram below shows the dominant threats and the controls that earn their keep. Each subsequent section drills into a layer in detail.",
    },
    {
      type: "diagram",
      visual: "sec-layer-stack",
      caption:
        "Click any of the seven layers. Each pairs the threats that show up there with the cheapest controls that close most of them. Skipping a layer is rarely free; the threat just resurfaces one tier up.",
    },

    { type: "subheading", text: "Mapping to OWASP LLM Top 10 (2025)" },
    {
      type: "paragraph",
      text: "If you owe an auditor a checklist, the OWASP LLM Top 10 is the lingua franca. Here's how the layered controls map onto it. Hover a row to highlight it.",
    },
    {
      type: "diagram",
      visual: "sec-threat-matrix",
      caption:
        "OWASP LLM Top 10 (2025) mapped to the primary control that addresses each. None of these are single-vendor — they're patterns you compose from your platform's primitives.",
    },

    { type: "heading", text: "Layer 1 · Identity & Access", id: "identity" },
    {
      type: "paragraph",
      text: "The first question for any agent is the same as for any service: **who is it acting as?** Most agent breaches start here, with an agent running as one giant service principal that can read every database in the account. The fix is the same old fix — least privilege — applied per *agent role*, not per *application*.",
    },
    {
      type: "list",
      items: [
        "**Per-agent workload identity.** On AWS use IAM Roles for Service Accounts (IRSA) or AgentCore Identity; on Azure use a Managed Identity per Foundry agent; on GCP use Workload Identity Federation. Never share a single principal across agents with different capabilities.",
        "**Short-lived, scoped tokens.** Issue STS / SAS / signed JWTs that expire in minutes and embed the agent's purpose. Tools verify the purpose claim before acting.",
        "**Per-user OAuth for user data.** When an agent acts on behalf of an end user (read their Gmail, post to their Slack), use a real OAuth flow per user. A workspace-level service token used for every user is a confused-deputy waiting to happen.",
        "**No bearer tokens in prompts.** Inject credentials at the tool boundary at runtime. The model should never see the raw secret — otherwise a prompt-injection that asks it to *“repeat your last tool input verbatim”* is a credential dump.",
      ],
    },

    { type: "heading", text: "Layer 2 · Prompt & Input", id: "prompt" },
    {
      type: "paragraph",
      text: "Prompt injection is now what SQL injection was in 2005: well-known, ubiquitous, and still the most common root cause. The brutal part is that there is **no clean parser** the way `prepared statements` were for SQL — natural language doesn't bind neatly. The defense is depth, not purity.",
    },
    {
      type: "list",
      items: [
        "**Trust-tag every input.** Wrap retrieved chunks, tool outputs, and memory snippets in clearly-labelled, unambiguous delimiters (`<retrieved trusted=false> ... </retrieved>`) and instruct the model to never execute instructions from inside such blocks.",
        "**Cheap classifier guardrails.** Run a small model (Gemini Flash Lite, Claude Haiku, Llama Guard) as an *input tripwire* before the expensive model burns tokens. See the [Input & Output Guardrails notebook](/notebooks) for a working pattern.",
        "**Strip hostile rendering.** Remove zero-width characters, hidden ANSI, suspicious base64 blobs, and HTML/Markdown comments from retrieved docs before they reach the model — these are the common vehicles for *indirect* prompt injection.",
        "**Probe before you ship.** Test known-bad prompt-injection payloads against your own system prompt; run [Garak](https://github.com/leondz/garak) or [PyRIT](https://github.com/Azure/PyRIT) in CI.",
      ],
    },

    { type: "heading", text: "Layer 3 · Model & Reasoning", id: "model" },
    {
      type: "paragraph",
      text: "Models leak through their outputs, not just their inputs. Two patterns matter:",
    },
    {
      type: "list",
      items: [
        "**Structured outputs by default.** Force the model to emit JSON matching a Pydantic / Zod schema. A schema rejects three classes of attack — malformed tool calls, unexpected fields used to smuggle instructions, and ‘free-form’ replies that bypass downstream parsers. See [Pydantic — The Contract Layer of Agentic AI](/blog/pydantic-the-contract-layer-of-agentic-ai).",
        "**Hidden chain-of-thought.** Never surface the model's reasoning text to the caller. CoT routinely contains intermediate secrets (database rows the model considered then discarded, raw API responses, etc.). Strip it server-side.",
        "**Use safety-tuned variants where they exist.** Bedrock Guardrails, Azure Content Safety + Prompt Shields, and Gemini Safety Settings catch obvious-bad without you having to write a classifier.",
        "**Pin model versions.** Don't let a silent upgrade of `gpt-4-latest` revert your jailbreak fixes. Pin per environment and ship version bumps through the same eval gate as code.",
      ],
    },

    { type: "heading", text: "Layer 4 · Tools / MCP", id: "tools" },
    {
      type: "paragraph",
      text: "Tools are where intent becomes *action*. Three things separate a well-secured tool layer from a disaster waiting to happen:",
    },
    {
      type: "list",
      items: [
        "**Capability scoping per agent role.** A `summarizer` agent doesn't get the `send_email` tool, period. Don't pass *“all available tools”* into every agent; the LLM will eventually find a creative use for the one you forgot to remove.",
        "**Tool-broker as policy point.** Put a thin server between the agent and the tool that re-validates inputs against a schema, checks the calling agent's identity, applies per-tool rate limits, and writes an audit row. The model can lie about its intent; the broker can't be talked out of its checks.",
        "**MCP servers behind an allowlist registry.** The MCP ecosystem is exploding and packages get yanked, replaced, or quietly compromised. Maintain an internal registry of pinned, signed MCP servers — see [MCP Production Playbook 2026](/blog/mcp-production-playbook-2026).",
        "**Human-in-the-loop for high-blast actions.** Any action that costs money, sends a customer message, or mutates production data should pause for explicit approval. Build it into the agent loop from day one; bolting it on later is expensive.",
      ],
    },
    {
      type: "callout",
      tone: "warn",
      title: "The lethal trifecta",
      text: "If your agent can read sensitive data, can be exposed to untrusted text, and can talk to the outside world — and you cannot remove one of those legs — assume an exfiltration channel exists. Add an egress proxy, an output guardrail that scans for known-secret patterns, and rate-limit external calls. The architecture in [Production System Design](/blog/production-system-design-for-agentic-ai) walks through breaking the trifecta in detail.",
    },

    { type: "heading", text: "Layer 5 · Memory & Data", id: "memory" },
    {
      type: "paragraph",
      text: "Long-term memory is what makes agents useful and what makes them dangerous. A poisoned memory entry written on Monday silently steers every conversation that week. A multi-tenant agent that mixes one customer's notes into another's response is a breach with regulatory consequences.",
    },
    {
      type: "list",
      items: [
        "**Tenant-scoped namespaces.** Every memory write/read passes through a tenant ID; the vector store enforces partition isolation, not the application code.",
        "**Provenance on every memory.** Store *who wrote this, when, from which session*. When something looks off, you can trace the source — and revoke its successors.",
        "**Encrypt at rest with CMK.** KMS / Key Vault / CMEK with customer-managed keys gives you a kill switch. Drop the key, the data is unreadable, even by the platform.",
        "**RAG source vetting.** Treat indexed documents as part of your supply chain. Hash content, watch for unexpected diffs, and apply [doc-staleness controls](/blog/when-your-documents-change-keeping-rag-honest) so the index doesn't drift into a poisoned state without you noticing.",
      ],
    },

    { type: "heading", text: "Layer 6 · Network & Runtime", id: "network" },
    {
      type: "paragraph",
      text: "Code that an LLM generated and an LLM decided to run is, by definition, not something you reviewed. Run it like you'd run user-supplied code: in a sandbox, in a private network, with egress controls.",
    },
    {
      type: "list",
      items: [
        "**Sandboxed code execution.** Bedrock AgentCore's Code Interpreter, Vertex's sandboxed exec, or self-hosted E2B / Firecracker / gVisor microVMs. No persistent filesystem, no network unless explicitly enabled, hard CPU and wall-clock limits.",
        "**Egress allowlist.** Force all outbound calls through a proxy that whitelists destinations. An injection that tries to POST a secret to `attacker.example.com` should fail at the network, not at the model.",
        "**Signed images + SBOM scanning.** Sign every container with Cosign, scan with Snyk / Trivy on every build, refuse to deploy unsigned or critical-CVE images.",
        "**Private VPC, no public ingress to internals.** Tools, memory stores, and vector DBs live in private subnets. The only public surface is the agent's API gateway.",
      ],
    },

    { type: "heading", text: "Layer 7 · Observability & Governance", id: "observability" },
    {
      type: "paragraph",
      text: "If you can't see what your agents did, you can't prove they did it correctly — and you can't catch the day they stop. Observability is the layer that makes every other control *enforceable*.",
    },
    {
      type: "list",
      items: [
        "**Trace every step.** OpenTelemetry GenAI conventions are now stable; emit one span per model call, per tool call, per guardrail decision. Hash inputs/outputs so traces are searchable without dumping PII into logs.",
        "**Tamper-evident audit log.** For regulated workloads, write tool-call audit rows to an append-only store (S3 Object Lock, Azure immutable blob, GCS bucket lock).",
        "**Continuous eval + red-team in CI.** Every prompt or tool change goes through an eval suite that includes injection attempts and known jailbreaks. Block the deploy if quality or safety regresses.",
        "**Per-agent budgets + anomaly alerts.** Cost spikes are often the first signal of a runaway loop or a compromise. See [Cost Control in Multi-Agent Systems](/blog/cost-control-in-multi-agent-systems).",
      ],
    },
    {
      type: "diagram",
      visual: "sec-defense-in-depth",
      caption:
        "A single request, eight trust boundaries. The pulsing highlight shows where the request currently is. Any single layer can refuse, redact, or downgrade — that's what makes defense-in-depth survive a single mistake.",
    },

    { type: "divider" },

    { type: "heading", text: "Reference architecture · AWS Bedrock AgentCore", id: "aws-bedrock" },
    {
      type: "paragraph",
      text: "Bedrock AgentCore (GA late 2025) is AWS's purpose-built agent runtime: session-isolated microVMs, an Identity service, a managed Memory store, a Gateway that exposes tools over MCP, and built-in Observability. It is opinionated about isolation, which is good for security.",
    },
    {
      type: "diagram",
      visual: "sec-bedrock-agentcore",
      caption:
        "A production-shape Bedrock AgentCore deployment, grouped by the four security domains: identity, runtime, data/tools, observability. Each block is a real AWS primitive — none of this is bespoke.",
    },
    { type: "subheading", text: "Minimal IaC sketch" },
    {
      type: "code",
      language: "hcl",
      code: `# Terraform — production-shape AgentCore agent
resource "aws_iam_role" "agent_runtime" {
  name = "swarm-support-agent"
  assume_role_policy = data.aws_iam_policy_document.bedrock_trust.json
}

# Per-agent role, scoped to ONE knowledge base + ONE Lambda tool
data "aws_iam_policy_document" "agent_perms" {
  statement {
    actions   = ["bedrock:Retrieve", "bedrock:InvokeModel"]
    resources = [aws_bedrockagent_knowledge_base.support.arn, var.model_arn]
  }
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.crm_lookup.arn]
  }
}

resource "aws_bedrock_guardrail" "support" {
  name = "support-guardrail"
  topic_policy_config {
    topics_config { name = "competitors" type = "DENY" }
  }
  sensitive_information_policy_config {
    pii_entities_config { type = "EMAIL" action = "BLOCK" }
    pii_entities_config { type = "CREDIT_DEBIT_CARD_NUMBER" action = "BLOCK" }
  }
  contextual_grounding_policy_config {
    filters_config { type = "GROUNDING" threshold = 0.7 }
  }
}

# Code interpreter / browser run in isolated microVMs by default —
# session isolation is enforced by AgentCore, not by your code.`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "AgentCore-specific wins",
      text: "Session isolation is enforced by the runtime, not by your application code — a single agent process never sees two sessions' state. Bedrock Guardrails apply both to the model output AND to retrieved context (contextual grounding). Use both. The integration with CloudTrail gives you a no-extra-work audit log.",
    },

    {
      type: "heading",
      text: "Reference architecture · Azure AI Foundry Agents",
      id: "azure-foundry",
    },
    {
      type: "paragraph",
      text: "Azure AI Foundry Agent Service is Microsoft's hosted agent runtime, paired with Entra-based identity, Content Safety (including Prompt Shields), and tight integration into Azure AI Search and the broader Azure data plane. If your data lives in Microsoft 365 or Azure SQL, Foundry's per-user On-Behalf-Of (OBO) flow is the cleanest path to per-user ACLs.",
    },
    {
      type: "diagram",
      visual: "sec-azure-foundry",
      caption:
        "An Azure AI Foundry agent deployed inside a VNet with Private Endpoints, Entra-managed identity, Prompt Shields, and Application Insights tracing. Note the OBO flow for any tool that touches user data.",
    },
    {
      type: "code",
      language: "python",
      code: `# Azure AI Foundry — agent with Content Safety + Prompt Shields enabled
from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential

project = AIProjectClient.from_connection_string(
    credential=DefaultAzureCredential(),  # managed identity, NOT a key
    conn_str=os.environ["FOUNDRY_CONN"],
)

agent = project.agents.create_agent(
    model="gpt-4o-2025-04",
    name="support-agent",
    instructions=SYSTEM_PROMPT,                     # never contains secrets
    tools=[search_tool, ticket_tool],               # least-privilege tool set
    content_safety={                                # Prompt Shields ON
        "prompt_shield": {"mode": "block"},
        "protected_material": {"mode": "block"},
        "groundedness": {"mode": "warn", "threshold": 0.75},
    },
    tracing_enabled=True,                           # App Insights
)

# Tools that touch USER data use OBO so RBAC is enforced as that user,
# not as the agent's managed identity.
search_tool = AzureAISearchTool(
    index="kb-prod",
    on_behalf_of=user_token,
)`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "Foundry-specific wins",
      text: "Prompt Shields catches direct + indirect injection inline. Connected Agents over A2A let you keep specialist agents in *separate* Foundry projects with independent permissions, instead of one mega-agent that holds every capability. Defender for Cloud surfaces agent-specific findings (over-permissive identity, missing Content Safety) without extra wiring.",
    },

    {
      type: "heading",
      text: "Reference architecture · Gemini Enterprise / Vertex Agent Engine",
      id: "gcp-vertex",
    },
    {
      type: "paragraph",
      text: "Google's stack splits across two products: **Vertex AI Agent Engine** (a managed runtime for agents you build with ADK, LangChain, or LangGraph) and **Gemini Enterprise** (a search + assistant layer over your connected data sources, with per-user ACL filtering). Both sit inside VPC Service Controls and benefit from Google's CMEK, IAM, and Model Armor primitives.",
    },
    {
      type: "diagram",
      visual: "sec-gemini-enterprise",
      caption:
        "Vertex Agent Engine + Gemini Enterprise inside a VPC-SC perimeter. Per-user OAuth and Discovery Engine ACL filtering give you row-level access control on retrieval — uncommon outside this stack.",
    },
    {
      type: "code",
      language: "python",
      code: `# Vertex Agent Engine — deploy an ADK agent with Model Armor + safety settings
from vertexai import agent_engines
from google.adk.agents import Agent
from google.adk.tools import google_search

agent = Agent(
    name="research-agent",
    model="gemini-2.5-pro",
    instructions=SYSTEM_PROMPT,
    tools=[google_search],
    safety_settings=STRICT_SAFETY,         # block HARM_CATEGORY_*
)

deployed = agent_engines.create(
    agent_engine=agent,
    display_name="research-prod",
    service_account="research-agent@proj.iam.gserviceaccount.com",  # least-priv SA
    # Model Armor scans BOTH inbound prompts and outbound responses
    model_armor={"prompt_template_id": "armor-prod-strict"},
    # CMEK + VPC-SC inherited from the project perimeter
)

# Gemini Enterprise streamAssist — per-user ACLs enforced by Discovery Engine
# so the assistant only retrieves docs the END USER can already see.
# Auth = the END USER's Google OAuth access token (not a service-account token),
# so Discovery Engine can filter results by that user's Drive / Workspace ACLs.
response = requests.post(
    f"https://discoveryengine.googleapis.com/v1alpha/{assistant}:streamAssist",
    headers={"Authorization": f"Bearer {user_google_access_token}"},
    json={"query": {"text": question},
          "toolsSpec": {"vertexAiSearchSpec": {}}},
)`,
    },
    {
      type: "callout",
      tone: "tip",
      title: "GCP-specific wins",
      text: "VPC Service Controls is the strongest data-exfiltration boundary of the three clouds — it blocks even authenticated API calls that would move data outside your perimeter. Discovery Engine ACL inheritance means a Gemini Enterprise assistant *cannot* return a document the calling user couldn't already open in Drive. That's per-row authorization for free.",
    },

    { type: "divider" },

    { type: "heading", text: "Open-source & 3rd-party stack", id: "open-source" },
    {
      type: "paragraph",
      text: "Managed services give you a strong baseline, but real production agents lean on open-source and third-party tools for the parts the platforms don't cover well — model-aware red-teaming, runtime AI firewalls, multi-cloud observability, deeper sandboxing.",
    },
    {
      type: "diagram",
      visual: "sec-tools-landscape",
      caption:
        "The 2026 agent-security tooling landscape, grouped by the layer they harden. Most production teams use 2–4 of these alongside their cloud provider's primitives.",
    },
    { type: "subheading", text: "What we recommend by maturity stage" },
    {
      type: "list",
      ordered: true,
      items: [
        "**Day 1 (prototype):** Add a cheap input guardrail (Llama Guard 3 or a Flash-Lite classifier). Wire OpenTelemetry GenAI traces to [Langfuse](https://langfuse.com) or [Arize Phoenix](https://phoenix.arize.com). Use Pydantic / Zod for every tool input.",
        "**First production deploy:** Add an output guardrail with Guardrails AI or NeMo Guardrails. Move code execution into E2B / Firecracker microVMs. Stand up an egress proxy with a small allowlist.",
        "**Scaling out:** Add red-team in CI with Garak or PyRIT. Sign artifacts with Sigstore / Cosign. Run an [AI Firewall](https://protectai.com) (Protect AI, Lakera, HiddenLayer) at the edge.",
        "**Regulated / enterprise:** Add tamper-evident audit logs, per-tenant CMK, formal red-team via Microsoft PyRIT or NVIDIA AI Red Team, and continuous evaluations as deploy gates.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "Try the controls inside AgentSwarms",
      text: "Most of the patterns above are runnable in the [AgentSwarms notebook lab](/notebooks): the *Guardrails (Tripwires)* notebook builds an OpenAI-Agents-style input/output guard, the *PII Sanitizer* notebook is a working middleware shim, and the *Failure Modes* lab reproduces lethal-trifecta exfil and lets you patch it.",
    },

    {
      type: "heading",
      text: "A checklist you can take to a threat-modelling session",
      id: "checklist",
    },
    {
      type: "list",
      items: [
        "Every agent has its own workload identity and a least-privilege policy.",
        "All retrieved / tool / memory content is wrapped in trust-tagged delimiters.",
        "An input guardrail runs before the expensive model on every call.",
        "Tool inputs validated against a strict schema by a tool broker, not by the model.",
        "Egress is allowlisted; no agent can POST to an arbitrary domain.",
        "Code execution is sandboxed; sandboxes have no persistent storage.",
        "Memory and vector stores are tenant-partitioned at the storage layer.",
        "An output guardrail scrubs PII / known secrets before the response leaves.",
        "Every model call, tool call, and guardrail decision emits an OTel span.",
        "Audit log is append-only and survives a malicious deletion attempt.",
        "Red-team and eval suites run in CI; deploys block on regression.",
        "Per-agent cost / latency / refusal-rate alerts are wired to on-call.",
      ],
    },
    {
      type: "paragraph",
      text: "If you can answer *yes* to every line on a given agent, you're ahead of the median enterprise deployment in 2026. If you can't — that's your roadmap.",
    },

    { type: "heading", text: "Going deeper", id: "deeper" },
    {
      type: "paragraph",
      text: "Security is a layer of every other concern, not a separate concern. The posts in the related list go one level deeper into each of the patterns we touched here — production architecture, failure modes, MCP, RAG freshness, cost control. The Explore section links to the tools in AgentSwarms you can use to validate each control on your own agent today.",
    },
    {
      type: "paragraph",
      text: "And if you're hiring for or interviewing into a senior agentic-AI role, [Agentic AI Interview Questions 2026](/blog/agentic-ai-interview-questions-2026) now leads with security questions. That's not a coincidence — it's how the market is pricing this discipline.",
    },
  ],
  references: [
    {
      label: "OWASP Top 10 for LLM Applications (2025)",
      url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
    },
    {
      label: "MITRE ATLAS — Adversarial threat landscape for AI systems",
      url: "https://atlas.mitre.org/",
    },
    {
      label: "Simon Willison — The lethal trifecta for AI agents",
      url: "https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/",
    },
    {
      label: "AWS — Bedrock AgentCore documentation",
      url: "https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore.html",
    },
    {
      label: "Microsoft — Azure AI Foundry Agent Service",
      url: "https://learn.microsoft.com/azure/ai-foundry/agents/",
    },
    {
      label: "Microsoft — Prompt Shields in Azure AI Content Safety",
      url: "https://learn.microsoft.com/azure/ai-services/content-safety/concepts/jailbreak-detection",
    },
    {
      label: "Google Cloud — Vertex AI Agent Engine",
      url: "https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview",
    },
    {
      label: "Google Cloud — Model Armor",
      url: "https://cloud.google.com/security-command-center/docs/model-armor-overview",
    },
    { label: "NVIDIA NeMo Guardrails", url: "https://github.com/NVIDIA/NeMo-Guardrails" },
    { label: "NVIDIA Garak — LLM vulnerability scanner", url: "https://github.com/leondz/garak" },
    {
      label: "Microsoft PyRIT — Python Risk Identification Tool",
      url: "https://github.com/Azure/PyRIT",
    },
    {
      label: "OpenTelemetry — GenAI semantic conventions",
      url: "https://opentelemetry.io/docs/specs/semconv/gen-ai/",
    },
  ],
};

const lowCodeBuilders: BlogPost = {
  slug: "flowise-vs-langflow-vs-dify-vs-n8n-vs-agentswarms",
  title: "Flowise vs Langflow vs Dify vs n8n vs AgentSwarms: The Honest 2026 Comparison",
  subtitle:
    "Five tools, five very different jobs. A side-by-side look at what each one is actually for, where they overlap, where they don't, and which one belongs in your stack — written by someone who has shipped with all of them.",
  excerpt:
    "n8n is a workflow engine, Flowise is a LangChainJS canvas, Langflow is a Python LangChain canvas, Dify is an LLM app platform, AgentSwarms is a multi-agent design studio. Here's the deep comparison nobody else writes.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-12",
  readingTime: "18 min read",
  tags: ["Frameworks", "Low-code", "Tooling"],
  cover: {
    gradient: "from-emerald-500/30 via-primary/20 to-violet-500/30",
    icon: "scale",
    motif: "compare",
  },
  blocks: [
    {
      type: "lead",
      text: "If you've spent a weekend on r/LocalLLaMA or AI Twitter, you've seen the same question three different ways: *“Should I use Flowise or Langflow?” “Is Dify just n8n with vibes?” “Why would I pick AgentSwarms over any of these?”* The honest answer is that these five tools were never really competing for the same job — they only *look* similar because they all have a canvas with boxes and arrows. Let's untangle them.",
    },
    {
      type: "paragraph",
      text: "I've shipped real things with every one of these platforms — a customer-support copilot on Dify, a marketing-ops mess of Slack triggers on n8n, a RAG prototype on Flowise that became a Langflow demo that became a LangGraph service. Each one was the right pick for *that* job and wrong for the next. The point of this post isn't to crown a winner. It's to give you a mental model so you stop wasting Saturdays on the wrong tool.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "TL;DR — pick by intent, not by stars",
      text: "**n8n** for automation glue with AI sprinkled in. **Flowise** for the fastest visual LangChainJS chatbot. **Langflow** if your team lives in Python and wants a LangChain GUI. **Dify** when you need a *product* (chat UI + RAG + APIs + analytics) end-to-end. **AgentSwarms** is an **education-and-PoC platform** — learn agentic AI and multi-agent systems hands-on, prototype the architecture, then *deploy* via Flowise / Langflow / Dify / n8n or an exported framework runtime (LangGraph / CrewAI / OpenAI Agents SDK).",
    },
    {
      type: "callout",
      tone: "info",
      title: "Where AgentSwarms fits — and where it doesn't",
      text: "AgentSwarms is **not** a production runtime and doesn't try to be. It's the place you go *before* you commit to Flowise, Langflow, Dify, n8n, LangGraph or CrewAI — to actually understand agentic AI, multi-agent patterns, RAG failure modes, and tool-calling, then prototype your swarm on a visual canvas and export the design. For deployment, you take that design to one of the runtimes in this post. AgentSwarms is currently in a **generous free tier** — full access to the labs, swarm canvas, notebooks, and exports at no cost. A **Pro tier** with higher limits and team features is on the roadmap.",
    },
    {
      type: "heading",
      text: "Why this comparison is usually wrong",
      id: "why-confusing",
    },
    {
      type: "paragraph",
      text: "Most “X vs Y” posts compare these tools on surface features: *do they have a node for OpenAI? Do they support vector stores? Is there a chat widget?* Almost everything does, almost everything does, and almost everything does. The feature grid converges; the *philosophies* don't.",
    },
    {
      type: "paragraph",
      text: "These tools live on different axes. One axis is **what they orchestrate** — generic workflows (n8n) vs LLM chains (Flowise/Langflow) vs whole LLM applications (Dify) vs multi-agent swarms (AgentSwarms). The other axis is **who they're for** — non-developer ops folks, full-stack devs, ML engineers, or platform teams. Plot the five on those axes and the “overlap” mostly disappears:",
    },
    {
      type: "diagram",
      visual: "lcb-quadrant",
      caption:
        "Five tools, five neighborhoods. n8n sits firmly in workflow-automation land. Flowise and Langflow are LLM-canvas siblings. Dify is the closest to a finished product. AgentSwarms leans furthest into framework-grade agent design.",
    },
    {
      type: "heading",
      text: "The one-paragraph identity of each",
      id: "identities",
    },
    {
      type: "subheading",
      text: "n8n — the workflow engine that learned to call LLMs",
    },
    {
      type: "paragraph",
      text: "n8n started life in 2019 as a self-hostable Zapier alternative and that DNA still runs the show. The atomic unit is a *workflow*: a trigger (webhook, cron, app event) fans out through nodes that hit ~400 integrations — Slack, HubSpot, Postgres, S3, Notion, your own HTTP endpoints. AI showed up later as a first-class **AI Agent** node and a small library of LangChain-flavored building blocks, but the gravity of the product is still *connect things and move data*. If your problem is mostly *integration* with a dash of *intelligence*, you're in the right place.",
    },
    {
      type: "subheading",
      text: "Flowise — the LangChainJS canvas",
    },
    {
      type: "paragraph",
      text: "Flowise is a TypeScript/Node.js drag-drop builder that wraps **LangChainJS**. Drop in a Chat Model, attach a Document Loader, point at a vector store, wire it to a Chat UI — and you have a working RAG bot in an hour. Its sweet spot is the *small, sharp LLM app*: a knowledge-base chatbot, a custom search assistant, an internal helper. There's a marketplace of templates, a hosted chatbot widget, and a clean API. It's permissively licensed and trivially self-hostable. The trade is that everything happens in JavaScript and the underlying abstractions are pure LangChain — if you outgrow LangChain, you'll feel it.",
    },
    {
      type: "subheading",
      text: "Langflow — the Python sibling, now part of DataStax",
    },
    {
      type: "paragraph",
      text: "Langflow is what Flowise is, but built around **LangChain Python**, with a heavier emphasis on producing flows you can serialize and run from a real Python service. After DataStax acquired it in 2024 (and then IBM acquired DataStax in 2025), it leaned harder into enterprise — Astra DB integration, MIT license, a hosted offering. If your runtime is going to be Python and you want a visual prototyping surface that maps cleanly to LangChain objects your engineers can read, Langflow is the path of least surprise.",
    },
    {
      type: "subheading",
      text: "Dify — the LLM application platform (BaaS for AI apps)",
    },
    {
      type: "paragraph",
      text: "Dify is the most *product-shaped* of the five. It bundles a prompt IDE, a workflow/agent/chatbot app builder, a built-in dataset and RAG pipeline, a hosted chat UI, an API gateway with keys and rate limits, and usage analytics — into a single open-source platform. If the artifact you want is a *running LLM product* with users, keys, and dashboards (not just a Python script that calls OpenAI), Dify covers a remarkable amount of ground. It's effectively a backend-as-a-service for LLM apps, and that's both its biggest strength and the reason it can feel heavy for a quick prototype.",
    },
    {
      type: "subheading",
      text: "AgentSwarms — multi-agent design with a portable runtime",
    },
    {
      type: "paragraph",
      text: "AgentSwarms is the one in this list explicitly built for **multi-agent** systems and the awkward parts of running them — orchestration patterns, observability, failure-mode practice, and *escape velocity from any single framework's API*. You design the swarm on a visual canvas, exercise the failure modes in the labs, then export the architecture to **LangGraph, CrewAI, the OpenAI Agents SDK, or Strands** to run wherever you want. The pitch isn't “replace your framework” — it's *“get the architecture right before you marry a framework's API.”*",
    },
    {
      type: "heading",
      text: "Where each tool sits in your stack",
      id: "stack",
    },
    {
      type: "paragraph",
      text: "A lot of teams end up using two or three of these together. That only feels obvious once you see them stacked by layer rather than racing in a feature grid:",
    },
    {
      type: "diagram",
      visual: "lcb-stack-arch",
      caption:
        "Not a horse race — a stack. n8n connects the world. Flowise / Langflow / Dify build the LLM app. AgentSwarms designs the multi-agent shape and exports to a runtime framework. They compose more than they compete.",
    },
    {
      type: "heading",
      text: "The honest feature matrix",
      id: "matrix",
    },
    {
      type: "paragraph",
      text: "Every comparison post owes you a table. Here's one — but read it as *“what is this product really trying to be good at”* rather than a scorecard. A red dot is rarely a flaw; it's usually a deliberate scope choice.",
    },
    {
      type: "diagram",
      visual: "lcb-feature-matrix",
      caption:
        "Color-coded support, not points. A platform isn't worse because it doesn't ship a feature outside its lane — it's *focused*.",
    },
    {
      type: "heading",
      text: "Pick by the job, not the demo",
      id: "use-case",
    },
    {
      type: "paragraph",
      text: "When folks ping me asking which one to use, the actual decision almost always falls out of the first sentence they say. *“I need to…”* and then they describe a job. Match the job and the answer is usually obvious:",
    },
    {
      type: "diagram",
      visual: "lcb-use-case-matcher",
      caption:
        "Click through the jobs. The recommendation isn't ideology — it's where each platform's gravity actually lives.",
    },
    {
      type: "heading",
      text: "The pieces almost nobody writes about",
      id: "operations",
    },
    {
      type: "subheading",
      text: "Multi-agent vs single-chain",
    },
    {
      type: "paragraph",
      text: "Flowise and Langflow grew up modeling *chains*: a linear-ish pipeline through prompts, retrievers, and tools. Both have since added agentic constructs (Flowise has *AgentFlows*, Langflow has agent components), but the mental model is still chain-first. Dify is more agent-aware out of the box — its *Agent* and *Workflow* apps support tool use, multi-step planning, and conditional branching cleanly. n8n's AI Agent node does ReAct-style tool use inside a workflow node. AgentSwarms is the only one that treats *multiple cooperating agents with explicit handoffs, parallel fan-out, and routing patterns* as the primary unit — and exports that design to a framework that runs it natively.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Single agent vs swarm — when does it matter?",
      text: "If your task is one model with three tools, a chain is fine. The moment you have *specialized roles* (researcher → writer → reviewer), *parallel work* (10 sub-questions answered concurrently), or *long-horizon control flow* with checkpoints, you're in swarm territory — and the tool that models swarms natively will save you weeks.",
    },
    {
      type: "subheading",
      text: "Observability and evals",
    },
    {
      type: "paragraph",
      text: "Every platform claims “observability” because every platform shows you a log. The real question is whether you can answer: *which node failed, on which input, with which prompt, costing how many tokens, against which evaluation*? Dify ships the most complete answer out of the box for *apps*. AgentSwarms ships traces and **failure-mode labs** specifically tuned to multi-agent breakage (cascading hallucinations, runaway loops, context bleed). Flowise and Langflow rely on you bolting on LangSmith / Langfuse. n8n's execution log is excellent for workflows but thin on LLM specifics.",
    },
    {
      type: "subheading",
      text: "RAG quality",
    },
    {
      type: "paragraph",
      text: "All five can do RAG. None of them, by default, do *good* RAG. The retrieval defaults are usually a single vector store, top-k cosine similarity, and a naive chunker. Dify gives you the most knobs in the UI (parent-child chunking, hybrid search, rerankers). Flowise/Langflow expose the LangChain ecosystem so you can wire anything. AgentSwarms emphasizes a Graph-RAG path on top of the basic vector flow. n8n is honestly the weakest here — its RAG nodes are functional but minimal; you'll usually call out to a real retrieval service.",
    },
    {
      type: "subheading",
      text: "Deployment, licensing, and the bill",
    },
    {
      type: "diagram",
      visual: "lcb-pricing",
      caption:
        "Snapshot of license + hosting + pricing. Self-host is real on n8n / Flowise / Langflow / Dify. AgentSwarms is a managed product whose *output* (exported code) is yours to run anywhere.",
    },
    {
      type: "paragraph",
      text: "License nuance matters more than people admit. **n8n** uses the *Sustainable Use License* — free for internal use, restricted for hosting it as a paid service. **Flowise** ships under a permissive OSS license, as does **Langflow** (MIT). **Dify** is permissive but has brand/multi-tenant restrictions in its license you should read before you fork it for a product. **AgentSwarms** itself is SaaS, but the artifacts it produces — your LangGraph / CrewAI / OpenAI Agents code — are yours under their respective OSS licenses. The lock-in profile is genuinely different from a self-hosted runtime: if AgentSwarms vanished tomorrow, your exported swarms would keep running.",
    },
    {
      type: "heading",
      text: "Common combinations that actually work",
      id: "combos",
    },
    {
      type: "list",
      items: [
        "**n8n + Dify** — n8n handles cross-app triggers (new Zendesk ticket → enrich → call Dify app → write back). Each tool does what it's best at.",
        "**Flowise inside n8n** — host a Flowise chatflow and call it as an HTTP node from a wider n8n workflow.",
        "**AgentSwarms → LangGraph in production** — design the swarm visually, run the failure-mode labs, export LangGraph code, deploy on your own infra.",
        "**Langflow for prototyping, plain LangChain for prod** — visual exploration, then hand-coded chains your engineers can actually maintain.",
        "**Dify for the customer-facing app, n8n for the internal automations** — almost every real LLM product looks like this within a year.",
      ],
    },
    {
      type: "heading",
      text: "Where each one *isn't* a great fit",
      id: "anti-patterns",
    },
    {
      type: "list",
      items: [
        "**n8n** is the wrong place to design a sophisticated multi-agent system. Its AI Agent node is great for one-shot tool use; it isn't a serious orchestrator.",
        "**Flowise** struggles once you need non-trivial state, complex routing, or anything outside the LangChainJS object model. It's a chatflow tool, not an app platform.",
        "**Langflow** has the same chain-first gravity. Also, its release cadence has bumpy moments — pin versions before you ship to prod.",
        "**Dify** can feel like a lot of platform for a tiny chatbot. If all you need is one RAG endpoint, you'll write more YAML than code.",
        "**AgentSwarms** is not where you go to wire 30 SaaS triggers or build a static workflow — it's optimized for the *agent-system* shape, not generic automation.",
      ],
    },
    {
      type: "heading",
      text: "A decision rubric you can paste into your design doc",
      id: "rubric",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**What's the artifact?** A workflow → n8n. A chatbot → Flowise/Dify. A multi-agent system → AgentSwarms. A whole LLM product with users → Dify.",
        "**Who maintains it?** Ops/non-developers → n8n or Dify. JS team → Flowise. Python team → Langflow. ML/platform team → AgentSwarms exporting to a framework.",
        "**Is the differentiator the orchestration?** If yes, you want to *own* the orchestration code. Design it in AgentSwarms, export to LangGraph, version it in git.",
        "**How long does this need to live?** Prototype → any of them. 2-year product → favor tools whose runtime you can host, version, and grep through.",
        "**What happens when the vendor changes?** Read the license. The honest cost of a free tool is sometimes paid years later in a forced migration.",
      ],
    },
    {
      type: "heading",
      text: "So which one should *you* use?",
      id: "verdict",
    },
    {
      type: "paragraph",
      text: "The most useful thing I can tell you is that this isn't a single choice. The teams I see ship the best LLM products use **two or three** of these in concert: an automation layer (n8n), an app layer (Dify or Flowise), and — when the system has more than one specialist agent — an agent-design layer (AgentSwarms) feeding a real framework runtime. The wrong move is to pick whichever GitHub repo had the most stars this month and try to bend it to every job. Each of these tools is excellent at the shape it was built for. Pick by that shape, and the “which one” question dissolves.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Try the multi-agent layer for free",
      text: "If your problem is genuinely *multi-agent*, design it on the AgentSwarms canvas, run it through the Failure-Mode Labs, and export to [LangGraph](/blog/langgraph-vs-crewai-vs-autogen-2026), CrewAI, the OpenAI Agents SDK, or Strands. You'll know the architecture is right before you commit to a framework's API.",
    },
  ],
  references: [
    { label: "n8n documentation", url: "https://docs.n8n.io/" },
    { label: "Flowise — GitHub", url: "https://github.com/FlowiseAI/Flowise" },
    { label: "Langflow — GitHub", url: "https://github.com/langflow-ai/langflow" },
    { label: "Dify — GitHub", url: "https://github.com/langgenius/dify" },
    { label: "n8n Sustainable Use License", url: "https://docs.n8n.io/sustainable-use-license/" },
    {
      label: "AgentSwarms — multi-agent design + framework export",
      url: "https://agentswarms.fyi",
    },
  ],
};

const retrievalRerank: BlogPost = {
  slug: "retrieval-chunking-reranking-and-when-llamaindex-helps",
  title: "Retrieval, Chunking, and Reranking: The Parts of RAG That Actually Decide Quality",
  subtitle:
    "Everyone obsesses over the model. But the answer was decided three steps earlier — in how you split the text, how you searched it, and whether you bothered to re-rank. Here's the part of the pipeline that quietly makes or breaks RAG, plus an honest take on when LlamaIndex earns its place and when it's just ceremony.",
  excerpt:
    "Chunking, two-stage retrieval, and cross-encoder reranking decide RAG quality more than the LLM does. A practical guide — popular reranker models, when each fits, and where LlamaIndex helps vs where it's overkill.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-13",
  readingTime: "19 min read",
  tags: ["RAG", "Retrieval", "LlamaIndex"],
  cover: {
    gradient: "from-primary/30 via-nexus-glow/20 to-emerald-500/30",
    icon: "network",
    motif: "retrieval",
  },
  blocks: [
    {
      type: "lead",
      text: "The bug report said the assistant was “hallucinating.” It wasn't. I pulled the trace, and the model had answered faithfully from the three chunks it was handed — they just happened to be the wrong three. The chunk that actually answered the question was sitting at retrieval rank 7, one slot outside the window we passed to the model. We hadn't given it a chance. We'd given it a worse problem and blamed it for failing.",
    },
    {
      type: "paragraph",
      text: "I've watched a dozen teams reach for a bigger model when the real fix was upstream. RAG quality is mostly decided before the LLM ever runs — in three unglamorous steps: how you *cut* the text, how you *find* the candidates, and whether you *re-rank* them before stuffing the prompt. Get those right and a mid-tier model looks brilliant. Get them wrong and GPT-5 will confidently answer from garbage.",
    },
    {
      type: "paragraph",
      text: "This post is about those three steps, in the order they bite you: **chunking**, **retrieval**, and **reranking**. Then the question everyone eventually asks — *do I need LlamaIndex for this, or am I adding a framework to justify the diagram?*",
    },
    {
      type: "heading",
      text: "Retrieval is two jobs, not one",
      id: "two-jobs",
    },
    {
      type: "paragraph",
      text: "The single most useful mental model I can give you: retrieval has to do two things that pull in opposite directions. First, **recall** — cast a wide enough net that the right passage is *somewhere* in your candidates. Second, **precision** — make sure the few chunks you actually hand the model are the *best* ones, not just the on-topic ones.",
    },
    {
      type: "paragraph",
      text: "A single vector search is decent at the first job and bad at the second. It will happily return 50 chunks that are all *about* the topic, but it's surprisingly bad at telling you which one *answers the question*. That's why serious RAG is almost always **two-stage**: a fast retriever casts the net, then a slower, sharper reranker decides the final order. Toggle the second stage on and off below and watch what reaches the model:",
    },
    {
      type: "diagram",
      visual: "rcr-two-stage",
      caption:
        "Two-stage retrieval. Stage one trades precision for recall — grab 50 candidates, cheap and fast. Stage two re-scores them properly and keeps the best 3. Turn it off and the answer chunk (rank #7) never reaches the model.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "The one-line version",
      text: "Retrieve wide, rerank narrow, then generate. If you only add one thing to a naïve RAG pipeline this year, add the reranker — it's the highest-leverage, lowest-effort upgrade in the stack.",
    },
    {
      type: "heading",
      text: "Chunking: the decision you make once and regret for months",
      id: "chunking",
    },
    {
      type: "paragraph",
      text: "Everything downstream inherits your chunking. The embedding model can only embed what you give it; the retriever can only return chunks that exist; the reranker can only reorder what was retrieved. If you split a procedure across two chunks so neither one is complete, no amount of reranking will reassemble it. Chunking is the foundation, and like most foundations, nobody notices it until it cracks.",
    },
    {
      type: "paragraph",
      text: "The core tension is simple. **Small chunks** match precisely — a tight passage about exactly one thing embeds into a sharp, specific vector. But small chunks are fragments: the model gets a sentence with no surrounding context. **Large chunks** carry their context with them, but the embedding has to average a paragraph of mixed ideas into one vector, so it matches everything weakly and nothing strongly — and it drags noise into your prompt. Drag the size around and watch both gauges fight each other:",
    },
    {
      type: "diagram",
      visual: "rcr-chunking-lab",
      caption:
        "The chunk-size tradeoff. Precision falls as chunks grow; context completeness rises. For most prose the sweet spot lives around 256–512 tokens — big enough to hold one whole idea, small enough to stay specific.",
    },
    {
      type: "paragraph",
      text: "Sizes are only half of it — *how* you split matters as much as how big. The strategies I actually reach for, roughly in order of how often:",
    },
    {
      type: "list",
      items: [
        "**Recursive / structure-aware** — split on the document's own boundaries (headings, paragraphs, then sentences) before falling back to a character count. This is the sane default. It respects the shape of the text instead of guillotining mid-sentence.",
        "**Sentence-window (small-to-big)** — embed single sentences for precise matching, but at retrieval time return the sentence *plus its neighbours*. You get the precision of small chunks and the context of large ones. This one quietly fixes a lot of “the answer was half-there” complaints.",
        "**Parent-document** — index small child chunks, but feed the model the larger parent they came from. Same idea as sentence-window, coarser granularity.",
        "**Semantic** — split where the topic actually shifts (using embedding distance between adjacent sentences) rather than at a fixed length. Lovely in theory, more expensive, and worth it mainly for long, rambling documents where fixed sizes cut across ideas.",
        "**Fixed-size with overlap** — the blunt instrument. A fixed token count with ~10–20% overlap so a fact straddling a boundary survives in at least one chunk. Fine for uniform text; crude for structured docs.",
      ],
    },
    {
      type: "callout",
      tone: "warn",
      title: "Overlap is not optional",
      text: "If you split with zero overlap, every chunk boundary is a place where a fact can be cut in half and lost from both sides. A little overlap is cheap insurance. Zero overlap is a guaranteed class of silent retrieval misses.",
    },
    {
      type: "paragraph",
      text: "There's no universal best chunk size, and anyone who quotes you one hasn't seen your documents. Dense API references want different treatment than chatty support articles. The honest workflow is: pick recursive splitting at ~400 tokens with overlap as a starting point, build a small eval set of real questions, and *measure* retrieval before you touch the model.",
    },
    {
      type: "heading",
      text: "Why dense retrieval alone disappoints",
      id: "dense-disappoints",
    },
    {
      type: "paragraph",
      text: "Dense (vector) retrieval works by embedding your query and your chunks into the same space and grabbing the nearest neighbours. It's fast, it scales to millions of chunks, and it captures meaning that keyword search misses. It's also, on its own, a blunt ranker. Here's the failure I see constantly: the top candidates all score within a hair of each other — 0.81, 0.80, 0.79 — because the embedding can tell they're all *on topic* but can't tell which one actually *answers* the question.",
    },
    {
      type: "paragraph",
      text: "Watch it happen. Below, a bi-encoder has returned seven on-topic chunks with nearly-identical scores. The one that contains the real answer is buried at rank 6. Hit the reranker:",
    },
    {
      type: "diagram",
      visual: "rcr-rerank-reorder",
      caption:
        "Dense scores are bunched (0.75–0.81) — the retriever knows these are all relevant but can't separate them. The cross-encoder reads each chunk against the query and the real answer leaps from #6 to #1.",
    },
    {
      type: "paragraph",
      text: "This is not a sign your embeddings are bad. It's structural. A bi-encoder embeds the query and the document *separately* and never lets them interact — it's comparing two summaries from across the room. That's exactly what makes it fast enough to search millions of chunks, and exactly what makes it imprecise at the top.",
    },
    {
      type: "heading",
      text: "What a reranker actually is",
      id: "reranker",
    },
    {
      type: "paragraph",
      text: "A reranker is almost always a **cross-encoder**, and the difference from your retriever is the whole story. A bi-encoder runs the query and a document through the model *separately* and compares the two output vectors. A cross-encoder concatenates them — `[query + document]` — and runs them through the model *together*, so every word of the query can attend to every word of the document. Then it emits a single relevance score. Flip between the two architectures:",
    },
    {
      type: "diagram",
      visual: "rcr-bi-cross",
      caption:
        "Bi-encoder vs cross-encoder. The bi-encoder's two towers let you precompute document vectors and search them with nearest-neighbour math. The cross-encoder sees query and document together — far more accurate, but you can't precompute it.",
    },
    {
      type: "paragraph",
      text: "That “can't precompute it” line is the entire reason for two stages. A cross-encoder has to do a fresh forward pass for *every* query–document pair, so running it over your whole corpus at query time is hopeless — that's millions of forward passes per question. So you don't. You let the cheap bi-encoder narrow a million chunks down to ~50, then spend the cross-encoder's expensive attention only on those 50. You get cross-encoder precision at bi-encoder scale. That's the trick, and it's most of why reranking feels like magic the first time you add it.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Rule of thumb for the window sizes",
      text: "Retrieve 25–100 candidates from the vector store, rerank, and keep the top 3–5 for the prompt. Retrieving too few starves the reranker (it can't promote a chunk that was never fetched). Keeping too many after reranking just re-adds the noise you paid to remove.",
    },
    {
      type: "heading",
      text: "Popular reranker models, and when to reach for each",
      id: "reranker-models",
    },
    {
      type: "paragraph",
      text: "The good news is you rarely train these. There's a healthy market of hosted APIs and open weights, and the choice mostly comes down to four questions: how much latency you can spend, whether the data can leave your network, whether you need multiple languages, and what you're willing to pay. Pick a constraint and see what fits:",
    },
    {
      type: "diagram",
      visual: "rcr-reranker-models",
      caption:
        "Reranker landscape by constraint. Hosted APIs (Cohere, Voyage) are the fastest path to good results. Open weights (BGE, mxbai, the MiniLM cross-encoders) win when cost or privacy says self-host.",
    },
    {
      type: "paragraph",
      text: "The version I give people who don't want to read a table:",
    },
    {
      type: "list",
      items: [
        "**Just want it to work, data can leave the network?** Start with **Cohere Rerank** or **Voyage rerank**. One API call, multilingual, genuinely strong. You'll have a better pipeline this afternoon.",
        "**Need to self-host (privacy, cost, air-gapped)?** **BGE-reranker-v2-m3** is the strong free default — multilingual, runs on a modest GPU, no per-call bill. **mxbai-rerank** is a solid alternative.",
        "**Latency-critical or CPU-only?** The classic **ms-marco-MiniLM** cross-encoders from sentence-transformers are tiny, fast, and have been the reliable baseline for years. Not the highest ceiling, but hard to beat on cost per millisecond.",
        "**Want a middle ground between retriever and reranker?** **ColBERT** (late interaction) scores at the token level and lands between a bi-encoder's speed and a cross-encoder's precision — more infrastructure, but a real option at scale.",
      ],
    },
    {
      type: "paragraph",
      text: "Whatever you pick, the integration shape is the same — score the candidates, sort, truncate:",
    },
    {
      type: "code",
      language: "python",
      code: '# Stage 1: dense retrieval casts the wide net (recall)\ncandidates = vector_store.search(query, top_k=50)\n\n# Stage 2: cross-encoder reranks for precision\nfrom sentence_transformers import CrossEncoder\nreranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")\n\npairs = [(query, c.text) for c in candidates]\nscores = reranker.predict(pairs)              # one forward pass per pair\nranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)\n\n# Keep only the best few for the prompt\ncontext = [c for c, _ in ranked[:4]]',
    },
    {
      type: "paragraph",
      text: "Forty lines, no framework, and it's the biggest quality jump most RAG systems will ever get. Which is a good moment to talk about frameworks.",
    },
    {
      type: "heading",
      text: "Where LlamaIndex fits — and what it actually adds",
      id: "llamaindex",
    },
    {
      type: "paragraph",
      text: "If you've only ever heard “LlamaIndex is a RAG framework,” here's the more useful framing: it's a set of opinionated abstractions over the exact seven layers you'd otherwise hand-write. Loaders, splitters, embeddings, the index, the retriever, the postprocessors (where rerankers live), and the response synthesizer. Nothing it does is impossible without it — the question is whether you want to own that code. Toggle between the raw stack and the LlamaIndex version:",
    },
    {
      type: "diagram",
      visual: "rcr-llamaindex-stack",
      caption:
        "Same seven layers, two ownership models. Raw: every box is code you write and maintain. LlamaIndex: each box is a swappable object — change a splitter or drop in a reranker by editing one line.",
    },
    {
      type: "paragraph",
      text: "So what's the real difference between “normal retrieval” and “retrieval with LlamaIndex”? With the raw approach you call an embeddings API, talk to your vector DB's SDK (pgvector, Qdrant, Pinecone), and write the query, the reranker glue, and the prompt assembly yourself. With LlamaIndex, those become configured components — and, more importantly, you get the *advanced* retrieval patterns for free instead of building each one:",
    },
    {
      type: "list",
      items: [
        "**Heterogeneous loaders** — 100+ connectors via LlamaHub, so Notion + Postgres + a folder of PDFs all become the same node type without three bespoke parsers.",
        "**Advanced retrieval out of the box** — sentence-window, auto-merging, recursive/small-to-big, metadata filtering, and query transforms like HyDE or sub-question decomposition. These are exactly the patterns that are annoying to build by hand.",
        "**Rerankers as one-line postprocessors** — `CohereRerank`, `SentenceTransformerRerank`, or an LLM reranker drop into the query engine as a node postprocessor. Swapping rerankers is a config change.",
        "**Index types beyond plain vector search** — summary, tree, keyword, and property-graph indices when a flat top-k isn't the right structure for your data.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "The honest value",
      text: "LlamaIndex's real payoff isn't the first vector search — that's a weekend either way. It's the third, fourth, and fifth retrieval pattern you'd otherwise build and maintain yourself, plus a consistent way to swap components as requirements shift.",
    },
    {
      type: "heading",
      text: "When LlamaIndex is overkill",
      id: "overkill",
    },
    {
      type: "paragraph",
      text: "I like LlamaIndex. I also routinely talk people out of it. A framework is a trade: you exchange a pile of glue code for a pile of abstractions, and abstractions have a cost — indirection when you debug, a version-churn tax, and the moments where the framework's opinion fights yours and you spend an afternoon learning *its* way to do a thing you could have written in ten lines. That trade is worth it when complexity is genuinely high and a waste when it isn't. Move the scenarios around:",
    },
    {
      type: "diagram",
      visual: "rcr-overkill-quadrant",
      caption:
        "When the framework earns its keep. Single source plus a plain top-k query: raw SDK wins, LlamaIndex is ceremony. Many sources plus multi-step retrieval: the abstractions save real work.",
    },
    {
      type: "paragraph",
      text: "Concretely, skip the framework when most of these are true:",
    },
    {
      type: "list",
      items: [
        "You have **one source** and **one retrieval pattern** — a single pgvector table, plain top-k. A vector-DB SDK and ~40 lines (including the reranker above) cover it with less surface area than the framework's config.",
        "Your corpus is **small and fairly static** — a few hundred to a few thousand chunks. Honestly, plain dense retrieval plus a reranker is often all you need; the fancy index types solve problems you don't have.",
        "You need **tight control over latency or the exact prompt** — frameworks add layers between you and the wire, and that's the last place you want surprises in a hot path.",
        "Your team will **maintain this for years** and values reading plain code over learning a framework's release notes.",
      ],
    },
    {
      type: "paragraph",
      text: "And reach for it when the opposite is true: many heterogeneous sources, retrieval that needs routing or multiple hops, a fast-moving prototype where you're trying five patterns this week, or a team that would rather configure than build. The mistake in both directions is the same — choosing the tool before you've described the job.",
    },
    {
      type: "heading",
      text: "A default recipe that holds up",
      id: "recipe",
    },
    {
      type: "paragraph",
      text: "If you want somewhere to start that won't embarrass you in production, this is the stack I reach for before I know anything special about the data:",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Chunk** with recursive, structure-aware splitting at ~400 tokens and ~15% overlap. Reach for sentence-window if early evals show truncated answers.",
        "**Embed** with a current general-purpose model and store in whatever vector DB you already run. Don't agonize here; the reranker covers a lot of embedding sins.",
        "**Retrieve** the top 50 candidates. Add keyword/BM25 as a hybrid second retriever if your domain is full of exact terms (codes, SKUs, names) — dense search is weak on those.",
        "**Rerank** with a cross-encoder (a hosted API to start, BGE if you self-host) and keep the top 3–5.",
        "**Generate**, and — this is the part everyone skips — **build a 30-question eval set** and measure retrieval hit-rate before you blame the model for anything.",
      ],
    },
    {
      type: "callout",
      tone: "success",
      title: "Build the pipeline, then break it",
      text: "You can wire retrieval, chunking, and a reranker into an agent on the AgentSwarms canvas and watch each stage in the trace — then run the [Failure-Mode Labs](/swarms) to see what a broken retrieval step actually looks like before it happens to you in production.",
    },
    {
      type: "paragraph",
      text: "The throughline of all of this: RAG quality is decided in the boring middle of the pipeline, not at the model. Cut your text so each chunk holds one whole idea. Retrieve wide so the answer is *somewhere* in the candidates. Rerank narrow so the best chunk reaches the model. Add a framework only when the job is complex enough to need one. Do those four things and you'll spend a lot less time accusing your LLM of hallucinating when it was only ever answering the question you actually gave it.",
    },
  ],
  references: [
    { label: "LlamaIndex documentation", url: "https://docs.llamaindex.ai/" },
    {
      label: "Sentence-Transformers — Cross-Encoders / reranking",
      url: "https://www.sbert.net/examples/applications/retrieve_rerank/README.html",
    },
    { label: "Cohere Rerank", url: "https://docs.cohere.com/docs/rerank-overview" },
    {
      label: "BAAI BGE reranker (FlagEmbedding)",
      url: "https://github.com/FlagOpen/FlagEmbedding",
    },
    {
      label: "ColBERT — late interaction retrieval",
      url: "https://github.com/stanford-futuredata/ColBERT",
    },
  ],
};

const buildingMcpServers: BlogPost = {
  slug: "building-mcp-servers-secure-exposure-and-testing-in-agentswarms",
  title: "Building MCP Servers That Agents Can Actually Use — and Trust",
  subtitle:
    "Connecting a remote MCP server to an agent takes five minutes. Building one that's well-designed, safely exposed, and actually tested is the real work. Here's how to build the server, expose it without handing an attacker your database, and wire it into an AgentSwarms agent you can watch in the trace.",
  excerpt:
    "A builder's guide to MCP servers: tool-design best practices, exposing remote servers securely (transports, OAuth scopes, validation, audit), and the exact flow to connect, allow-list, and test a remote server inside an AgentSwarms agent.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-13",
  readingTime: "17 min read",
  tags: ["MCP & Tools", "Production", "Security"],
  cover: {
    gradient: "from-primary/30 via-sky-500/20 to-nexus-glow/30",
    icon: "plug",
    motif: "mcp-build",
  },
  blocks: [
    {
      type: "lead",
      text: "We connected a remote MCP server to an agent in about five minutes. It worked on the first try — the agent listed the tools, called one, came back with the right answer. Everyone was pleased until a teammate asked the only question that mattered: “What can this thing actually do, and to *what* — our staging data or production?” Nobody in the room knew. We'd confused *connected* with *safe*, and *it answered* with *it was tested*. This post is about closing both gaps.",
    },
    {
      type: "paragraph",
      text: "There's a good post already on this site about the protocol itself — the n×m math, the JSON-RPC handshake, the confused-deputy attack — in the [MCP production playbook](/blog/mcp-production-playbook-2026). I won't re-litigate that here. This one is the builder's companion: how to design a server agents use *well*, how to expose a remote one without regret, and the concrete steps to connect and *test* it inside an AgentSwarms agent. Less theory, more “what do I actually type and click.”",
    },
    {
      type: "heading",
      text: "What you're actually building",
      id: "what-you-build",
    },
    {
      type: "paragraph",
      text: "An MCP server is a small, standardized adapter that sits in front of capabilities you already have. It exposes three kinds of things, and most servers only ever use the first:",
    },
    {
      type: "diagram",
      visual: "mcps-anatomy",
      caption:
        "The three things an MCP server can expose. Tools are the workhorse — typed actions the agent invokes. Resources are read-only data it can pull in. Prompts are shareable templates. Under all of it, the server just calls your existing backend.",
    },
    {
      type: "paragraph",
      text: "The protocol underneath is JSON-RPC: the client initializes, asks the server to list its tools, then calls them with typed arguments. If you want to watch that conversation step by step, the playbook has an animated version — here's the short one:",
    },
    {
      type: "diagram",
      visual: "mcp-handshake",
      caption:
        "initialize → tools/list → tools/call → result. The SDK handles all of it; your job is to declare good tools and guard them.",
    },
    {
      type: "heading",
      text: "Designing tools an agent can actually use",
      id: "tool-design",
    },
    {
      type: "paragraph",
      text: "This is the part that separates a server that demos well from one that works in the hands of a model you don't control. A tool isn't an API endpoint with a fancy hat — it's an instruction you're giving to a reasoning system that will read your description literally and call you with whatever it inferred. Sloppy tools produce sloppy agents. Compare the same tool written two ways:",
    },
    {
      type: "diagram",
      visual: "mcps-tool-design",
      caption:
        "The same capability, demo-grade vs production-grade. The name, the description, typed args, a scope, structured errors, and an explicit risk level aren't bureaucracy — they're the difference between a tool a model uses correctly and one it fumbles.",
    },
    {
      type: "list",
      items: [
        "**Name tools like verbs, scope them like nouns** — `refund_order`, not `doStuff` or `handler3`. The agent picks tools by name and description; vague names get mis-selected.",
        "**The description is a prompt** — write it for the model, not for your API docs. State what it does, what it returns, and when *not* to use it. One good sentence prevents a dozen wrong calls.",
        "**Type every argument** and validate server-side before you touch anything real. The model will eventually pass you a string where you wanted an int; decide how that fails on purpose.",
        '**Return structured errors, not stack traces** — `{ "error": "order_not_found" }` is something an agent can reason about and recover from. A 500 with a traceback is something it will hallucinate around.',
        "**Make writes idempotent** — agents retry. A `refund_order` that issues two refunds because the first response timed out is a tool that will cost you money. Take an idempotency key.",
        "**Mark risk explicitly** — read-only tools and destructive tools should not look the same to the system that gates them.",
      ],
    },
    {
      type: "paragraph",
      text: "In practice the SDK makes the protocol disappear, so almost all your effort goes into the contract above. A production-shaped tool looks like this — note how much of it is guarding, not doing:",
    },
    {
      type: "code",
      language: "python",
      code: 'from mcp.server.fastmcp import FastMCP\n\nmcp = FastMCP("orders")\n\n@mcp.tool()\ndef refund_order(order_id: str, reason: str, idempotency_key: str) -> dict:\n    """Issue a refund for an order. HIGH RISK — writes money.\n    Use only after confirming the order exists and is refundable.\n    Returns {status, refund_id} or {error}."""\n    require_scope("orders:refund")                 # authorization, per-action\n    if not (order := db.fetch_order(order_id)):    # validate before acting\n        return {"error": "order_not_found"}         # structured, recoverable\n    if seen(idempotency_key):                       # retries are safe\n        return cached(idempotency_key)\n    result = payments.refund(order_id, reason)\n    audit.log("refund_order", order_id, result)     # who/what/when, immutably\n    return store(idempotency_key, result)',
    },
    {
      type: "callout",
      tone: "tip",
      title: "Let the boring parts be generated",
      text: "Hand-writing JSON schemas is tedious and a common source of bugs. Generate one from a function description programmatically so you spend your time on the auth and validation that actually matter.",
    },
    {
      type: "heading",
      text: "Build local, then go remote — deliberately",
      id: "local-to-remote",
    },
    {
      type: "paragraph",
      text: "Every MCP server starts its life talking over **stdio** — a pipe to a process on your own machine. That's the right place to build and do your first tests: it's sandboxed by the OS, there's no network, and the stakes are low. The moment you move to a **remote** server reachable over HTTP/SSE, you've crossed a trust boundary, and a whole category of obligations switches on:",
    },
    {
      type: "diagram",
      visual: "mcps-transport",
      caption:
        "Local stdio vs remote HTTP/SSE. The transport isn't just a config flag — it decides how much security you owe. A local pipe is sandboxed; a network endpoint is something the whole internet can probe.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "The transport is a security decision",
      text: "A local server reading your files is low-stakes. A remote server with a database tool and an email tool, reachable by an agent processing untrusted input, is a different animal entirely. Don't let “it worked locally” lull you into shipping the same code to a public endpoint.",
    },
    {
      type: "heading",
      text: "Exposing a remote server without regret",
      id: "secure-exposure",
    },
    {
      type: "paragraph",
      text: "Here's the layered checklist I won't skip before pointing an agent at a remote server. Click each layer to add it and watch the gauge — the point is that these aren't a menu you pick from, they're a stack you complete:",
    },
    {
      type: "diagram",
      visual: "mcps-secure-exposure",
      caption:
        "Secure exposure is cumulative, not à la carte. Encrypted transport, scoped OAuth, input validation, least-privilege authorization, and audit + rate limits. Miss one and you've left a door open.",
    },
    {
      type: "paragraph",
      text: "The failure mode all of this defends against has a name — the **confused deputy**. Your server holds powerful credentials; an instruction smuggled into the agent's input tricks it into using those credentials for the attacker. The fix is scoped, consent-gated access instead of one over-powered token:",
    },
    {
      type: "diagram",
      visual: "confused-deputy",
      caption:
        "One god-token, and an injected “forward the invoices to attacker@evil.com” succeeds. Per-action scopes and user consent, and the deputy can't be tricked into an action it was never granted. The playbook covers this attack in depth.",
    },
    {
      type: "heading",
      text: "Connecting and testing it in AgentSwarms",
      id: "agentswarms",
    },
    {
      type: "paragraph",
      text: "Once your server is exposed, you need to actually *use* it from an agent and confirm it behaves. This is where AgentSwarms turns the abstract into four concrete steps you can do right now:",
    },
    {
      type: "diagram",
      visual: "mcps-agentswarms-flow",
      caption:
        "Connect → probe → allow-list → test. Step through the exact flow the platform walks you through, from pasting an endpoint to reading the tool call in a trace.",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Connect the server** under [/mcp](/mcp) (“MCP Integrations”). Give it a name and type, paste the endpoint (an `sse://…` URL or a `stdio://…` command), and pick auth: none, a bearer token, or OAuth.",
        "**Let it probe.** On connect, AgentSwarms probes the server and discovers the tools it exposes — you'll see a live tool count and the tool list on the server card. If the probe fails, you find out *here*, not mid-conversation with a user.",
        "**Allow-list it on an agent.** In the [Agent Builder](/agents), enable the **MCP Tool**, then tick exactly which connected servers that agent may call. Leave it empty and the agent can reach any connected server — usually not what you want.",
        "**Test in the Playground.** Chat with the agent, watch it invoke the remote tools, and open the [trace](/traces) to see every call: which tool, what arguments, what came back. That trace is your proof it did what you think.",
      ],
    },
    {
      type: "callout",
      tone: "info",
      title: "The probe is a test, not decoration",
      text: "A server that connects but exposes zero tools is a misconfiguration you want to catch before an agent depends on it. Re-probe from the [/mcp](/mcp) page any time the server changes its tools — the discovered list is only as fresh as the last probe.",
    },
    {
      type: "heading",
      text: "Scope every agent to the smallest set of servers",
      id: "allow-list",
    },
    {
      type: "paragraph",
      text: "The allow-list is the single most important control on this page, and it's easy to leave wide open. An agent that only needs to look up orders should not be able to reach your internal database server just because both are connected to the workspace. Toggle the servers an agent may call:",
    },
    {
      type: "diagram",
      visual: "mcps-allowlist",
      caption:
        "Per-agent server allow-list. Tick only what the agent needs. An empty list means “any connected server” — convenient in a demo, dangerous in production. The restriction is enforced server-side, not just hidden in the UI.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Build the agent, then watch it work",
      text: "Connect a server at [/mcp](/mcp), enable the MCP Tool on an agent in the [Agent Builder](/agents), and run it in the [Playground](/playground) — every remote tool call shows up in the trace so you can verify behavior before any user does.",
    },
    {
      type: "paragraph",
      text: "MCP is becoming plumbing — boring, ubiquitous, load-bearing, the way HTTP is. The teams that win with it won't be the ones who connected a server fastest; they'll be the ones whose servers are well-designed, scoped, audited, and *tested against a real agent in a real trace*. Build the server like a model will read every word of it, expose it like the internet will probe it, and test it like a user's data is on the line — because eventually, all three are true.",
    },
  ],
  references: [
    { label: "Model Context Protocol — specification", url: "https://modelcontextprotocol.io/" },
    {
      label: "MCP — building servers (quickstart)",
      url: "https://modelcontextprotocol.io/quickstart/server",
    },
    {
      label: "MCP security best practices",
      url: "https://modelcontextprotocol.io/docs/concepts/security",
    },
    {
      label: "AgentSwarms — connect & test MCP servers",
      url: "https://agentswarms.fyi/mcp",
    },
  ],
};

const agenticVsGenerative: BlogPost = {
  slug: "agentic-ai-vs-generative-ai",
  title: "Agentic AI vs Generative AI: The Difference That Actually Matters in 2026",
  subtitle:
    "Two phrases, one giant source of confusion. A plain-English, deeply technical walk-through of where generative AI ends, where agentic AI begins, and how to pick the right shape for the problem in front of you.",
  excerpt:
    "Generative AI predicts the next token. Agentic AI decides what to do next. The gap between those two sentences is the gap between a chatbot and a colleague — and where most teams quietly burn six months.",
  author: "AgentSwarms Authors",
  authorRole: "The AgentSwarms team",
  date: "2026-06-13",
  readingTime: "16 min read",
  tags: ["Agentic AI", "Generative AI", "Foundations"],
  cover: {
    gradient: "from-sky-500/30 via-primary/20 to-emerald-500/30",
    icon: "brain",
    motif: "compare",
  },
  blocks: [
    {
      type: "lead",
      text: "Someone in a stand-up will say *“we're adding agentic AI”* and mean five different things. One person hears “a smarter ChatGPT prompt.” Another hears “a fleet of autonomous services touching production data.” Both will nod. Three months later, the project quietly slips because nobody clarified which one was actually being built. This post is the conversation you wish you'd had on day one.",
    },
    {
      type: "paragraph",
      text: "The cleanest one-liner I've found, after dozens of architecture reviews: **Generative AI predicts the next token. Agentic AI decides the next action.** That's not a marketing distinction — it changes the system you build, the failure modes you'll hit, the bill at the end of the month, and the role of the engineer who maintains it.",
    },
    {
      type: "callout",
      tone: "tip",
      title: "TL;DR — the shape decides everything",
      text: "**Generative AI** is a *function*: prompt in, content out, stateless. **Agentic AI** is a *system*: a goal in, a loop of plan→act→observe→update, and an answer (plus a trace) out. Most real products use *both* — generative calls inside an agentic loop. The mistake is calling a single LLM call “an agent” or treating a real agent like “just another API.”",
    },
    {
      type: "heading",
      text: "What “generative AI” actually means",
      id: "generative",
    },
    {
      type: "paragraph",
      text: "Generative AI is the family of models that *produce content* — text, code, images, audio, video — by sampling from a learned probability distribution. The canonical example is a large language model: you give it a prompt, it runs a forward pass, it emits tokens. There is no goal beyond completing the sequence well, no memory beyond what you stuffed into the context window, no ability to take action in the world.",
    },
    {
      type: "paragraph",
      text: "That sounds reductive, but it's exactly the property that makes generative AI *delightful to ship*. A single model call is **stateless, idempotent, easy to evaluate, easy to cache, and easy to bill for**. You can A/B-test prompts, pin a model version, and reason about p95 latency the way you would about any other HTTP endpoint. Most of the production AI in the world today is still this shape — a smart endpoint behind a feature flag — and that's fine.",
    },
    {
      type: "subheading",
      text: "Where retrieval (RAG) sits",
    },
    {
      type: "paragraph",
      text: "When people say *“we added RAG”* they usually still mean generative AI — they just pre-pend retrieved context to the prompt. The system is still **one call per user turn**. Retrieval makes the answer fresher; it doesn't make the system agentic. The model is not deciding which tool to use, what to remember, or whether to try again. It's still a stateless completer of text.",
    },
    {
      type: "heading",
      text: "What “agentic AI” actually means",
      id: "agentic",
    },
    {
      type: "paragraph",
      text: "Agentic AI is what you get when you wrap a generative model in a **control loop** that gives it three things it doesn't have on its own: *goals, tools, and memory*. The model stops being a function and starts being a participant. It picks the next step, calls a tool, observes the result, updates state, and loops — until the goal is met, a budget is exhausted, or a guardrail trips.",
    },
    {
      type: "diagram",
      visual: "agag-spectrum",
      caption:
        "The spectrum nobody draws clearly. Most products live in the middle three stops. Calling everything to the right of “chat” an *agent* is what muddles the conversation.",
    },
    {
      type: "paragraph",
      text: "On that spectrum, the threshold for *“agentic”* isn't tool use — it's **autonomy over the control flow**. A workflow with a hard-coded `if user_asked_for_refund: call_refund_api()` is automation with an LLM in it. An agent is a system where the LLM itself looks at the situation and decides *“I should call the refund tool now, then check the order status, then draft a reply.”* The branching lives in the model, not in your code.",
    },
    {
      type: "diagram",
      visual: "agag-anatomy",
      caption:
        "Same model under the hood — radically different runtime. Generative is a function call. Agentic is a small event loop with state and side effects.",
    },
    {
      type: "heading",
      text: "Side by side: the honest comparison",
      id: "comparison",
    },
    {
      type: "paragraph",
      text: "Read this as *“what does the platform have to handle natively”* — not as a scorecard. Generative AI being **easier to debug** isn't a flaw of agentic AI; it's the price you pay for the extra capability. The right question is whether the problem needs that capability at all.",
    },
    {
      type: "diagram",
      visual: "agag-matrix",
      caption:
        "Generative wins on simplicity, determinism, and evaluability. Agentic wins on autonomy, memory, and the ability to handle open-ended goals. Pick by which list matches your problem.",
    },
    {
      type: "heading",
      text: "How the underlying model is the same — and the system is not",
      id: "same-model",
    },
    {
      type: "paragraph",
      text: "Here's the part that confuses everyone: **GPT-5, Claude 4.5, Gemini 3, Llama 4 — all of them are generative models.** Agentic AI doesn't use a different family of models. It uses the same models, wrapped in a *scaffold* that adds the missing pieces: a planner, a tool registry, a memory store, a control loop, and (in real systems) an evaluator and guardrails.",
    },
    {
      type: "code",
      language: "python",
      code: `# Generative AI — one stateless call
answer = llm.complete("Summarise this email: …")

# Agentic AI — same llm, very different system
agent = Agent(
    llm=llm,
    tools=[search_inbox, draft_reply, schedule_meeting],
    memory=LongTermMemory(user_id),
    planner=ReActPlanner(),
    guardrails=[budget_cap, pii_filter],
)
result, trace = agent.run("Clear my inbox before 5pm.")`,
    },
    {
      type: "paragraph",
      text: "Everything to the right of the second `agent =` line is the agentic part. The LLM is doing what it always does — predict tokens. What's *new* is that those tokens are now interpreted as **decisions**: which tool to call, what arguments to pass, when to stop. That interpretation layer is where every agentic framework lives — LangGraph, CrewAI, OpenAI Agents SDK, Strands, AutoGen.",
    },
    {
      type: "heading",
      text: "Single agent vs multi-agent — another step nobody flags",
      id: "multi-agent",
    },
    {
      type: "paragraph",
      text: "Once you've crossed into agentic territory, there's a second jump people make without naming it: from **one agent with many tools** to **many agents with explicit roles**. A single agent is usually enough for narrow workflows (the inbox assistant above). A *swarm* earns its complexity when you have specialised roles (researcher → writer → reviewer), parallel sub-tasks, or long-horizon control flow with checkpoints and handoffs.",
    },
    {
      type: "callout",
      tone: "info",
      title: "Don't go multi-agent until you have to",
      text: "Every extra agent multiplies the surface area for cascading hallucinations, runaway loops, and context bleed. The honest rule of thumb: start with one well-designed agent and a small toolbox. Split into multiple agents only when you can name *why* — distinct expertise, parallel work, or a handoff that has to be auditable.",
    },
    {
      type: "heading",
      text: "Where each one breaks in production",
      id: "failure-modes",
    },
    {
      type: "subheading",
      text: "Generative AI failures are boring",
    },
    {
      type: "paragraph",
      text: "Generative systems fail in well-understood ways: hallucinated facts, stale context, prompt-injection in the inputs, model-version drift. They're *boring* in the best sense — you can write a test for each one, gate releases on an eval set, and bound the blast radius because each call is independent.",
    },
    {
      type: "subheading",
      text: "Agentic AI failures are emergent",
    },
    {
      type: "paragraph",
      text: "Agentic systems add a whole new shelf of failure modes that don't exist in single-shot generation: **runaway loops** (the agent keeps calling itself because it can't tell it's done), **tool misfires** (right tool, wrong arguments), **context accumulation** (the trace bloats until the model loses the original goal), **cascading hallucinations** (agent A confidently passes a wrong fact to agent B, who treats it as ground truth), and the **lethal trifecta** — untrusted input + private data + external action — which turns an agent into an exfiltration vector.",
    },
    {
      type: "callout",
      tone: "warn",
      title: "The 3am page is different",
      text: "When a generative endpoint misbehaves, you read the prompt and the response. When an agent misbehaves, you read a *trace* — dozens of steps, tool calls, intermediate plans, memory writes. If your observability stack only logs request/response, you're not ready for production agents.",
    },
    {
      type: "heading",
      text: "Cost, latency, and the bill at the end of the month",
      id: "economics",
    },
    {
      type: "paragraph",
      text: "A generative call has a *predictable* cost — roughly input tokens × in-price + output tokens × out-price. You can model it on a napkin. An agentic run has a **distribution** of costs, not a point estimate. Every step is a model call, every tool result becomes new context, and the loop can iterate any number of times before stopping. A reasonable single-agent task that should take 4 calls can, on a bad day, take 40. That's a 10× blow-up nobody planned for.",
    },
    {
      type: "paragraph",
      text: "In practice, agentic systems need three things generative systems don't: a **step budget** (max iterations), a **token budget** (hard cap per run), and an **alerting layer** that catches when the average run cost drifts by more than ~30% week-over-week. Without those, the first viral week of usage will be a finance incident.",
    },
    {
      type: "heading",
      text: "Which one do I actually need?",
      id: "decision",
    },
    {
      type: "paragraph",
      text: "Click through the four common shapes. The recommendation is empirical — it's what teams who *shipped* the thing settled on, not what looks best in a slide deck.",
    },
    {
      type: "diagram",
      visual: "agag-decision",
      caption:
        "The first two cases cover ~70% of LLM features in production. Don't reach for an agent until the job demands one — and don't reach for a swarm until a single agent visibly can't carry it.",
    },
    {
      type: "heading",
      text: "A decision rubric you can paste into your design doc",
      id: "rubric",
    },
    {
      type: "list",
      ordered: true,
      items: [
        "**Can I write the steps down ahead of time?** If yes, you want a workflow + a generative call inside it — not an agent.",
        "**Does the system need to decide *when* it's done?** If yes, you're agentic. Plan for a control loop, a step budget, and a stop condition.",
        "**Does the system need to call tools with arguments it chose itself?** If yes, you need tool-calling + a registry + permissions. Don't grant write access until you have an audit trail.",
        "**Will more than one specialist agent be better than one generalist?** Only if you can name the specialities and the handoffs. Otherwise, one agent with a richer toolbox is cheaper and easier to debug.",
        "**What happens on the worst run?** Write the answer down. If you can't bound cost, latency, and blast radius, you're not ready for production — and that's true whether the system is generative, agentic, or a swarm.",
      ],
    },
    {
      type: "heading",
      text: "Where AgentSwarms fits in this picture",
      id: "agentswarms",
    },
    {
      type: "paragraph",
      text: "AgentSwarms is an **education and PoC platform** aimed exactly at the moment a team is crossing the generative→agentic boundary. The hardest part of that crossing isn't writing the code — it's *understanding the shape* well enough to design the right system the first time. The labs walk through the failure modes (runaway loops, cascading hallucinations, context bleed, the lethal trifecta) on a visual canvas so you feel them before they bite you in production. The notebooks let you build agents end-to-end with traces, memory, and tool-calling. When you're ready, you export the swarm to **LangGraph, CrewAI, the OpenAI Agents SDK, or Strands** and deploy via [Flowise / Langflow / Dify / n8n](/blog/flowise-vs-langflow-vs-dify-vs-n8n-vs-agentswarms) or your own runtime.",
    },
    {
      type: "callout",
      tone: "success",
      title: "Free while you're learning",
      text: "AgentSwarms is in a **generous free tier** — full access to the labs, swarm canvas, notebooks, and framework exports. A **Pro tier** with higher limits and team features is on the roadmap. Build the architecture right *before* you commit to a runtime — that's the whole point.",
    },
    {
      type: "heading",
      text: "Putting it together",
      id: "verdict",
    },
    {
      type: "paragraph",
      text: "Generative AI is a phenomenal capability and, for most product features, it's all you need — wrap a model call in a good prompt, add retrieval if facts matter, ship it behind a flag. Agentic AI is a different *system shape* you reach for when the job genuinely requires autonomy: open-ended goals, tool use the model has to choose, memory across turns, multiple specialists collaborating. The mistake almost every team makes is calling something “an agent” when it's a workflow, or treating a real agent like “just another endpoint.” Get the shape right and the rest of the decisions — framework, runtime, observability, budget — fall out cleanly.",
    },
  ],
  references: [
    {
      label: "OpenAI — function calling & Agents SDK",
      url: "https://platform.openai.com/docs/guides/function-calling",
    },
    {
      label: "Anthropic — building effective agents",
      url: "https://www.anthropic.com/research/building-effective-agents",
    },
    {
      label: "LangGraph — control flow for agents",
      url: "https://langchain-ai.github.io/langgraph/",
    },
    {
      label: "ReAct: synergising reasoning and acting in language models",
      url: "https://arxiv.org/abs/2210.03629",
    },
    {
      label: "AgentSwarms — multi-agent design + framework export",
      url: "https://agentswarms.fyi",
    },
  ],
};

export const BLOG_POSTS: BlogPost[] = [
  agenticVsGenerative,
  buildingMcpServers,
  retrievalRerank,
  lowCodeBuilders,
  securingAgenticAi,
  word2vecFoundations,
  typescriptNotebooks,

  productionSystemDesign,
  useCaseFeasibility,
  hermesSelfImproving,
  pydanticAgentic,
  memoryManagement,
  agentCostControl,
  gpuForLlms,
  cloudCicdGuide,
  devopsForAgents,
  failureModes,
  frameworkCompare,
  agenticRag,
  mcpPlaybook,
  interviewQuestions,
  ragDocChange,
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
