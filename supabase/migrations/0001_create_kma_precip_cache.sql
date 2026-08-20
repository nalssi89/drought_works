create table if not exists public.kma_precip_cache (
  cache_key text primary key,
  observation_time timestamptz not null,
  payload jsonb not null,
  refreshed_at timestamptz not null default now()
);

alter table public.kma_precip_cache enable row level security;

comment on table public.kma_precip_cache is
  'Official and intraday KMA precipitation payloads used by the dashboard Edge Function.';
