// Internal linking graph for /blog. Each post gets:
//   - related: 3 sibling posts (pillar + cluster mates) with a one-line note
//   - explore: 2–3 AgentSwarms product surfaces relevant to the post's topic
//
// Rendered by BlogContent.tsx as two cards beneath the article body, so every
// blog page exposes 5–8 crawlable internal links without touching the 5k-line
// blog.ts content file. Pillars per cluster:
//   production-system-design-for-agentic-ai      (Production & Architecture)
//   langgraph-vs-crewai-vs-autogen-2026           (Frameworks & Multi-Agent)
//   devops-for-agentic-ai-open-source-playbook    (Infrastructure & DevOps)
//   agentic-ai-interview-questions-2026           (Learning & Career)

export type RelatedPost = { slug: string; note: string };
export type ExploreLink = { label: string; href: string; note: string };

export const RELATED_POSTS: Record<string, RelatedPost[]> = {
  "securing-agentic-ai-layered-defense": [
    {
      slug: "production-system-design-for-agentic-ai",
      note: "The architecture pillars that make the security layers enforceable.",
    },
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "The failure modes the layered defenses are designed to prevent.",
    },
    {
      slug: "mcp-production-playbook-2026",
      note: "Where MCP servers fit — and break — in the tool-security layer.",
    },
  ],

  // ── Production & Architecture cluster ────────────────────────────────
  "production-system-design-for-agentic-ai": [
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "The failure modes the six pillars are designed to prevent.",
    },
    {
      slug: "cost-control-in-multi-agent-systems",
      note: "How the cost pillar plays out in real swarm budgets.",
    },
    {
      slug: "devops-for-agentic-ai-open-source-playbook",
      note: "The deployment side of the same architectural picture.",
    },
  ],
  "7-failure-modes-that-kill-multi-agent-systems": [
    {
      slug: "production-system-design-for-agentic-ai",
      note: "The architecture pillars that close most of these failure modes.",
    },
    {
      slug: "cost-control-in-multi-agent-systems",
      note: "Runaway loops are also the #1 way swarms burn money.",
    },
    {
      slug: "pydantic-the-contract-layer-of-agentic-ai",
      note: "Typed contracts shut down a third of these failures at the boundary.",
    },
  ],
  "cost-control-in-multi-agent-systems": [
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "The loop and snowball patterns that quietly multiply your bill.",
    },
    {
      slug: "memory-management-in-agentic-ai",
      note: "Most token blow-ups start in an unbounded conversation history.",
    },
    {
      slug: "agentic-ai-use-case-feasibility-framework",
      note: "Decide if the use case is worth the bill before you build.",
    },
  ],
  "agentic-ai-use-case-feasibility-framework": [
    {
      slug: "production-system-design-for-agentic-ai",
      note: "Once it passes feasibility, here's the architecture to build.",
    },
    {
      slug: "cost-control-in-multi-agent-systems",
      note: "Plug realistic unit costs into the ROI math, not aspirational ones.",
    },
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "The risks that should weight your feasibility score.",
    },
  ],
  "when-your-documents-change-keeping-rag-honest": [
    {
      slug: "agentic-rag-vs-traditional-rag",
      note: "Agentic RAG raises the bar for index freshness even higher.",
    },
    {
      slug: "mcp-production-playbook-2026",
      note: "MCP servers are the other interface your assistant sees out of date first.",
    },
    {
      slug: "production-system-design-for-agentic-ai",
      note: "Observability + identity pillars for catching drift early.",
    },
  ],

  "word2vec-the-foundational-root-of-llms": [
    {
      slug: "memory-management-in-agentic-ai",
      note: "Embeddings are the substrate of every agent memory layer.",
    },
    {
      slug: "agentic-rag-vs-traditional-rag",
      note: "What word2vec-style retrieval becomes once an agent drives it.",
    },
    {
      slug: "when-your-documents-change-keeping-rag-honest",
      note: "The embedding index is the part of RAG that quietly goes stale.",
    },
  ],

  // ── Frameworks & Multi-Agent cluster ────────────────────────────────
  "langgraph-vs-crewai-vs-autogen-2026": [
    {
      slug: "hermes-self-improving-agents-memory-skills-subagents",
      note: "What an agent built on top of these frameworks looks like in 2026.",
    },
    {
      slug: "memory-management-in-agentic-ai",
      note: "The memory layer every framework leaves to you.",
    },
    {
      slug: "pydantic-the-contract-layer-of-agentic-ai",
      note: "The typed-output layer that makes any of these frameworks safe in production.",
    },
  ],
  "hermes-self-improving-agents-memory-skills-subagents": [
    {
      slug: "memory-management-in-agentic-ai",
      note: "Deep dive on the STM/LTM split Hermes relies on.",
    },
    {
      slug: "langgraph-vs-crewai-vs-autogen-2026",
      note: "Where Hermes-style patterns map onto each framework.",
    },
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "Self-improving agents amplify the failure modes you didn't fix.",
    },
  ],
  "memory-management-in-agentic-ai": [
    {
      slug: "hermes-self-improving-agents-memory-skills-subagents",
      note: "Memory + skills as the substrate for self-improvement.",
    },
    {
      slug: "cost-control-in-multi-agent-systems",
      note: "Memory hygiene is the #1 lever on token spend.",
    },
    {
      slug: "langgraph-vs-crewai-vs-autogen-2026",
      note: "How each framework exposes (or hides) the memory primitives.",
    },
  ],
  "pydantic-the-contract-layer-of-agentic-ai": [
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "Typed outputs eliminate the silent-corruption failure mode.",
    },
    {
      slug: "langgraph-vs-crewai-vs-autogen-2026",
      note: "Where Pydantic plugs into LangGraph, CrewAI, and AutoGen.",
    },
    {
      slug: "production-system-design-for-agentic-ai",
      note: "Schemas are the contract pillar of production architecture.",
    },
  ],
  "agentic-rag-vs-traditional-rag": [
    {
      slug: "when-your-documents-change-keeping-rag-honest",
      note: "Agentic RAG only works if the index underneath stays fresh.",
    },
    {
      slug: "memory-management-in-agentic-ai",
      note: "Retrieval and memory blur once the agent decides when to query.",
    },
    {
      slug: "langgraph-vs-crewai-vs-autogen-2026",
      note: "Agentic-RAG topologies sit naturally inside graph frameworks.",
    },
  ],

  // ── Infrastructure & DevOps cluster ─────────────────────────────────
  "devops-for-agentic-ai-open-source-playbook": [
    {
      slug: "deploying-agents-cicd-bedrock-azure-gcp",
      note: "One pipeline shipping the same agent to AWS, Azure, and GCP.",
    },
    {
      slug: "mcp-production-playbook-2026",
      note: "What you actually deploy when you deploy an MCP server.",
    },
    {
      slug: "production-system-design-for-agentic-ai",
      note: "The architectural pillars that this pipeline enforces.",
    },
  ],
  "deploying-agents-cicd-bedrock-azure-gcp": [
    {
      slug: "devops-for-agentic-ai-open-source-playbook",
      note: "The full open-source DevOps story this pipeline plugs into.",
    },
    {
      slug: "which-gpu-runs-which-llm-the-complete-guide",
      note: "Pick the right instance class before you wire up the deploy job.",
    },
    {
      slug: "cost-control-in-multi-agent-systems",
      note: "Multi-cloud deploys make per-call cost visibility non-optional.",
    },
  ],
  "which-gpu-runs-which-llm-the-complete-guide": [
    {
      slug: "deploying-agents-cicd-bedrock-azure-gcp",
      note: "Once you've picked the GPU, here's how to ship the model on it.",
    },
    {
      slug: "cost-control-in-multi-agent-systems",
      note: "GPU choice is the first lever on inference economics.",
    },
    {
      slug: "devops-for-agentic-ai-open-source-playbook",
      note: "The open-source stack that makes GPU choice portable.",
    },
  ],
  "mcp-production-playbook-2026": [
    {
      slug: "devops-for-agentic-ai-open-source-playbook",
      note: "How MCP servers fit into a real CI/CD pipeline.",
    },
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "MCP introduces fresh classes of tool-call failures.",
    },
    {
      slug: "when-your-documents-change-keeping-rag-honest",
      note: "MCP tools go stale the same way RAG indexes do.",
    },
  ],

  // ── Learning & Career cluster ───────────────────────────────────────
  "agentic-ai-interview-questions-2026": [
    {
      slug: "production-system-design-for-agentic-ai",
      note: "The architecture answers most senior interviews are probing for.",
    },
    {
      slug: "7-failure-modes-that-kill-multi-agent-systems",
      note: "Half the system-design questions in 2026 are about these.",
    },
    {
      slug: "agentic-ai-use-case-feasibility-framework",
      note: "How to think about 'should we even build this?' under interview pressure.",
    },
  ],
  "why-we-built-typescript-notebooks-for-agentic-ai": [
    {
      slug: "agentic-ai-interview-questions-2026",
      note: "What the questions look like once you've actually shipped something.",
    },
    {
      slug: "langgraph-vs-crewai-vs-autogen-2026",
      note: "The TS-first ecosystem the notebooks lean into.",
    },
    {
      slug: "production-system-design-for-agentic-ai",
      note: "The architecture the build-along notebooks point you at.",
    },
  ],
};

export const EXPLORE_LINKS: Record<string, ExploreLink[]> = {
  "securing-agentic-ai-layered-defense": [
    {
      label: "Notebooks: Guardrails + PII Sanitizer",
      href: "/notebooks",
      note: "Runnable input/output tripwires and a PII middleware shim.",
    },
  ],

  "word2vec-the-foundational-root-of-llms": [
    {
      label: "Notebooks: embeddings build-alongs",
      href: "/notebooks",
      note: "Train a tiny word2vec yourself, then graduate to transformer embeddings.",
    },
  ],
  // ── Production & Architecture ───────────────────────────────────────
  "production-system-design-for-agentic-ai": [
    {
      label: "Curriculum: Production track",
      href: "/curriculum",
      note: "End-to-end path from prototype to production.",
    },
  ],
  "7-failure-modes-that-kill-multi-agent-systems": [
    {
      label: "Failure-Mode Labs in AgentSwarms",
      href: "/learn",
      note: "Broken swarms you can repair, one failure mode at a time.",
    },
  ],
  "cost-control-in-multi-agent-systems": [],
  "agentic-ai-use-case-feasibility-framework": [
    {
      label: "Curriculum overview",
      href: "/curriculum",
      note: "Pick the depth that matches your feasibility verdict.",
    },
    {
      label: "AgentSwarms pricing",
      href: "/pricing",
      note: "Run the build-along yourself for the cost of a coffee.",
    },
  ],
  "when-your-documents-change-keeping-rag-honest": [],

  // ── Frameworks & Multi-Agent ────────────────────────────────────────
  "langgraph-vs-crewai-vs-autogen-2026": [
    {
      label: "Curriculum: Frameworks track",
      href: "/curriculum",
      note: "Hands-on notebooks for all three.",
    },
  ],
  "hermes-self-improving-agents-memory-skills-subagents": [
    {
      label: "Learn: agentic notebooks",
      href: "/learn",
      note: "Run a self-improving agent end-to-end in your browser.",
    },
  ],
  "memory-management-in-agentic-ai": [
    {
      label: "Learn: memory build-alongs",
      href: "/learn",
      note: "STM, summarisation, and LTM in runnable notebooks.",
    },
  ],
  "pydantic-the-contract-layer-of-agentic-ai": [
    {
      label: "Curriculum: structured outputs",
      href: "/curriculum",
      note: "Where contracts fit in the production track.",
    },
  ],
  "agentic-rag-vs-traditional-rag": [],

  // ── Infrastructure & DevOps ─────────────────────────────────────────
  "devops-for-agentic-ai-open-source-playbook": [
    {
      label: "Curriculum: DevOps track",
      href: "/curriculum",
      note: "Full path through deployment, scaling, and ops.",
    },
  ],
  "deploying-agents-cicd-bedrock-azure-gcp": [
    {
      label: "Curriculum: DevOps track",
      href: "/curriculum",
      note: "Where multi-cloud ships fit in the broader path.",
    },
  ],
  "which-gpu-runs-which-llm-the-complete-guide": [
    {
      label: "Curriculum: infra track",
      href: "/curriculum",
      note: "Self-hosting vs. managed inference, end to end.",
    },
  ],
  "mcp-production-playbook-2026": [],

  // ── Learning & Career ───────────────────────────────────────────────
  "agentic-ai-interview-questions-2026": [
    {
      label: "Interview Questions practice",
      href: "/interview-questions",
      note: "Drill the same 50 questions interactively.",
    },
    {
      label: "Curriculum overview",
      href: "/curriculum",
      note: "Build the depth the senior questions assume.",
    },
    {
      label: "Learn: hands-on notebooks",
      href: "/learn",
      note: "Implement an answer before you have to explain it.",
    },
  ],
  "why-we-built-typescript-notebooks-for-agentic-ai": [
    {
      label: "Learn: open the notebooks",
      href: "/learn",
      note: "Press run, change a line, press run again.",
    },
    {
      label: "Curriculum overview",
      href: "/curriculum",
      note: "The track the notebooks plug into.",
    },
  ],
};
