-- Seed shared sample knowledge base for the LLM-as-Judge — Support QA swarm template.
-- Pattern: user_id IS NULL, is_sample = true, deterministic UUID so the swarm
-- template references it directly without needing a saved agent.

INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'b3a7c91e-2d4f-4a8b-9c1e-5f7e8d2a4b10',
  NULL,
  'Sample · Company QA Guidelines',
  'Customer-support QA rubric used by the "LLM as a Judge — Support QA" swarm template. The Policy Compliance Judge retrieves rules from this rubric via kb_search.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_sample = true,
      user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'b3a7c91e-2d4f-4a8b-9c1e-5f7e8d2a4b11',
  'b3a7c91e-2d4f-4a8b-9c1e-5f7e8d2a4b10',
  NULL,
  'Company_QA_Guidelines.pdf',
  $rubric$COMPANY CUSTOMER SUPPORT — QA GUIDELINES (v3.2)
Owner: VP of Customer Experience
Effective: Q3 2026

PURPOSE
This rubric is the single source of truth for grading every closed support ticket. All QA reviewers (human and AI) MUST cite the specific rule number when flagging a violation. Tickets violating any "Core Rule" (marked ★) automatically fail QA regardless of other dimensions.

──────────────────────────────────────────────────────────────
SECTION A — OWNERSHIP & ACCOUNTABILITY (★ Core Rules)
──────────────────────────────────────────────────────────────
★ Rule 1: Always take ownership of shipping delays.
   Even when the carrier (FedEx, UPS, DHL) is at fault, the agent represents the company. Phrases like "It's not our fault," "Talk to FedEx," or "Nothing we can do" are STRICT VIOLATIONS. The correct pattern is: acknowledge → apologize → offer concrete next step (reship, refund, escalate to logistics).

★ Rule 2: Never blame an external party in writing.
   Do not name-shame carriers, payment processors, or upstream vendors. Internal root-cause analysis stays internal.

★ Rule 3: Never guarantee a delivery date you cannot enforce.
   Use "estimated to arrive by" not "will arrive on". Hard guarantees are only authorized for Priority Plus customers (CRM tier ≥ 4).

──────────────────────────────────────────────────────────────
SECTION B — TONE & EMPATHY
──────────────────────────────────────────────────────────────
Rule 4: Always apologize for any downtime, delay, or inconvenience — even if the company is not at fault. A single sincere apology in the first response is required.

Rule 5: Mirror the customer's urgency. If the customer mentions a deadline (party, wedding, business meeting), the response MUST acknowledge that specific event.

Rule 6: No dismissive language. Banned phrases include: "calm down", "it's not a big deal", "you should have", "as I already said".

──────────────────────────────────────────────────────────────
SECTION C — REFUNDS, CREDITS & COMPENSATION
──────────────────────────────────────────────────────────────
★ Rule 7: Refund authority limits.
   - Tier 1 agents: up to $50 goodwill credit, no manager approval.
   - Tier 2 agents: up to $250 refund, no manager approval.
   - Anything above $250, OR any free-product offer (laptops, phones, subscriptions > 12 months) REQUIRES written manager approval logged in the ticket.
   Giving away free hardware without approval is a terminable offense.

Rule 8: Never offer a refund the customer did not ask for unless policy mandates it (e.g., SLA breach, double-charge). Proactive refunds inflate cost-per-ticket.

Rule 9: Always link to the official refund policy URL (/policies/refunds) when discussing money back.

──────────────────────────────────────────────────────────────
SECTION D — TECHNICAL ACCURACY
──────────────────────────────────────────────────────────────
Rule 10: Tracking numbers must be quoted exactly as they appear in the order management system. Do not retype from memory.

Rule 11: When linking to documentation, use the canonical /docs/ URL, never a personal Google Doc, Notion page, or screenshot.

Rule 12: If unsure of the technical answer, escalate to Tier 2 — do NOT guess. "I think" and "probably" are red flags in technical responses.

──────────────────────────────────────────────────────────────
SECTION E — ESCALATION & HUMAN HANDOFF
──────────────────────────────────────────────────────────────
Rule 13: Any mention of legal action, media, regulator (FTC, FCA), or self-harm triggers immediate escalation to the Trust & Safety queue. Do not respond further on the original thread.

Rule 14: VIP tier customers (CRM tier ≥ 4) must receive a response from a Tier 2 agent or higher within 15 minutes.

──────────────────────────────────────────────────────────────
SCORING GUIDANCE FOR QA REVIEWERS
──────────────────────────────────────────────────────────────
- Each Core Rule violation (★) = automatic Policy score ≤ 2/10.
- Each non-core rule violation = -1.5 from Policy score.
- A response that follows all rules but is robotic / cold = Tone score capped at 6/10.
- Final QA scorecard: Policy 50% · Tone 30% · Technical 20%. Tickets scoring < 70/100 trigger a manager alert.
$rubric$,
  true,
  jsonb_build_object('source', 'sample', 'pages', 2, 'doc_type', 'qa_rubric', 'version', '3.2')
)
ON CONFLICT (id) DO UPDATE
  SET content = EXCLUDED.content,
      name = EXCLUDED.name,
      is_sample = true,
      user_id = NULL,
      metadata = EXCLUDED.metadata;