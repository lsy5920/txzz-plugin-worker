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

alter table public.txzz_accounts enable row level security;
alter table public.txzz_full_detail_cache enable row level security;
alter table public.txzz_audit_logs enable row level security;

-- The Worker uses the Supabase service_role key, which bypasses RLS.
-- Do not create anon read/write policies for these tables.
