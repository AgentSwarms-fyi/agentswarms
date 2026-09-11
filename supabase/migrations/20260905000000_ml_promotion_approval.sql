-- Somebody else has to say yes before a version serves production.
--
-- Promotion was audited but not gated: any owner could put a new model in
-- front of customers, and the record said so afterwards. Model-risk practice
-- (SR 11-7 and the policies written from it) asks for a second signature
-- BEFORE the change, by someone who did not make it.
--
-- NO SECOND APPROVALS SYSTEM. public.approvals already carries designated
-- approvers, groups, a decision and a decider, and it already has an inbox in
-- the header. A promotion becomes an approval with action_type 'ml.promote'.
-- Building a parallel one would have meant two inboxes, two audit shapes and
-- two things to remember.

ALTER TABLE public.ml_models
  ADD COLUMN IF NOT EXISTS promotion_approvers uuid[];

COMMENT ON COLUMN public.ml_models.promotion_approvers IS
  'Users who may approve this model''s promotions to production. NULL or empty means promotion is ungated, which is the default and the previous behaviour. The person who REQUESTS a promotion may never be the one who approves it, whatever this column says.';
