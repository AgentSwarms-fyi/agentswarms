// Curriculum module: "The Production & Business Field Manual"
//
// Purpose: extend Chapter 6 (Production & Business) into the senior layer.
// Chapter 6 covers guardrails, scaling, OpenAI-compatible APIs, security
// posture, and the ROI calculation. The Production Field Manual that lives
// in Chapter 4 (Engineering) covers the *engineering* depth: infra,
// deploys, evals depth, latency, observability, etc. This manual covers
// what neither of those address — the layer above engineering and outside
// the agent itself: regulation, sovereignty, packaging, vendor risk, model
// lifecycle, SLAs over non-deterministic systems, and procurement.
//
// Coverage map (each section answers "what do the engineering manual and
// Chapter 6 both skip?"):
//   1. Regulatory architecture — EU AI Act, NIST AI RMF, ISO/IEC 42001
//   2. Data sovereignty       — residency, cross-border, model-in-region
//   3. Pricing & packaging    — per-seat vs per-token vs outcome-based
//   4. Vendor concentration   — model deprecation, multi-model strategy
//   5. SLAs over stochastic systems — what you can and cannot promise
//   6. Build vs buy economics — the math that has shifted since 2022
//   7. Responsible AI metrics — fairness, drift, harm — as KPIs not posters
//
// Style mirrors the other field manuals: long-form prose, **bold** for
// terminology, `code` for identifiers, worked examples, references to
// named regulations, frameworks and incidents.

export type BusinessDepthSection = {
  id: string;
  number: string;
  title: string;
  oneLiner: string;
  body: string;
  workedExample?: { title: string; language: string; code: string };
  sources?: { label: string; href: string; note?: string }[];
};

export const businessDepthIntro = {
  headline:
    "Engineering an agent is the easy half. Operating one inside a regulated business — with auditors, procurement, finance and a CISO in the room — is the half that determines whether it survives its first year.",
  body:
    "Chapter 6 introduced the surfaces a production agent must respect: guardrails, scaling, security, ROI. The Engineering Field Manual that lives in Chapter 4 went one layer down into the technical mechanics. This manual goes one layer up — into the layer where the agent meets the rest of the company. Almost every \"why was this AI project killed?\" post-mortem traces to one of seven causes that have nothing to do with model quality: an EU AI Act risk classification nobody mapped, a data-residency clause in a customer's MSA, a per-seat pricing model that became unprofitable at scale, a model deprecation with three weeks' notice, an SLA the legal team promised but the agent could not honour, a build-vs-buy decision made on 2022 economics, or a fairness regression that hit the press. None of these are bugs. All of them are predictable, and a senior practitioner is expected to see them coming. This is the manual for that.",
};

export const businessDepthSections: BusinessDepthSection[] = [
  /* ─────────── 1. Regulatory architecture ─────────── */
  {
    id: "biz-regulation",
    number: "B-01",
    title: "Regulatory architecture — the EU AI Act, NIST AI RMF, and ISO/IEC 42001 are now part of the stack",
    oneLiner:
      "The first agent your company ships into the EU is the first time \"AI risk classification\" stops being a slide and becomes a release blocker.",
    body:
      "From August 2026 the **EU AI Act** (Regulation (EU) 2024/1689) is fully in force, and from August 2025 its general-purpose AI obligations have applied. It classifies AI systems into four risk tiers — **prohibited** (social scoring, real-time biometric categorisation in public spaces, certain emotion-recognition uses), **high-risk** (employment, credit, education, law enforcement, critical infrastructure, plus most safety components), **limited-risk** (chatbots, generative content — transparency obligations only), and **minimal-risk** (everything else, no obligations). The mistake teams make is to assume their assistant-style agent is minimal-risk. It is not, the moment it touches hiring (CV screening), credit (eligibility hints), education (grading), or the eight other Annex III categories. Then it is high-risk and triggers Article 9 (risk-management system), Article 10 (data governance), Article 12 (logging), Article 13 (transparency), Article 14 (human oversight), Article 15 (accuracy/robustness/cybersecurity) — each of which is an audit-grade obligation, not a checklist.\n\nThe **NIST AI Risk Management Framework** (AI RMF 1.0, 2023, plus the Generative AI Profile, 2024) is the equivalent in the US: voluntary but increasingly referenced in federal contracts and adopted by the FTC and state AGs as the reasonable-care benchmark in enforcement actions. It organises the work into four functions — **Govern, Map, Measure, Manage** — and pairs each with concrete artefacts (model cards, system cards, incident response plans, harm taxonomies). **ISO/IEC 42001:2023** is the international management-system standard for AI; it is to AI what ISO 27001 is to information security, and large enterprise customers have started requiring it in RFPs. **ISO/IEC 23894** (AI risk management guidance) and **ISO/IEC 23053** (framework for AI systems using machine learning) are the supporting documents.\n\nThe practical posture for an agent-shipping team: produce a **Model Card** (per the Mitchell et al. template), a **System Card** (per the OpenAI/Anthropic format), an **Article 13 transparency notice** for any EU user-facing surface, and a documented **risk register** that maps each agent capability to a NIST AI RMF function and an EU AI Act risk tier. None of this requires a lawyer to draft — it requires a senior engineer who has read the source documents — but all of it requires the engineer to know the documents exist. The teams that get blindsided are the ones whose first encounter with the AI Act is the email from Customer Procurement asking for the conformity assessment.\n\nA quietly important sub-point: the **Code of Practice for General-Purpose AI** (published July 2025 by the EU AI Office) tells you exactly what frontier-model providers will and won't share with you under the Act. If you are a downstream deployer of GPT-5 or Claude or Gemini, you are entitled to the model's `Article 53(1)(d)` summary of training data and the technical documentation needed to comply with your own obligations. Provider portals expose this. Knowing it exists, and asking for it before signing, is part of the job now.",
    workedExample: {
      title: "Mapping one agent to AI Act tiers",
      language: "text",
      code:
        "Agent: \"Recruitment assistant — drafts JD, screens CVs, schedules interviews\"\n\n  Capability                    EU AI Act tier         Obligations\n  ---------------------------   --------------------   ------------------------\n  Draft job description         Limited (generative)   Article 50 transparency\n  Score / rank CVs              HIGH (Annex III §4)    Articles 9-15 in full\n  Schedule interview slots      Minimal                None\n  Reject candidate autonomously PROHIBITED (likely)    Cannot ship in EU\n\n  → The agent as a whole is HIGH-RISK because one capability is.\n  → \"Reject autonomously\" gets removed; humans make all reject decisions.\n  → CV scoring needs: documented training data, accuracy testing across\n    demographic groups, logged decisions for 10 years (Article 12),\n    a Fundamental Rights Impact Assessment (Article 27).\n\nIgnoring the table is not an option — the fines are 7% of global turnover\nfor prohibited-use violations, 3% for high-risk non-compliance.",
    },
    sources: [
      {
        label: "EU AI Act — Regulation (EU) 2024/1689 (consolidated text)",
        href: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj",
      },
      {
        label: "NIST AI Risk Management Framework 1.0 + Generative AI Profile",
        href: "https://www.nist.gov/itl/ai-risk-management-framework",
      },
      {
        label: "ISO/IEC 42001:2023 — AI management system",
        href: "https://www.iso.org/standard/81230.html",
      },
      {
        label: "Mitchell et al. — Model Cards for Model Reporting",
        href: "https://arxiv.org/abs/1810.03993",
      },
    ],
  },

  /* ─────────── 2. Sovereignty ─────────── */
  {
    id: "biz-sovereignty",
    number: "B-02",
    title: "Data sovereignty — residency, cross-border transfer, and the \"model in region\" question",
    oneLiner:
      "Your agent calls an API in Virginia. Your customer's data is in Frankfurt. Their DPA says \"no transfer outside the EEA.\" The agent is non-compliant the moment it runs.",
    body:
      "Every cross-border SaaS contract written in the last five years contains some version of a **data-residency clause**. The clause names the regions where the customer's data may be processed and stored, the conditions under which it may be transferred, and the legal basis for any transfer (Standard Contractual Clauses, the EU-US Data Privacy Framework, BCRs, Article 49 derogations). LLM APIs make these clauses load-bearing because every prompt sent to a model is, in DPA terms, a processing operation; every response is one too; and the model provider is a sub-processor your customer has the right to approve.\n\nThree concrete patterns to plan for. **First**, **model-in-region inference**. AWS Bedrock, Azure OpenAI, Google Vertex AI and OCI Generative AI all expose region selectors with explicit residency commitments — your prompts and responses stay within the named region (e.g. `eu-central-1`, `Switzerland North`, `europe-west4`). OpenAI's direct API does not offer this for most models; Anthropic's direct API offers a small number of regions; Mistral hosts in EU and US. The implication for an agent platform serving an EU bank: the only viable deployment is via a hyperscaler's regional offering, not the model vendor's direct API. Build your routing layer assuming this is true.\n\n**Second**, **prompt-content residency vs metadata residency**. Even \"region-locked\" services may route metadata (timing, request IDs, content-safety telemetry) through other regions. Your customer's Data Protection Officer will ask, in writing, whether any personal data leaves the named region for any purpose, including abuse monitoring. The honest answer requires reading the provider's processing-locations page closely; the wrong answer in an audit is worse than no answer.\n\n**Third**, **the Schrems II problem and the Data Privacy Framework's fragility**. The 2023 EU-US DPF is the current legal basis for most US-to-EU model usage; it has been challenged and, depending on how the next CJEU ruling lands, may be struck down as Privacy Shield was. Resilient architectures assume DPF could fail tomorrow and have a fallback (EU-resident model, SCCs with supplementary measures, on-prem fine-tune). Architectures that assume legal stability of a six-year-old framework are betting against history.\n\nA fourth, often-missed dimension: **logging and trace residency**. An NL→SQL agent that streams prompts to OpenAI but ships traces to Datadog (US) or LangSmith (US) has technically transferred data twice. The provider stack must be drawn end-to-end, including observability, before claiming residency compliance. Most teams find out about this from an auditor; the better path is to draw the diagram on day one.",
    workedExample: {
      title: "End-to-end residency diagram for an EU agent",
      language: "text",
      code:
        "User (DE) → CDN (EU PoP, Cloudflare/Fastly EU)\n          → API (eu-central-1, Frankfurt)\n          → Model: Bedrock Claude (eu-central-1)            ✔ in-region\n          → Vector DB: pgvector on RDS (eu-central-1)       ✔\n          → Tools:\n              · Stripe API (us-east) for billing            ✘ flag\n              · Internal search (eu-central-1)              ✔\n          → Traces: Phoenix self-hosted (eu-central-1)      ✔\n          → Logs: CloudWatch (eu-central-1)                 ✔\n          → Email: SES (eu-central-1)                       ✔\n\nThe Stripe call is the only out-of-region hop. Mitigation:\n  · Hash + scrub PII before the call (no name/email leaves region)\n  · Document the Article 28 sub-processor in the DPA\n  · Add to the customer-facing trust page\n\nWithout this diagram, the team would discover the Stripe transfer\nin a year-2 audit, not in design.",
    },
    sources: [
      {
        label: "AWS Bedrock — supported regions and data residency",
        href: "https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html",
      },
      {
        label: "Azure OpenAI — data, privacy and security",
        href: "https://learn.microsoft.com/en-us/legal/cognitive-services/openai/data-privacy",
      },
      {
        label: "EDPB — Schrems II Recommendations on supplementary measures",
        href: "https://edpb.europa.eu/our-work-tools/our-documents/recommendations/recommendations-012020-measures-supplement-transfer_en",
      },
    ],
  },

  /* ─────────── 3. Pricing & packaging ─────────── */
  {
    id: "biz-pricing",
    number: "B-03",
    title: "Pricing & packaging — why the per-seat SaaS playbook breaks for AI products",
    oneLiner:
      "When the cost of the product scales with usage and the price of the product doesn't, the most successful customers are the most expensive ones. That ends one of two ways.",
    body:
      "Twenty-five years of SaaS pricing converged on a tidy formula: charge per seat, deliver value at near-zero marginal cost, win on logo expansion. The unit economics worked because the marginal cost of one more user was a database row. Generative AI breaks the formula because the marginal cost of one more user is a stack of GPU minutes that the provider charges you for in real time. A heavy power user can cost 50–500× a light one; on a flat per-seat plan they are subsidised by the rest of your customers, and as adoption grows your gross margin compresses.\n\nFour packaging patterns are emerging, each with its own failure mode. **Per-seat with a fair-use cap** is the path of least resistance — you keep the SaaS muscle memory and add a usage ceiling. The risk is the cap becomes a customer-experience cliff (\"I'm using my own product\" is the screenshot you do not want shared). **Per-token / per-action passthrough** mirrors the underlying cost but exposes customers to LLM-pricing volatility and to provider price cuts they expect to be passed through. **Outcome-based** (per resolved ticket, per generated lead, per closed loop) aligns with value but is operationally hard: you must measure outcomes deterministically and adjudicate disputes. **Two-part tariff** (a base SaaS fee plus metered usage above a threshold) is what most mature AI products converge on, because it captures predictable revenue and contains downside.\n\nThe **margin engineering** practices that go with these models are not optional. **Prompt caching** (covered in the Foundations Field Manual) routinely cuts costs 30-90% on stable system prompts. **Tier routing** — a small/cheap model for the 90% of trivial requests, a frontier model only when needed — buys back another 40-70%. **Cache-first retrieval** (semantic cache + exact-match cache before the model is called) eliminates a measurable double-digit % of calls in customer-support workloads. None of these are visible to the customer; all of them protect the gross margin that pays the salaries.\n\nThe meta-question every founder eventually faces: **does AI raise or lower your willingness-to-pay ceiling?** For some categories (legal research, medical coding, sales prospecting) the agent unambiguously enables higher prices because it replaces hours of skilled human labour; the value gap is large enough to absorb the cost. For others (consumer chat, internal Q&A, FAQ deflection) the agent is a feature, not a product, and customers price it like any other SaaS feature; the cost gap closes from the wrong direction. Knowing which category you are in is the most consequential strategic choice in the first year of an AI product, and it is almost never the one founders write on the whiteboard.",
    workedExample: {
      title: "Why per-seat breaks at scale — a 100-customer cohort",
      language: "text",
      code:
        "Plan:        $50 / seat / month\nCost model:  Median user ≈ $4/mo in LLM cost; P95 user ≈ $80/mo\n\n  Per-seat margin (median user):    ($50 − $4) / $50 = 92%   ✔\n  Per-seat margin (P95 user):       ($50 − $80) / $50 = −60% ✘\n\nAt 100 customers with a typical long-tailed usage distribution:\n  Revenue:    100 × $50 = $5,000\n  Cost:       median $4 × 80 + P95 $80 × 20 = $1,920\n  Gross margin = 62%\n\nAdd 200 more customers, growth-team ships a feature that doubles\nP95 usage:\n  Revenue:    300 × $50 = $15,000\n  Cost:       $4 × 240 + $160 × 60 = $10,560\n  Gross margin = 30%\n\nThe better the product, the more it gets used, the worse the margin.\nFix: two-part tariff with usage above 50 actions metered at $0.20/action.",
    },
    sources: [
      {
        label: "a16z — The New Business of AI",
        href: "https://a16z.com/the-new-business-of-ai-and-how-its-different-from-traditional-software/",
        note: "The clearest published treatment of why AI gross margins differ from SaaS.",
      },
      {
        label: "Tomasz Tunguz — Pricing AI products",
        href: "https://tomtunguz.com/pricing-ai-products/",
      },
      {
        label: "Anthropic — Prompt caching pricing mechanics",
        href: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching",
      },
    ],
  },

  /* ─────────── 4. Vendor concentration ─────────── */
  {
    id: "biz-vendor-risk",
    number: "B-04",
    title: "Vendor concentration & model lifecycle — when the model you built on is deprecated with three weeks' notice",
    oneLiner:
      "A frontier model is not a database engine. It is shipped, retrained, retired and re-priced on a cadence that no procurement team is prepared for.",
    body:
      "Treating a hosted model as durable infrastructure is the most expensive default assumption in the field. Frontier vendors ship a new flagship roughly every six to nine months, deprecate the previous one on a posted but easily-missed schedule, and silently change behaviour through system-prompt updates, RLHF rounds and safety patches. Three concrete scenarios you should plan for, not react to.\n\n**Scenario one: model deprecation.** OpenAI deprecated the original `gpt-3.5-turbo-0301` and `gpt-4-0314` snapshots after 12-15 months. Anthropic deprecated `claude-1` and `claude-2` along similar timelines. Google moved Gemini 1.0 to legacy status within a year. The lifecycle pattern is roughly: snapshot ships → 12-18 months later, deprecation announcement → 90-180 days later, removal. If your eval suite, your fine-tunes and your prompt library are all targeted at a single snapshot, deprecation is a forced re-validation cycle that takes weeks. The mitigation is to **always run two snapshots in parallel** in CI — current production and the next-newer one — so the migration is a flip, not a project.\n\n**Scenario two: silent behavioural drift.** Even within a snapshot, behaviour can shift: tool-use formatting, refusal thresholds, JSON-mode fidelity. The 2023 \"is GPT-4 getting worse?\" episode (Chen, Zaharia, Zou — *How Is ChatGPT's Behavior Changing Over Time?*) measured a real, statistically significant drop in math accuracy across a quarter. The lesson is not \"the vendor is malicious\" — it is \"silent change is a property of the medium.\" The mitigation is a **canary eval suite** that runs daily against the date-pinned snapshot and alerts on any metric drift > 2σ. Less than 100 questions, fully automated, $5/day. The teams that have one catch drift in 24 hours; the teams that don't catch it from a customer support ticket.\n\n**Scenario three: pricing / capacity / regional changes.** Capacity tiers move (the move from on-demand to provisioned-throughput on Bedrock; rate limit revisions on OpenAI), region availability changes (a model launches in `us-east-1` six months before `eu-central-1`), and prices fall — but only for the new model, never the old one you are committed to. Senior practice is to design a **provider-agnostic abstraction** (your own thin gateway, or LiteLLM/Portkey/OpenRouter) so that swapping a provider is a config change, and to **measure the swap cost** in a test environment annually so you know the real number before you need it.\n\nThe broader posture: **multi-model is not a hedge; it is a competence**. A team that has run two providers in production for a year understands their differences, knows the prompt-portability cost, and has built the abstractions that make a third one cheap. A team that has run one for three years has a single point of failure they have not yet discovered. Plan accordingly.",
    workedExample: {
      title: "A practical model-lifecycle calendar",
      language: "text",
      code:
        "Per quarter, on the second Monday:\n\n  ☐ Pull each provider's deprecation page, diff against last quarter.\n     (OpenAI: platform.openai.com/docs/deprecations\n      Anthropic: docs.anthropic.com/en/docs/about-claude/model-deprecations\n      Google: ai.google.dev/gemini-api/docs/models)\n\n  ☐ For every model used in production, confirm:\n       · Sunset date is > 9 months out\n       · A successor snapshot is in CI canary\n       · An A/B in-shadow is running for the successor\n\n  ☐ For every fine-tune on a model, confirm an export of the fine-tune\n     dataset (so it can be re-trained on the successor).\n\n  ☐ Re-run the daily canary eval over the last 90 days, plot drift,\n     escalate any metric off > 2σ.\n\n  ☐ Re-cost top-10 endpoints against current price sheets.\n     (Last 90d's prices may be stale by 20-50%.)\n\nThis is 90 minutes/quarter and it eliminates the entire class of\n\"the model we depend on is being turned off in three weeks\" incidents.",
    },
    sources: [
      {
        label: "OpenAI — Model deprecation policy and schedule",
        href: "https://platform.openai.com/docs/deprecations",
      },
      {
        label: "Anthropic — Model deprecations",
        href: "https://docs.anthropic.com/en/docs/about-claude/model-deprecations",
      },
      {
        label: "Chen, Zaharia, Zou — How Is ChatGPT's Behavior Changing Over Time?",
        href: "https://arxiv.org/abs/2307.09009",
      },
      {
        label: "LiteLLM — provider abstraction layer",
        href: "https://github.com/BerriAI/litellm",
      },
    ],
  },

  /* ─────────── 5. SLAs ─────────── */
  {
    id: "biz-slas",
    number: "B-05",
    title: "SLAs over stochastic systems — what you can and cannot promise about an LLM",
    oneLiner:
      "An LLM does not have a 99.9% correctness mode. Promising one in a contract is a category error you will be held to.",
    body:
      "Service-level agreements were built for systems whose failure modes are binary and observable: the database is up or down, the API responds in ≤200 ms or doesn't, the disk has corrupted bytes or hasn't. LLMs fit none of these shapes. They are stochastic at the token level, partially-correct at the response level, and their \"failures\" are usually plausible-sounding wrong answers a contract-writer cannot define. This forces a reshaping of what an SLA can mean, which most legal teams discover only when an enterprise customer's draft MSA arrives with `99.9% accuracy` written into Schedule A.\n\nThree categories of guarantee can be made honestly, and three cannot. **You can guarantee availability** of the *agent surface* — request acceptance, queueing, eventual response — even if you cannot guarantee the underlying model API's own availability (so build a multi-region, multi-provider fallback and SLA the system, not the dependency). **You can guarantee latency percentiles** (P50, P95, P99 time-to-first-token, end-to-end) because they are measurable, monotone in your effort, and not LLM-correctness-coupled. **You can guarantee evaluable, narrow correctness** — \"the agent will correctly extract the invoice number from a valid PDF in 99% of cases\" — *if* you have a frozen test set, an audit trail, and a remediation path on miss. Each of these is a real number you can defend.\n\n**You cannot guarantee subjective quality** (\"the agent will be helpful\"), **open-ended correctness** (\"the agent will not hallucinate\"), or **regulatory outcomes** (\"the agent will be GDPR-compliant\" — that is the deployer's obligation, not yours). Trying to commit to these is what creates the post-deal blow-ups: the customer interprets the clause expansively, you interpret it narrowly, and the dispute lands in a quarterly business review. Healthy practice is to substitute these clauses with **process-level commitments**: documented eval methodology, monthly accuracy reports against a customer-shared benchmark, named human-in-the-loop owners for high-stakes decisions, and a defined incident-response timeline.\n\nA fourth dimension worth designing in early: **the credit mechanism**. Service credits for downtime are well-understood; service credits for correctness regressions are not. The mechanism that works is a **rolling weekly accuracy report** against a per-customer canary suite; if the rolling number falls below an agreed threshold, the customer can either trigger a re-validation cycle (operationally expensive for you, valuable for them) or take a service credit. This is closer to how managed-services contracts work than to how SaaS works, which is the right reference point — agents are operationally closer to outsourced labour than to deterministic software, and the contracts should reflect that.",
    workedExample: {
      title: "An SLA you can actually meet",
      language: "text",
      code:
        "AVAILABILITY\n  Agent API request acceptance:        99.95% / month\n  End-to-end response within 60s:      99.5%  / month\n  (Underlying model API failures handled by automatic fallback)\n\nLATENCY (over 5-minute windows, excl. cold starts)\n  P50 time-to-first-token:             ≤ 1.5 s\n  P95 time-to-first-token:             ≤ 4.0 s\n  P99 end-to-end completion:           ≤ 25 s\n\nCORRECTNESS — narrowly evaluable tasks only\n  Invoice extraction (Customer canary, 200 docs, refreshed quarterly):\n      precision ≥ 0.97   recall ≥ 0.95\n  PII redaction (entity-level F1 on Customer canary, 500 docs):\n      F1 ≥ 0.98\n  Reported monthly. Below threshold for 2 consecutive months\n  triggers either (a) re-validation cycle or (b) 10% service credit.\n\nWHAT WE DO NOT COMMIT\n  · \"The agent will be helpful\"  → not measurable\n  · \"No hallucinations\"           → not measurable\n  · \"GDPR compliance\"             → joint obligation, allocated by DPA\n\nThis SLA has been signed by enterprise customers; the previous draft\n(\"99.9% accuracy\") was the one Legal had to walk back twice.",
    },
    sources: [
      {
        label: "Anthropic — service-level agreement",
        href: "https://www.anthropic.com/legal/sla",
      },
      {
        label: "Microsoft — Azure OpenAI Service SLA",
        href: "https://www.microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services",
      },
      {
        label: "Google — Vertex AI SLA",
        href: "https://cloud.google.com/vertex-ai/sla",
      },
    ],
  },

  /* ─────────── 6. Build vs buy ─────────── */
  {
    id: "biz-build-buy",
    number: "B-06",
    title: "Build vs buy — the math that has shifted under everyone since 2022",
    oneLiner:
      "The case for training your own foundation model died for almost everyone in 2024. The case for fine-tuning, distillation, or building a thin specialised wrapper has never been stronger.",
    body:
      "In 2022, \"AI strategy\" for a serious enterprise meant deciding whether to train an internal model. The cost was eight figures, the talent supply was twelve people on Earth, and the moat was real. Three years later the math has inverted on every axis. A frontier-class model now costs $50–$200M to pretrain, well outside any non-hyperscaler budget; a competitive 7B-70B open-weights model (Llama 3.1, Mistral, Qwen 2.5, DeepSeek) is downloadable for free and runs in a week of fine-tuning on commodity hardware. The conclusion is that almost no enterprise should be training a foundation model from scratch, and almost every enterprise should be doing one of three things instead.\n\n**Path A: thin specialisation on a frontier API.** Use GPT-5 / Claude / Gemini through a hyperscaler, build prompts, retrieval, tools, and evals that encode your domain. This wins when (i) the domain is already well-represented in pretraining data, (ii) your differentiation is workflow and integrations, not raw modelling capability, (iii) you need cutting-edge capability faster than a release cycle. 80%+ of enterprise AI products belong here. Margins are constrained by the API provider, but TTM is weeks.\n\n**Path B: parameter-efficient fine-tuning (LoRA / QLoRA / DoRA) on an open model.** This wins when (i) you have hundreds-to-thousands of high-quality examples of the exact task, (ii) you need predictable latency / cost / residency that an API cannot offer, (iii) the task is narrow enough that a 7-13B fine-tuned model beats a generic frontier model — which, on narrow tasks, it routinely does (see the Mistral 7B Instruct → domain-tuned papers from 2024). Cost: a single A100/H100 day to train, ~$50K/year amortised to serve.\n\n**Path C: distillation from a frontier teacher.** Generate synthetic training data with GPT-5/Claude, fine-tune a small open model on that data, ship the small one. Margins: enormous. Risks: the teacher's terms-of-service may forbid this (Anthropic's do for competitive models; OpenAI's do for competing-product training); the student inherits the teacher's biases; license-laundering arguments are unsettled. Path C is dominant in agent companies that operate at consumer-scale unit economics where API cost would be ruinous.\n\nThe cases left for **building from scratch** are vanishingly small: sovereign AI initiatives (Mistral/EU, Aya/Cohere, Sarvam India) where geopolitical considerations override economics, and a handful of specialised modalities (protein, climate, materials) where pretraining data is bespoke. If you are not in one of those, you are not in the building-from-scratch category, and the senior signal in 2026 is to know that early enough not to spend two quarters proving it the hard way.",
    workedExample: {
      title: "A 12-month TCO for the same use-case, three paths",
      language: "text",
      code:
        "Use case: structured extraction from 10M docs/year, 8K tokens avg.\nVolume:   10M req × 10K total tokens = 100B tokens/year.\n\n--- Path A: GPT-4o-class API ---\n  100B tok × $5/M ≈ $500K/year\n  Eng: 1.5 FTE × $250K = $375K\n  TCO year 1:  ~$875K\n  TTM:         3 weeks\n\n--- Path B: LoRA on Llama 3.1 70B, hosted on Bedrock ---\n  Training: 1 A100 day × 4 iterations = ~$2K\n  Serving:  ~$3/M tokens at provisioned throughput → $300K/year\n  Eng: 2 FTE × $250K = $500K (more MLOps work)\n  TCO year 1:  ~$800K\n  TTM:         8-10 weeks\n\n--- Path C: Distill GPT-4o → fine-tune Llama 3.1 8B, self-host ---\n  Synthetic data gen: 200K examples × $0.05 = $10K\n  Training:           4 H100-days = ~$400\n  Serving:            2× H100, 24/7, eu-central-1 = ~$120K/year\n  Eng: 2.5 FTE × $250K = $625K (eval rigour matters more)\n  TCO year 1:  ~$755K\n  TCO year 2+: ~$155K/year (no eng growth)\n  TTM:         12-16 weeks\n  Risk:        teacher TOS, capability ceiling at 8B\n\nDecision rule: A for v1 → B once volume is proven → C if margin matters\nand the task is genuinely narrow. Skipping straight to C before you have\nthe eval suite is the single most common over-engineering failure.",
    },
    sources: [
      {
        label: "Hu et al. — LoRA: Low-Rank Adaptation of Large Language Models",
        href: "https://arxiv.org/abs/2106.09685",
      },
      {
        label: "Dettmers et al. — QLoRA: Efficient Finetuning of Quantized LLMs",
        href: "https://arxiv.org/abs/2305.14314",
      },
      {
        label: "Anthropic — Acceptable use policy (model training restrictions)",
        href: "https://www.anthropic.com/legal/aup",
      },
      {
        label: "Sequoia — The new economics of AI applications",
        href: "https://www.sequoiacap.com/article/the-new-economics-of-ai-applications/",
      },
    ],
  },

  /* ─────────── 7. Responsible AI metrics ─────────── */
  {
    id: "biz-responsible-ai",
    number: "B-07",
    title: "Responsible AI as KPIs — fairness, drift and harm as numbers, not posters",
    oneLiner:
      "An AI ethics statement is a poster. An AI risk register, with thresholds and on-call owners, is a system. Auditors and journalists tell the difference instantly.",
    body:
      "Responsible-AI work has a credibility problem: most companies publish principles, very few measure against them, and almost none have a defined response when a metric regresses. The senior practice is to treat fairness, drift and harm exactly the way you treat latency and uptime — instrumented, alerting, owned. Three measurement surfaces are mature enough to ship today.\n\n**Fairness** for any high-stakes agent decision (eligibility, scoring, ranking, moderation) requires a **disaggregated metric report** across demographic and operational slices. The standard taxonomy from the fairness literature (Barocas-Hardt-Narayanan, *Fairness and Machine Learning*) gives you statistical parity, equal opportunity, equalised odds, calibration. Pick the one that matches the legal regime you operate in (US disparate-impact uses the four-fifths rule; EU AI Act Article 10 requires \"appropriate measures to detect, prevent and mitigate possible biases\"; specific sectors have specific rules). Compute the metric monthly on a held-out slice, alert on a >5pp regression, and treat the regression like a Sev-2 incident with a written post-mortem. This is the practice that survives an FTC inquiry; nothing softer does.\n\n**Drift** means three different things and you should measure each. **Input drift**: the distribution of incoming requests changes (new customer segment, seasonal shift). Track via embedding-space density, KL divergence on input topic clusters, or simple length/language histograms. **Output drift**: the distribution of agent outputs changes even with stable inputs (a model update, a prompt change, a tool change). Track via output-classifier scores or LLM-as-judge against a fixed rubric. **Outcome drift**: the downstream metric the agent affects (deflection rate, NPS, conversion) changes. Track via the existing product analytics. The Responsible-AI practice is to require a written diagnosis when any of the three drifts more than 2σ — separately, because conflating them is the most common analysis mistake.\n\n**Harm** measurement requires a **harm taxonomy** specific to your product. The OpenAI/Anthropic/DeepMind published taxonomies (toxicity, bias, deception, privacy, security, dangerous content) are starting points, not endpoints. The senior practice is to maintain a **harm log** — every reported incident, classified, with severity, with detection mechanism, with remediation — and to report monthly aggregates. The log is the artefact you produce when an auditor or regulator asks how you know your agent is safe; \"we have a strong system prompt\" is not an answer that survives the question.\n\nThe overarching pattern: responsible AI is not a separate workstream that competes with engineering velocity. It is a set of dashboards and alerts that live in the same observability stack as everything else, owned by the same on-call rotation, with the same incident-response discipline. Companies that bolt it on as a posters-and-policies layer fail their first serious external review. Companies that wire it into the trace pipeline pass.",
    workedExample: {
      title: "A monthly Responsible-AI scorecard you can actually publish",
      language: "text",
      code:
        "AGENT: Loan-pre-qualification assistant       Period: 2026-04\n\nFAIRNESS — approval-rate parity across protected slices\n  Slice            Approvals  Rate    Δ vs majority   4/5 rule\n  Majority         1,420     31.2%    —               —\n  Slice A             192    25.4%   −5.8pp           ✔ (0.81)\n  Slice B             310    27.8%   −3.4pp           ✔ (0.89)\n  Slice C             148    19.1%   −12.1pp          ✘ (0.61)  ALERT\n\nDRIFT\n  Input KL vs baseline:        0.04   (threshold 0.10)         ✔\n  Output sentiment shift:     +0.07   (threshold ±0.10)        ✔\n  Outcome (default-rate 30d):  3.1%   vs trailing 90d 2.8%    ✔\n\nHARM LOG (this period)\n  Sev-1: 0    Sev-2: 1 (PII echo, contained <30min, RCA filed)\n  Sev-3: 4    Sev-4: 11   (all auto-detected, none customer-reported)\n\nACTIONS\n  ☐ Slice C alert: investigation owner = @amelia, due 2026-04-19\n  ☐ Sev-2 RCA review at next architecture council\n  ☐ Re-baseline drift thresholds after Q2 model upgrade\n\nThis report goes to: VP Eng, Legal, the customer's risk committee\n(under NDA), and the published Trust Center summary (aggregated).",
    },
    sources: [
      {
        label: "Barocas, Hardt, Narayanan — Fairness and Machine Learning",
        href: "https://fairmlbook.org/",
        note: "The reference textbook for the fairness metrics worth knowing.",
      },
      {
        label: "Weidinger et al. — Taxonomy of Risks Posed by Language Models",
        href: "https://arxiv.org/abs/2206.05862",
      },
      {
        label: "EEOC — Four-fifths rule for disparate impact (US)",
        href: "https://www.eeoc.gov/laws/guidance/section-4-uniform-guidelines-employee-selection-procedures-29-cfr-part-1607",
      },
      {
        label: "NIST — AI RMF Generative AI Profile (harm categorisation)",
        href: "https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf",
      },
    ],
  },
];

export const businessDepthClosing = {
  title: "From shipping an agent to running a business that ships agents",
  body:
    "The work in this manual is the work that no demo, prototype, or hackathon ever rehearses, and it is the work that determines whether an AI initiative is still alive in three years. None of it is intellectually heroic — it is regulation read closely, contracts drafted carefully, dashboards instrumented properly, and lifecycle calendars maintained without drama. The reason it is the senior layer is not that it is hard to understand; it is that it is easy to defer until it becomes the most expensive thing in the company. The pattern, again: when an AI product fails in year two, the cause is almost never the model. It is one of the seven layers in this manual that nobody had named as their job.",
};
