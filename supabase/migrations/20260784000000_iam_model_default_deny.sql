-- Instance-wide default for model access when a user has NO applicable rules.
--
--   'allow' — historical behaviour: no rules means unrestricted.
--   'deny'  — no rules means NO models are callable (fail closed); access
--             exists only where an admin has written an allow-list rule.
--             Superadmins bypass, so the people who administer the lists
--             cannot lock themselves out.
--
-- DEFAULT 'allow', deliberately: applying this migration must change nothing
-- on an existing instance. Flipping to deny is an explicit superadmin action
-- in Admin → IAM, made after the allow-lists exist. A migration that flipped
-- the default itself would brick every deployment that has users but no rules
-- — which is every deployment, the moment this lands.
--
-- Resource access (knowledge bases, datasets, secrets, dashboards, agents,
-- connections…) is unaffected: it is already deny-by-default — owner-only RLS
-- with additive read-only grants (iam_resource_grants / has_resource_access).

ALTER TABLE public.iam_settings
  ADD COLUMN IF NOT EXISTS model_access_default text NOT NULL DEFAULT 'allow';

ALTER TABLE public.iam_settings
  DROP CONSTRAINT IF EXISTS iam_settings_model_access_default_check;

ALTER TABLE public.iam_settings
  ADD CONSTRAINT iam_settings_model_access_default_check
  CHECK (model_access_default IN ('allow', 'deny'));
