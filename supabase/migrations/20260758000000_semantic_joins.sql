-- Joins for semantic models.
--
-- A model could previously bind exactly ONE physical table, which pushed every
-- fact-to-dimension relationship out of the governed layer: users pre-joined
-- in a prep flow or a warehouse view, and the metric definition no longer told
-- the whole story. A model now carries its joins the same way it carries its
-- dimensions and metrics — as owner-authored definitions, compiled and
-- validated by src/lib/semanticLayer.ts (table refs and aliases are strict
-- identifiers; ON conditions are owner-trusted fragments like dimension SQL).

ALTER TABLE public.semantic_models
  ADD COLUMN IF NOT EXISTS joins jsonb NOT NULL DEFAULT '[]'::jsonb;
