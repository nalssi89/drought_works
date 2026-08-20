create table if not exists public.kma_cache_leases (
  lease_key text primary key,
  owner_id text not null,
  lease_until timestamptz not null,
  acquired_at timestamptz not null default now()
);

alter table public.kma_cache_leases enable row level security;

create or replace function public.try_acquire_kma_cache_lease(
  p_lease_key text,
  p_owner_id text,
  p_ttl_seconds integer default 300
)
returns boolean
language sql
security invoker
set search_path = public
as $$
  with acquired as (
    insert into public.kma_cache_leases (lease_key, owner_id, lease_until)
    values (p_lease_key, p_owner_id, now() + make_interval(secs => p_ttl_seconds))
    on conflict (lease_key) do update
      set owner_id = excluded.owner_id,
          lease_until = excluded.lease_until,
          acquired_at = now()
      where public.kma_cache_leases.lease_until <= now()
         or public.kma_cache_leases.owner_id = excluded.owner_id
    returning 1
  )
  select exists(select 1 from acquired);
$$;

create or replace function public.release_kma_cache_lease(
  p_lease_key text,
  p_owner_id text
)
returns boolean
language sql
security invoker
set search_path = public
as $$
  delete from public.kma_cache_leases
  where lease_key = p_lease_key and owner_id = p_owner_id;
  select true;
$$;

create or replace function public.upsert_kma_precip_cache(
  p_cache_key text,
  p_observation_time timestamptz,
  p_payload jsonb,
  p_refreshed_at timestamptz default now()
)
returns boolean
language sql
security invoker
set search_path = public
as $$
  with written as (
    insert into public.kma_precip_cache (cache_key, observation_time, payload, refreshed_at)
    values (p_cache_key, p_observation_time, p_payload, p_refreshed_at)
    on conflict (cache_key) do update
      set observation_time = excluded.observation_time,
          payload = excluded.payload,
          refreshed_at = excluded.refreshed_at
      where excluded.observation_time >= public.kma_precip_cache.observation_time
    returning 1
  )
  select exists(select 1 from written);
$$;

revoke all on public.kma_cache_leases from public, anon, authenticated;
grant all on public.kma_cache_leases to service_role;
grant all on public.kma_precip_cache to service_role;
revoke all on function public.try_acquire_kma_cache_lease(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_kma_cache_lease(text, text) from public, anon, authenticated;
revoke all on function public.upsert_kma_precip_cache(text, timestamptz, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.try_acquire_kma_cache_lease(text, text, integer) to service_role;
grant execute on function public.release_kma_cache_lease(text, text) to service_role;
grant execute on function public.upsert_kma_precip_cache(text, timestamptz, jsonb, timestamptz) to service_role;
