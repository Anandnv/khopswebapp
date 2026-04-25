-- ─────────────────────────────────────────────────────────────────────────────
-- KH Operations Dashboard — Normalized Supabase Schema
-- Run this once in the Supabase SQL editor.
-- If migrating from the old single-blob app_state table, run migrate.sql after.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. App config ─────────────────────────────────────────────────────────────
-- Stores centres array and procedure settings. One row, id = 'main'.
create table if not exists app_config (
  id            text primary key default 'main',
  centers       jsonb not null default '[]',
  procedures    jsonb not null default '[]',
  updated_at    timestamptz not null default now()
);

-- ── 2. Daily entries ───────────────────────────────────────────────────────────
-- One row per centre + date. op, referrals, procedures stored as JSONB.
create table if not exists daily_entries (
  id            bigserial primary key,
  centre_index  integer not null,
  centre_name   text    not null,
  entry_date    date    not null,
  op            jsonb   not null default '{}',
  referrals     jsonb   not null default '{}',
  procedures    jsonb   not null default '{}',
  updated_at    timestamptz not null default now(),
  unique (centre_index, entry_date)
);

create index if not exists daily_entries_centre_date
  on daily_entries (centre_index, entry_date);

-- ── 3. Entry metadata ──────────────────────────────────────────────────────────
-- Tracks last-saved timestamp and who saved. One row per centre + date.
create table if not exists entry_meta (
  id            bigserial primary key,
  centre_index  integer not null,
  entry_date    date    not null,
  saved_at      timestamptz not null default now(),
  saved_by      text    not null,
  unique (centre_index, entry_date)
);

-- ── 4. Unlock requests ─────────────────────────────────────────────────────────
create table if not exists unlock_requests (
  id              bigint primary key,   -- client-generated Date.now()
  centre_index    integer      not null,
  centre_name     text         not null,
  entry_date      date         not null,
  reason          text         not null,
  status          text         not null default 'pending'
                  check (status in ('pending','approved','rejected','expired')),
  requested_at    timestamptz  not null default now(),
  resolved_at     timestamptz,
  expires_at      timestamptz,
  unlock_req_id   bigint
);

create index if not exists unlock_requests_status
  on unlock_requests (status);

-- ── 5. Audit log ───────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id                bigint primary key,   -- client-generated Date.now()
  centre_index      integer      not null,
  centre_name       text         not null,
  entry_date        date         not null,
  saved_at          timestamptz  not null default now(),
  saved_by          text         not null,
  type              text         not null default 'normal'
                    check (type in ('normal','unlocked-edit','revert')),
  unlock_request_id bigint,
  reverted_from_id  bigint,
  before_state      jsonb        not null default '{}',
  after_state       jsonb        not null default '{}'
);

create index if not exists audit_log_centre_date
  on audit_log (centre_index, entry_date);
create index if not exists audit_log_saved_at
  on audit_log (saved_at desc);

-- ── 6. Row Level Security ──────────────────────────────────────────────────────
-- Mirrors your existing app_state policy pattern exactly.
-- app_config is a single-row table (id = 'main') — INSERT and UPDATE are
-- locked to that row, same as your current "Insert main only" / "Update main only".
-- Multi-row tables (daily_entries, entry_meta, unlock_requests, audit_log) use
-- open read/write since row identity is enforced by unique constraints and the
-- app's own logic, not a sentinel id value.

alter table app_config      enable row level security;
alter table daily_entries   enable row level security;
alter table entry_meta      enable row level security;
alter table unlock_requests enable row level security;
alter table audit_log       enable row level security;

-- ── app_config (single-row, id = 'main') ─────────────────────────────────────
create policy "Read app_config"
  on public.app_config for select
  using (true);

create policy "Insert app_config main only"
  on public.app_config for insert
  with check (id = 'main');

create policy "Update app_config main only"
  on public.app_config for update
  using (id = 'main')
  with check (id = 'main');

-- ── daily_entries ─────────────────────────────────────────────────────────────
create policy "Read daily_entries"
  on public.daily_entries for select using (true);
create policy "Insert daily_entries"
  on public.daily_entries for insert with check (true);
create policy "Update daily_entries"
  on public.daily_entries for update using (true) with check (true);

-- ── entry_meta ────────────────────────────────────────────────────────────────
create policy "Read entry_meta"
  on public.entry_meta for select using (true);
create policy "Insert entry_meta"
  on public.entry_meta for insert with check (true);
create policy "Update entry_meta"
  on public.entry_meta for update using (true) with check (true);

-- ── unlock_requests ───────────────────────────────────────────────────────────
create policy "Read unlock_requests"
  on public.unlock_requests for select using (true);
create policy "Insert unlock_requests"
  on public.unlock_requests for insert with check (true);
create policy "Update unlock_requests"
  on public.unlock_requests for update using (true) with check (true);

-- ── audit_log ─────────────────────────────────────────────────────────────────
create policy "Read audit_log"
  on public.audit_log for select using (true);
create policy "Insert audit_log"
  on public.audit_log for insert with check (true);
create policy "Update audit_log"
  on public.audit_log for update using (true) with check (true);

-- ── 8. Legacy table (keep for safety during migration) ────────────────────────
-- Do NOT drop app_state until you have confirmed the migration succeeded.
-- Check row counts at the end of migrate.sql first.
-- Once confirmed: DROP TABLE IF EXISTS app_state;
