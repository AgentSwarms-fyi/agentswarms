// Real, runnable templates for the platform.
// Each template ships with:
//   - a default model id served through the instance's OpenRouter fallback
//     (no extra credentials needed when the operator sets OPENROUTER_API_KEY)
//   - real seed documents that get inserted into knowledge_bases / knowledge_documents
//   - a real tool list (knowledge base RAG, optional approval workflow)
//   - a real guardrails configuration (PII scan, output safety, citation enforcement)
//   - a suggested first prompt the user can fire with one click
//   - a guided lesson with checkpoints that auto-tick as the user completes them
//
// Important: model ids must match what /api/chat will accept. For providers
// that need user credentials we set requiresProvider so the UI can guard the CTA.

export type TemplateCategory =
  | "Customer Support"
  | "Research & Analysis"
  | "Knowledge Q&A"
  | "Sales & Marketing"
  | "Engineering"
  | "Data Processing"
  | "Web Research"
  | "Developer Productivity"
  | "Content & Marketing"
  | "Support & Operations";

export type TemplateProvider =
  | "openrouter"
  | "anthropic"
  | "bedrock"
  | "vertex"
  | "azure_openai"
  | "qwen";

export type TemplateGuardrails = {
  piiScan: boolean;
  outputSafety: boolean;
  enforceCitations: boolean;
  maxTokens: number;
};

export type TemplateTool =
  | { type: "knowledge_base"; description: string }
  | { type: "human_approval"; description: string; threshold?: string }
  | { type: "web_search"; description: string };

export type TemplateSeedDoc = {
  name: string;
  // Plain markdown / text. Inserted into knowledge_documents.content where the
  // RAG retriever can keyword-score it.
  content: string;
};

export type TemplateLessonStep = {
  id:
    | "send_first_message"
    | "model_replies"
    | "citations_appear"
    | "approval_shown"
    | "approval_decided";
  title: string;
  description: string;
  // Concrete prompt the user can fire at this step to drive the demo down the
  // intended pathway (e.g. an out-of-scope question to test the citation guardrail).
  suggestedPrompt?: string;
  // Short label rendered next to the prompt chip, e.g. "Try a refund request".
  promptHint?: string;
  // Where in the platform this concept lives (used as a "Learn more" link).
  learnMoreRoute?: string;
  learnMoreLabel?: string;
};

export type RealTemplate = {
  id: string;
  title: string;
  tagline: string;
  description: string;
  category: TemplateCategory;
  // Provider used by default in the demo.
  provider: TemplateProvider;
  modelId: string;
  modelLabel: string;
  // If set, the demo can only run when the user has connected this provider.
  requiresProvider?: Exclude<TemplateProvider, "openrouter">;
  systemPrompt: string;
  temperature: number;
  guardrails: TemplateGuardrails;
  tools: TemplateTool[];
  // Empty array = no knowledge base for this template.
  seedDocuments: TemplateSeedDoc[];
  // Suggested first message for the user to click.
  suggestedPrompts: string[];
  // Optional human-in-the-loop seed: an approval row created so the demo's
  // approval inbox already has something realistic to act on.
  approvalSeed?: {
    action_title: string;
    action_type: string;
    risk_level: "low" | "medium" | "high";
    description: string;
    payload: Record<string, unknown>;
  };
  lesson: TemplateLessonStep[];
  // Visual accent for the card.
  accent: string;
  /** If set, the provisioner reuses this existing knowledge base instead of seeding one. */
  existingKnowledgeBaseId?: string;
  /** Extra built-in tool toggles to enable on the provisioned agent (e.g. { kb_graph_search: true }). */
  extraBuiltInTools?: Record<string, boolean>;
  /** If set, the Playground guided-tour overlay (SkillSampleTour) activates with this id. */
  skillTourId?: string;
};

export const REAL_TEMPLATES: RealTemplate[] = [
  // ──────────────────────────────────────────────────────────────────
  // 1. Customer Support agent with a real product KB
  // ──────────────────────────────────────────────────────────────────
  {
    id: "support-kb-agent",
    title: "Product Support Assistant",
    tagline: "Answers customer questions from your help center docs.",
    description:
      "A grounded support agent that retrieves answers from a product knowledge base, cites the exact help article, and refuses to invent policy it can't find.",
    category: "Customer Support",
    provider: "openrouter",
    modelId: "google/gemini-3-flash-preview",
    modelLabel: "Gemini 3 Flash",
    systemPrompt:
      "You are a friendly product support agent for SonicPro, a wireless headphone brand. " +
      "Always ground your answers in the provided knowledge base sources. " +
      "If the answer isn't in the sources, tell the customer you can't find a definitive policy " +
      "and offer to escalate. Cite sources inline as [1], [2] using the source numbers.",
    temperature: 0.3,
    guardrails: {
      piiScan: true,
      outputSafety: true,
      enforceCitations: true,
      maxTokens: 1024,
    },
    tools: [
      {
        type: "knowledge_base",
        description: "SonicPro help center: returns, warranty, shipping, troubleshooting.",
      },
    ],
    seedDocuments: [
      {
        name: "Returns & Refunds Policy",
        content: `# SonicPro — Returns & Refunds Policy

You can return any SonicPro product within **30 days of delivery** for a full refund.

## Eligibility
- The product must be in its original packaging.
- Items received damaged on arrival are eligible for a **full refund or replacement** at the customer's choice, regardless of the 30-day window.
- Custom-engraved items are non-returnable unless they arrived damaged.

## Refund timing
- Refunds are issued to the original payment method.
- Most refunds appear within **3-5 business days** of us receiving the returned product.
- For damaged-on-arrival cases the refund is issued within **24 hours** of approval — the customer keeps the damaged unit.

## How to start a return
1. Open the order in your account → "Request return".
2. Choose a reason. If "Damaged on arrival", upload at least one photo.
3. Print the prepaid shipping label we email you.

Refunds above $25 require a quick supervisor approval before they are issued.`,
      },
      {
        name: "Warranty Coverage",
        content: `# SonicPro — Warranty

Every SonicPro headphone ships with a **2-year limited warranty** that covers manufacturing defects.

## What is covered
- Driver failure
- Battery capacity drop below 70% within 24 months
- Hinge / headband cracking under normal use

## What is NOT covered
- Cosmetic damage (scratches, dents)
- Water damage on non-IPX rated models (X1, X2)
- Damage caused by third-party accessories

## How to claim
Email warranty@sonicpro.example with your order number, a description of the issue, and 2-3 photos. We respond within **1 business day**.`,
      },
      {
        name: "Shipping & Delivery",
        content: `# Shipping

| Region | Standard | Express |
|---|---|---|
| US (48 states) | 3-5 business days · free | 1-2 business days · $12 |
| Canada | 5-7 business days · $9 | 2-3 business days · $19 |
| EU | 5-9 business days · $14 | 2-4 business days · $29 |

We ship from a single warehouse in Reno, NV. Orders placed before 1pm PT ship the same day.

We do not currently ship to PO boxes for express orders.`,
      },
      {
        name: "Pairing & Troubleshooting",
        content: `# Pairing your SonicPro headphones

1. Hold the power button for **5 seconds** until the LED blinks blue.
2. On your device, open Bluetooth settings and select "SonicPro X2".
3. Default pairing PIN is **0000** (only required on older devices).

## If the LED won't blink
- Charge the headphones for at least 15 minutes with the included USB-C cable.
- Reset the headphones: hold power + volume-down for 10 seconds.

## Audio cuts out
- Stay within 10 meters / 33 feet of the source.
- Microwave ovens and 2.4GHz Wi-Fi can cause interference; try moving away.`,
      },
    ],
    suggestedPrompts: [
      "I just got my SonicPro X2 and the right earcup is cracked. I want a refund, not a replacement. What can you do?",
      "How long do I have to return a non-damaged pair of headphones?",
      "My headphones won't pair with my Mac. The LED won't even blink — what should I try?",
    ],
    approvalSeed: {
      action_title: "Issue $50 refund — order A-48291",
      action_type: "refund",
      risk_level: "medium",
      description:
        "Refund above $25 threshold for damaged-on-arrival case (2nd incident for this customer). Auto-flagged for supervisor review.",
      payload: {
        order_id: "A-48291",
        amount_usd: 50.0,
        reason: "damaged_on_arrival_repeat",
        payment_method: "visa_4242",
      },
    },
    lesson: [
      {
        id: "send_first_message",
        title: "Send the first message",
        description:
          "Try the suggested prompt or write your own. Your message is sent to the agent's configured model with the system prompt and the knowledge base attached.",
        suggestedPrompt:
          "I just got my SonicPro X2 and the right earcup is cracked. I want a refund of $50, not a replacement. What can you do?",
        promptHint: "Damaged-on-arrival refund — triggers RAG + approval",
      },
      {
        id: "model_replies",
        title: "Watch the model stream a response",
        description:
          "The reply streams token-by-token from the AgentSwarms AI Gateway. The execution trace on the right shows every step.",
        learnMoreRoute: "/traces",
        learnMoreLabel: "Open traces",
      },
      {
        id: "citations_appear",
        title: "Look for cited sources",
        description:
          "Because this template enforces citations, the assistant grounds its answer in the help articles and lists them under a 'Sources' card.",
        suggestedPrompt: "How long do I have to return a non-damaged pair of headphones?",
        promptHint: "Clean policy lookup — should cite the Returns doc",
        learnMoreRoute: "/knowledge",
        learnMoreLabel: "Manage knowledge bases",
      },
      {
        id: "approval_shown",
        title: "A high-impact action paused for review",
        description:
          "Refunds above $25 are gated. The agent created an approval request — find it in the Approval Inbox.",
        suggestedPrompt: "Please go ahead and issue that $50 refund to my Visa.",
        promptHint: "Forces a human-approval action",
        learnMoreRoute: "/dashboard",
        learnMoreLabel: "Open approval inbox",
      },
      {
        id: "approval_decided",
        title: "Approve or reject",
        description:
          "Once you decide, the agent continues. This is the human-in-the-loop pattern in action.",
      },
    ],
    accent: "from-emerald-500/25 to-transparent",
  },

  // ──────────────────────────────────────────────────────────────────
  // 2. RAG over uploaded research PDFs
  // ──────────────────────────────────────────────────────────────────
  {
    id: "research-rag",
    title: "Research Q&A on AI Papers",
    tagline: "Ask questions about a small library of AI research summaries.",
    description:
      "A RAG agent grounded in summaries of three influential AI papers. Demonstrates retrieval scoring, inline citations, and how to refuse out-of-scope questions.",
    category: "Research & Analysis",
    provider: "openrouter",
    modelId: "google/gemini-2.5-flash",
    modelLabel: "Gemini 2.5 Flash",
    systemPrompt:
      "You are a research assistant. Answer ONLY using the provided sources. " +
      "Cite each claim with [n] using the source numbers below. " +
      "If the question is not covered by the sources, say so clearly and do not speculate.",
    temperature: 0.2,
    guardrails: {
      piiScan: false,
      outputSafety: true,
      enforceCitations: true,
      maxTokens: 1500,
    },
    tools: [
      {
        type: "knowledge_base",
        description: "Three classic AI paper summaries: Transformer, LoRA, RAG.",
      },
    ],
    seedDocuments: [
      {
        name: "Attention Is All You Need (2017) — Summary",
        content: `# Attention Is All You Need (Vaswani et al., 2017)

## Core contribution
The Transformer architecture introduces a sequence-to-sequence model based **entirely on attention mechanisms**, removing the recurrence used by RNNs and the convolutions used by CNNs.

## Key components
- **Multi-head self-attention**: every position attends to every other position in parallel; multiple heads let the model attend to different representation subspaces.
- **Positional encoding**: since attention is permutation-invariant, fixed sinusoidal positional encodings are added to the input embeddings to inject order.
- **Encoder-decoder stack**: 6 identical layers each, with residual connections + layer normalization.

## Why it mattered
- Trains in **far less wall-clock time** than RNN seq2seq because attention is fully parallelizable across the sequence dimension.
- Achieved a new state of the art on WMT 2014 English-to-German translation (28.4 BLEU) using a fraction of the compute.
- Became the foundation for BERT, GPT, T5, and essentially every modern large language model.`,
      },
      {
        name: "LoRA: Low-Rank Adaptation (2021) — Summary",
        content: `# LoRA: Low-Rank Adaptation of Large Language Models (Hu et al., 2021)

## Problem
Full fine-tuning of a large LLM updates **billions of parameters**, which is expensive in memory and storage, especially when serving many task-specific variants of the same base model.

## Idea
Freeze the pretrained weights W and learn two small low-rank matrices A (d × r) and B (r × k) such that the effective update is **W + B·A**. The rank r is typically 4-16, so the number of trainable parameters drops by **10,000× or more** versus full fine-tuning.

## Results
- Comparable or better task quality than full fine-tuning on GLUE, WikiSQL, SAMSum.
- **No additional inference latency** because B·A can be merged back into W at deployment time.
- Each task ships as a small adapter file (a few MB) instead of a full model checkpoint.

## Practical impact
LoRA underpins virtually all efficient fine-tuning today and is the basis of techniques like QLoRA (LoRA + 4-bit quantized base weights).`,
      },
      {
        name: "Retrieval-Augmented Generation (RAG, 2020) — Summary",
        content: `# Retrieval-Augmented Generation (Lewis et al., 2020)

## Motivation
LLMs encode knowledge **parametrically** in their weights, which means updating that knowledge requires retraining. RAG decouples knowledge from the model: a **retriever** pulls relevant documents from an external corpus at inference time and a **generator** conditions on them.

## Architecture
1. **Retriever** (DPR): a dual-encoder that embeds the query and documents, then returns the top-k by inner-product.
2. **Generator** (BART): conditions on the query AND the retrieved passages to produce the final text.
3. The two are trained end-to-end with the retrieval choice marginalized over.

## Two variants
- **RAG-Sequence**: the same documents are used for the entire output sequence.
- **RAG-Token**: a different document can be selected for each generated token.

## Why it matters
RAG demonstrated that grounding LLM outputs in **retrievable evidence** improves factuality and lets the knowledge base be updated **without retraining the model**, which is why production AI systems for Q&A, support, and search overwhelmingly use a RAG pattern today.`,
      },
    ],
    suggestedPrompts: [
      "Why does the Transformer use positional encodings? Cite your sources.",
      "How does LoRA reduce the number of trainable parameters versus full fine-tuning?",
      "Compare RAG-Sequence and RAG-Token. When would you pick one over the other?",
    ],
    lesson: [
      {
        id: "send_first_message",
        title: "Ask a research question",
        description:
          "Try one of the suggested prompts or paste your own. The agent will only answer questions that the seed papers cover.",
        suggestedPrompt: "Why does the Transformer use positional encodings? Cite your sources.",
        promptHint: "Grounded Q&A — should cite the Transformer paper",
      },
      {
        id: "model_replies",
        title: "Streaming response",
        description:
          "Watch the answer assemble token-by-token. The right-side trace stream shows the model + retrieval steps.",
      },
      {
        id: "citations_appear",
        title: "Inspect the cited papers",
        description:
          "The 'Sources' card under the reply tells you which paper each [n] points to. Click into Knowledge to see the raw documents.",
        suggestedPrompt:
          "How does LoRA reduce the number of trainable parameters versus full fine-tuning?",
        promptHint: "Multi-source citation — should cite the LoRA paper",
        learnMoreRoute: "/knowledge",
        learnMoreLabel: "View knowledge bases",
      },
      {
        id: "approval_shown",
        title: "Try an out-of-scope question",
        description:
          "Ask something the papers don't cover. The agent should refuse rather than hallucinate — that's the citation guardrail working.",
        suggestedPrompt: "What is Mixture of Experts and how does it compare to dense models?",
        promptHint: "Out-of-scope — agent should refuse, not hallucinate",
      },
      {
        id: "approval_decided",
        title: "Customize for your own corpus",
        description:
          "Replace the seed documents with your own PDFs from the Knowledge page to make this template yours.",
        suggestedPrompt: "Summarize all three papers in one paragraph each, with citations.",
        promptHint: "Multi-doc synthesis across the whole corpus",
        learnMoreRoute: "/knowledge",
        learnMoreLabel: "Upload your own docs",
      },
    ],
    accent: "from-violet-500/25 to-transparent",
  },

  // ──────────────────────────────────────────────────────────────────
  // 3. Sales — outbound email draft with HITL approval
  // ──────────────────────────────────────────────────────────────────
  {
    id: "sales-outreach",
    title: "Sales Outreach Drafter",
    tagline: "Drafts personalized outbound emails — humans approve before sending.",
    description:
      "A creative agent that drafts a short, personalized outreach email and then routes it to the Approval Inbox for human review before any send action would fire.",
    category: "Sales & Marketing",
    provider: "openrouter",
    modelId: "google/gemini-2.5-pro",
    modelLabel: "Gemini 2.5 Pro",
    systemPrompt:
      "You are a B2B sales outreach copywriter. Given a prospect description, write ONE outbound email of " +
      "no more than 120 words. It must feel personal, reference at least one specific detail from the prospect, " +
      "have a single clear call to action, and avoid pushy phrases. Output only the email subject + body — no preamble.",
    temperature: 0.7,
    guardrails: {
      piiScan: true,
      outputSafety: true,
      enforceCitations: false,
      maxTokens: 600,
    },
    tools: [
      {
        type: "human_approval",
        description: "Every drafted email is paused for human approval before any send action.",
        threshold: "always",
      },
    ],
    seedDocuments: [],
    suggestedPrompts: [
      "Prospect: VP of Engineering at a mid-market fintech (~150 engineers). They just open-sourced their feature flag service on GitHub last week. Pain point we solve: replacing brittle home-grown LLM eval pipelines.",
      "Prospect: Head of Customer Support at a DTC mattress brand. Recently mentioned on their blog that they're scaling their support team 3x for the holiday season. Pain we solve: AI triage so live agents only handle hard tickets.",
    ],
    approvalSeed: {
      action_title: "Send drafted outreach email to prospect",
      action_type: "send_email",
      risk_level: "low",
      description:
        "Outbound email drafted by the Sales Outreach agent. Review tone, accuracy, and CTA before approving — approval triggers the send.",
      payload: {
        to: "vp.eng@example-fintech.com",
        subject: "Replacing brittle LLM eval pipelines — quick idea",
        body: "Hi {first_name}, …",
      },
    },
    lesson: [
      {
        id: "send_first_message",
        title: "Describe a prospect",
        description:
          "Try the suggested prompt. Real outreach happens in seconds — the agent has no list of contacts of its own.",
        suggestedPrompt:
          "Prospect: VP of Engineering at a mid-market fintech (~150 engineers). They just open-sourced their feature flag service on GitHub last week. Pain point we solve: replacing brittle home-grown LLM eval pipelines.",
        promptHint: "Detailed prospect brief — drives a personalized draft",
      },
      {
        id: "model_replies",
        title: "Read the draft",
        description: "The model returns subject + body. Higher temperature lets it sound human.",
      },
      {
        id: "citations_appear",
        title: "Notice no citations",
        description:
          "Citations are off for this template — outreach is generative, not retrieval. Guardrails still scan for PII.",
        suggestedPrompt: "Rewrite that draft 30% shorter and end with a meeting-link CTA.",
        promptHint: "Iterate on tone and length",
        learnMoreRoute: "/agents",
        learnMoreLabel: "Tune guardrails",
      },
      {
        id: "approval_shown",
        title: "Send was paused for human review",
        description:
          "Notice that nothing was actually sent. The send action sits in your Approval Inbox awaiting your decision.",
        suggestedPrompt: "Looks good — queue it for sending to vp.eng@example-fintech.com.",
        promptHint: "Triggers a send_email approval row",
        learnMoreRoute: "/dashboard",
        learnMoreLabel: "Open approval inbox",
      },
      {
        id: "approval_decided",
        title: "Approve or reject",
        description:
          "Approving simulates firing your real send-email integration. Rejecting cancels the action — nothing leaves your workspace.",
      },
    ],
    accent: "from-amber-500/25 to-transparent",
  },

  // ──────────────────────────────────────────────────────────────────
  // 4. Engineering — code reviewer (no KB, just system prompt)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "code-reviewer",
    title: "Code Review Assistant",
    tagline: "Reviews a pasted diff for bugs, style, and security issues.",
    description:
      "A senior-engineer-style code reviewer. Demonstrates how to get high-quality structured output from a powerful model with a strong system prompt — no knowledge base required.",
    category: "Engineering",
    provider: "openrouter",
    modelId: "openai/gpt-5-mini",
    modelLabel: "GPT-5 Mini",
    systemPrompt: `You are a senior software engineer doing a code review.

For any code or diff the user pastes, respond in EXACTLY this structure:

### 🐛 Bugs
- One bullet per real bug, citing the line. Empty section if none.

### ⚠️ Risks
- Edge cases, race conditions, security issues, performance cliffs.

### 🎨 Style
- Naming, structure, idiomatic improvements.

### ✅ Approve / ❌ Request changes
- One sentence verdict.

Be terse. Do not restate the code back. Be honest about uncertainty.`,
    temperature: 0.4,
    guardrails: {
      piiScan: false,
      outputSafety: true,
      enforceCitations: false,
      maxTokens: 1500,
    },
    tools: [],
    seedDocuments: [],
    suggestedPrompts: [
      `Review this Python:

def get_user(db, user_id):
    cursor = db.cursor()
    query = "SELECT * FROM users WHERE id = " + user_id
    cursor.execute(query)
    return cursor.fetchone()`,
      `Review this React handler:

const handleSubmit = async (e) => {
  setLoading(true);
  const res = await fetch("/api/save", { method: "POST", body: form });
  setLoading(false);
  if (res.ok) navigate("/");
};`,
    ],
    lesson: [
      {
        id: "send_first_message",
        title: "Paste some code",
        description: "Try the suggested SQL injection example or paste your own diff.",
        suggestedPrompt: `Review this Python:

def get_user(db, user_id):
    cursor = db.cursor()
    query = "SELECT * FROM users WHERE id = " + user_id
    cursor.execute(query)
    return cursor.fetchone()`,
        promptHint: "Classic SQL injection — reviewer should flag it",
      },
      {
        id: "model_replies",
        title: "Read the structured review",
        description:
          "The system prompt forces a fixed structure (Bugs / Risks / Style / Verdict). This is the simplest way to get reliable formatting from an LLM.",
      },
      {
        id: "citations_appear",
        title: "No knowledge base needed",
        description:
          "Some templates don't need RAG. The reviewer relies entirely on the model's training and a strong system prompt.",
        learnMoreRoute: "/agents",
        learnMoreLabel: "Edit the system prompt",
      },
      {
        id: "approval_shown",
        title: "Try a tougher diff",
        description:
          "Paste a 30-50 line change from your own repo. Notice how the reviewer flags issues you may not have spotted.",
        suggestedPrompt: `Review this React handler:

const handleSubmit = async (e) => {
  setLoading(true);
  const res = await fetch("/api/save", { method: "POST", body: form });
  setLoading(false);
  if (res.ok) navigate("/");
};`,
        promptHint: "Missing preventDefault, no error handling, race conditions",
      },
      {
        id: "approval_decided",
        title: "Connect this to your CI",
        description:
          "Clone this template into your workspace and call its agent from a GitHub Action via the chat API.",
        learnMoreRoute: "/integrations",
        learnMoreLabel: "Set up an integration",
      },
    ],
    accent: "from-sky-500/25 to-transparent",
  },

  // ──────────────────────────────────────────────────────────────────
  // 5. Anthropic-only template (gated by provider connection)
  // ──────────────────────────────────────────────────────────────────
  {
    id: "claude-long-context",
    title: "Long-Context Document Analyst",
    tagline: "Summarizes long contracts and meeting transcripts using Claude.",
    description:
      "Uses Anthropic Claude 3.5 Sonnet directly (via your own API key) to handle very long documents. Demonstrates how the platform routes to external providers when you connect them.",
    category: "Research & Analysis",
    provider: "anthropic",
    requiresProvider: "anthropic",
    modelId: "claude-3-5-sonnet-20241022",
    modelLabel: "Claude 3.5 Sonnet",
    systemPrompt:
      "You are a senior analyst. Given a long document the user pastes (contract, transcript, or report), produce: " +
      "(1) a 5-bullet executive summary, (2) a list of explicit obligations or action items with the responsible party, " +
      "(3) a list of open risks or ambiguities. Be precise; quote directly from the document where possible.",
    temperature: 0.3,
    guardrails: {
      piiScan: true,
      outputSafety: true,
      enforceCitations: false,
      maxTokens: 2000,
    },
    tools: [],
    seedDocuments: [],
    suggestedPrompts: [
      "Paste a contract, meeting transcript, or design doc here and I'll extract obligations and risks.",
    ],
    lesson: [
      {
        id: "send_first_message",
        title: "Connect Anthropic first",
        description:
          "This template runs against your Anthropic API key — connect it under Integrations to enable.",
        learnMoreRoute: "/integrations",
        learnMoreLabel: "Connect Anthropic",
      },
      {
        id: "model_replies",
        title: "Paste a long document",
        description:
          "Claude 3.5 Sonnet handles ~200K tokens of context. Try a full meeting transcript.",
        suggestedPrompt:
          "Paste a contract or meeting transcript here and I'll extract obligations, owners, and risks.",
        promptHint: "Long-document analysis pattern",
      },
      {
        id: "citations_appear",
        title: "Notice direct quotes",
        description:
          "The system prompt asks Claude to quote directly. That's a lightweight alternative to RAG when the document is short enough to fit in context.",
        suggestedPrompt:
          "Now extract just the dates and deadlines mentioned, formatted as a bulleted timeline.",
        promptHint: "Follow-up extraction on the same context",
      },
      {
        id: "approval_shown",
        title: "Try multiple providers",
        description:
          "The same agent can be re-pointed at AWS Bedrock or Vertex from the agent editor — same Claude model, your choice of vendor.",
        learnMoreRoute: "/integrations",
        learnMoreLabel: "Add another provider",
      },
      {
        id: "approval_decided",
        title: "Switch models on the fly",
        description:
          "If you hit a rate limit, the playground will offer to swap models and replay the conversation with full context preserved.",
      },
    ],
    accent: "from-orange-500/25 to-transparent",
  },
];

export const TEMPLATE_CATEGORIES: ("All" | TemplateCategory)[] = [
  "All",
  "Customer Support",
  "Research & Analysis",
  "Knowledge Q&A",
  "Sales & Marketing",
  "Engineering",
  "Data Processing",
  "Web Research",
  "Developer Productivity",
  "Content & Marketing",
  "Support & Operations",
];

export function getRealTemplate(id: string): RealTemplate | undefined {
  return REAL_TEMPLATES.find((t) => t.id === id);
}
