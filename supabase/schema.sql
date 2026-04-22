-- TABLE
create table if not exists public.app_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- ENABLE RLS
alter table public.app_state enable row level security;

-- 🔒 POLICY: ONLY ALLOW READ (safe for now)
drop policy if exists "Allow read" on public.app_state;
create policy "Allow read"
on public.app_state
for select
using (true);

-- 🔒 POLICY: BLOCK INSERT (TEMPORARY)
drop policy if exists "Allow insert" on public.app_state;
create policy "Allow insert"
on public.app_state
for insert
with check (false);

-- 🔒 POLICY: BLOCK UPDATE (TEMPORARY)
drop policy if exists "Allow update" on public.app_state;
create policy "Allow update"
on public.app_state
for update
using (false)
with check (false);