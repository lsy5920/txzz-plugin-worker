create table if not exists public.txzz_accounts (
  id text primary key,
  label text not null,
  username text,
  role text not null default 'full',
  enabled boolean not null default true,
  source text not null default 'remote',
  secret_box jsonb not null,
  user_info jsonb,
  status text not null default 'idle',
  notes text,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.txzz_full_detail_cache (
  account_id text not null references public.txzz_accounts(id) on delete cascade,
  movie_id text not null,
  detail jsonb not null,
  summary jsonb not null,
  cached_at timestamptz not null default now(),
  primary key (account_id, movie_id)
);

-- v2 缓存字段为增量添加，保留并兼容现有 v1 缓存数据。
alter table public.txzz_full_detail_cache
  add column if not exists schema_version integer not null default 1,
  add column if not exists expires_at timestamptz;

update public.txzz_full_detail_cache
set expires_at = cached_at + interval '10 minutes'
where expires_at is null;

create table if not exists public.txzz_audit_logs (
  id bigserial primary key,
  event text not null,
  account_id text,
  movie_id text,
  ok boolean not null default true,
  message text,
  meta jsonb,
  created_at timestamptz not null default now()
);

-- 跨 Worker 实例的金币购买互斥锁，避免同一视频被并发重复购买。
create table if not exists public.txzz_purchase_locks (
  movie_id text primary key,
  owner text not null,
  locked_at timestamptz not null default now()
);

-- 每个“视频 + 账号”只保留一条扣费事实，任何 charged/uncertain 记录都必须原账号对账。
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

-- 尝试获取购买锁；旧锁超过指定秒数后允许新请求安全接管。
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

drop trigger if exists txzz_accounts_touch_updated_at on public.txzz_accounts;
create trigger txzz_accounts_touch_updated_at
before update on public.txzz_accounts
for each row execute procedure public.txzz_touch_updated_at();

drop trigger if exists txzz_purchase_ledger_touch_updated_at on public.txzz_purchase_ledger;
create trigger txzz_purchase_ledger_touch_updated_at
before update on public.txzz_purchase_ledger
for each row execute procedure public.txzz_touch_updated_at();

-- 发布门禁使用只读探针，同时确认账本表、状态约束和 v2 缓存列都已存在。
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

alter table public.txzz_accounts enable row level security;
alter table public.txzz_full_detail_cache enable row level security;
alter table public.txzz_audit_logs enable row level security;
alter table public.txzz_purchase_locks enable row level security;
alter table public.txzz_purchase_ledger enable row level security;

revoke all on function public.txzz_try_acquire_purchase_lock(text, text, integer) from public;
revoke all on function public.txzz_try_acquire_purchase_lock(text, text, integer) from anon;
revoke all on function public.txzz_try_acquire_purchase_lock(text, text, integer) from authenticated;
grant execute on function public.txzz_try_acquire_purchase_lock(text, text, integer) to service_role;

revoke all on function public.txzz_playback_schema_status() from public;
revoke all on function public.txzz_playback_schema_status() from anon;
revoke all on function public.txzz_playback_schema_status() from authenticated;
grant execute on function public.txzz_playback_schema_status() to service_role;

-- Worker 使用可绕过行级安全策略的 Supabase service_role 密钥访问数据。
-- 严禁为这些数据表创建匿名读写策略。
