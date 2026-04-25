-- ─────────────────────────────────────────────────────────────────────────────
-- KH Operations — One-time migration from app_state blob to normalized tables
-- Run AFTER schema.sql, and ONLY ONCE.
-- Safe to re-run — all inserts use ON CONFLICT DO NOTHING or DO UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. App config ─────────────────────────────────────────────────────────────
insert into app_config (id, centers, procedures, updated_at)
select
  'main',
  (state -> 'centers'),
  (state -> 'procedureSettings'),
  now()
from app_state
where id = 'main'
on conflict (id) do update
  set centers    = excluded.centers,
      procedures = excluded.procedures,
      updated_at = excluded.updated_at;

-- ── 2. Daily entries ───────────────────────────────────────────────────────────
-- The old blob stores entries as { "centreIndex": { "YYYY-MM-DD": { op, referrals, procedures } } }
-- We expand that nested JSONB into rows here.

insert into daily_entries (centre_index, centre_name, entry_date, op, referrals, procedures, updated_at)
select
  (centre_kv.key)::integer                                as centre_index,
  (state -> 'centers' -> (centre_kv.key)::integer ->> 'name') as centre_name,
  (date_kv.key)::date                                     as entry_date,
  coalesce(date_kv.value -> 'op',         '{}')           as op,
  coalesce(date_kv.value -> 'referrals',  '{}')           as referrals,
  coalesce(date_kv.value -> 'procedures', '{}')           as procedures,
  now()                                                   as updated_at
from
  app_state,
  jsonb_each(state -> 'entries') as centre_kv,
  jsonb_each(centre_kv.value)    as date_kv
where app_state.id = 'main'
on conflict (centre_index, entry_date) do update
  set op         = excluded.op,
      referrals  = excluded.referrals,
      procedures = excluded.procedures,
      updated_at = excluded.updated_at;

-- ── 3. Entry metadata ──────────────────────────────────────────────────────────
insert into entry_meta (centre_index, entry_date, saved_at, saved_by)
select
  (centre_kv.key)::integer                                     as centre_index,
  (date_kv.key)::date                                          as entry_date,
  coalesce(
    (date_kv.value ->> 'savedAt')::timestamptz,
    now()
  )                                                            as saved_at,
  coalesce(date_kv.value ->> 'savedBy', 'unknown')            as saved_by
from
  app_state,
  jsonb_each(state -> 'entryMeta') as centre_kv,
  jsonb_each(centre_kv.value)      as date_kv
where app_state.id = 'main'
on conflict (centre_index, entry_date) do update
  set saved_at = excluded.saved_at,
      saved_by = excluded.saved_by;

-- ── 4. Unlock requests ─────────────────────────────────────────────────────────
insert into unlock_requests (
  id, centre_index, centre_name, entry_date, reason, status,
  requested_at, resolved_at, expires_at
)
select
  (r ->> 'id')::bigint,
  (r ->> 'centreIndex')::integer,
  r ->> 'centreName',
  (r ->> 'date')::date,
  r ->> 'reason',
  coalesce(r ->> 'status', 'pending'),
  (r ->> 'requestedAt')::timestamptz,
  case when r ->> 'resolvedAt' is not null then (r ->> 'resolvedAt')::timestamptz end,
  case when r ->> 'expiresAt'  is not null then (r ->> 'expiresAt')::timestamptz  end
from
  app_state,
  jsonb_array_elements(state -> 'unlockRequests') as r
where app_state.id = 'main'
  and jsonb_array_length(state -> 'unlockRequests') > 0
on conflict (id) do nothing;

-- ── 5. Audit log ───────────────────────────────────────────────────────────────
insert into audit_log (
  id, centre_index, centre_name, entry_date, saved_at, saved_by,
  type, unlock_request_id, reverted_from_id, before_state, after_state
)
select
  (l ->> 'id')::bigint,
  (l ->> 'centreIndex')::integer,
  l ->> 'centreName',
  (l ->> 'date')::date,
  (l ->> 'savedAt')::timestamptz,
  l ->> 'savedBy',
  coalesce(l ->> 'type', 'normal'),
  case when l ->> 'unlockRequestId'  is not null then (l ->> 'unlockRequestId')::bigint  end,
  case when l ->> 'revertedFromId'   is not null then (l ->> 'revertedFromId')::bigint   end,
  coalesce(l -> 'before', '{}'),
  coalesce(l -> 'after',  '{}')
from
  app_state,
  jsonb_array_elements(state -> 'auditLog') as l
where app_state.id = 'main'
  and jsonb_array_length(state -> 'auditLog') > 0
on conflict (id) do nothing;

-- ── Done ───────────────────────────────────────────────────────────────────────
-- Verify row counts:
select 'app_config'      as tbl, count(*) from app_config
union all
select 'daily_entries',          count(*) from daily_entries
union all
select 'entry_meta',             count(*) from entry_meta
union all
select 'unlock_requests',        count(*) from unlock_requests
union all
select 'audit_log',              count(*) from audit_log;

-- Once confirmed correct, you can drop the old table:
-- DROP TABLE IF EXISTS app_state;
