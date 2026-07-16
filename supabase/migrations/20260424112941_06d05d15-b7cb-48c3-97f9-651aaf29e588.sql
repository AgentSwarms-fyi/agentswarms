
-- ============================================================================
-- 1. Status columns on knowledge_bases
-- ============================================================================
ALTER TABLE public.knowledge_bases
  ADD COLUMN IF NOT EXISTS kb_graph_status TEXT
    CHECK (kb_graph_status IN ('none','building','ready','error')) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS kb_graph_built_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kb_graph_error TEXT;

-- ============================================================================
-- 2. kb_graph_entities
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.kb_graph_entities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id          UUID,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'other'
    CHECK (type IN ('person','org','product','concept','location','event','other')),
  description      TEXT,
  mention_count    INTEGER NOT NULL DEFAULT 1,
  is_sample        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, normalized_name, type)
);

CREATE INDEX IF NOT EXISTS idx_kb_graph_entities_kb ON public.kb_graph_entities(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_graph_entities_norm ON public.kb_graph_entities(normalized_name);

ALTER TABLE public.kb_graph_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read own or sample entities" ON public.kb_graph_entities
  FOR SELECT USING (
    auth.uid() = user_id
    OR is_sample = true
    OR EXISTS (
      SELECT 1 FROM public.knowledge_bases kb
      WHERE kb.id = knowledge_base_id AND (kb.user_id = auth.uid() OR kb.is_sample = true)
    )
  );

CREATE POLICY "insert own entities" ON public.kb_graph_entities
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM public.knowledge_bases kb
      WHERE kb.id = knowledge_base_id AND kb.user_id = auth.uid()
    )
  );

CREATE POLICY "update own entities" ON public.kb_graph_entities
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "delete own entities" ON public.kb_graph_entities
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- 3. kb_graph_relations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.kb_graph_relations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id           UUID,
  source_entity_id  UUID NOT NULL REFERENCES public.kb_graph_entities(id) ON DELETE CASCADE,
  target_entity_id  UUID NOT NULL REFERENCES public.kb_graph_entities(id) ON DELETE CASCADE,
  predicate         TEXT NOT NULL,
  weight            INTEGER NOT NULL DEFAULT 1,
  document_id       UUID REFERENCES public.knowledge_documents(id) ON DELETE SET NULL,
  is_sample         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, source_entity_id, predicate, target_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_graph_relations_kb ON public.kb_graph_relations(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_graph_relations_src ON public.kb_graph_relations(knowledge_base_id, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_kb_graph_relations_tgt ON public.kb_graph_relations(knowledge_base_id, target_entity_id);

ALTER TABLE public.kb_graph_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read own or sample relations" ON public.kb_graph_relations
  FOR SELECT USING (
    auth.uid() = user_id
    OR is_sample = true
    OR EXISTS (
      SELECT 1 FROM public.knowledge_bases kb
      WHERE kb.id = knowledge_base_id AND (kb.user_id = auth.uid() OR kb.is_sample = true)
    )
  );

CREATE POLICY "insert own relations" ON public.kb_graph_relations
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND EXISTS (
      SELECT 1 FROM public.knowledge_bases kb
      WHERE kb.id = knowledge_base_id AND kb.user_id = auth.uid()
    )
  );

CREATE POLICY "delete own relations" ON public.kb_graph_relations
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- 4. kb_graph_mentions
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.kb_graph_mentions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID NOT NULL REFERENCES public.kb_graph_entities(id) ON DELETE CASCADE,
  document_id UUID REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  snippet     TEXT NOT NULL,
  char_start  INTEGER,
  is_sample   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_graph_mentions_entity ON public.kb_graph_mentions(entity_id);

ALTER TABLE public.kb_graph_mentions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read mentions if entity readable" ON public.kb_graph_mentions
  FOR SELECT USING (
    is_sample = true
    OR EXISTS (
      SELECT 1 FROM public.kb_graph_entities e
      WHERE e.id = entity_id
        AND (e.user_id = auth.uid() OR e.is_sample = true
             OR EXISTS (
               SELECT 1 FROM public.knowledge_bases kb
               WHERE kb.id = e.knowledge_base_id AND (kb.user_id = auth.uid() OR kb.is_sample = true)
             ))
    )
  );

CREATE POLICY "insert mentions for own entities" ON public.kb_graph_mentions
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.kb_graph_entities e
      WHERE e.id = entity_id AND e.user_id = auth.uid()
    )
  );

CREATE POLICY "delete mentions for own entities" ON public.kb_graph_mentions
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.kb_graph_entities e
      WHERE e.id = entity_id AND e.user_id = auth.uid()
    )
  );

-- ============================================================================
-- 5. Sample KB seed — Acme Corp Graph RAG demo
-- ============================================================================
-- Idempotent: only insert if a sample KB by this name doesn't already exist.
DO $$
DECLARE
  kb_id UUID;
  doc_arch UUID;
  doc_billing UUID;
  doc_auth UUID;
  doc_team UUID;
  doc_compliance UUID;

  e_acme UUID; e_billing UUID; e_auth UUID; e_legacy_auth UUID;
  e_dataplatform UUID; e_alice UUID; e_bob UUID; e_carla UUID;
  e_dan UUID; e_eve UUID; e_payments_team UUID; e_security_team UUID;
  e_pci UUID; e_eu_dpa UUID;
BEGIN
  SELECT id INTO kb_id FROM public.knowledge_bases
   WHERE is_sample = true AND name = 'Graph RAG Demo — Acme Corp' LIMIT 1;

  IF kb_id IS NOT NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.knowledge_bases (name, description, is_sample, user_id, kb_graph_status, kb_graph_built_at)
  VALUES (
    'Graph RAG Demo — Acme Corp',
    'A fictional company''s docs designed to show how Graph RAG answers multi-hop questions (who depends on what, who owns what) that flat RAG misses.',
    true, NULL, 'ready', now()
  ) RETURNING id INTO kb_id;

  -- Documents
  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Architecture Overview',
    'Acme Corp runs a microservice architecture. The Billing Service depends on the Auth Service for token validation and on the Data Platform for usage metering. The Auth Service replaced the Legacy Auth API in 2023; Legacy Auth is still kept alive for two enterprise customers. The Data Platform powers analytics across all internal teams.',
    true, NULL, '{"source":"sample"}'::jsonb)
  RETURNING id INTO doc_arch;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Billing Service Ownership',
    'The Billing Service is owned by the Payments Team. Alice leads the Payments Team. Bob is the on-call engineer for Billing this quarter. Billing handles all PCI-scoped credit card flows and is therefore in scope for PCI DSS audits.',
    true, NULL, '{"source":"sample"}'::jsonb)
  RETURNING id INTO doc_billing;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Auth Service Ownership',
    'The Auth Service is owned by the Security Team. Carla leads the Security Team. Dan is the principal engineer on Auth. The Legacy Auth API is also maintained by the Security Team but only Eve still works on it.',
    true, NULL, '{"source":"sample"}'::jsonb)
  RETURNING id INTO doc_auth;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Team Roster',
    'Payments Team: Alice (lead), Bob, plus three engineers. Security Team: Carla (lead), Dan (principal on Auth), Eve (Legacy Auth maintainer). Both teams report to the VP of Engineering.',
    true, NULL, '{"source":"sample"}'::jsonb)
  RETURNING id INTO doc_team;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Compliance Map',
    'PCI DSS scope: Billing Service. EU Data Protection Act scope: Auth Service and Data Platform (because they store user identifiers). Any change to a service in scope requires sign-off from the owning team lead and the Security Team.',
    true, NULL, '{"source":"sample"}'::jsonb)
  RETURNING id INTO doc_compliance;

  -- Entities
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Acme Corp', 'acme corp', 'org', 'The company.', 1, true) RETURNING id INTO e_acme;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Billing Service', 'billing service', 'product', 'Handles credit card and invoicing flows.', 3, true) RETURNING id INTO e_billing;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Auth Service', 'auth service', 'product', 'Modern authentication and token validation.', 3, true) RETURNING id INTO e_auth;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Legacy Auth API', 'legacy auth api', 'product', 'Deprecated auth endpoint kept alive for two enterprise customers.', 2, true) RETURNING id INTO e_legacy_auth;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Data Platform', 'data platform', 'product', 'Internal analytics + metering platform.', 2, true) RETURNING id INTO e_dataplatform;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Alice', 'alice', 'person', 'Lead of the Payments Team.', 2, true) RETURNING id INTO e_alice;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Bob', 'bob', 'person', 'On-call engineer for Billing.', 2, true) RETURNING id INTO e_bob;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Carla', 'carla', 'person', 'Lead of the Security Team.', 2, true) RETURNING id INTO e_carla;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Dan', 'dan', 'person', 'Principal engineer on Auth.', 2, true) RETURNING id INTO e_dan;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Eve', 'eve', 'person', 'Legacy Auth API maintainer.', 2, true) RETURNING id INTO e_eve;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Payments Team', 'payments team', 'org', 'Owns Billing Service.', 2, true) RETURNING id INTO e_payments_team;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Security Team', 'security team', 'org', 'Owns Auth and Legacy Auth.', 3, true) RETURNING id INTO e_security_team;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'PCI DSS', 'pci dss', 'concept', 'Payment Card Industry Data Security Standard.', 2, true) RETURNING id INTO e_pci;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'EU Data Protection Act', 'eu data protection act', 'concept', 'EU regulation on personal data.', 1, true) RETURNING id INTO e_eu_dpa;

  -- Relations (triples)
  INSERT INTO public.kb_graph_relations (knowledge_base_id, user_id, source_entity_id, target_entity_id, predicate, weight, document_id, is_sample) VALUES
    (kb_id, NULL, e_billing, e_auth, 'depends_on', 2, doc_arch, true),
    (kb_id, NULL, e_billing, e_dataplatform, 'depends_on', 1, doc_arch, true),
    (kb_id, NULL, e_auth, e_legacy_auth, 'replaced', 1, doc_arch, true),
    (kb_id, NULL, e_billing, e_payments_team, 'owned_by', 2, doc_billing, true),
    (kb_id, NULL, e_auth, e_security_team, 'owned_by', 2, doc_auth, true),
    (kb_id, NULL, e_legacy_auth, e_security_team, 'owned_by', 1, doc_auth, true),
    (kb_id, NULL, e_alice, e_payments_team, 'leads', 2, doc_billing, true),
    (kb_id, NULL, e_carla, e_security_team, 'leads', 2, doc_auth, true),
    (kb_id, NULL, e_bob, e_payments_team, 'member_of', 1, doc_team, true),
    (kb_id, NULL, e_dan, e_security_team, 'member_of', 1, doc_team, true),
    (kb_id, NULL, e_eve, e_security_team, 'member_of', 1, doc_team, true),
    (kb_id, NULL, e_dan, e_auth, 'works_on', 1, doc_auth, true),
    (kb_id, NULL, e_eve, e_legacy_auth, 'works_on', 1, doc_auth, true),
    (kb_id, NULL, e_bob, e_billing, 'on_call_for', 1, doc_billing, true),
    (kb_id, NULL, e_billing, e_pci, 'in_scope_for', 2, doc_compliance, true),
    (kb_id, NULL, e_auth, e_eu_dpa, 'in_scope_for', 1, doc_compliance, true),
    (kb_id, NULL, e_dataplatform, e_eu_dpa, 'in_scope_for', 1, doc_compliance, true);

  -- Mentions
  INSERT INTO public.kb_graph_mentions (entity_id, document_id, snippet, char_start, is_sample) VALUES
    (e_billing, doc_arch, 'The Billing Service depends on the Auth Service for token validation', 19, true),
    (e_auth, doc_arch, 'The Auth Service replaced the Legacy Auth API in 2023', 96, true),
    (e_legacy_auth, doc_arch, 'Legacy Auth is still kept alive for two enterprise customers', 144, true),
    (e_dataplatform, doc_arch, 'The Data Platform powers analytics across all internal teams', 200, true),
    (e_billing, doc_billing, 'The Billing Service is owned by the Payments Team', 0, true),
    (e_alice, doc_billing, 'Alice leads the Payments Team', 50, true),
    (e_bob, doc_billing, 'Bob is the on-call engineer for Billing this quarter', 80, true),
    (e_pci, doc_billing, 'Billing handles all PCI-scoped credit card flows', 130, true),
    (e_auth, doc_auth, 'The Auth Service is owned by the Security Team', 0, true),
    (e_carla, doc_auth, 'Carla leads the Security Team', 48, true),
    (e_dan, doc_auth, 'Dan is the principal engineer on Auth', 80, true),
    (e_eve, doc_auth, 'only Eve still works on it', 200, true),
    (e_payments_team, doc_team, 'Payments Team: Alice (lead), Bob, plus three engineers', 0, true),
    (e_security_team, doc_team, 'Security Team: Carla (lead), Dan (principal on Auth), Eve', 60, true),
    (e_pci, doc_compliance, 'PCI DSS scope: Billing Service', 0, true),
    (e_eu_dpa, doc_compliance, 'EU Data Protection Act scope: Auth Service and Data Platform', 35, true);

END $$;
