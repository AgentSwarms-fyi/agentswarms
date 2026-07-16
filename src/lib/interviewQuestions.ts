/**
 * Generative AI & Agentic AI interview questions.
 *
 * Sources synthesized (April 2026):
 *  - Anthropic, "Building effective agents" (Dec 19, 2024) — anthropic.com/research/building-effective-agents
 *  - Anthropic, "Trustworthy agents in practice" (Apr 9, 2026) — anthropic.com/research/trustworthy-agents
 *  - OpenAI, "New tools for building agents" (Mar 11, 2025) — openai.com/index/new-tools-for-building-agents
 *  - OpenAI Agents SDK docs — platform.openai.com/docs/guides/agents
 *  - DataCamp, "Top 30 Agentic AI Interview Questions and Answers for 2026"
 *  - AgenticCareers, "25 Agentic AI Interview Questions You Will Actually Get Asked (2026)"
 *  - Towards AI, "40 Generative AI Interview Questions That Actually Get Asked in 2026"
 *  - Medium / Adil Shamim, "Top 20 RAG Interview Questions Every AI Engineer Should Know" (Mar 2026)
 *  - Glassdoor / Blind / LinkedIn aggregated reports for OpenAI, Anthropic, DeepMind, Hugging Face
 *  - Microsoft GraphRAG paper (Edge et al., 2024, arXiv:2404.16130)
 *  - Liu et al., "Lost in the Middle" (arXiv:2307.03172)
 *
 * Each Q includes:
 *  - average: a competent but unmemorable answer
 *  - standout: what an interviewer says "hire" to — depth, trade-offs, war-stories
 *  - example / caseStudy: real-world references (no invented case studies)
 *  - sources: authoritative quotes/citations to sound credible
 */

export type InterviewLevel = "Screening" | "Mid" | "Senior" | "Staff+";
export type InterviewTopic =
  | "Foundations"
  | "RAG"
  | "Agents"
  | "Multi-Agent"
  | "Prompting"
  | "Tools & MCP"
  | "Evaluation"
  | "Safety & Security"
  | "Fine-Tuning"
  | "System Design"
  | "Memory"
  | "Behavioral"
  | "Cost & Latency";

export type InterviewQuestion = {
  id: string;
  question: string;
  topic: InterviewTopic;
  level: InterviewLevel;
  /** Companies that have asked variants of this (per Glassdoor / Blind / public reports). */
  askedAt?: string[];
  /** A correct but generic answer — gets you to "no" or "maybe". */
  average: string;
  /** What turns the interview into an offer. */
  standout: string;
  /** A natural, spoken-style answer to deliver in the interview — no brackets, links, or citations. */
  interviewAnswer: string;
  /** Real product / case study reference — never invented. */
  example?: string;
  /** Citations & further reading. */
  sources?: { label: string; url: string }[];
};

export const INTERVIEW_TOPICS: InterviewTopic[] = [
  "Foundations",
  "RAG",
  "Agents",
  "Multi-Agent",
  "Prompting",
  "Tools & MCP",
  "Memory",
  "Evaluation",
  "Safety & Security",
  "Fine-Tuning",
  "System Design",
  "Cost & Latency",
  "Behavioral",
];

export const INTERVIEW_LEVELS: InterviewLevel[] = ["Screening", "Mid", "Senior", "Staff+"];

export const interviewQuestions: InterviewQuestion[] = [
  // ─────────────────────────────  FOUNDATIONS  ─────────────────────────────
  {
    id: "what-is-genai",
    topic: "Foundations",
    level: "Screening",
    question: "What is generative AI, and how is it different from predictive ML?",
    askedAt: ["Anthropic", "Meta", "Capital One"],
    average:
      "Generative AI creates new content — text, images, audio, code — instead of just classifying or predicting from existing data. Models like GPT-4 or Claude are large neural networks trained on massive corpora.",
    standout:
      "Frame it the way OpenAI and Anthropic do in their docs: generative models output a *probability distribution over the next token* and sample from it, while predictive ML outputs a class label or scalar. Then pivot to consequences: because outputs are sampled, you must design for non-determinism (eval harnesses, temperature control, output validation) — predictive ML pipelines rarely need any of that. Mention that the same transformer can be used predictively (classification head) or generatively (causal LM head) — the architecture isn't what makes it 'generative', the decoding objective is.",
    interviewAnswer:
      "Generative AI is a class of machine-learning models that produce new content — text, images, audio, code — by learning the underlying patterns of their training data and then sampling from a probability distribution over what comes next. The classic example is a large language model like GPT or Claude, which predicts the next token given everything before it. The important contrast with predictive ML is that predictive systems output a fixed answer like a class label or a number, whereas generative systems sample from a distribution, so they're inherently non-deterministic. That non-determinism is what makes them creative, but it's also why building production systems on top of them is so different from traditional ML — you need evaluation harnesses, you need to control temperature, you need output validation, and you need to design for the fact that the same input can produce slightly different outputs each time. Architecturally, the same transformer can be used either way; what makes a model generative is the decoding objective, not the network itself.",
    example:
      "GitHub Copilot is generative (samples the next code token); GitHub's spam-PR detector is predictive ML on the same code. Same data, very different system design.",
    sources: [
      { label: "OpenAI — How GPT models work", url: "https://platform.openai.com/docs/guides/text-generation" },
      { label: "Anthropic — Core views on AI safety", url: "https://www.anthropic.com/news/core-views-on-ai-safety" },
    ],
  },
  {
    id: "transformer-attention",
    topic: "Foundations",
    level: "Mid",
    question: "Explain self-attention in a transformer and why it matters for LLMs.",
    askedAt: ["OpenAI", "Google DeepMind", "NVIDIA"],
    average:
      "Self-attention lets each token look at every other token in the sequence using Query, Key and Value projections. Attention scores are softmax(QKᵀ/√d) and the output is a weighted sum of V.",
    standout:
      "Add the *why it matters* layer: attention is O(n²) in sequence length — that single fact drives almost every modern decision (KV-cache, FlashAttention, sliding-window attention, MoE, sparse attention, Mamba/SSMs as alternatives). Mention that long-range dependencies were the bottleneck RNNs couldn't solve, and that attention is what made in-context learning possible — without it, few-shot prompting wouldn't work. Bonus: explain why decoder-only models (GPT family) use causal masking and what that means for KV-cache reuse during streaming.",
    interviewAnswer:
      "Self-attention is the mechanism that lets every token in a sequence look at every other token and decide how much each one matters for understanding it. Each token gets projected into a query, a key, and a value vector, you compute attention scores by taking the dot product of queries with keys, scale and softmax them, and then use those scores to take a weighted sum over the values. The reason this matters so much for large language models is that it solves the long-range dependency problem that recurrent networks struggled with, and it's what makes in-context learning and few-shot prompting possible at all. The catch is that attention is quadratic in the sequence length, which is the single fact that drives almost every modern engineering decision in this space — KV caching, FlashAttention, sliding-window attention, mixture of experts, and the whole exploration into linear-time alternatives like state-space models. So when I think about why transformers won and why long context is expensive, the answer to both questions is the same — it's all attention.",
    example:
      "Claude 3.5 Sonnet's 200k-token window and GPT-4o's 128k window are both feasible because of FlashAttention-2 (Dao, 2023), not because attention itself got cheaper.",
    sources: [
      { label: "Vaswani et al. — Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762" },
      { label: "FlashAttention-2 (Dao)", url: "https://arxiv.org/abs/2307.08691" },
    ],
  },
  {
    id: "context-window",
    topic: "Foundations",
    level: "Mid",
    question: "What is a context window, and what are the practical challenges of a large one?",
    askedAt: ["Anthropic", "Cohere", "Hugging Face"],
    average:
      "It's the maximum number of tokens a model can process in a single forward pass. Larger windows mean more in-context learning but cost more compute.",
    standout:
      "Lead with the *Lost in the Middle* finding (Liu et al., 2023, Stanford): retrieval accuracy degrades sharply for information placed in the middle of a long context. So 'just stuff everything in 200k tokens' is a real anti-pattern — you'll see worse answers than a tighter RAG pipeline. Then talk about the cost curve: attention is quadratic, so cost roughly 4× when you 2× context; KV-cache memory grows linearly per layer, which is why long-context inference is memory-bound, not compute-bound. Production answer: rerank to put the most important chunks at the start *and* the end, cap retrieved chunks at 5–10, and instrument recall on mid-context info.",
    interviewAnswer:
      "The context window is the maximum number of tokens a model can read and reason over in a single pass, including both the prompt and the generated output. The obvious benefit of a large window is that you can fit more in-context examples, more retrieved documents, or longer conversations without truncating. The less obvious challenges are what really matter in production. First, attention is quadratic, so doubling the context roughly quadruples the compute and significantly grows memory pressure. Second, even when the model can technically read 200,000 tokens, recall actually degrades for information stuck in the middle of the context — there's a well-known U-shaped curve where the model remembers the beginning and the end much better than the middle. Third, longer context means higher latency and higher cost per call. So in practice, even with huge windows available, the right move is usually to keep prompts tight, retrieve only the most relevant chunks, and place the most important information at the start and the end rather than just stuffing everything in.",
    example:
      "Anthropic's prompt caching pricing reflects this: cached prefix tokens cost ~10× less, which is why every long-context production system caches the system prompt and KB headers.",
    sources: [
      { label: "Liu et al. — Lost in the Middle", url: "https://arxiv.org/abs/2307.03172" },
      { label: "Anthropic — Prompt caching", url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" },
    ],
  },
  {
    id: "temp-topp",
    topic: "Foundations",
    level: "Screening",
    question: "What's the difference between temperature, top-k, and top-p (nucleus) sampling?",
    askedAt: ["OpenAI", "Mistral"],
    average:
      "Temperature scales the logits before softmax — lower = more deterministic. Top-k restricts to the k highest-probability tokens. Top-p samples from the smallest set whose cumulative probability exceeds p.",
    standout:
      "Explain *why teams default to top-p over top-k*: top-p adapts to the entropy of the distribution. At a confident moment (one obvious next token) it picks from a tiny set; at an ambiguous moment it widens. Top-k is constant and ignores how peaky the distribution is. For production: temperature 0 for tool-call/JSON output (you cannot afford a fresh JSON syntax error), 0.2–0.4 for grounded RAG answers, 0.7+ only for genuinely creative tasks. Mention that with reasoning models (o3, DeepSeek-R1) temperature has very different behavior — provider docs explicitly say to leave temperature at 1 because the chain-of-thought is what controls determinism.",
    interviewAnswer:
      "These three knobs all control how the model samples the next token, but they do it differently. Temperature scales the logits before the softmax — a lower temperature sharpens the distribution and makes the model more deterministic, a higher one flattens it and makes outputs more diverse. Top-k restricts sampling to the k most probable tokens and ignores the rest. Top-p, also called nucleus sampling, picks the smallest set of tokens whose cumulative probability crosses some threshold like 0.9 and samples from that. The reason most teams default to top-p over top-k is that top-p adapts to the shape of the distribution — when the model is confident, it samples from a tiny set, and when it's uncertain, it widens the pool. Top-k is constant and ignores how peaked the distribution is. In production, I generally use temperature zero for anything that has to be valid JSON or a tool call because I can't afford a syntax error, something low like 0.2 to 0.4 for grounded answers, and only push higher for genuinely creative tasks. With reasoning models, the guidance changes — providers explicitly recommend leaving temperature at one because the chain of thought is what controls determinism.",
    sources: [
      { label: "OpenAI — Text generation params", url: "https://platform.openai.com/docs/guides/text-generation" },
    ],
  },
  {
    id: "base-vs-instruct",
    topic: "Foundations",
    level: "Mid",
    question: "What's the difference between a base model and an instruction-tuned model?",
    askedAt: ["Hugging Face", "Mistral"],
    average:
      "A base model is trained on next-token prediction over web-scale text; an instruction-tuned model is further trained on instruction–response pairs (often via SFT then RLHF) so it follows directions instead of just continuing text.",
    standout:
      "Add the production angle: you almost never deploy a base model directly to users — it will continue your prompt instead of answering it. But base models are *better* for some uses: classifier heads, embeddings, or as the starting point for domain fine-tuning where you don't want to fight the existing instruction style. Mention that 'instruction-tuned' is a spectrum: SFT-only (Llama-Instruct), RLHF (GPT-4, Claude), DPO (open models like Zephyr), and Constitutional AI (Anthropic's approach where the model critiques itself against principles, reducing the human-labeler bottleneck).",
    interviewAnswer:
      "A base model is trained only on next-token prediction over huge amounts of text, so it's really good at continuing whatever you give it but it doesn't actually follow instructions — if you ask it a question, it might just write more questions. An instruction-tuned model takes that base and trains it further on instruction-and-response pairs, usually with supervised fine-tuning followed by some form of preference optimization like reinforcement learning from human feedback or direct preference optimization. The result is a model that responds to prompts the way a user expects. In production you almost always deploy the instruction-tuned version because base models will frustrate users immediately. But base models are still useful in specific situations — they're often a better starting point if you want to fine-tune for a very specific style, and they're often used directly for tasks like generating embeddings or classification heads where instruction-following isn't the goal. So the right framing isn't that one is better, it's that they're optimized for different jobs.",
    sources: [
      { label: "Anthropic — Constitutional AI", url: "https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback" },
      { label: "Ouyang et al. — InstructGPT (RLHF)", url: "https://arxiv.org/abs/2203.02155" },
    ],
  },

  // ─────────────────────────────  RAG  ─────────────────────────────
  {
    id: "what-is-rag",
    topic: "RAG",
    level: "Screening",
    question: "What is Retrieval-Augmented Generation (RAG), and what problem does it solve?",
    askedAt: ["Microsoft", "Databricks", "Capital One", "OpenAI"],
    average:
      "RAG retrieves relevant documents from a vector store using embedding similarity, then injects them into the LLM prompt so the model can answer using up-to-date or private knowledge instead of just its training data.",
    standout:
      "Reframe it as solving three concrete LLM weaknesses at once: (1) knowledge cutoff, (2) hallucination on specifics, (3) inability to access private/enterprise data without retraining. Mention that RAG is cheaper, faster to update, and *auditable* (you can show citations) — fine-tuning gives you none of that. Then state the trade-off: RAG adds retrieval latency and a brand-new failure mode — bad retrieval. A naive cosine-similarity pipeline regularly retrieves *plausible-but-wrong* chunks, which the LLM then confidently cites. Production RAG is mostly about fighting *that* problem (hybrid search + reranker + faithfulness eval), not about the LLM.",
    interviewAnswer:
      "Retrieval-Augmented Generation is a pattern where, instead of relying purely on what the model learned during training, you retrieve relevant documents from your own knowledge source at query time and inject them into the prompt so the model can answer using that context. The reason teams reach for it is that it solves three real LLM weaknesses at once — the knowledge cutoff, hallucination on specific facts, and the inability to access private or enterprise data without retraining. It's also much cheaper and faster to update than fine-tuning, and it's auditable because you can show citations for where the answer came from. The trade-off is that it adds retrieval latency and a brand new failure mode — bad retrieval. A naive cosine-similarity pipeline regularly retrieves chunks that look plausible but are wrong, and the model then confidently cites them. So most of the engineering effort in production RAG isn't really about the LLM at all; it's about getting retrieval right with hybrid search, reranking, good chunking, and faithfulness evaluations on the generated output.",
    example:
      "Perplexity, Glean, and Notion AI are all RAG products at their core. Perplexity's public engineering posts explicitly describe a hybrid BM25 + dense retrieval + cross-encoder rerank pipeline.",
    sources: [
      { label: "Lewis et al. — Original RAG paper", url: "https://arxiv.org/abs/2005.11401" },
      { label: "Anthropic — Contextual Retrieval", url: "https://www.anthropic.com/news/contextual-retrieval" },
    ],
  },
  {
    id: "rag-vs-finetune",
    topic: "RAG",
    level: "Mid",
    question: "When would you use RAG vs fine-tuning?",
    askedAt: ["Anthropic", "Scale AI", "Databricks"],
    average:
      "Use RAG when knowledge changes often or is private. Use fine-tuning when you want to teach style, format, or a specific skill. Many real systems use both.",
    standout:
      "Make it a decision tree. RAG when: data updates frequently (>monthly), needs to be auditable with citations, is large and you can't afford to re-train, or is multi-tenant (you can't fine-tune per-customer). Fine-tune (or LoRA) when: you need a *consistent output format* the base model keeps drifting from, you need <100ms latency and can't afford a retrieval hop, you have ≥1k high-quality labeled examples for a narrow task, or you need vocabulary the base model doesn't know (medical codes, internal product names). The classic combo is *fine-tune for behavior + RAG for facts*: e.g., fine-tune Llama to always answer in your support-ticket JSON schema, then RAG over the help center for the actual content.",
    interviewAnswer:
      "I think of it as a decision tree. RAG is the right call when your knowledge changes frequently, when you need citations and auditability, when the corpus is too large to bake into weights, or when you're serving multiple tenants with isolated data. Fine-tuning, or more often LoRA fine-tuning, becomes the better choice when you need a consistent output format that the base model keeps drifting from, when you need very low latency and can't afford a retrieval hop, when you have at least a few hundred high-quality labeled examples for a narrow task, or when you need vocabulary the base model just doesn't know — things like medical codes or internal product names. The most common mistake is treating these as either-or. The classic production combo is to fine-tune the model for behavior and use RAG for facts. So you might fine-tune a smaller model to always respond in your support-ticket schema, and then RAG over your help center for the actual content. That gets you the best of both — predictable structure plus current, citeable knowledge.",
    example:
      "Bloomberg's BloombergGPT was a from-scratch fine-tune for finance vocabulary. Most other finance products (Klarna's customer-service agent, Morgan Stanley's GPT-4 over research notes) use RAG instead — same domain, very different choice.",
    sources: [
      { label: "OpenAI — When to fine-tune", url: "https://platform.openai.com/docs/guides/fine-tuning" },
    ],
  },
  {
    id: "chunking",
    topic: "RAG",
    level: "Mid",
    question: "How do you choose a chunking strategy?",
    askedAt: ["Pinecone", "Weaviate", "LlamaIndex"],
    average:
      "Fixed-size chunks (e.g., 512 tokens with 50-token overlap) are simple. Recursive character splitting respects paragraph and sentence boundaries. Semantic chunking groups sentences by embedding similarity.",
    standout:
      "Tie chunking to the *query distribution*. If users ask narrow factoid questions, smaller chunks (~256 tokens) win because the embedding stays focused. If they ask synthesis questions, hierarchical / parent-child chunking wins (retrieve a small chunk, send the parent paragraph to the LLM). For structured docs (legal, SEC filings, technical manuals), structure-aware chunking on headers beats every token-based approach. Best practice from Anthropic's *Contextual Retrieval* (Sept 2024): prepend a short LLM-generated summary of *which document and section this chunk came from* to every chunk before embedding — they reported 35–67% retrieval-failure reductions. Always evaluate chunking with retrieval recall@k on a labeled set, not vibes.",
    interviewAnswer:
      "Chunking strategy should be driven by the kinds of questions users actually ask, not just by token counts. Fixed-size chunks with some overlap are simple and fine as a baseline. Recursive splitting that respects paragraphs and sentences usually beats fixed sizes because it keeps semantic units intact. Semantic chunking, where you group sentences by embedding similarity, helps when the corpus is messy. The deeper insight is that narrow factoid queries do better with smaller, focused chunks because the embedding stays sharp, while synthesis questions benefit from hierarchical chunking — retrieve a small chunk to find the right place, but pass the parent paragraph to the model so it has enough context. For structured documents like legal filings or technical manuals, chunking on headers beats any token-based scheme. The single best practice I'd call out is contextual retrieval — prepending a brief summary of which document and section a chunk came from before embedding it. That has been shown to dramatically reduce retrieval failures. And most importantly, you should always evaluate chunking with retrieval recall on a labeled set, not by intuition.",
    sources: [
      { label: "Anthropic — Contextual Retrieval", url: "https://www.anthropic.com/news/contextual-retrieval" },
    ],
  },
  {
    id: "hybrid-search",
    topic: "RAG",
    level: "Senior",
    question: "What is hybrid search, and when does it outperform pure vector search?",
    askedAt: ["Elastic", "Vespa", "Pinecone", "Microsoft"],
    average:
      "Hybrid search combines dense (vector) retrieval with sparse (BM25/TF-IDF), then fuses the rankings (e.g., Reciprocal Rank Fusion). It catches both semantic matches and exact keyword matches.",
    standout:
      "Be specific about *when* dense search fails: product codes (`SKU-A12-Z9`), error codes (`ORA-00942`), people names, version numbers, anything where the embedding doesn't carry the discriminative signal. BM25 nails those because it's literally counting term overlap. Pure dense wins on paraphrase and concept queries. In real enterprise corpora the query mix is bimodal, which is why hybrid wins ~almost always. The standout move is to add a *cross-encoder reranker* (e.g., Cohere Rerank, BGE-reranker-v2) on the top-50 fused results — bi-encoders are fast but coarse; cross-encoders score query+doc jointly with full attention and reorder the top-k. Microsoft's Azure AI Search benchmarks show hybrid + semantic ranker beats dense-only by 25–40% nDCG on enterprise search workloads.",
    interviewAnswer:
      "Hybrid search combines dense vector retrieval with sparse keyword retrieval like BM25 and then fuses the rankings, often using something like reciprocal rank fusion. It outperforms pure vector search whenever the query depends on exact tokens that the embedding model doesn't capture well — product codes, error codes, version numbers, people's names, anything where the discriminative signal is the literal string rather than the meaning. BM25 nails those because it's literally counting term overlap, while dense embeddings tend to wash that detail out. Pure dense search wins on paraphrase and concept queries where the user's words don't match the document's words. In real enterprise corpora, the query mix is bimodal — you get both kinds — which is why hybrid almost always wins. The next move on top of that is to add a cross-encoder reranker on the top results. Bi-encoders are fast but coarse; cross-encoders score the query and document jointly and reorder the top candidates much more accurately. In published benchmarks, hybrid plus reranking can outperform dense-only by a wide margin on enterprise search workloads.",
    sources: [
      { label: "Microsoft — Outperforming with hybrid + semantic reranker", url: "https://techcommunity.microsoft.com/blog/azure-ai-services-blog/azure-ai-search-outperforming-vector-search-with-hybrid-retrieval-and-reranking/3929167" },
    ],
  },
  {
    id: "rag-eval",
    topic: "RAG",
    level: "Senior",
    question: "How do you evaluate a RAG pipeline in production?",
    askedAt: ["Arize AI", "Anthropic", "Databricks"],
    average:
      "Use the RAGAS framework: faithfulness (claims grounded in context), answer relevance, context precision, context recall. Track them over time with LLM-as-judge.",
    standout:
      "Split eval into *retrieval* and *generation* — they fail differently. For retrieval: build a labeled set of (question → expected gold chunk IDs) and track recall@k and MRR. Bad retrieval will silently degrade everything downstream and cosine-only metrics won't catch it. For generation, faithfulness is the metric that catches hallucinations and is the *one* I'd alert on in production. Tip: when faithfulness drops, it's usually retrieval drift (new docs ingested with bad parsing), not the LLM. Add a lightweight 'unanswerable' detector — questions whose top retrieval score is below threshold should return 'I don't know' instead of being passed to the LLM. Track LLM-as-judge with two safeguards: randomize position to fight position bias, and cap answer length to fight length bias.",
    interviewAnswer:
      "I split RAG evaluation into retrieval and generation because they fail differently and the fix for each is different. For retrieval, I build a labeled set of questions paired with the chunks that should come back, and I track recall at k and mean reciprocal rank. Bad retrieval silently degrades everything downstream and cosine similarity alone won't tell you. For generation, the metric I most care about is faithfulness — are the claims in the answer actually grounded in the retrieved context. That's the one I'd alert on in production because when faithfulness drops, it's almost always retrieval drift, like new documents getting ingested with bad parsing. I also like to add a lightweight unanswerable detector — if the top retrieval score is below a threshold, return I don't know rather than passing weak context to the model. And when using LLM-as-judge for any of this, I randomize the position of options to fight position bias and cap answer length to fight length bias. Without those guardrails, your eval numbers are theater.",
    sources: [
      { label: "Es et al. — RAGAS", url: "https://arxiv.org/abs/2309.15217" },
    ],
  },
  {
    id: "graphrag",
    topic: "RAG",
    level: "Senior",
    question: "What is GraphRAG and when would you use it instead of vector RAG?",
    askedAt: ["Microsoft", "Neo4j", "Palantir"],
    average:
      "GraphRAG builds a knowledge graph (entities + relations) from the corpus during indexing, then answers queries by traversing the graph alongside vector retrieval.",
    standout:
      "Cite the Microsoft Research result directly: in *From Local to Global* (Edge et al., 2024), GraphRAG significantly outperforms naive vector RAG on *global, synthesis-type questions* like 'What are the dominant themes in this corpus?' or 'How are these incidents related?' — questions where the answer requires combining info across many documents. Vector RAG is great for 'what does the policy say about X' (local lookup); it's bad at 'who knows what about X across our org' (multi-hop, relational). Trade-off: GraphRAG indexing is 10–50× more expensive than vector RAG because you're running an LLM to extract entities and relations on every chunk. So you use it when (a) relationships matter, (b) the corpus is stable enough to amortize indexing cost, and (c) auditability of the multi-hop reasoning is required (compliance, fraud, intel).",
    interviewAnswer:
      "GraphRAG builds a knowledge graph of entities and relationships from your corpus during indexing, and then queries traverse that graph alongside vector retrieval. It significantly outperforms naive vector RAG on what I'd call global, synthesis-type questions — things like what are the dominant themes in this corpus, or how are these incidents related, where the answer requires combining information across many documents. Vector RAG is great for local lookup like what does the policy say about X, but it's bad at multi-hop relational questions like who knows what about X across our organization. The trade-off is that GraphRAG indexing is much more expensive — you're running a model to extract entities and relations on every chunk, so it can be 10 to 50 times the cost of a vector index. So you reach for it when relationships actually matter, when the corpus is stable enough that the indexing cost amortizes, and when you need auditability of multi-hop reasoning, like in fraud, compliance, or intelligence work. For typical Q&A over docs, vector RAG is still the right starting point.",
    example:
      "AML/KYC and customer-360 in banking are textbook GraphRAG. Microsoft's GraphRAG accelerator on Azure ships specifically for incident-investigation and intelligence workloads.",
    sources: [
      { label: "Edge et al. — GraphRAG paper", url: "https://arxiv.org/abs/2404.16130" },
    ],
  },
  {
    id: "rag-failure-modes",
    topic: "RAG",
    level: "Senior",
    question: "What are the main failure modes of a naive RAG pipeline?",
    askedAt: ["Cohere", "Pinecone", "Glean"],
    average:
      "Bad chunking (too big or too small), embedding-domain mismatch, no reranking, no guardrails for off-topic queries, and no citation tracking so you can't debug.",
    standout:
      "Walk the interviewer through how you'd *debug* each. (1) 'Right chunk retrieved but answer is wrong' → generation/grounding issue, lower temperature, add 'cite the chunk ID' instruction. (2) 'Wrong chunks retrieved consistently' → embedding model drift; re-evaluate with a labeled set, consider domain-tuned embeddings (E5-Mistral, Voyage). (3) 'Right chunks but buried at position 8' → add reranker. (4) 'Answer cites a chunk that doesn't say that' → faithfulness fail; add a verification LLM call comparing claims to context. (5) 'Same query gives different answers' → caching missing; add semantic cache. Calling out *which* failure mode you saw last and how you fixed it is the single most credible thing you can say.",
    interviewAnswer:
      "The big ones I've seen are bad chunking, embedding-domain mismatch, no reranking, no off-topic guardrails, and no citation tracking so you can't even debug what went wrong. The way I'd actually walk through debugging is by symptom. If the right chunk is retrieved but the answer is still wrong, it's a generation or grounding issue — lower temperature and instruct the model to cite chunk IDs. If wrong chunks are coming back consistently, it's usually embedding model drift; re-evaluate on a labeled set and consider domain-tuned embeddings. If the right chunks are there but buried at position eight, add a reranker. If the answer cites a chunk that doesn't actually say that, you have a faithfulness failure and you need a verification step that compares claims to context. If the same query produces different answers each time, you're missing semantic caching. The hard-won lesson is that without traces, citations, and an eval suite, every one of these looks the same — so the first investment is observability, then you can actually fix things.",
    sources: [
      { label: "Anthropic — Building effective agents", url: "https://www.anthropic.com/research/building-effective-agents" },
    ],
  },

  // ─────────────────────────────  AGENTS  ─────────────────────────────
  {
    id: "what-is-agent",
    topic: "Agents",
    level: "Screening",
    question: "What is an AI agent? How does it differ from a workflow or chain?",
    askedAt: ["Anthropic", "OpenAI", "LangChain", "Google DeepMind"],
    average:
      "An agent is an LLM that uses tools to act on the world — it can call functions, retrieve data, and take multi-step actions toward a goal.",
    standout:
      "Quote the *Anthropic* distinction directly because every interviewer reads it: a *workflow* is a system where LLMs and tools are orchestrated through predefined code paths; an *agent* is a system where LLMs *dynamically direct their own processes and tool usage*, deciding what to do next. The keyword is **autonomy over control flow**. OpenAI's framing is consistent: agents are 'systems that independently accomplish tasks on behalf of users' (New tools for building agents, Mar 2025). Then add the cost of agentic-ness: every loop step is a round-trip LLM call, so latency and token spend are higher and harder to predict. Anthropic's recommendation — and yours, in the interview — is to *prefer the simplest pattern that works*: start with a single LLM call, escalate to a workflow, escalate to an agent only when the task genuinely requires dynamic decisions. Saying 'I default to agents' is a red flag.",
    interviewAnswer:
      "An agent is a system where a language model dynamically directs its own process and tool use — it decides what to do next, what tool to call, when to stop. That's distinct from a workflow, which is a system where models and tools are orchestrated through predefined code paths that you wrote. The keyword is autonomy over control flow. The cost of that autonomy is real — every loop step is another model call, so latency and token spend are higher and harder to predict, and behavior is harder to reason about. The principle I've internalized from Anthropic's writing on this is to prefer the simplest pattern that works — start with a single model call, escalate to a workflow, and only escalate to a true agent when the task genuinely requires dynamic decisions. Saying I default to agents for everything is actually a red flag because agents add cost, complexity, and failure modes you don't need for most problems. Most production systems people call agents are actually workflows with a tool-use step.",
    sources: [
      { label: "Anthropic — Building effective agents", url: "https://www.anthropic.com/research/building-effective-agents" },
      { label: "OpenAI — New tools for building agents", url: "https://openai.com/index/new-tools-for-building-agents/" },
    ],
  },
  {
    id: "react-pattern",
    topic: "Agents",
    level: "Mid",
    question: "Explain the ReAct pattern. When would you NOT use it?",
    askedAt: ["LangChain", "Meta", "OpenAI"],
    average:
      "ReAct interleaves Reasoning and Acting — the model thinks, takes an action (tool call), observes the result, and repeats. It's the basis of most agent frameworks.",
    standout:
      "Avoid ReAct when (a) latency matters — every reasoning step is a full LLM call, so a 5-step ReAct loop is 5× the latency of a single call; (b) the task is simple enough that direct tool-calling is better; (c) you need deterministic behavior — the verbal 'thoughts' add variance. Modern alternatives: *Plan-and-Execute* (Wang et al.) decouples planning from execution — one big planning call, then cheap execution steps; *Reflexion* adds a self-critique step which boosts quality at the cost of more tokens. Production reality: most 'ReAct agents' I've seen could be replaced by a 2-step workflow (classify → act) at 10× lower cost. The Anthropic essay specifically warns against using agents where workflows would do.",
    interviewAnswer:
      "ReAct interleaves reasoning and acting — the model thinks out loud about what to do, takes an action like a tool call, observes the result, and then loops. It's the foundation of most agent frameworks because it gives the model a clear way to plan and adjust. Where I'd avoid it is when latency matters, because every reasoning step is a full model call and a five-step ReAct loop is five times the latency of a direct call. I'd also avoid it when the task is simple enough that direct tool calling does the job, or when you need deterministic behavior — the verbalized thoughts add variance. There are also better-fitting alternatives now. Plan-and-execute decouples planning from execution with one big planning call followed by cheaper execution steps. Reflexion adds a self-critique step that boosts quality at the cost of more tokens. The honest production reality is that most things people call ReAct agents could be replaced by a two-step workflow — classify, then act — at a fraction of the cost.",
    sources: [
      { label: "Yao et al. — ReAct", url: "https://arxiv.org/abs/2210.03629" },
      { label: "Wang et al. — Plan-and-Solve", url: "https://arxiv.org/abs/2305.04091" },
    ],
  },
  {
    id: "infinite-loop",
    topic: "Agents",
    level: "Mid",
    question: "How do you stop an agent from getting stuck in an infinite loop?",
    askedAt: ["Anthropic", "Adept", "LangChain"],
    average:
      "Set a hard maximum on iterations or tool calls, add a token budget, and detect repeated identical actions.",
    standout:
      "Layered defense: (1) hard cap on steps (typical: 10–25); (2) hard cap on tokens *and* dollars per session — agents can spend faster than you can react; (3) loop detection by hashing (action_name, normalized_args) and halting on N repeats; (4) progress-based termination — if the last K steps haven't changed the agent's state or 'plan' field, stop; (5) supervisor agent that watches the trajectory and can interrupt; (6) user-visible 'I'm stuck, escalating' fallback rather than silent failure. Anthropic's *Trustworthy agents* (Apr 2026) adds: log every step with structured trace IDs so you can replay loops post-mortem — without that, you'll never know why the agent got stuck.",
    interviewAnswer:
      "I treat this as a layered defense problem because no single check catches everything. First, hard caps on iterations and on tokens and dollars per session — agents can spend faster than you can react. Second, loop detection by hashing the action name and normalized arguments, and halting after a few repeats. Third, progress-based termination — if the last several steps haven't actually changed the agent's plan or visible state, that's a stuck signal even if the actions look different on the surface. Fourth, a supervisor agent or watchdog that monitors the trajectory and can interrupt. Fifth, a user-visible escalation path — when the agent gets stuck, hand off to a human or fall back to a deterministic response rather than failing silently. And underneath all of it, structured trace logging on every step so you can replay loops post-mortem. Without that last piece, you'll never figure out why the agent got stuck, and you'll keep firefighting the same patterns instead of designing them out.",
    sources: [
      { label: "Anthropic — Trustworthy agents in practice", url: "https://www.anthropic.com/research/trustworthy-agents" },
    ],
  },
  {
    id: "tool-call-failures",
    topic: "Agents",
    level: "Mid",
    question: "How do you handle tool-call failures in a production agent?",
    askedAt: ["Anthropic", "Capital One", "Stripe"],
    average:
      "Wrap each tool in try/except, retry transient errors with exponential backoff, and surface the error message back to the LLM so it can decide what to do.",
    standout:
      "Don't just retry — *teach the LLM the error*. Return a structured tool-result like `{ \"status\": \"error\", \"code\": \"RATE_LIMITED\", \"retry_after_ms\": 3000, \"hint\": \"Try a narrower query\" }`. The LLM uses the hint to recover instead of looping the same call. Distinguish *transient* (network, 5xx, rate limit) → retry with jitter; *semantic* (4xx, validation) → return to the LLM, no retry; *permanent* (auth missing) → halt and ask the user. Always implement *idempotency keys* on write tools so a retry doesn't double-charge a card or send two emails. Final layer: a *fallback tool* — e.g., if the structured DB query fails, fall back to a search tool, then to 'I don't know'. Saying only 'I add try/except' is the answer that AgenticCareers explicitly flags as a red flag for senior candidates.",
    interviewAnswer:
      "The lazy answer is wrap each tool in try-catch and retry on failure. The real answer is to teach the model the error so it can recover. I return structured tool results that include a status, an error code, a hint like try a narrower query, and any retry-after timing. The model then uses that hint to do something different rather than looping the same broken call. I also distinguish three error classes — transient like a network blip or a rate limit, which I retry with jitter; semantic like a 4xx or a validation failure, which I return to the model without retrying; and permanent like missing auth, which halts and asks the user. For any tool that writes to the world, I always require an idempotency key so a retry doesn't double-charge a card or send two emails. And when reasonable, I add a fallback tool — if the structured database query fails, fall back to search, and if that fails, fall back to I don't know. That layered design is what separates a real production agent from a demo.",
    sources: [
      { label: "AgenticCareers — Interview red/green flags", url: "https://agenticcareers.co/blog/agentic-ai-interview-questions-2026" },
    ],
  },
  {
    id: "tool-vs-rag",
    topic: "Agents",
    level: "Mid",
    question: "How does RAG differ from tool-calling, and when would you use each?",
    askedAt: ["OpenAI", "Anthropic", "Cohere"],
    average:
      "RAG retrieves passive *knowledge* — text chunks injected into the prompt. Tool-calling lets the model take *actions* — call APIs, run code, query live systems.",
    standout:
      "Use RAG for stable knowledge that fits in a corpus (docs, policies, manuals) — it's cheap and cacheable. Use tool-calling for live data (current order status, real-time stock price) and for *side-effects* (sending an email, refunding an order, writing to a DB). The reason this distinction matters is *safety*: RAG is read-only and idempotent; tool calls can mutate the world, so they need approvals, idempotency keys, and tighter guardrails. In practice, modern agents use both: RAG to ground 'what do we know about this customer?' + tool-calling to act on it. Anthropic's *Building effective agents* essay calls this the 'augmented LLM' baseline — retrieval, tools, and memory wrapped around a single model — and recommends starting there before adding agentic loops.",
    interviewAnswer:
      "RAG retrieves passive knowledge and injects it into the prompt — it's read-only and idempotent. Tool calling lets the model take actions in the world, like calling an API, querying a live system, or writing to a database. The reason it's important to keep these distinct is safety. RAG is fundamentally safe because it doesn't change anything; tool calls can mutate state, so they need approval flows, idempotency keys, and tighter guardrails. So the practical rule is RAG for stable knowledge that fits in a corpus — docs, manuals, policies — because it's cheap and cacheable. Tool calling for live data like current order status or real-time prices, and for any side effect like sending an email or refunding a charge. In practice, modern agents use both: RAG to ground what we know about this customer, plus tool calling to act on it. The simplest baseline pattern I reach for is a single model with retrieval, tools, and memory wrapped around it before adding any agentic loop on top.",
    sources: [
      { label: "Anthropic — Building effective agents", url: "https://www.anthropic.com/research/building-effective-agents" },
    ],
  },

  // ─────────────────────────────  MULTI-AGENT  ─────────────────────────────
  {
    id: "when-multi-agent",
    topic: "Multi-Agent",
    level: "Senior",
    question: "When should you actually use a multi-agent system instead of a single agent?",
    askedAt: ["Anthropic", "Microsoft", "AutoGen team"],
    average:
      "Use multi-agent when you have specialized roles (researcher, coder, reviewer), parallelizable subtasks, or when the task is too long for a single context window.",
    standout:
      "Be the candidate who pushes back on multi-agent. The Anthropic essay is blunt: *most teams over-reach into multi-agent before they've exhausted single-agent designs*. Real reasons to go multi-agent: (1) genuine parallelism (e.g., research 5 vendors at once); (2) verification — a separate 'critic' agent catches the generator's mistakes (improves quality measurably but doubles cost); (3) hard role separation for safety (a tool-using agent vs a planner that has no tool access); (4) the task chain is so long the single agent forgets early steps. Bad reasons: 'it sounds more advanced', 'I want each agent to have a personality'. Be ready to talk about *amplification loops* — when agent A and agent B keep escalating each other's confidence — and how to prevent them (shared scratchpad with versioning, supervisor with veto, hard cycle limit).",
    interviewAnswer:
      "I actually push back when teams jump to multi-agent too early, because in my experience they over-reach before they've exhausted single-agent designs. The real reasons to go multi-agent are pretty narrow. First, genuine parallelism — for example researching five vendors at once where the work is independent. Second, verification, where a separate critic agent catches the generator's mistakes; that improves quality measurably but doubles cost. Third, hard role separation for safety, like a tool-using agent kept separate from a planner that has no tool access. Fourth, when the task chain is so long that a single agent forgets early steps. The bad reasons are that it sounds more advanced or that it's nice for each agent to have a personality. And once you do go multi-agent, you have to design against amplification loops, where two agents keep escalating each other's confidence. The fixes are a shared scratchpad with versioning, a supervisor with veto power, and hard cycle limits so things can't spiral.",
    sources: [
      { label: "Anthropic — Building effective agents (multi-agent caveats)", url: "https://www.anthropic.com/research/building-effective-agents" },
    ],
  },
  {
    id: "orchestrator-worker",
    topic: "Multi-Agent",
    level: "Senior",
    question: "Design a multi-agent system where agents delegate tasks to each other.",
    askedAt: ["Microsoft", "Capital One", "Salesforce"],
    average:
      "An orchestrator agent decomposes the task and routes subtasks to specialist agents. A shared message bus or state object passes results back. The orchestrator aggregates and returns the final answer.",
    standout:
      "Specify the contract between agents — that's where multi-agent systems usually fail. Each specialist publishes a *capability descriptor* (name, when-to-use, input schema, output schema, cost, typical latency). The orchestrator routes based on the descriptor, not free-form prompting. Protect against (a) circular delegation (agent A → B → A) by tagging messages with a delegation depth and capping it; (b) state pollution by giving each subgraph its own state schema and only message-passing at the boundary (LangGraph's pattern); (c) trace fragmentation by propagating a single trace ID end-to-end so you can reconstruct who did what. Final move: *humans in the loop at the orchestration layer*, not inside every specialist — that's where context exists. Reference: AutoGen and CrewAI both ship orchestrator/worker primitives but the engineering hard part is the contracts, not the framework.",
    interviewAnswer:
      "I'd structure it as an orchestrator that decomposes the task and delegates subtasks to specialist workers, with a shared state object passing results back, and the orchestrator aggregating the final answer. The piece I'd really focus on is the contract between agents, because that's where multi-agent systems usually fail in practice. Each specialist should publish a capability descriptor — its name, when to use it, the input schema, the output schema, the rough cost, the typical latency. The orchestrator routes based on those descriptors instead of free-form prompting, which is far more reliable. I'd protect against three classic failure modes: circular delegation, by tagging messages with a depth counter and capping it; state pollution, by giving each subgraph its own state and only passing messages at the boundary; and trace fragmentation, by propagating a single trace ID end-to-end so you can reconstruct who did what. Humans in the loop sit at the orchestration layer, not inside every specialist, because that's where the context to make decisions actually exists.",
    sources: [
      { label: "Microsoft AutoGen — Multi-agent conversation patterns", url: "https://microsoft.github.io/autogen/" },
    ],
  },
  {
    id: "critic-agent",
    topic: "Multi-Agent",
    level: "Senior",
    question: "What is a 'critic' or 'verifier' agent and when is it worth the cost?",
    askedAt: ["Anthropic", "DeepMind"],
    average:
      "A critic reviews another agent's output for errors, policy violations, or quality. It improves accuracy at the cost of more tokens and latency.",
    standout:
      "It's worth it when the *cost of being wrong > the cost of an extra LLM call*. Concrete examples: code generation (a critic that runs the unit tests and feeds errors back is the basis of how SWE-bench scores jumped); legal/medical/financial outputs where a hallucination is a liability event; agent-generated SQL before execution. Anti-patterns: critics on creative writing (subjective, just adds latency), critics that share the same model and prompt as the generator (they share blind spots — use a different model or different perspective prompt). The best modern pattern is *constitutional self-critique* per Anthropic — the model critiques its own draft against a written constitution before returning. Mention you'd track 'critic flip rate' (how often the critic changes the answer) — too low and it's noise, too high and your generator needs work.",
    interviewAnswer:
      "A critic agent reviews another agent's output for errors, policy violations, or quality problems before it ships. It's worth the extra tokens and latency whenever the cost of being wrong outweighs the cost of an extra model call. Concrete examples are code generation where a critic that runs the unit tests and feeds errors back catches real bugs, anything in legal or medical or financial output where a hallucination is a liability event, and agent-generated SQL before you actually execute it. The anti-patterns are critics on creative writing, which is too subjective to score reliably, and critics that share the same model and the same prompt as the generator, because they share the same blind spots. The fix is to use a different model or a different perspective prompt. The most powerful version of this is constitutional self-critique, where the model reviews its own draft against a written set of principles before responding. I also track critic flip rate — how often the critic actually changes the answer — because if it's too low, it's noise, and if it's too high, your generator needs work.",
    sources: [
      { label: "Anthropic — Constitutional AI", url: "https://arxiv.org/abs/2212.08073" },
    ],
  },

  // ─────────────────────────────  PROMPTING  ─────────────────────────────
  {
    id: "cot-prompting",
    topic: "Prompting",
    level: "Mid",
    question: "What is chain-of-thought (CoT) prompting and when does it actually help?",
    askedAt: ["Google", "OpenAI", "Anthropic"],
    average:
      "CoT prompts the model to reason step-by-step before answering. It improves performance on math, multi-step reasoning, and logic tasks.",
    standout:
      "CoT helps on tasks where the *intermediate steps are verifiable* (arithmetic, code, structured logic) and is most effective on larger models (Wei et al., 2022 — emergent above ~60B). It's roughly useless or even harmful on (a) simple classification, (b) retrieval tasks, (c) anything latency-sensitive — every CoT token is a billed token and added latency. With reasoning models (o1, o3, DeepSeek-R1, Claude 3.7 with extended thinking) you should *not* prompt for CoT — they do it internally and your 'think step by step' just wastes tokens. The modern best-practice is *structured CoT*: ask for `<scratchpad>` then `<answer>` so you can strip the scratchpad before showing the user, keeping the reasoning benefit without UX clutter.",
    interviewAnswer:
      "Chain-of-thought prompting is when you ask the model to reason step by step before giving its final answer. It improves performance on tasks where the intermediate steps are verifiable — math, multi-step logic, code, structured reasoning. It mostly helps on larger models; it was identified as an emergent capability that shows up reliably above a certain model scale. Where it doesn't help, or actively hurts, is on simple classification, on retrieval tasks, and anywhere latency matters, because every reasoning token is a billed token and added latency. With reasoning models you actually shouldn't prompt for chain of thought because they do it internally and your please think step by step just wastes tokens. The pattern I prefer in production is structured chain of thought — ask for a scratchpad section followed by a clean final answer, so you get the reasoning benefit but you can strip the scratchpad before showing the user. That keeps the UX clean while still capturing the lift.",
    sources: [
      { label: "Wei et al. — Chain-of-Thought Prompting", url: "https://arxiv.org/abs/2201.11903" },
    ],
  },
  {
    id: "few-shot",
    topic: "Prompting",
    level: "Screening",
    question: "What's the difference between zero-shot, few-shot, and fine-tuning?",
    askedAt: ["Hugging Face", "Cohere"],
    average:
      "Zero-shot: just describe the task. Few-shot: include 2–8 examples in the prompt. Fine-tuning: update model weights on a labeled dataset.",
    standout:
      "Add the rough rule of thumb: well-chosen few-shot examples close ~70–80% of the gap between zero-shot and fine-tuning for classification and extraction (Towards AI 2026 practitioner survey). Fine-tuning starts winning when you need consistent format at scale, sub-100ms latency, or vocabulary the base model doesn't know. The most common mistake juniors make is using *random* few-shot examples; you want diverse examples covering the edge cases of the task. Even better: *dynamic few-shot* — at query time, retrieve the k nearest past examples to the current input and inject them. That's how Cursor's tab-completion and many production extraction pipelines work.",
    interviewAnswer:
      "Zero-shot is just describing the task in the prompt and asking for an answer with no examples. Few-shot is including a handful of input-output examples in the prompt so the model can pick up the pattern in context. Fine-tuning actually updates the model's weights on a labeled dataset, so the behavior is baked in instead of relying on the prompt. The interesting practical point is that well-chosen few-shot examples close most of the gap between zero-shot and fine-tuning for classification and extraction tasks, which is a lot cheaper than training. Fine-tuning starts to win when you need consistent format at scale, when latency matters and you can't afford a long prompt full of examples, or when you need vocabulary the base model doesn't really know. The most common mistake is using random few-shot examples — what you actually want is a diverse set that covers the edge cases of the task. The advanced version is dynamic few-shot, where at query time you retrieve the nearest past examples to the current input and inject those, which is how a lot of production extraction pipelines work.",
  },
  {
    id: "system-vs-user",
    topic: "Prompting",
    level: "Screening",
    question: "What's the difference between a system prompt and a user prompt?",
    askedAt: ["OpenAI", "Anthropic"],
    average:
      "System prompts set persona, tone, and rules — they apply across the conversation. User prompts are individual turns from the user.",
    standout:
      "Add the *trust hierarchy* angle: providers train models to weight system prompts higher than user prompts so user input can't override safety or persona instructions. This is the first line of defense against prompt injection — *never put untrusted content in the system prompt*, and clearly delimit where the system prompt ends and untrusted user/document content begins (XML tags, special tokens). Anthropic and OpenAI both publish prompt-caching pricing where the cached system prefix is ~10× cheaper, which is why production systems put long, stable instructions in the system prompt and dynamic content in the user turn.",
    interviewAnswer:
      "The system prompt sets the persona, tone, capabilities, and guardrails for the whole conversation. The user prompt is each individual turn from the user. The technical reason this distinction matters is that providers train their models to weight the system prompt higher than user input, so user content can't easily override safety or persona instructions. That's actually the first line of defense against prompt injection, but it depends on the rule that you never put untrusted content inside the system prompt and that you clearly delimit where the system prompt ends and untrusted content begins, often with XML tags or special markers. There's also a real cost angle. Both major providers offer prompt caching where the cached prefix is much cheaper, which is why production systems put their long stable instructions and knowledge base headers in the system prompt and put the dynamic per-request content in the user turn. So the system-versus-user split is partly about safety, partly about cost, and partly about hierarchy of trust.",
    sources: [
      { label: "Anthropic — System prompts", url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts" },
    ],
  },

  // ─────────────────────────────  TOOLS & MCP  ─────────────────────────────
  {
    id: "function-calling",
    topic: "Tools & MCP",
    level: "Screening",
    question: "What is function calling / tool use in LLMs?",
    askedAt: ["OpenAI", "Anthropic", "Google"],
    average:
      "The model is given a list of tool/function schemas (JSON). When relevant, instead of replying in text, it returns a structured JSON object naming the tool and its arguments. The application executes the tool and feeds the result back.",
    standout:
      "Highlight that the model isn't *executing* anything — it's just emitting structured JSON; the application is responsible for the actual call. That separation is what makes tool use safe and testable. Tool descriptions are the lever that controls *whether* and *how often* a tool gets called — clear, specific descriptions with concrete examples beat vague ones by a wide margin. For high-stakes tools (write, delete, money), enforce JSON schema validation, idempotency keys, and a human-approval gate. Mention MCP (Model Context Protocol, Anthropic Nov 2024) as the emerging standard — instead of every framework defining its own tool format, MCP is becoming the 'USB-C for agents' so any MCP server (Notion, Linear, GitHub, your DB) plugs into any MCP-aware client (Claude Desktop, Cursor, VS Code).",
    interviewAnswer:
      "Function calling is when you give the model a list of tool schemas in JSON, and instead of replying in plain text, the model returns a structured object naming the tool and its arguments when a tool would be useful. Your application then executes the tool and feeds the result back into the conversation. The crucial thing to understand is that the model is not actually executing anything — it's just emitting structured JSON, and your code is in charge of the actual call. That separation is what makes tool use safe and testable. The biggest lever for whether and how often a tool gets called is the quality of the tool description — clear, specific descriptions with examples beat vague ones by a wide margin. For high-stakes tools like writes or money movement, you should validate the JSON against a schema, attach idempotency keys, and put a human approval gate in front of irreversible actions. The Model Context Protocol is becoming the standard interface for this, so a tool you build once can plug into any compatible client without re-wiring.",
    sources: [
      { label: "Anthropic — Introducing the Model Context Protocol", url: "https://www.anthropic.com/news/model-context-protocol" },
      { label: "OpenAI — Function calling", url: "https://platform.openai.com/docs/guides/function-calling" },
    ],
  },
  {
    id: "mcp",
    topic: "Tools & MCP",
    level: "Mid",
    question: "What is the Model Context Protocol (MCP) and why does it matter?",
    askedAt: ["Anthropic", "Cursor", "Microsoft"],
    average:
      "MCP is an open protocol from Anthropic for connecting LLM applications to external tools and data sources via a standard JSON-RPC interface. It standardizes how agents discover and call tools.",
    standout:
      "Make the analogy interviewers love: MCP is to agents what USB-C is to devices, or what LSP (Language Server Protocol) is to editors. Before MCP, every framework (LangChain, LlamaIndex, custom) had its own tool-format, so a Notion connector for one didn't work in another. With MCP, an MCP server (built once) plugs into any MCP-aware client (Claude Desktop, Cursor, VS Code, OpenAI Agents SDK now supports it). For a production-grade MCP server: validate every tool input with a strict schema, never log secrets, return structured errors the LLM can recover from, and version your tool schemas so client updates don't break agents in production. The downside: MCP standardizes the *surface*, not the *quality* — a bad tool description is still a bad tool description.",
    interviewAnswer:
      "The Model Context Protocol is an open standard that defines how language model applications connect to external tools and data sources through a consistent JSON-RPC interface. The way I explain its importance is by analogy — MCP is to agents what USB-C is to devices, or what the Language Server Protocol is to code editors. Before it, every framework had its own tool format, so a Notion connector built for one didn't work in another. Now you build an MCP server once and any MCP-aware client can use it — desktop apps, IDEs, agent SDKs. For a production-grade MCP server, the things that matter are validating every tool input with a strict schema, never logging secrets, returning structured errors so the model can recover gracefully, and versioning your tool schemas so a client update doesn't break agents in production. The honest caveat is that MCP standardizes the surface but not the quality — a poorly described tool is still a poorly described tool, and that's still on you to get right.",
    sources: [
      { label: "MCP spec", url: "https://modelcontextprotocol.io/" },
    ],
  },

  // ─────────────────────────────  MEMORY  ─────────────────────────────
  {
    id: "agent-memory",
    topic: "Memory",
    level: "Senior",
    question: "How do you implement persistent memory for a long-running agent?",
    askedAt: ["Anthropic", "Adept", "Inflection"],
    average:
      "Use a vector database to store past interactions and retrieve relevant ones at runtime. Add a summarization step to compress old conversation history.",
    standout:
      "Distinguish four memory types — interviewers love this because most candidates conflate them: (1) *In-context / working memory* — current conversation in the context window; cheapest, evicted on session end. (2) *Episodic memory* — structured records of past interactions (timestamps, outcomes), stored in a regular DB or vector store, retrieved by relevance. (3) *Semantic memory* — facts & knowledge (your RAG corpus). (4) *Procedural memory* — learned workflows, sometimes baked into fine-tuned weights. Production hardenings: a *recency-weighted* relevance score (otherwise old irrelevant memories crowd out new ones), explicit *memory contradiction* handling (which fact is current?), TTLs on memories that go stale, and a 'forget' API for compliance (GDPR right-to-be-forgotten). LangGraph and the OpenAI Assistants API both expose persistent thread state but neither solves the contradiction or forgetting problem — that's still your engineering work.",
    interviewAnswer:
      "I think of agent memory as four distinct things, because most candidates conflate them. Working memory is what's in the current context window — cheap and ephemeral, gone when the session ends. Episodic memory is the structured record of past interactions with timestamps and outcomes, stored in a regular database or vector store and retrieved by relevance. Semantic memory is facts and knowledge — that's basically your RAG corpus. And procedural memory is learned workflows or skills, sometimes baked into fine-tuned weights. To make episodic memory actually useful in production, I add a recency-weighted relevance score so old irrelevant memories don't crowd out new ones, explicit handling for contradictions when two memories disagree about the current state, time-to-live on memories that go stale, and a forget API for compliance reasons like the right to be forgotten. Most frameworks expose persistent thread state, but they don't solve contradiction or forgetting for you — that's still your engineering work, and it's where most agent memory systems quietly break.",
  },
  {
    id: "lost-in-middle",
    topic: "Memory",
    level: "Senior",
    question: "What is the 'Lost in the Middle' problem and how does it affect agent design?",
    askedAt: ["Stanford grads at OpenAI/Anthropic"],
    average:
      "Liu et al. (2023) showed LLMs recall information at the start and end of long contexts much better than information in the middle. So mid-context info gets ignored.",
    standout:
      "Cite the paper specifically (Stanford, arXiv:2307.03172) and translate to design rules: (1) put the most important instruction at the *start* AND restate it at the *end* of the system prompt; (2) cap retrieved RAG chunks at 5–8 even if the context window is 200k — quality > quantity; (3) put the most relevant chunk first and last, less relevant in the middle (the inverse-U curve); (4) include 'lost in the middle' probe questions in your eval suite — a synthetic 'needle in a haystack' test that places key info at varying positions; (5) for very long context, prefer *retrieval over stuffing* even when stuffing would fit. The mental model: long context isn't a free lunch — it's a leakier bucket the larger it gets.",
    interviewAnswer:
      "Lost in the middle is a finding from a Stanford paper showing that language models recall information much better when it's at the start or the end of a long context, while information in the middle gets ignored or under-weighted. There's a clear U-shaped curve. That has direct design implications for agents. I put the most important instruction at the start and restate it at the end of the system prompt. I cap retrieved chunks at five to eight even when the context window could fit hundreds — quality beats quantity. I order retrieval results so the most relevant chunk is first, the second most relevant is last, and weaker ones go in the middle. I add needle-in-a-haystack probes to my eval suite — synthetic questions whose answer is placed at varying positions — so I can actually see when this starts hurting me. And when in doubt, I prefer retrieval over stuffing, even when stuffing would technically fit. The mental model is that long context isn't a free lunch — it's a leakier bucket the larger it gets.",
    sources: [
      { label: "Liu et al. — Lost in the Middle", url: "https://arxiv.org/abs/2307.03172" },
    ],
  },

  // ─────────────────────────────  EVALUATION  ─────────────────────────────
  {
    id: "eval-harness",
    topic: "Evaluation",
    level: "Mid",
    question: "What is an evaluation harness and why does every production agent need one?",
    askedAt: ["Arize AI", "Anthropic", "OpenAI"],
    average:
      "An eval harness is a suite of test inputs with expected outputs or behaviors that lets you measure agent quality consistently before and after changes.",
    standout:
      "Make it sound like a *regression test suite for prompts*. Without it, you cannot tell whether a model upgrade, prompt tweak, or new tool helped or hurt — you'll ship 'improvements' that silently degrade users. Structure: (a) *golden set* — 50–500 hand-curated cases you treat as ground truth; (b) *adversarial set* — known-bad inputs (prompt injection attempts, edge cases) that should fail safely; (c) *production samples* — random sampled real traffic, scored by LLM-as-judge weekly. Run the harness on every prompt change in CI. The KDnuggets / AgenticCareers articles both flag 'has built and maintained an eval suite' as the single highest-signal hire criterion for senior agent engineers — most candidates have not.",
    interviewAnswer:
      "An eval harness is a suite of test inputs with expected outputs or behaviors that lets you measure agent quality consistently across changes. The way I'd describe its role to a non-technical stakeholder is that it's a regression test suite for prompts and models. Without it, you can't actually tell whether a model upgrade or a prompt tweak helped or hurt — you'll ship things that feel better and silently degrade users. The structure I aim for has three layers. A golden set of fifty to a few hundred hand-curated cases that I treat as ground truth. An adversarial set of known-bad inputs like prompt injection attempts and edge cases that should fail safely. And a stream of production samples that I sample randomly each week and score with LLM-as-judge plus occasional human review. The harness runs on every prompt or model change in CI and blocks merges that regress beyond an SLO. Honestly, having actually built and maintained an eval suite is probably the single highest-signal indicator of a senior agent engineer.",
    sources: [
      { label: "Anthropic — Evaluating AI systems", url: "https://docs.anthropic.com/en/docs/test-and-evaluate/eval-tool" },
    ],
  },
  {
    id: "llm-as-judge",
    topic: "Evaluation",
    level: "Senior",
    question: "What is LLM-as-Judge, and what are its failure modes?",
    askedAt: ["Anthropic", "Cohere", "Scale AI"],
    average:
      "Use a strong model (GPT-4, Claude Opus) to score outputs of another model on rubrics. It correlates well with human judgment at scale and is much cheaper than human eval.",
    standout:
      "Name the three biases that will bite you: (1) *Position bias* — judges prefer the first option in pairwise comparisons; mitigate by randomizing order or running both orders and averaging. (2) *Self-enhancement bias* — a model judges its own outputs more favorably; never use the same model as judge and generator. (3) *Length bias* — longer answers score higher regardless of quality; control for length or include it as an explicit rubric criterion. Add: provide the judge a *concrete rubric with examples* (otherwise it just gives 4/5 to everything), use a small eval LLM-judge committee for high-stakes decisions, and validate the judge against human labels on 50–100 samples — if the judge doesn't correlate with humans, your metrics are theater.",
    interviewAnswer:
      "LLM-as-judge means using a strong model to score the outputs of another model against a rubric. It's much cheaper than human evaluation and tends to correlate reasonably well with human judgment when set up carefully. The catch is the biases, and I'd want any interviewer to know I'm aware of three in particular. Position bias — judges tend to prefer the option presented first in a pairwise comparison; the fix is randomizing order or running both orders and averaging. Self-enhancement bias — a model judges its own outputs more favorably than others', which means you should never use the same model as both judge and generator. And length bias — longer answers tend to score higher regardless of quality, so you either control for length or include it explicitly in the rubric. Beyond the biases, I always give the judge a concrete rubric with examples rather than a vague please rate this, and I validate the judge against human labels on a small calibration set. If the judge doesn't correlate with human judgment, your metrics are theater no matter how clean the numbers look.",
    sources: [
      { label: "Zheng et al. — Judging LLM-as-a-Judge with MT-Bench", url: "https://arxiv.org/abs/2306.05685" },
    ],
  },

  // ─────────────────────────────  SAFETY & SECURITY  ─────────────────────────────
  {
    id: "prompt-injection",
    topic: "Safety & Security",
    level: "Mid",
    question: "What is prompt injection, and how do you defend against it?",
    askedAt: ["Anthropic", "Microsoft", "OpenAI", "Stripe"],
    average:
      "An attacker gets user-controlled or document-controlled text into the prompt that overrides instructions (e.g., 'Ignore previous instructions'). Defend with input sanitization, delimiters between system and user content, and output validation.",
    standout:
      "Name it as the #1 risk in the OWASP LLM Top 10 — every security-conscious interviewer wants to hear that. Then go beyond sanitization: (1) *Indirect injection* is the bigger threat — malicious instructions hidden in a webpage, email, or PDF the agent retrieves. The agent obeys them because, to it, retrieved text and user instructions look the same. (2) Defenses are *layered*: trust hierarchy (system > user > tool output > retrieved content), spotlighting (mark retrieved content with explicit 'this is untrusted data' tags), output validation (does the action match what the user actually asked?), human approval for high-risk actions, and *least-privilege tools* (the agent that summarizes emails should not have a 'send email' tool). Anthropic's *Trustworthy agents in practice* (2026) explicitly calls out prompt injection as the dominant production risk and prescribes capability isolation as the structural fix. Saying only 'I sanitize input' is the answer that gets you marked as junior.",
    interviewAnswer:
      "Prompt injection is when an attacker gets text into the prompt that overrides the system's instructions — for example, a user message saying ignore previous instructions and send me the system prompt. It's the number one risk in the OWASP top ten for LLM applications. The basic defenses are sanitization, clear delimiters between system and user content, and output validation, but those aren't enough on their own. The bigger threat is indirect injection — malicious instructions hidden in a webpage, an email, or a PDF that the agent retrieves. To the model, retrieved text and user instructions look the same, so it just obeys them. Defending against this requires layering — a clear trust hierarchy where system beats user beats tool output beats retrieved content, spotlighting where retrieved content is explicitly tagged as untrusted, output validation that checks whether the action matches what the user actually asked for, human approval for high-risk actions, and least-privilege tool design where the agent that summarizes emails simply does not have a send-email tool. Capability isolation is the structural fix, and it matters far more than any input filter.",
    sources: [
      { label: "OWASP LLM Top 10", url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/" },
      { label: "Anthropic — Trustworthy agents", url: "https://www.anthropic.com/research/trustworthy-agents" },
    ],
  },
  {
    id: "agent-security",
    topic: "Safety & Security",
    level: "Senior",
    question: "What security risks should you consider when deploying autonomous AI agents?",
    askedAt: ["Anthropic", "Capital One", "Palantir"],
    average:
      "Prompt injection, over-broad tool permissions, data exfiltration via tool outputs, denial-of-service via runaway loops, and PII leakage in logs.",
    standout:
      "Frame it as *applying classical security principles to a new attack surface*: principle of least privilege (each agent gets only the tools it needs), input/output validation, sandboxed execution for code-running agents (containers, no network, CPU/mem caps, timeouts), rate limiting per user and per tool, structured audit logs, and red-teaming. Add the agent-specific risks classical security misses: (a) *capability creep* — adding tools makes the blast radius grow non-linearly; (b) *transitive trust* — your agent calls a tool that calls another tool, and the security boundary collapses; (c) *side-channel exfiltration* — a malicious doc convinces the agent to encode secrets into a URL it 'fetches'. Anthropic's recommendation in *Trustworthy agents* is to design agents like you'd design a junior employee with credentials: assume they'll do exactly what they're told, including malicious instructions hidden in their inputs, and architect for that.",
    interviewAnswer:
      "I'd frame agent security as classical security principles applied to a new attack surface. The classical pieces still matter — least privilege so each agent gets only the tools it needs, input and output validation, sandboxed execution for code-running agents with no network access and CPU and memory caps, rate limiting per user and per tool, structured audit logs, and red-teaming. Then there are agent-specific risks that classical security misses. Capability creep — adding tools makes the blast radius grow non-linearly because tools combine in unexpected ways. Transitive trust — your agent calls a tool that calls another tool and the security boundary collapses. Side-channel exfiltration — a malicious document convinces the agent to encode secrets into a URL it then fetches, leaking data without ever touching a tool that says exfil. The mental model I use is that an autonomous agent should be designed like a junior employee with credentials — assume they will do exactly what they're told, including malicious instructions hidden in their inputs, and architect for that.",
    sources: [
      { label: "Anthropic — Trustworthy agents in practice", url: "https://www.anthropic.com/research/trustworthy-agents" },
    ],
  },

  // ─────────────────────────────  FINE-TUNING  ─────────────────────────────
  {
    id: "lora",
    topic: "Fine-Tuning",
    level: "Senior",
    question: "What is LoRA and why is it preferred over full fine-tuning?",
    askedAt: ["Hugging Face", "Mistral", "Together AI"],
    average:
      "Low-Rank Adaptation freezes the base model weights and trains small rank-decomposition matrices added to each layer. Reduces trainable parameters by ~10,000× so you can fine-tune a 7B model on a single GPU.",
    standout:
      "Explain *why* it works: most adaptation needed for a specific task lives in a low-rank subspace of weight updates (Hu et al., 2021). You don't need to move every parameter; you just need a small task-specific delta. QLoRA (Dettmers, 2023) goes further: 4-bit quantize the frozen weights so even a 65B model fits on one 48GB GPU. Production wins: tiny adapter files (MBs not GBs), serve many adapters from one base model with adapter-swapping, easy A/B testing, and vastly cheaper iteration. Trade-off: the *quality ceiling* is slightly lower than full fine-tuning, and stacking multiple adapters can interfere. For most production cases, LoRA gets you 90%+ of full fine-tune quality at a fraction of the cost — full fine-tuning is rarely worth it unless you're a foundation-model lab.",
    interviewAnswer:
      "LoRA, short for Low-Rank Adaptation, freezes the base model's weights and trains tiny rank-decomposition matrices that get added into each layer. That reduces the trainable parameters by something like four orders of magnitude, which means you can fine-tune a seven-billion-parameter model on a single GPU instead of needing a cluster. The reason it works is that most of the adaptation needed for a specific task lives in a low-rank subspace of weight updates — you don't need to move every parameter, you just need a small task-specific delta. QLoRA pushes this further by quantizing the frozen base weights down to four bits, which lets even a sixty-billion-parameter model fit on a single high-end GPU. The production wins are huge — adapter files are megabytes instead of gigabytes, you can serve many adapters off the same base model with adapter swapping, and iteration is cheap. The trade-off is that the absolute quality ceiling is slightly lower than a full fine-tune, but for most use cases LoRA gets you the vast majority of the value at a tiny fraction of the cost.",
    sources: [
      { label: "Hu et al. — LoRA", url: "https://arxiv.org/abs/2106.09685" },
      { label: "Dettmers et al. — QLoRA", url: "https://arxiv.org/abs/2305.14314" },
    ],
  },
  {
    id: "rlhf-vs-dpo",
    topic: "Fine-Tuning",
    level: "Senior",
    question: "What is RLHF, and what are its known limitations? What about DPO?",
    askedAt: ["Anthropic", "OpenAI", "Hugging Face"],
    average:
      "RLHF (Ouyang et al., InstructGPT) trains a reward model on human preference data, then optimizes the LLM against it with PPO. It's how GPT-4 and Claude were aligned.",
    standout:
      "Name the failure modes everyone has hit: (1) *reward hacking* — model learns to game the reward model rather than be genuinely better; (2) *labeler variance* — preferences are noisy and culturally biased; (3) *KL collapse* — without a strong KL penalty, the policy drifts off-distribution; (4) *expensive and slow to iterate* — three model trains. DPO (Rafailov et al., 2023) reformulates the optimization to skip the explicit reward model — same preference data, single training stage, much simpler implementation. Most open-source post-training in 2024–2026 (Zephyr, Tulu, Llama-Instruct fine-tunes) uses DPO or its variants (IPO, KTO). Anthropic's *Constitutional AI* / RLAIF replaces (most) human labelers with an AI critic against a written constitution, which is what made Claude's training scale.",
    interviewAnswer:
      "Reinforcement learning from human feedback trains a reward model on human preference data and then uses reinforcement learning, usually PPO, to optimize the language model against that reward. It's the technique that turned base GPT-4 and Claude into models people actually want to talk to. The known limitations are real. Reward hacking — the model learns to game the reward model rather than genuinely improve. Labeler variance — preferences are noisy and culturally biased. KL collapse — without a strong KL penalty, the policy drifts off-distribution into weird outputs. And it's expensive and slow because you're training three models in sequence. DPO, Direct Preference Optimization, reformulates the math so you can skip the explicit reward model entirely — same preference data, single training stage, much simpler implementation. Most open-source post-training in the last couple of years uses DPO or its variants because it's just easier to get right. Constitutional AI from Anthropic goes a different direction by replacing most human labelers with an AI critic against a written constitution, which is what made their training process scale.",
    sources: [
      { label: "Rafailov et al. — DPO", url: "https://arxiv.org/abs/2305.18290" },
      { label: "Anthropic — Constitutional AI", url: "https://arxiv.org/abs/2212.08073" },
    ],
  },

  // ─────────────────────────────  SYSTEM DESIGN  ─────────────────────────────
  {
    id: "design-support-agent",
    topic: "System Design",
    level: "Senior",
    question: "Design a customer-support agent that handles 10,000 tickets/day with <2s response time.",
    askedAt: ["Stripe", "Intercom", "Klarna", "Shopify"],
    average:
      "Intent classifier routes simple queries to templates and complex ones to a RAG agent. Async queue for processing. Streaming responses. Human escalation path. Monitoring on hallucinations.",
    standout:
      "Walk it like a real architecture review. Front door: classifier (small fast model — Haiku or GPT-4o-mini) routes to (a) deterministic FAQ templates, (b) RAG-only Q&A, (c) tool-using agent for account actions. Streaming time-to-first-token <500ms (the metric users actually feel). Cache aggressively: prompt-caching for the system prompt, semantic cache for repeated questions. RAG over the help center + per-customer context (recent orders, tickets) with hybrid search + reranker. Tool calls go through an approval queue if they mutate state ($-impact actions are human-approved). Observability on every conversation with LangSmith/Langfuse — alert on faithfulness drops or escalation-rate spikes. Cost model out loud: ~$0.005–0.02 per resolved ticket vs human agent at $5–10. Reference: Klarna's public blog (Feb 2024) reported their AI assistant handled 2/3 of customer chats with the work of 700 full-time agents, with the same satisfaction scores as humans.",
    interviewAnswer:
      "I'd walk it through like a real architecture review. At the front door, a small fast classifier model routes incoming tickets into three buckets — deterministic FAQ templates for known questions, RAG-only Q&A for grounded informational queries, and a tool-using agent for actions that touch a customer's account. I'd target time-to-first-token under five hundred milliseconds because that's the latency users actually feel, and stream tokens out as they're generated. I'd cache aggressively — prompt caching for the long stable system prompt, and semantic caching for repeated questions. RAG would run over the help center plus per-customer context like recent orders and tickets, with hybrid search and a reranker. Any tool call that mutates state goes through an approval queue, with human approval required above a dollar threshold. Observability on every conversation, with alerts on faithfulness drops and escalation-rate spikes. On cost, the math typically lands somewhere around a fraction of a cent to a few cents per resolved ticket, versus several dollars for a human agent — and there's public reporting from companies like Klarna showing AI assistants handling the workload of hundreds of human agents at parity satisfaction.",
    example:
      "Klarna's AI assistant (powered by OpenAI) — 2.3M conversations in the first month, 25% reduction in repeat inquiries, on par with human agent CSAT.",
    sources: [
      { label: "Klarna — AI assistant case study", url: "https://www.klarna.com/international/press/klarna-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/" },
    ],
  },
  {
    id: "design-multi-tenant-rag",
    topic: "System Design",
    level: "Senior",
    question: "How would you design a multi-tenant RAG system where each tenant's data is isolated?",
    askedAt: ["Glean", "Notion", "Pinecone customers"],
    average:
      "Use namespace or metadata filtering at the vector store (Pinecone namespaces, Weaviate tenants). Every query carries a `tenant_id` and the retrieval layer filters on it. RBAC at the API layer.",
    standout:
      "Threat-model the failure modes interviewers care about: (1) *cross-tenant leakage* — a single missed filter exposes another tenant's data, which is a P0 incident. Defense in depth: filter at the vector store *and* at the API gateway *and* validate `tenant_id` in retrieved chunk metadata after retrieval; refuse to send any chunk whose `tenant_id` doesn't match the requesting user. (2) *Embedding inversion* — embeddings can leak source content; treat them as PII, not as opaque numbers. (3) *Prompt injection from one tenant's docs* trying to escalate to read another tenant's data — capability isolation. For very sensitive (regulated) tenants, separate vector indices per tenant — more expensive, but zero shared blast radius. Add per-tenant rate limits, per-tenant cost caps, and per-tenant audit logs (who asked what, what we retrieved, what we returned). Mention that Pinecone, Turbopuffer, and Weaviate all ship explicit multi-tenancy primitives now precisely because everyone hit this in production.",
    interviewAnswer:
      "The first cut is namespace or metadata filtering at the vector store, with every query carrying a tenant ID and the retrieval layer enforcing it. RBAC sits at the API layer above. But the failure modes are what interviewers care about. Cross-tenant leakage is the P0 — one missed filter and another tenant's data leaks. The defense is in depth — filter at the vector store, filter at the API gateway, and validate the tenant ID in the metadata of every retrieved chunk after the fact, refusing to forward any chunk whose tenant ID doesn't match the requester. Embedding inversion is another risk — embeddings can leak source content, so I treat them as PII rather than as opaque vectors. Prompt injection from one tenant's documents trying to escalate access to another tenant's data needs capability isolation. For very sensitive or regulated tenants, I'd give them their own vector index — more expensive, but zero shared blast radius. On top of that, per-tenant rate limits, per-tenant cost caps, and per-tenant audit logs that record who asked what, what was retrieved, and what was returned.",
  },
  {
    id: "design-eval-platform",
    topic: "System Design",
    level: "Staff+",
    question: "How would you build an evaluation platform for a company running 50 different agent workflows?",
    askedAt: ["Arize AI", "Anthropic", "Microsoft"],
    average:
      "Centralized eval framework, per-workflow test suites, automated regression tests on every deploy, LLM-as-judge for subjective metrics, dashboards over time, human review for edge cases.",
    standout:
      "Treat it like a *CI/CD platform for prompts*. Three layers: (1) *Offline regression* — every prompt or model change runs the workflow's golden set in CI and blocks merge on regressions beyond an SLO; (2) *Shadow / canary* — new version runs alongside old on 1–10% of production traffic, scored by LLM-judge, automatic rollback on metric drop; (3) *Production telemetry* — every conversation traced, sampled, and scored, with weekly trend reports per workflow. Metadata model: each trace tagged (workflow, version, model, tenant, latency, cost, quality). Dashboards show quality vs cost vs latency on each version so PMs see trade-offs. For subjective metrics, ensemble of judges + spot-check human review. The hard parts are *not the LLM judge* — they're the dataset hygiene, the per-workflow rubric design, and the org change management to make eng teams actually wait for evals before shipping. Tools: Arize Phoenix, Langfuse, Braintrust, internal builds.",
    interviewAnswer:
      "I'd treat the platform like a CI/CD pipeline for prompts, with three layers. First, offline regression — every prompt or model change runs the workflow's golden set in CI and blocks merges if quality regresses beyond an agreed SLO. Second, shadow or canary — the new version runs alongside the old on a small slice of production traffic, scored automatically, with rollback if metrics drop. Third, production telemetry — every conversation traced, sampled, and scored, with weekly trend reports per workflow. The metadata model tags each trace with the workflow, the version, the model, the tenant, latency, cost, and quality. Dashboards show quality versus cost versus latency on each version so PMs can see the trade-offs explicitly. For subjective metrics, I use an ensemble of judges plus periodic human spot-checks. The hard parts are not the LLM judge — they're dataset hygiene, the per-workflow rubric design, and the org change management to actually make engineering teams wait for evals before shipping. Tools like Arize Phoenix, Langfuse, or Braintrust handle the plumbing, but the discipline is on you.",
  },
  {
    id: "human-in-loop",
    topic: "System Design",
    level: "Senior",
    question: "Describe how you would implement a human-in-the-loop approval step for high-risk agent actions.",
    askedAt: ["Capital One", "Stripe", "Anthropic"],
    average:
      "Pause the workflow before the high-risk action, persist state, notify an approver with full context, resume after approval. Use idempotency keys to prevent double execution.",
    standout:
      "Be specific about the failure modes: (1) what counts as 'high-risk' — codified in policy (e.g., any tool with a write, any action above $X, any action affecting another user); (2) approval must include the *full agent reasoning trace* and the proposed effect, not just the action name — approvers can't approve what they don't understand; (3) timeout policy — auto-deny or escalate after N hours; (4) idempotency — generate the action's idempotency key *before* the approval, attach it to the persisted state, and reuse it on resume so a network blip doesn't double-execute; (5) audit log — every approval/denial recorded with approver identity, timestamp, justification (regulators care). UX matter: approvers will rubber-stamp if you ask them too often — only escalate genuinely high-risk actions, otherwise approval fatigue makes the human checkpoint worthless. Production reference: GitHub Copilot Workspace and Claude's computer-use ship explicit human-confirmation patterns for irreversible actions.",
    interviewAnswer:
      "The core flow is straightforward — pause the workflow before the high-risk action, persist the agent's full state, notify an approver with the context, and resume after the decision, using idempotency keys to prevent double execution. The details are where it gets interesting. I'd codify what counts as high-risk in policy, not in code comments — for example, any tool that writes, any action above a dollar threshold, any action affecting another user. The approval needs to include the full reasoning trace and the proposed effect, not just the action name, because approvers can't approve what they don't understand. There has to be a timeout policy that auto-denies or escalates after some number of hours. The idempotency key has to be generated before approval, attached to persisted state, and reused on resume so a network blip doesn't double-execute. And every approval and denial gets recorded in an audit log with the approver's identity and timestamp, which regulators do care about. Critically, you should only escalate genuinely high-risk actions, because if approvers are asked too often they'll rubber-stamp and the human checkpoint becomes worthless.",
    sources: [
      { label: "Anthropic — Computer use safety", url: "https://www.anthropic.com/news/3-5-models-and-computer-use" },
    ],
  },

  // ─────────────────────────────  COST & LATENCY  ─────────────────────────────
  {
    id: "reduce-latency",
    topic: "Cost & Latency",
    level: "Mid",
    question: "How do you reduce LLM latency in a production chatbot?",
    askedAt: ["OpenAI", "Anthropic", "Replit"],
    average:
      "Stream tokens, use a smaller model where possible, cache responses, parallelize independent tool calls, and use quantized inference for self-hosted models.",
    standout:
      "Order matters because it's where the time actually goes. Profile first: in most chatbots, *retrieval and tool latency dominate, not the LLM*. Then attack: (1) **Stream the first token** — TTFT (time to first token) is the metric the user feels; aim <500ms. (2) **Prompt caching** — both Anthropic and OpenAI ship cached-prefix pricing (5–10× cheaper, lower latency). Put your big system prompt + KB headers in the cached prefix. (3) **Model routing** — classify the query first with a cheap model and route only complex ones to the big model. (4) **Parallel tool calls** — modern Claude/GPT support `parallel_tool_calls`; don't serialize independent calls. (5) **Speculative decoding** for self-hosted (Leviathan et al., 2023) — small draft model proposes tokens, big model verifies in one forward pass — 2–3× speedup. Mention that `temperature=0` actually doesn't help latency (same compute), it just helps reproducibility — junior candidates often confuse this.",
    interviewAnswer:
      "Order matters here because it's about where the time actually goes. The first step is profiling, because in most chatbots retrieval and tool latency dominate, not the model itself. Then I'd attack in this order. Stream the first token, because time to first token is the metric users feel — I aim for under five hundred milliseconds. Use prompt caching, because both major providers offer cached-prefix pricing that's much faster and cheaper, so the long stable system prompt belongs there. Route by model — classify queries first with a cheap model and route only the genuinely complex ones to the flagship. Parallel tool calls — modern model APIs support parallel tool calling and you should never serialize independent calls. For self-hosted inference, speculative decoding, where a small draft model proposes tokens and the big model verifies in one pass, gets you a noticeable speedup. One thing I'd correct any junior on — temperature zero doesn't actually help latency, it just helps reproducibility, because the same compute happens either way.",
    sources: [
      { label: "Anthropic — Prompt caching", url: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching" },
      { label: "OpenAI — Prompt caching", url: "https://platform.openai.com/docs/guides/prompt-caching" },
    ],
  },
  {
    id: "cost-control",
    topic: "Cost & Latency",
    level: "Mid",
    question: "How do you build a cost-efficient agent that handles both simple and complex tasks?",
    askedAt: ["OpenAI customers", "Anthropic", "AWS Bedrock"],
    average:
      "Model routing: a cheap fast model (GPT-4o-mini, Haiku) handles classification and simple tasks, complex tasks route to a stronger model. Cache repeated queries. Batch when possible.",
    standout:
      "Quantify it. A typical support workflow: classifier ($0.0001), retrieval ($0.001), generation ($0.005 with mini, $0.05 with flagship). Routing 80% of queries to mini gets you ~10× cost reduction with usually minimal quality drop — *measured on your eval suite*. Add: (1) prompt caching can save 50–80% on long stable prefixes; (2) semantic caching catches near-duplicate questions (set similarity threshold ~0.95, don't go too low or you'll serve stale answers); (3) per-user/per-tenant budget caps with auto-disable — agents have run up $10k bills overnight in well-publicized incidents; (4) instrument cost-per-resolved-task as the real KPI, not cost-per-token; (5) for batchable workloads (overnight summarization, embedding refresh), use the batch APIs (OpenAI/Anthropic batch tier ~50% off). Cite that this is exactly the recipe Anthropic and OpenAI both publish in their cost-optimization guides.",
    interviewAnswer:
      "I make this concrete by quantifying it. A typical support workflow might cost a tiny fraction of a cent for a classifier call, around a tenth of a cent for retrieval, half a cent for generation with a small model, and several cents with a flagship model. Routing eighty percent of queries to the small model gets you about an order of magnitude cost reduction, usually with minimal quality drop measured on your eval suite. On top of that, prompt caching can save fifty to eighty percent on long stable prefixes. Semantic caching catches near-duplicate questions, but you have to set the similarity threshold carefully — too low and you serve stale answers. I always set per-user and per-tenant budget caps with auto-disable, because there have been well-publicized incidents of agents running up huge bills overnight. I instrument cost-per-resolved-task as the real KPI, not cost-per-token, because tokens are an implementation detail. And for batchable workloads like overnight summarization or embedding refreshes, the batch APIs from major providers cut roughly half the cost.",
    sources: [
      { label: "OpenAI — Cost optimization", url: "https://platform.openai.com/docs/guides/cost-optimization" },
    ],
  },

  // ─────────────────────────────  BEHAVIORAL  ─────────────────────────────
  {
    id: "agent-misbehaved",
    topic: "Behavioral",
    level: "Senior",
    question: "Tell me about a time an agent you built behaved unexpectedly in production. What did you do?",
    askedAt: ["Anthropic", "OpenAI", "every senior interview"],
    average:
      "Describe the bug, the immediate fix, and the long-term mitigation. Show you can stay calm under pressure and root-cause the issue.",
    standout:
      "Use the *STAR + Postmortem* shape interviewers actually want. Situation: specific, observable symptom (latency spike, hallucination rate, cost surge). Task: what you owned. Action: (1) immediate mitigation to stop the bleeding (kill switch, route to human, revert prompt), (2) root cause via traces (not guesses), (3) systemic fix (eval test that would have caught it, guardrail, monitoring alert), (4) blameless postmortem written and shared. Result: numbers — incident closed in X mins, regression test added, recurrence rate. The worst answer is 'I fixed the bug' without the systemic part — that signals you'll keep firefighting. The AgenticCareers and DataCamp guides both flag this question as the most common senior-round filter — prepare *one specific story* in advance with concrete numbers.",
    interviewAnswer:
      "The structure I use is a STAR plus postmortem, because that's what senior interviewers actually want. I'd start with a specific observable symptom — say, faithfulness scores on our support agent dropped overnight by fifteen percent. I'd describe what I owned in that situation. Then the actions, in order — first an immediate mitigation to stop the bleeding, like flipping the kill switch or routing affected traffic to a human, then root-causing through traces rather than guessing, then a systemic fix, which usually means an eval test that would have caught it plus a monitoring alert plus a guardrail. Then a blameless postmortem written and shared. The result has to include numbers — incident closed in some number of minutes, regression test added, recurrence rate measured. The worst version of this answer is just I fixed the bug, because that signals you'll keep firefighting the same problem. The version interviewers grade well is the one where the systemic fix means the same class of bug can't ship again.",
  },
  {
    id: "stay-current",
    topic: "Behavioral",
    level: "Mid",
    question: "How do you stay current in a field that changes as fast as agentic AI?",
    askedAt: ["Almost everywhere"],
    average:
      "I follow Twitter/X researchers, read papers from OpenAI, Anthropic, and DeepMind, watch conference talks (NeurIPS, ICML), and try new tools.",
    standout:
      "Show *active* learning, not passive consumption — interviewers can tell the difference. Concrete signals: (1) you build a small prototype every week or month to test a new technique (prompt caching, MCP server, GraphRAG); (2) you contribute to or read open-source — LangGraph, LlamaIndex, vLLM source code; (3) you have a take on a recent paper or release (e.g., 'I think Anthropic's Contextual Retrieval will be a default by mid-2026 because…'); (4) you write or share — a blog, a Loom, an internal tech-talk. Mention 2–3 specific resources you actually use (Latent Space podcast, Anthropic & OpenAI engineering blogs, The Batch, arXiv-sanity, your favorite Discord). Avoid 'I read a lot' — every candidate says that.",
    interviewAnswer:
      "I'd point to active learning rather than passive consumption, because interviewers can tell the difference. Concrete signals I'd give — I build a small prototype every couple of weeks to actually test a new technique, whether that's prompt caching, an MCP server, or trying GraphRAG on a corpus I know well. I read or contribute to open source — looking at how LangGraph handles state, or how vLLM does paged attention, teaches you more than another blog post. I have an opinion on a recent paper or release that I can defend, like why I think contextual retrieval is going to become a default. And I share what I learn, even if it's just a brief internal write-up or a Loom for the team. For sources, I'd name two or three I actually use rather than rattling off ten — the engineering blogs from Anthropic and OpenAI, a podcast like Latent Space, and arXiv-sanity for paper triage. The thing I'd avoid is the answer everyone gives, which is I read a lot — that's true of every candidate.",
  },
  {
    id: "convince-stakeholders",
    topic: "Behavioral",
    level: "Senior",
    question: "Describe a time you convinced stakeholders that a more conservative agent design was the right call.",
    askedAt: ["Anthropic", "Capital One", "any regulated industry"],
    average:
      "Frame the trade-off in business terms — risk, cost, blast radius — not just technical detail. Show you can disagree and still collaborate.",
    standout:
      "Make it concrete: *they wanted X autonomy, I argued for Y guardrail because the worst-case cost of being wrong was $Z (or a regulatory event, or a brand event)*. Strong answers cite a *specific risk model* you brought to the conversation — not 'because it's safer'. E.g., 'For an action that mutated billing, I proposed human-approval-in-the-loop for any change >$500. The PM wanted full autonomy; I showed the eval data — at our then-current accuracy of 92%, an autonomous setup would create ~80 incorrect billing changes per 1,000 interactions, each one a CS escalation costing $40 to resolve plus customer-trust impact. We agreed on the human-approval gate and revisited it after we got the agent above 99% on the eval.' That structure — measured risk, business cost, agreed exit criteria — is what senior interviewers grade on.",
    interviewAnswer:
      "I'd frame this with a specific example so it doesn't sound theoretical. The structure is — they wanted some level of autonomy, I argued for a guardrail, and the reason I won the argument was that I brought a measured risk model rather than just a feeling. For example, on an action that mutated billing, the PM wanted full agent autonomy. I went back with the eval data — at the agent's then-current accuracy of around ninety-two percent, an autonomous setup would create roughly eighty incorrect billing changes per thousand interactions. Each of those is a customer service escalation that costs real money to resolve, plus the customer trust impact that's harder to put a number on. We agreed on a human-approval gate above a dollar threshold, with explicit exit criteria — once we got the agent above ninety-nine percent on the eval, we'd revisit the threshold. That structure of measured risk, business cost translated into dollars, and agreed exit criteria is what senior interviewers grade on. It shows you can disagree well, you can collaborate, and you can speak the language of the people making the decision.",
  },
];

export type InterviewSection = {
  topic: InterviewTopic;
  description: string;
  questions: InterviewQuestion[];
};

export function groupQuestionsByTopic(qs: InterviewQuestion[]): InterviewSection[] {
  const descriptions: Record<InterviewTopic, string> = {
    Foundations: "Core LLM concepts every GenAI interview opens with — attention, sampling, context, instruction tuning.",
    RAG: "Retrieval-augmented generation: chunking, hybrid search, reranking, evaluation, GraphRAG.",
    Agents: "Single-agent design — ReAct, tool use, loop control, failure handling.",
    "Multi-Agent": "Orchestrator/worker, critic/verifier, when multi-agent helps and when it just adds cost.",
    Prompting: "Chain-of-thought, few-shot, system vs user prompts, prompt engineering trade-offs.",
    "Tools & MCP": "Function calling, the Model Context Protocol, tool description quality.",
    Memory: "Working / episodic / semantic / procedural memory, lost-in-the-middle, contradictions.",
    Evaluation: "Eval harnesses, RAGAS, LLM-as-Judge biases, regression testing for prompts.",
    "Safety & Security": "Prompt injection (direct & indirect), capability isolation, OWASP LLM Top 10.",
    "Fine-Tuning": "RAG vs fine-tune, LoRA / QLoRA, RLHF & DPO, Constitutional AI.",
    "System Design": "End-to-end designs interviewers ask: support agents, multi-tenant RAG, eval platforms, HITL.",
    "Cost & Latency": "Model routing, prompt caching, streaming, parallel tool calls, semantic cache, batch tier.",
    Behavioral: "The senior-round filters: incident stories, staying current, disagreeing well.",
  };

  const map = new Map<InterviewTopic, InterviewQuestion[]>();
  for (const q of qs) {
    if (!map.has(q.topic)) map.set(q.topic, []);
    map.get(q.topic)!.push(q);
  }
  return INTERVIEW_TOPICS.filter((t) => map.has(t)).map((topic) => ({
    topic,
    description: descriptions[topic],
    questions: map.get(topic)!,
  }));
}
