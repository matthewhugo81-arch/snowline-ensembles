-- Only the weather endpoint's server credential can read or write this cache.
create table if not exists public.snowline_mogreps_cache (
  key text primary key,
  run bigint not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists snowline_mogreps_cache_run_idx on public.snowline_mogreps_cache(run);
alter table public.snowline_mogreps_cache enable row level security;
revoke all on public.snowline_mogreps_cache from anon, authenticated;
grant select, insert, update, delete on public.snowline_mogreps_cache to service_role;
