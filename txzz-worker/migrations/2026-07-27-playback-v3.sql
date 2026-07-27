-- 糖心志者 2.1：购买请求幂等、单向状态机与安全对账。
begin;

create table if not exists public.txzz_purchase_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  request_id text not null,
  movie_id text not null,
  account_id text not null references public.txzz_accounts(id) on delete restrict,
  status text not null check (status in ('pending', 'charged', 'resolved', 'failed_before_charge', 'uncertain')),
  price numeric not null default 0,
  detail jsonb,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, movie_id, account_id)
);

create index if not exists txzz_purchase_attempts_movie_status_idx
  on public.txzz_purchase_attempts (movie_id, status, updated_at desc);

create or replace function public.txzz_purchase_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select case p_from
    when 'pending' then p_to in ('charged', 'failed_before_charge', 'uncertain')
    when 'charged' then p_to in ('resolved', 'uncertain')
    when 'uncertain' then p_to in ('resolved', 'uncertain')
    else false
  end;
$$;

insert into public.txzz_purchase_attempts (
  request_id, movie_id, account_id, status, price, detail, error, created_at, updated_at
)
select request_id, movie_id, account_id, status, price, detail, error, created_at, updated_at
from public.txzz_purchase_ledger
on conflict (request_id, movie_id, account_id) do nothing;

create or replace function public.txzz_mirror_purchase_ledger_v3()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.txzz_purchase_attempts (
    request_id, movie_id, account_id, status, price, detail, error, created_at, updated_at
  ) values (
    new.request_id, new.movie_id, new.account_id, new.status, new.price,
    new.detail, new.error, new.created_at, new.updated_at
  )
  on conflict (request_id, movie_id, account_id) do update
    set status = case
          when public.txzz_purchase_transition_allowed(public.txzz_purchase_attempts.status, excluded.status)
            then excluded.status
          else public.txzz_purchase_attempts.status
        end,
        price = excluded.price,
        detail = coalesce(excluded.detail, public.txzz_purchase_attempts.detail),
        error = excluded.error,
        updated_at = greatest(public.txzz_purchase_attempts.updated_at, excluded.updated_at);
  return new;
end;
$$;

drop trigger if exists txzz_purchase_ledger_mirror_v3 on public.txzz_purchase_ledger;
create trigger txzz_purchase_ledger_mirror_v3
after insert or update on public.txzz_purchase_ledger
for each row execute procedure public.txzz_mirror_purchase_ledger_v3();

drop trigger if exists txzz_purchase_attempts_touch_updated_at on public.txzz_purchase_attempts;
create trigger txzz_purchase_attempts_touch_updated_at
before update on public.txzz_purchase_attempts
for each row execute procedure public.txzz_touch_updated_at();

create or replace function public.txzz_expire_stale_purchase_attempts(
  p_movie_id text default null,
  p_stale_seconds integer default 90
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.txzz_purchase_attempts
  set status = 'uncertain',
      error = case when error = '' then 'pending lease expired before a confirmed charge result' else error end
  where status = 'pending'
    and updated_at < now() - make_interval(secs => greatest(p_stale_seconds, 60))
    and (p_movie_id is null or movie_id = p_movie_id);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.txzz_begin_purchase_attempt(
  p_request_id text,
  p_movie_id text,
  p_account_id text,
  p_price numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_value public.txzz_purchase_attempts%rowtype;
begin
  if coalesce(trim(p_request_id), '') = '' or coalesce(trim(p_movie_id), '') = '' or coalesce(trim(p_account_id), '') = '' then
    raise exception 'request_id, movie_id and account_id are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_movie_id, 210));
  perform public.txzz_expire_stale_purchase_attempts(p_movie_id, 90);

  select * into row_value
  from public.txzz_purchase_attempts
  where request_id = p_request_id and movie_id = p_movie_id and account_id = p_account_id
  limit 1;
  if found then
    return jsonb_build_object('action', 'idempotent', 'attempt', to_jsonb(row_value));
  end if;

  select * into row_value
  from public.txzz_purchase_attempts
  where movie_id = p_movie_id and status in ('pending', 'charged', 'resolved', 'uncertain')
  order by updated_at desc
  limit 1;
  if found then
    return jsonb_build_object('action', 'blocked', 'attempt', to_jsonb(row_value));
  end if;

  insert into public.txzz_purchase_attempts (request_id, movie_id, account_id, status, price)
  values (p_request_id, p_movie_id, p_account_id, 'pending', coalesce(p_price, 0))
  returning * into row_value;
  return jsonb_build_object('action', 'created', 'attempt', to_jsonb(row_value));
end;
$$;

create or replace function public.txzz_transition_purchase_attempt(
  p_attempt_id uuid,
  p_status text,
  p_error text default '',
  p_detail jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_value public.txzz_purchase_attempts%rowtype;
begin
  select * into row_value from public.txzz_purchase_attempts where attempt_id = p_attempt_id for update;
  if not found then raise exception 'purchase attempt not found'; end if;
  if not public.txzz_purchase_transition_allowed(row_value.status, p_status) then
    raise exception 'illegal purchase transition: % -> %', row_value.status, p_status;
  end if;
  update public.txzz_purchase_attempts
  set status = p_status,
      error = coalesce(p_error, ''),
      detail = coalesce(p_detail, detail)
  where attempt_id = p_attempt_id
  returning * into row_value;
  return to_jsonb(row_value);
end;
$$;

create or replace function public.txzz_playback_schema_status()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'ready',
      to_regclass('public.txzz_purchase_attempts') is not null
      and to_regprocedure('public.txzz_begin_purchase_attempt(text,text,text,numeric)') is not null
      and to_regprocedure('public.txzz_transition_purchase_attempt(uuid,text,text,jsonb)') is not null
      and to_regprocedure('public.txzz_expire_stale_purchase_attempts(text,integer)') is not null
      and exists (
        select 1 from pg_constraint
        where conrelid = 'public.txzz_purchase_attempts'::regclass
          and contype = 'u'
          and pg_get_constraintdef(oid) like '%request_id, movie_id, account_id%'
      )
      and exists (
        select 1 from pg_constraint
        where conrelid = 'public.txzz_purchase_attempts'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%failed_before_charge%'
          and pg_get_constraintdef(oid) like '%uncertain%'
      )
      and exists (
        select 1 from information_schema.triggers
        where event_object_schema = 'public'
          and event_object_table = 'txzz_purchase_ledger'
          and trigger_name = 'txzz_purchase_ledger_mirror_v3'
      ),
    'version', 3
  );
$$;

alter table public.txzz_purchase_attempts enable row level security;

revoke all on function public.txzz_purchase_transition_allowed(text, text) from public, anon, authenticated;
revoke all on function public.txzz_expire_stale_purchase_attempts(text, integer) from public, anon, authenticated;
revoke all on function public.txzz_begin_purchase_attempt(text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.txzz_transition_purchase_attempt(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.txzz_purchase_transition_allowed(text, text) to service_role;
grant execute on function public.txzz_expire_stale_purchase_attempts(text, integer) to service_role;
grant execute on function public.txzz_begin_purchase_attempt(text, text, text, numeric) to service_role;
grant execute on function public.txzz_transition_purchase_attempt(uuid, text, text, jsonb) to service_role;
grant execute on function public.txzz_playback_schema_status() to service_role;

commit;
