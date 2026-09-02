alter table public.kma_precip_cache
  drop constraint kma_precip_cache_cache_key_check;

alter table public.kma_precip_cache
  add constraint kma_precip_cache_cache_key_check
  check (
    cache_key ~ '^(official|intraday):(1m|3m|6m|12m|ty)$'
    or cache_key ~ '^rollover:[0-9]{4}-[0-9]{2}-[0-9]{2}:(1m|3m|6m|12m|ty)$'
  );
