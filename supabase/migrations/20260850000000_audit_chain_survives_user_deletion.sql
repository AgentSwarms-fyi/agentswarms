-- Deleting a user must not rewrite the audit trail.
--
-- TWO CORRECT FEATURES THAT CONTRADICTED EACH OTHER.
--
--   20260781000000 changed audit_events.user_id to ON DELETE SET NULL, under
--   the heading "the trail outlives the account". Right instinct: deleting a
--   person should not delete the record of what they did.
--
--   20260762000000 hashes each event into a chain, and user_id is one of the
--   hashed fields. That is also right: without it, an event could be
--   re-attributed to someone else and the hash would still check out.
--
-- Together they mean that deleting one account silently rewrites a hashed
-- field on every row that account ever produced. The chain then fails from the
-- first such row, and audit_chain_verify() reports "an event was altered or
-- removed" — true in the letter, and badly wrong in the implication, because
-- the thing that altered the row was the platform itself.
--
-- Measured on a live instance before this migration: 167 rows carried a NULL
-- user_id, the earliest at chain_seq 324, and verification reported the break
-- at exactly 324. Worse, only 50 of the 167 had an actor_email, so 117 rows
-- lost the subject entirely — the trail did not outlive the account, it merely
-- became anonymous.
--
-- THE FIX. Drop the foreign key. An audit row is history: nothing that happens
-- later may edit it, and a constraint whose whole job is to edit rows when
-- something else is deleted has no business on an append-only trail. user_id
-- stays exactly as written — the id that acted, whether or not that account
-- still exists — and actor_email continues to carry the human-readable
-- attribution.
--
-- The column stays NULLABLE: the 167 rows already nulled cannot be repaired,
-- because the value that would repair them was destroyed. Their break is
-- permanent and honest. This stops any new one.
ALTER TABLE public.audit_events
  DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey;

COMMENT ON COLUMN public.audit_events.user_id IS
  'The subject that acted. Deliberately NOT a foreign key: an audit row is append-only history, and a cascade or SET NULL would rewrite a hash-chained field when an account is deleted (see migration 20260850000000). May reference a user that no longer exists; actor_email carries the readable attribution.';
