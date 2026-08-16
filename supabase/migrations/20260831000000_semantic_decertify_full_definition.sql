-- Decertify on EVERY definition change, not most of them.
--
-- 20260820000000 introduced semantic_model_decertify_on_edit and put it in a
-- BEFORE UPDATE trigger deliberately, so no write path could skip it. That
-- reasoning was right and is kept. What it watched had simply fallen behind
-- what the model can hold.
--
-- MEASURED by diffing the fields the save path writes against the fields the
-- trigger compared. Six definition fields were written and unwatched:
--
--   table_id                 repoints the model at a DIFFERENT local dataset.
--                            `source_table` was watched and this is its
--                            local-source twin, so the gap is an oversight
--                            rather than a decision.
--   rollups                  aggregate awareness routes a query to a summary
--                            table when it can prove equivalence. Change the
--                            rollups and a different table answers.
--   calendar                 custom fiscal calendars (4-4-5). Redefines what
--                            a period contains.
--   fiscal_year_start_month  changes what "Q1" means, and therefore what every
--                            fiscal-grain query returns.
--   parameters               declared parameters carry defaults that feed
--                            computed values and what-if baselines.
--   hierarchies              declared drill paths — part of the definition a
--                            certificate vouches for.
--
-- The first four change NUMBERS. A model could be certified, repointed at
-- another dataset or given a different fiscal year, and keep a badge whose
-- whole meaning is "every validation check passed against the live source".
-- That is the failure this trigger exists to prevent, reached through a column
-- it did not happen to name.
--
-- label and description stay excluded, for the reason the original gave:
-- renaming a display label does not change what "revenue" computes.

CREATE OR REPLACE FUNCTION public.semantic_model_decertify_on_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only a DEFINITION change invalidates a certificate. Status flips and
  -- metadata-only touches (label, description) keep it.
  IF OLD.status = 'certified' AND NEW.status = 'certified' AND (
       NEW.dimensions   IS DISTINCT FROM OLD.dimensions
    OR NEW.metrics      IS DISTINCT FROM OLD.metrics
    OR NEW.joins        IS DISTINCT FROM OLD.joins
    OR NEW.assertions   IS DISTINCT FROM OLD.assertions
    OR NEW.primary_key  IS DISTINCT FROM OLD.primary_key
    OR NEW.source_kind  IS DISTINCT FROM OLD.source_kind
    OR NEW.source_table IS DISTINCT FROM OLD.source_table
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.name         IS DISTINCT FROM OLD.name
    -- Added 20260831000000 — see the header for what each one changes.
    OR NEW.table_id     IS DISTINCT FROM OLD.table_id
    OR NEW.rollups      IS DISTINCT FROM OLD.rollups
    OR NEW.calendar     IS DISTINCT FROM OLD.calendar
    OR NEW.fiscal_year_start_month IS DISTINCT FROM OLD.fiscal_year_start_month
    OR NEW.parameters   IS DISTINCT FROM OLD.parameters
    OR NEW.hierarchies  IS DISTINCT FROM OLD.hierarchies
  ) THEN
    NEW.status := 'draft';
    NEW.certified_by := NULL;
    NEW.certified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
