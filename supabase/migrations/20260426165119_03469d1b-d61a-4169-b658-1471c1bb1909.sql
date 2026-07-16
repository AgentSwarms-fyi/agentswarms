-- Pharmacovigilance Drug Safety sample KB + knowledge graph.
-- Used by the "Agentic RAG (Pharmacovigilance)" swarm template.
-- Pattern matches the existing "Graph RAG Demo — Acme Corp" seed.

DO $$
DECLARE
  kb_id UUID;
  doc_carde_label   UUID;
  doc_carde_pk      UUID;
  doc_rhythmoral    UUID;
  doc_vasostatil    UUID;
  doc_safety_bull   UUID;

  -- Drugs
  e_cardenolex UUID; e_rhythmoral UUID; e_vasostatil UUID;
  -- Enzymes / transporters
  e_cyp3a4 UUID; e_oatp1b1 UUID;
  -- Mechanisms
  e_sodium_ch UUID; e_beta1 UUID; e_ace UUID;
  -- Adverse events
  e_hepatotox UUID; e_acute_liver_inj UUID; e_hepatitis UUID; e_brady UUID;
  e_hyperkalemia UUID; e_cough UUID;
  -- Concomitant drugs
  e_atorvastatin UUID; e_warfarin UUID; e_spironolactone UUID;
  -- Concepts
  e_faers UUID;
BEGIN
  SELECT id INTO kb_id FROM public.knowledge_bases
   WHERE is_sample = true AND name = 'Sample · Pharmacovigilance Drug Safety' LIMIT 1;
  IF kb_id IS NOT NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.knowledge_bases (name, description, is_sample, user_id, kb_graph_status, kb_graph_built_at)
  VALUES (
    'Sample · Pharmacovigilance Drug Safety',
    'Fictional pharmacovigilance corpus: drug labels, pharmacokinetic monographs, internal safety bulletins, and a knowledge graph of drugs, enzymes, mechanisms, and adverse events. Used by the Agentic RAG (Pharmacovigilance) swarm template.',
    true, NULL, 'ready', now()
  ) RETURNING id INTO kb_id;

  -- ─── Documents ───
  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Cardenolex — FDA Label (Section 5: Warnings & Precautions)',
    'CARDENOLEX (cardenolide acetate) is indicated for the treatment of paroxysmal atrial fibrillation in adults. Section 5.2 — Hepatotoxicity: Post-marketing reports describe cases of elevated hepatic transaminases, cholestatic injury, and rare cases of acute liver failure, predominantly in patients aged 65 and older receiving concomitant CYP3A4 substrates. Liver function tests are recommended at baseline, at 4 weeks, and quarterly thereafter. Discontinue Cardenolex if ALT or AST rises above 5x the upper limit of normal. Section 5.3 — Drug Interactions: Cardenolex is a strong inhibitor of OATP1B1; co-administration with statins (particularly atorvastatin and simvastatin) significantly increases statin plasma exposure and the risk of myopathy and hepatic injury. Avoid concomitant use where possible.',
    true, NULL, '{"source":"sample","doc_type":"fda_label","drug":"Cardenolex"}'::jsonb)
  RETURNING id INTO doc_carde_label;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Cardenolex — Pharmacokinetics Monograph',
    'Cardenolex is a class Ic-like antiarrhythmic that blocks late sodium channels. It is extensively metabolized by CYP3A4 (>80%) with minor contribution from CYP2D6. Cardenolex is also a substrate and potent inhibitor of the OATP1B1 hepatic uptake transporter. Steady-state plasma concentrations are reached within 5 days. Mean elimination half-life is 14 hours; clearance is reduced by ~40% in patients with mild hepatic impairment. The CYP3A4 inhibition pathway is the dominant mechanism behind the observed hepatotoxicity signal: build-up of unmetabolized parent drug + impaired statin clearance via OATP1B1 produces a synergistic hepatic insult.',
    true, NULL, '{"source":"sample","doc_type":"pk_monograph","drug":"Cardenolex"}'::jsonb)
  RETURNING id INTO doc_carde_pk;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Rhythmoral — Comparator Monograph',
    'Rhythmoral (rhytmolide hydrochloride) is a class III antiarrhythmic indicated for paroxysmal atrial fibrillation. Mechanism: selective beta-1 adrenergic blockade combined with potassium channel modulation. Metabolism is renal (>70%) with minimal CYP3A4 involvement. Rhythmoral does not inhibit OATP1B1 and has no documented interaction with statins. Post-marketing data over 6 years shows hepatic adverse events in <0.4% of patients — comparable to placebo. Rhythmoral is the standard-of-care comparator for new atrial fibrillation antiarrhythmics in safety benchmarking.',
    true, NULL, '{"source":"sample","doc_type":"pk_monograph","drug":"Rhythmoral"}'::jsonb)
  RETURNING id INTO doc_rhythmoral;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Vasostatil — Drug Profile',
    'Vasostatil (vasostatil maleate) is an ACE inhibitor indicated for essential hypertension. Mechanism: inhibition of angiotensin-converting enzyme. Common adverse events: dry cough (12% of patients), hyperkalemia (especially with concomitant potassium-sparing diuretics like spironolactone), and rare angioedema. Vasostatil has no clinically significant hepatic adverse event profile and is metabolized by ester hydrolysis independent of CYP3A4. Included in the safety database as an unrelated control drug for signal detection algorithms.',
    true, NULL, '{"source":"sample","doc_type":"drug_profile","drug":"Vasostatil"}'::jsonb)
  RETURNING id INTO doc_vasostatil;

  INSERT INTO public.knowledge_documents (knowledge_base_id, name, content, is_sample, user_id, metadata)
  VALUES (kb_id, 'Internal Safety Bulletin — Q2 2026',
    'The Pharmacovigilance Safety Committee reviewed all hepatic adverse event (AE) signals across the cardiovascular portfolio for Q2 2026. Cardenolex showed a disproportionate hepatic AE reporting rate (~62% of all reports vs. an expected baseline of <15% for class Ic antiarrhythmics). The committee identified an enriched signal in patients aged 65+ co-prescribed atorvastatin, consistent with the OATP1B1-mediated drug-drug interaction described in the FDA label. Recommended action: update the label with a Boxed Warning for patients on concomitant statins, issue a Dear Healthcare Provider letter, and submit a 15-day expedited safety report to FDA per 21 CFR 314.80.',
    true, NULL, '{"source":"sample","doc_type":"internal_bulletin","drug":"Cardenolex"}'::jsonb)
  RETURNING id INTO doc_safety_bull;

  -- ─── Entities ───
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Cardenolex', 'cardenolex', 'product', 'Class Ic-like antiarrhythmic for paroxysmal atrial fibrillation.', 5, true) RETURNING id INTO e_cardenolex;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Rhythmoral', 'rhythmoral', 'product', 'Class III antiarrhythmic — comparator for atrial fibrillation safety benchmarking.', 2, true) RETURNING id INTO e_rhythmoral;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Vasostatil', 'vasostatil', 'product', 'ACE inhibitor for hypertension (control drug).', 2, true) RETURNING id INTO e_vasostatil;

  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'CYP3A4', 'cyp3a4', 'concept', 'Cytochrome P450 3A4 — major hepatic metabolizing enzyme.', 3, true) RETURNING id INTO e_cyp3a4;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'OATP1B1', 'oatp1b1', 'concept', 'Organic anion transporting polypeptide 1B1 — hepatic uptake transporter.', 3, true) RETURNING id INTO e_oatp1b1;

  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Late Sodium Channel', 'late sodium channel', 'concept', 'Cardiac late sodium current target.', 1, true) RETURNING id INTO e_sodium_ch;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Beta-1 Adrenergic Receptor', 'beta-1 adrenergic receptor', 'concept', 'Cardiac beta-1 adrenoceptor.', 1, true) RETURNING id INTO e_beta1;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Angiotensin Converting Enzyme', 'angiotensin converting enzyme', 'concept', 'ACE — target of ACE inhibitors.', 1, true) RETURNING id INTO e_ace;

  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Hepatotoxicity', 'hepatotoxicity', 'concept', 'Liver injury — broad adverse-event category.', 4, true) RETURNING id INTO e_hepatotox;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Acute Liver Injury', 'acute liver injury', 'concept', 'Severe hepatic adverse event.', 2, true) RETURNING id INTO e_acute_liver_inj;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Hepatitis', 'hepatitis', 'concept', 'Inflammation of the liver.', 2, true) RETURNING id INTO e_hepatitis;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Bradycardia', 'bradycardia', 'concept', 'Abnormally slow heart rate.', 1, true) RETURNING id INTO e_brady;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Hyperkalemia', 'hyperkalemia', 'concept', 'Elevated serum potassium.', 1, true) RETURNING id INTO e_hyperkalemia;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Dry Cough', 'dry cough', 'concept', 'ACE-inhibitor class effect.', 1, true) RETURNING id INTO e_cough;

  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Atorvastatin', 'atorvastatin', 'product', 'HMG-CoA reductase inhibitor; OATP1B1 substrate.', 3, true) RETURNING id INTO e_atorvastatin;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Warfarin', 'warfarin', 'product', 'Vitamin-K antagonist anticoagulant.', 1, true) RETURNING id INTO e_warfarin;
  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'Spironolactone', 'spironolactone', 'product', 'Potassium-sparing diuretic.', 1, true) RETURNING id INTO e_spironolactone;

  INSERT INTO public.kb_graph_entities (knowledge_base_id, user_id, name, normalized_name, type, description, mention_count, is_sample) VALUES
    (kb_id, NULL, 'FAERS', 'faers', 'concept', 'FDA Adverse Event Reporting System.', 1, true) RETURNING id INTO e_faers;

  -- ─── Relations (drug → enzyme/mechanism → AE) ───
  INSERT INTO public.kb_graph_relations (knowledge_base_id, user_id, source_entity_id, target_entity_id, predicate, weight, document_id, is_sample) VALUES
    (kb_id, NULL, e_cardenolex, e_cyp3a4, 'metabolized_by', 3, doc_carde_pk, true),
    (kb_id, NULL, e_cardenolex, e_oatp1b1, 'inhibits', 3, doc_carde_pk, true),
    (kb_id, NULL, e_cardenolex, e_sodium_ch, 'targets', 1, doc_carde_pk, true),
    (kb_id, NULL, e_cardenolex, e_hepatotox, 'associated_with', 4, doc_carde_label, true),
    (kb_id, NULL, e_cardenolex, e_acute_liver_inj, 'associated_with', 2, doc_carde_label, true),
    (kb_id, NULL, e_cardenolex, e_hepatitis, 'associated_with', 2, doc_safety_bull, true),
    (kb_id, NULL, e_cardenolex, e_atorvastatin, 'interacts_with', 3, doc_carde_label, true),
    (kb_id, NULL, e_cardenolex, e_warfarin, 'co_administered_with', 1, doc_carde_label, true),

    (kb_id, NULL, e_atorvastatin, e_oatp1b1, 'transported_by', 2, doc_carde_pk, true),
    (kb_id, NULL, e_atorvastatin, e_hepatotox, 'associated_with', 1, doc_carde_pk, true),

    (kb_id, NULL, e_rhythmoral, e_beta1, 'targets', 1, doc_rhythmoral, true),
    (kb_id, NULL, e_rhythmoral, e_brady, 'associated_with', 1, doc_rhythmoral, true),

    (kb_id, NULL, e_vasostatil, e_ace, 'targets', 1, doc_vasostatil, true),
    (kb_id, NULL, e_vasostatil, e_cough, 'associated_with', 1, doc_vasostatil, true),
    (kb_id, NULL, e_vasostatil, e_hyperkalemia, 'associated_with', 1, doc_vasostatil, true),
    (kb_id, NULL, e_vasostatil, e_spironolactone, 'interacts_with', 1, doc_vasostatil, true),

    (kb_id, NULL, e_acute_liver_inj, e_hepatotox, 'is_a', 1, doc_carde_label, true),
    (kb_id, NULL, e_hepatitis, e_hepatotox, 'is_a', 1, doc_carde_label, true);

  -- ─── Mentions ───
  INSERT INTO public.kb_graph_mentions (entity_id, document_id, snippet, char_start, is_sample) VALUES
    (e_cardenolex, doc_carde_label, 'CARDENOLEX (cardenolide acetate) is indicated for the treatment of paroxysmal atrial fibrillation', 0, true),
    (e_hepatotox, doc_carde_label, 'Section 5.2 — Hepatotoxicity: Post-marketing reports describe cases of elevated hepatic transaminases', 200, true),
    (e_atorvastatin, doc_carde_label, 'co-administration with statins (particularly atorvastatin and simvastatin)', 700, true),
    (e_oatp1b1, doc_carde_label, 'Cardenolex is a strong inhibitor of OATP1B1', 600, true),
    (e_cyp3a4, doc_carde_pk, 'extensively metabolized by CYP3A4 (>80%)', 80, true),
    (e_oatp1b1, doc_carde_pk, 'substrate and potent inhibitor of the OATP1B1 hepatic uptake transporter', 160, true),
    (e_acute_liver_inj, doc_safety_bull, 'enriched signal in patients aged 65+ co-prescribed atorvastatin', 400, true),
    (e_rhythmoral, doc_rhythmoral, 'Rhythmoral (rhytmolide hydrochloride) is a class III antiarrhythmic', 0, true),
    (e_vasostatil, doc_vasostatil, 'Vasostatil (vasostatil maleate) is an ACE inhibitor', 0, true),
    (e_cough, doc_vasostatil, 'dry cough (12% of patients)', 200, true);
END $$;