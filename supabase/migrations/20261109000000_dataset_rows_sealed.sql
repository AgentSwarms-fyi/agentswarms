-- A dataset says when its rows go through the server (R452).
--
-- Rows of a user under a customer key are to be sealed under that key, and the
-- browser holds no key, so it cannot read or write them directly. This is how it
-- knows which datasets those are. Nothing else changes: every dataset stays
-- false until its owner is under a customer key, and the app works without this
-- column, reading every dataset as it always did.
ALTER TABLE public.user_data_tables
  ADD COLUMN IF NOT EXISTS rows_sealed boolean NOT NULL DEFAULT false;
