create table if not exists public.app_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "Allow app state read" on public.app_state;
create policy "Allow app state read"
on public.app_state
for select
using (true);

drop policy if exists "Allow app state write" on public.app_state;
create policy "Allow app state write"
on public.app_state
for insert
with check (true);

drop policy if exists "Allow app state update" on public.app_state;
create policy "Allow app state update"
on public.app_state
for update
using (true)
with check (true);
