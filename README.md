<div align="center">
  <img src="public/og-image.png" alt="AgentSwarms" width="140" style="border-radius:28px" />

  <h1>AgentSwarms</h1>

  <p><strong>The hands-on playground for learning Agentic AI.</strong><br />
  Build agents, run multi-agent swarms, and inspect traces — all in your browser.</p>

  <p>
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
    <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" />
    <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.19-339933?logo=node.js&logoColor=white" />
    <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack%20Start-React%2019-FF4154?logo=react&logoColor=white" />
    <img alt="Supabase" src="https://img.shields.io/badge/backend-Supabase-3ECF8E?logo=supabase&logoColor=white" />
    <img alt="Cloudflare Workers" src="https://img.shields.io/badge/deploy-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" />
  </p>

  <p>
    <a href="./INSTALL.md">Install</a> ·
    <a href="#features">Features</a> ·
    <a href="#tech-stack">Tech Stack</a> ·
    <a href="./CONTRIBUTING.md">Contributing</a> ·
    <a href="./LICENSE">License</a>
  </p>
</div>

---

AgentSwarms teaches Agentic & Generative AI **by doing**. Every concept ships
with a runnable agent, a real dataset, or a live swarm canvas — no slides,
no theory-only chapters. Bring your own provider keys (OpenAI, Anthropic,
Gemini, Bedrock, Azure, OCI, Qwen, Grok) when you want unlimited usage, or
use the app's built-in default key to try it with zero setup.

## Features

|                                 |                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧭 **Guided curriculum**        | Five tracks — Foundations, Patterns & Tools, SQL Agents, Multi-Agent Swarms, Scaling & Enterprise — each chapter pairs a concept with something you actually run. |
| 🤖 **Agent Playground**         | Build an agent, wire up tools, and chat with it in-browser, with full request/response traces.                                                                    |
| 🐝 **Swarm canvas**             | Design multi-agent workflows visually (built on [XYFlow](https://xyflow.com)) and execute them end-to-end.                                                        |
| 📓 **Interactive notebooks**    | Cell-by-cell, runnable lessons — memory, RAG, guardrails, evals — with real state carried between cells.                                                          |
| 📚 **Knowledge Base / RAG**     | Upload documents, chunk and embed them (pgvector), and ground agents in your own data.                                                                            |
| 🔍 **Observability**            | Inspect every tool call, token, and cost in a full execution trace.                                                                                               |
| 🛡️ **Guardrails & evals**       | Prompt-injection tests, PII redaction, LLM-as-judge scoring — hands-on, not hypothetical.                                                                         |
| 🎓 **Certification**            | Pass the exam, get a verifiable certificate and badge.                                                                                                            |
| 🧰 **17 free standalone tools** | RAG chunk visualizer, prompt injection tester, agent cost calculator, and more — no sign-up required.                                                             |

<div align="center">
  <img src="public/sample-badge-current.png" alt="AgentSwarms Certified Agentic AI Practitioner badge" width="220" />
  <br />
  <sub>Every learner who passes the certification exam earns a verifiable badge like this one.</sub>
</div>

## Tech stack

| Layer        | Tech                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Framework    | [TanStack Start](https://tanstack.com/start) (React 19), file-based routing via TanStack Router |
| Backend      | [Supabase](https://supabase.com) — Postgres, Auth, Storage, pgvector                            |
| Styling      | [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)                    |
| Agents       | [LangChain](https://js.langchain.com) / LangGraph                                               |
| Swarm canvas | [XYFlow](https://xyflow.com)                                                                    |
| Deployment   | Cloudflare Workers                                                                              |

## Getting started

See **[INSTALL.md](./INSTALL.md)** for the full local setup guide (Node/Bun,
your own Supabase project + migrations, environment variables) on macOS,
Linux, and Windows.

Quick version:

```bash
git clone <your-fork-or-repo-url> agentswarms
cd agentswarms
npm install
cp .env.example .env   # fill in your Supabase + provider keys
npm run dev
```

## Project structure

```
agentswarms/
├── src/
│   ├── routes/       # pages and API routes (file-based routing)
│   ├── components/   # UI, organized by feature (agents, swarms, playground, ...)
│   ├── lib/          # curriculum content, agent/swarm export logic, sample data
│   └── utils/        # server-side utilities (providers, tools, memory, observability)
└── supabase/
    └── migrations/   # the full database schema, as SQL migrations
```

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](./CONTRIBUTING.md)** for
the workflow, and please read the **[Code of Conduct](./CODE_OF_CONDUCT.md)**
first.

## Security

Found a vulnerability? Please see **[SECURITY.md](./SECURITY.md)** for how
to report it responsibly instead of opening a public issue.

## License

Released under the **[MIT License](./LICENSE)**.

---

<div align="center">
  <sub>Built with TanStack Start, Supabase, and a genuine dislike of theory-only AI courses.</sub>
</div>
