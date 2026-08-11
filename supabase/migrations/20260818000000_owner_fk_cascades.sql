-- Three tables key off auth.users and never referenced it.
--
-- `budget_settings`, `user_data_tables` and `execution_traces` each declare
-- `user_id uuid not null` with no foreign key, so deleting an account leaves
-- its rows behind permanently. Measured on this instance after removing seven
-- fixture accounts left by earlier test runs: 24 orphaned budget_settings, 4
-- orphaned user_data_tables and 260 orphaned execution_traces, the oldest from
-- 2026-07-22. Tables that DO declare the reference — bi_dashboards, agents,
-- conversations, notifications, profiles — came away clean, which is what made
-- the difference visible.
--
-- Each one fails differently, so each gets a different rule.
--
--   user_data_tables → CASCADE
--     Orphaned datasets are unreachable, not merely untidy: RLS on
--     user_data_rows is `user_id = auth.uid()`, so once the owner is gone
--     nobody can list, read or delete them through the application. They are
--     storage that only grows. The user's data goes with the user.
--
--   budget_settings → CASCADE
--     A spending cap for an account that does not exist has no meaning.
--
--   execution_traces → SET NULL, and the column becomes nullable
--     NOT deleted. This is cost history, and an operator doing chargeback has
--     a legitimate reason to keep the spend after the person leaves — dropping
--     it would silently reduce recorded instance spend, which is the same
--     class of dishonesty as a truncated total. Nulling the owner keeps the
--     money in instance-wide sums and out of per-user ones, which is exactly
--     right: every per-user read filters `.eq("user_id", …)` and a null simply
--     never matches. The RLS policy is `auth.uid() = user_id`, so a nulled row
--     is readable by nobody but the service role.
--
-- Existing orphans are cleaned up here, because adding a foreign key to a
-- table that already violates it fails outright.

-- ── user_data_tables ────────────────────────────────────────────────────────
-- `is_sample` rows are owned by nobody ON PURPOSE and must survive. Only rows
-- with a non-null owner that no longer exists are removed. user_data_rows and
-- user_data_table_versions already cascade from user_data_tables.
delete from public.user_data_tables t
where t.user_id is not null
  and not exists (select 1 from auth.users u where u.id = t.user_id);

alter table public.user_data_tables
  add constraint user_data_tables_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- ── budget_settings ─────────────────────────────────────────────────────────
delete from public.budget_settings b
where not exists (select 1 from auth.users u where u.id = b.user_id);

alter table public.budget_settings
  add constraint budget_settings_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- ── execution_traces ────────────────────────────────────────────────────────
-- Detach rather than delete, so historical spend survives the account.
alter table public.execution_traces alter column user_id drop not null;

update public.execution_traces t
set user_id = null
where t.user_id is not null
  and not exists (select 1 from auth.users u where u.id = t.user_id);

alter table public.execution_traces
  add constraint execution_traces_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
