import { createFileRoute } from "@tanstack/react-router";
import {
  DocLink,
  DocsHeader,
  Diagram,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/agents")({
  head: () => ({
    meta: [
      { title: "Agent Builder — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Every configuration block in the AgentSwarms Agent Builder: model and provider, system prompt, knowledge bases, tools, guardrails, memory, and export.",
      },
      { property: "og:title", content: "Agent Builder — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "Every configuration block in the AgentSwarms Agent Builder: model and provider, system prompt, knowledge bases, tools, guardrails, memory, and export.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/agents" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Agent Builder — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "Every configuration block in the AgentSwarms Agent Builder: model, prompt, knowledge, tools, guardrails, memory, export.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/agents" }],
  }),
  component: AgentsDoc,
});

function AgentsDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Agent Builder"
        description="An agent is a complete AI worker: a system prompt plus a model plus optional tools, knowledge, memory, and guardrails. Agents built at /agents can be chatted with in the Playground, embedded as swarm nodes, or exported as code."
      />

      <P>
        New agents default to the built-in AgentSwarms AI provider, so you can save and chat with a
        working agent before configuring anything. This page walks the configuration blocks in the
        order they appear in the form.
      </P>

      <H2 id="identity">Identity</H2>
      <P>
        Name and description follow the agent everywhere it is referenced — swarm nodes, playground
        pickers, the trace viewer. A descriptive name ("Insurance Claim Triage v2") pays for itself
        the first time you have more than a handful of agents.
      </P>

      <H2 id="model">Model</H2>
      <FieldList
        items={[
          {
            name: "Provider",
            body: "AgentSwarms AI (built-in, no key), OpenAI, Google Gemini, Grok (xAI), Groq, OpenRouter, Anthropic, AWS Bedrock, Google Vertex AI, Azure OpenAI, OCI Generative AI, Qwen (DashScope), custom Ollama, or self-hosted vLLM. Bring-your-own-key providers are configured in Integrations.",
          },
          {
            name: "Model",
            body: (
              <>
                Filtered by provider. The <DocLink to="/model-registry">Model Registry</DocLink>{" "}
                supplies context-window and pricing data per model.
              </>
            ),
          },
          {
            name: "Temperature",
            body: "Zero for deterministic tasks (classification, SQL); higher for creative drafting.",
          },
          {
            name: "Sampling & limits",
            body: "Max tokens, top-p, frequency penalty, presence penalty, and stop sequences — standard defaults pre-filled, ignorable unless you have an opinion.",
          },
        ]}
      />

      <H2 id="system-prompt">System prompt</H2>
      <P>
        The single most important field on the form. Starter prompts can be pulled from the{" "}
        <DocLink to="/docs/skills">Prompt Library</DocLink>, and the same prompt patterns carry over
        when the agent is dropped into a swarm node.
      </P>

      <H2 id="knowledge">Knowledge bases</H2>
      <P>
        Attach one or more knowledge bases from <DocLink to="/knowledge">/knowledge</DocLink> and
        the agent automatically gains a search tool scoped to them — no separate tool setup.
        Knowledge bases are pgvector indexes populated from:
      </P>
      <UL>
        <li>
          <strong>File uploads</strong> — PDF, CSV, Markdown, plain text; parsed, chunked, and
          embedded automatically with live status.
        </li>
        <li>
          <strong>URL ingestion</strong> — pull a page's content in as a document, re-syncable from
          the sources panel.
        </li>
        <li>
          <strong>GitHub ingestion</strong> — index files from a public repo, also re-syncable.
        </li>
        <li>
          <strong>Pasted text</strong> — the fastest path for short policy docs and FAQs.
        </li>
      </UL>
      <P>
        The knowledge page also has a <strong>Graph</strong> tab that builds an entity-relation
        graph over a knowledge base; agents can then use <em>Knowledge Graph Search</em> for
        multi-hop Graph-RAG questions.
      </P>

      <H2 id="tools">Tools</H2>
      <FieldList
        items={[
          {
            name: "Web Search",
            body: "Live search with built-in Firecrawl, or bring your own key (Brave, SerpAPI, Tavily).",
          },
          {
            name: "Web Browser",
            body: "Fetches a URL as clean markdown for the agent to read.",
          },
          {
            name: "Knowledge Base Search",
            body: "Auto-enabled when a knowledge base is linked; returns the most relevant chunks with citations.",
          },
          {
            name: "Knowledge Graph Search",
            body: "Multi-hop Graph RAG over a knowledge base's entity graph (build the graph in Knowledge → Graph first).",
          },
          {
            name: "SQL Query",
            body: (
              <>
                Read-only SELECT against your CSV-derived tables, managed in{" "}
                <DocLink to="/data-sql">Data &amp; SQL Agents</DocLink> — see below.
              </>
            ),
          },
          {
            name: "Calculator / Date & Time / Weather",
            body: "Deterministic utility tools that need no key: safe math evaluation, timezone-aware clock, Open-Meteo forecasts.",
          },
          {
            name: "Workflow triggers",
            body: "Call out to automation platforms you connect — n8n, Activepieces, Node-RED, Windmill, Temporal, Airflow, Huginn, Zapier, Make, or a custom webhook.",
          },
          {
            name: "MCP tools",
            body: (
              <>
                Tools exposed by Model Context Protocol servers connected at{" "}
                <DocLink to="/mcp">/mcp</DocLink>; pick which servers the agent may call.
              </>
            ),
          },
        ]}
      />

      <H2 id="sql-tables">Text-to-SQL setup</H2>
      <P>
        The SQL tool queries local tables created by uploading CSVs in{" "}
        <DocLink to="/data-sql">Data &amp; SQL Agents</DocLink> — column types are inferred, so you
        can prototype text-to-SQL agents without touching a real database. Execution is read-only
        (SELECT), and the platform's SQL-agent templates demonstrate the production pattern this
        teaches: schema-aware prompting, validation before execution, and strict scope.
      </P>

      <H2 id="guardrails">Guardrails</H2>
      <P>Opt-in per agent; enabling any guardrail adds a "Guarded" badge to the agent's card.</P>
      <FieldList
        items={[
          {
            name: "Input Guardrails",
            body: "Input filtering with a max input length and blocked patterns (regex, one per line) for prompt-injection and jailbreak strings.",
          },
          {
            name: "Output Guardrails",
            body: "Output filtering with optional hallucination detection, citation checking, and a custom filter prompt.",
          },
          {
            name: "Rate Limiting & Boundaries",
            body: "Max turns per conversation, requests-per-minute rate limit, and a token threshold above which a human approval is required.",
          },
          {
            name: "Topic Boundaries",
            body: "Allowed and restricted topic lists that keep the agent on its job.",
          },
        ]}
      />

      <H2 id="memory">Memory</H2>
      <UL>
        <li>
          <strong>Short-term memory</strong> (on by default) — the conversation window, with older
          turns folded into a rolling summary so long chats don't lose the thread.
        </li>
        <li>
          <strong>Long-term memory</strong> (opt-in) — typed items (facts, preferences, episodic
          notes, instructions) extracted across conversations and recalled by relevance. The memory
          section of the form shows every stored item and lets you inspect or delete them.
        </li>
        <li>
          <strong>Memory tools</strong> — agents with memory enabled can call remember/recall/forget
          explicitly, plus a per-conversation scratchpad shared across swarm nodes.
        </li>
      </UL>

      <H2 id="export">Export, share, publish, import</H2>
      <UL>
        <li>
          <strong>Export</strong> — LangChain (Python or TypeScript), LangGraph ReAct (Python or
          TypeScript), CrewAI YAML config, or a portable JSON manifest with prompts, tools, and
          model configuration. The generated code is readable and idiomatic — take it into your own
          codebase and keep going.
        </li>
        <li>
          <strong>Share</strong> — a link another signed-in user can import from; imports are
          one-time copies.
        </li>
        <li>
          <strong>Import</strong> — recreate any exported AgentSwarms JSON agent in your workspace.
        </li>
      </UL>

      <Diagram caption="Anatomy of an AgentSwarms agent">{`              ┌─────────────────────────────────────────────┐
   chat ───▶  │   System prompt  +  short / long-term memory │
              └────────────────┬────────────────────────────┘
                               │
                               ▼
                        ┌────────────┐
                        │   Model    │  (provider + parameters)
                        └────┬───────┘
                             │
            ┌────────────────┼────────────────────────┐
            ▼                ▼                        ▼
        ┌────────┐    ┌─────────────┐         ┌──────────────┐
        │ Tools  │    │ Knowledge   │         │  Guardrails  │
        │+skills │    │ bases (RAG) │         │  + approvals │
        └────┬───┘    └──────┬──────┘         └──────┬───────┘
             │               │                       │
             └──────────► response ◄─────────────────┘`}</Diagram>

      <Note>
        The fastest way to learn this form is to provision a{" "}
        <DocLink to="/docs/templates">template</DocLink> and open it here — you'll see how a working
        agent is wired before you fill in a blank one.
      </Note>

      <NextPrev current="/docs/agents" />
    </>
  );
}
