do $$
declare
  scheduled_job record;
begin
  for scheduled_job in
    select jobid
    from cron.job
    where jobname = 'refresh-kma-daily-cache'
  loop
    perform cron.unschedule(scheduled_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'refresh-kma-daily-cache',
  '20 0-14,16-23 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'kma_cache_project_url') || '/functions/v1/kma-hourly-cache?refresh=official',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'kma_cache_anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kma_cache_anon_key'),
      'x-kma-auth', (select decrypted_secret from vault.decrypted_secrets where name = 'kma_api_auth_key')
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 120000
  ) as request_id
  where (
    select count(*)
    from public.kma_precip_cache
    where cache_key in ('official:1m', 'official:3m', 'official:6m', 'official:12m', 'official:ty')
      and payload->>'effectiveDate' = (((now() at time zone 'Asia/Seoul')::date - 1)::text)
      and payload->>'source' = 'daily'
  ) < 5;
  $$
);
