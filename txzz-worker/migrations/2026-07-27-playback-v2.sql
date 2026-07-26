-- 糖果影院播放系统 v2：非破坏性缓存升级与购买幂等账本。
begin;

alter table public.txzz_full_detail_cache
  add column if not exists schema_version integer not null default 1,
  add column if not exists expires_at timestamptz;

update public.txzz_full_detail_cache
set expires_at = cached_at + interval '10 minutes'
where expires_at is null;

-- 独立升级必须补齐旧部署可能缺失的跨实例购买锁，不能假设执行过最新版 schema.sql。
create table if not exists public.txzz_purchase_locks (
  movie_id text primary key,
  owner text not null,
  locked_at timestamptz not null default now()
);

create or replace function public.txzz_try_acquire_purchase_lock(
  p_movie_id text,
  p_owner text,
  p_ttl_seconds integer default 45
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_rows integer;
begin
  insert into public.txzz_purchase_locks (movie_id, owner, locked_at)
  values (p_movie_id, p_owner, now())
  on conflict (movie_id) do update
    set owner = excluded.owner,
        locked_at = excluded.locked_at
    where public.txzz_purchase_locks.locked_at
      < now() - make_interval(secs => greatest(p_ttl_seconds, 5));

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.txzz_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.txzz_purchase_ledger (
  movie_id text not null,
  account_id text not null references public.txzz_accounts(id) on delete restrict,
  request_id text not null,
  status text not null check (status in ('pending', 'charged', 'resolved', 'failed_before_charge', 'uncertain')),
  price numeric not null default 0,
  detail jsonb,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (movie_id, account_id)
);

create index if not exists txzz_purchase_ledger_status_idx
  on public.txzz_purchase_ledger (status, updated_at desc);

drop trigger if exists txzz_purchase_ledger_touch_updated_at on public.txzz_purchase_ledger;
create trigger txzz_purchase_ledger_touch_updated_at
before update on public.txzz_purchase_ledger
for each row execute procedure public.txzz_touch_updated_at();

alter table public.txzz_purchase_ledger enable row level security;
alter table public.txzz_purchase_locks enable row level security;

revoke all on function public.txzz_try_acquire_purchase_lock(text, text, integer) from public;
revoke all on function public.txzz_try_acquire_purchase_lock(text, text, integer) from anon;
revoke all on function public.txzz_try_acquire_purchase_lock(text, text, integer) from authenticated;
grant execute on function public.txzz_try_acquire_purchase_lock(text, text, integer) to service_role;

create or replace function public.txzz_playback_schema_status()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'ready',
      to_regclass('public.txzz_purchase_ledger') is not null
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'txzz_full_detail_cache'
          and column_name = 'schema_version'
      )
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'txzz_full_detail_cache'
          and column_name = 'expires_at'
      )
      and (
        select count(*) from information_schema.columns
        where table_schema = 'public'
          and table_name = 'txzz_purchase_ledger'
          and column_name in ('movie_id', 'account_id', 'request_id', 'status', 'detail', 'updated_at')
      ) = 6
      and to_regprocedure('public.txzz_try_acquire_purchase_lock(text,text,integer)') is not null,
    'version', 2
  );
$$;

revoke all on function public.txzz_playback_schema_status() from public;
revoke all on function public.txzz_playback_schema_status() from anon;
revoke all on function public.txzz_playback_schema_status() from authenticated;
grant execute on function public.txzz_playback_schema_status() to service_role;

commit;
