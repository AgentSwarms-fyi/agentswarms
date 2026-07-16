-- Seed a shared sample knowledge base containing the Q3 Marketing & Strategy Memo.
-- Mirrors the existing sample dataset pattern: user_id IS NULL, is_sample = true.
-- Uses a deterministic UUID so swarm templates can reference it directly.

INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  '173e2bc9-a16a-5e58-9da1-7956c93cb828',
  NULL,
  'Sample · Q3 Marketing & Strategy Memo',
  'Executive memorandum explaining Q3 budget variances across Marketing, Engineering, Sales, HR, and Legal. Used by the Financial Variance (ERP + RAG) swarm template.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_sample = true,
      user_id = NULL;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  '173e2bc9-a16a-5e58-9da1-7956c93cb829',
  '173e2bc9-a16a-5e58-9da1-7956c93cb828',
  NULL,
  'Q3_Marketing_Memo.pdf',
  $memo$MEMORANDUM
To: Executive Steering Committee & Board of Directors
From: Office of the CEO & CFO
Date: October 4, 2026
Subject: Q3 2026 Financial Variance & Strategy Realignment

Executive Summary
Q3 presented several macroeconomic challenges and unforeseen competitive threats that required immediate deviations from our Board-approved Annual Operating Plan (AOP). While top-line revenue remained stable, aggressive strategic shifts resulted in significant departmental variances. This memo serves as the official narrative context for the Q3 financial close.

Marketing & Go-To-Market Pivot
In early August, our primary competitor, Acme Corp, launched their "Copilot Pro" tier, accompanied by a massive multi-channel advertising blitz. In response, the VP of Marketing authorized an emergency defensive strategy. We canceled our planned Q3 regional event sponsorships and reallocated that capital, along with an additional unbudgeted $280,000 injection, directly into hyper-targeted Google and LinkedIn Digital Ads. Our goal was to protect our enterprise pipeline, which data suggests was successful, though it severely impacted the GL-5020 budget line.

Engineering & Infrastructure Scaling
Engineering saw substantial overages in Q3, primarily driven by the expedited launch of our own Generative AI features. Originally slated for Q1 2027, the Board requested we pull this launch forward to September. As a result, our Cloud Hosting (AWS) costs spiked by $215,000 as we spun up dedicated GPU clusters for model training. Furthermore, our API Usage Fees (GL-6050) exceeded budget by $135,000 due to heavier-than-expected user adoption of the new AI features in the first two weeks of launch. We are currently negotiating enterprise tier pricing with our LLM providers to compress these margins in Q4.

Sales & Expansion Efforts
The Sales organization exceeded their Travel & Entertainment budget by $110,000. This was a deliberate decision approved by the CRO. Following the collapse of a European competitor in July, we sent 15 Senior Account Executives to London and Berlin for six weeks to aggressively capture newly orphaned enterprise clients. This travel, combined with high-end client dinners to close these deals, drove the variance.

HR & Legal Updates
To offset the heavy spend in Marketing and Engineering, we instituted a temporary global hiring freeze in mid-August. This resulted in HR coming in significantly under budget on external recruiting fees (GL-8010). Additionally, all company-wide offsites were paused. Finally, Legal experienced a severe variance of $230,000 in Outside Counsel fees. This was due to unforeseen litigation regarding patent infringement claims filed against us in the Eastern District of Texas. We retain high confidence in our defense, but the discovery phase required extensive external legal billing.
$memo$,
  true,
  jsonb_build_object('source', 'sample', 'pages', 1, 'doc_type', 'executive_memo')
)
ON CONFLICT (id) DO UPDATE
  SET content = EXCLUDED.content,
      name = EXCLUDED.name,
      is_sample = true,
      user_id = NULL,
      metadata = EXCLUDED.metadata;