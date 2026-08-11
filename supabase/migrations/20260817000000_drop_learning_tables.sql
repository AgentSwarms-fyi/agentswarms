-- Drop four tables that belong to a product this repository is not.
--
-- quiz_questions, quiz_attempts and lab_attempts are a learning/academy
-- feature; user_announcements_dismissed backs an in-app announcement banner.
-- None of them has ever existed in this codebase: an audit of all 103 tables
-- in the schema against all 725 application files found no reference to any of
-- them outside the generated types file, and no SQL function reads or writes
-- them either. They arrived with the schema when this fork was cut.
--
-- Why remove them rather than leave them be:
--
--   * quiz_questions is READABLE BY EVERY AUTHENTICATED USER (`using (true)`).
--     A permissive policy is defensible for a catalog the UI needs; it is not
--     defensible for a table nothing reads. The RLS audit test keeps an
--     explicit list of blanket-read tables so each one is a decision, and this
--     one has no justification to write down.
--   * A self-hosted operator inspecting their own database should not have to
--     work out which tables are theirs. Twenty rows of quiz content in an
--     agent platform is a question every serious evaluator will ask.
--
-- Deliberately NOT dropped: concurrency_leases. It looked like a fifth orphan
-- — no application file names it, and it holds zero rows — but it backs
-- concurrency_acquire / concurrency_release, called from
-- src/utils/rateLimit.server.ts. Empty is its normal state: a row exists only
-- while a lease is held.
--
-- Data loss is intended and total. If a downstream fork built on these, keep
-- this migration out of that branch.

drop table if exists public.quiz_attempts;
drop table if exists public.quiz_questions;
drop table if exists public.lab_attempts;
drop table if exists public.user_announcements_dismissed;
