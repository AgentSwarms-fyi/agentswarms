-- R531, follow-up: the query log's money columns keep every digit.
--
-- 20261127000000 first declared cost_usd and ai_cost_usd as numeric(14,6),
-- the mistake R318 removed from every other money column: a query priced at
-- a fraction of a millionth of a dollar was rounded, and each total over such
-- queries carried the rounding. The migration now declares them unconstrained;
-- this changes a database that applied the first version, and does nothing to
-- one that did not.
ALTER TABLE public.query_log ALTER COLUMN cost_usd TYPE numeric;
ALTER TABLE public.query_log ALTER COLUMN ai_cost_usd TYPE numeric;
