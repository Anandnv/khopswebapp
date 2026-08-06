-- Run this once in the Supabase SQL Editor before deploying the matching app code.
-- It provides the authoritative clock used by the daily-entry lock.

create or replace function public.kh_server_time()
returns timestamptz
language sql
stable
as $$
  select now();
$$;

grant execute on function public.kh_server_time() to anon, authenticated;
notify pgrst, 'reload schema';
