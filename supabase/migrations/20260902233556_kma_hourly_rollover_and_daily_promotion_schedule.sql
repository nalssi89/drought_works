do $$
declare
  scheduled_job record;
begin
  for scheduled_job in
    select jobid
    from cron.job
    where jobname in ('refresh-kma-hourly-cache', 'refresh-kma-daily-cache')
  loop
    perform cron.unschedule(scheduled_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'refresh-kma-hourly-cache',
  '10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'kma_cache_project_url') || '/functions/v1/kma-hourly-cache',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'kma_cache_anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kma_cache_anon_key'),
      'x-kma-auth', (select decrypted_secret from vault.decrypted_secrets where name = 'kma_api_auth_key')
    ),
    body := jsonb_build_object('scheduled_at', now()),
    timeout_milliseconds := 120000
  ) as request_id;
  $$
);

select cron.schedule(
  'refresh-kma-daily-cache',
  '20 0-14,23 * * *',
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
  ) as request_id;
  $$
);
