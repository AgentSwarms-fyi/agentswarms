-- Semantic models learn their own grain, and pin the numbers they must keep.
--
-- primary_key: the column/expression that uniquely identifies one SOURCE row
-- (the model's grain). Declared by the owner; semanticValidateModel MEASURES
-- it (COUNT(*) vs COUNT(DISTINCT pk)) rather than trusting it, and the
-- compiler's fan-out refusals use it to name the correct count_distinct fix.
--
-- assertions: pinned metric values — [{metric, filters, expected, tolerance,
-- label}]. Validate re-computes each one and fails when a definition edit
-- moves a number someone has signed off on. This is the difference between
-- "the SQL still runs" and "revenue still means what the board was told";
-- until now Validate could only promise the former.
--
-- Join CARDINALITY needs no column: joins are already jsonb, so the new
-- per-join `cardinality` field rides along. Old rows lack it and keep
-- compiling exactly as before (the compiler only enforces declared fan-out);
-- Validate measures the truth for them.
ALTER TABLE public.semantic_models
  ADD COLUMN IF NOT EXISTS primary_key text,
  ADD COLUMN IF NOT EXISTS assertions jsonb NOT NULL DEFAULT '[]'::jsonb;
