create extension if not exists pgcrypto;

create type public.prediction_side as enum ('over', 'under');
create type public.session_status as enum ('scheduled', 'locked', 'counting', 'resolved', 'cancelled');
create type public.ledger_reason as enum (
  'daily_grant',
  'prediction_win',
  'prediction_loss',
  'streak_bonus',
  'admin_adjustment'
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 2 and 64),
  tier text not null default 'Bronze',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_streaks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  login_streak int not null default 0 check (login_streak >= 0),
  prediction_streak int not null default 0 check (prediction_streak >= 0),
  last_login_date date,
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_login_claims (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  claim_date date not null,
  tokens_awarded int not null check (tokens_awarded > 0),
  created_at timestamptz not null default now(),
  unique (user_id, claim_date)
);

create table if not exists public.achievements (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null,
  criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete cascade,
  awarded_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  mode_seconds int not null check (mode_seconds in (30, 60)),
  threshold int not null check (threshold > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.session_status not null default 'scheduled',
  camera_feed_url text not null,
  region_polygon jsonb not null,
  final_count int check (final_count is null or final_count >= 0),
  resolved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists game_sessions_status_starts_idx
  on public.game_sessions(status, starts_at);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.game_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  side public.prediction_side not null,
  wager_tokens int not null check (wager_tokens > 0),
  placed_at timestamptz not null default now(),
  was_correct boolean,
  token_delta int,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, user_id)
);

create index if not exists predictions_session_idx
  on public.predictions(session_id);

create index if not exists predictions_user_idx
  on public.predictions(user_id, created_at desc);

create table if not exists public.token_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta int not null check (delta <> 0),
  reason public.ledger_reason not null,
  reference_type text not null,
  reference_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists token_ledger_user_idx
  on public.token_ledger(user_id, created_at desc);

create or replace view public.user_token_balances as
select
  user_id,
  coalesce(sum(delta), 0)::int as token_balance
from public.token_ledger
group by user_id;

create or replace function public.resolve_session(
  p_session_id uuid,
  p_final_count int
)
returns table(processed_predictions int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions%rowtype;
begin
  if p_final_count < 0 then
    raise exception 'Final count cannot be negative.';
  end if;

  select *
  into v_session
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Session not found: %', p_session_id;
  end if;

  if v_session.status = 'resolved' then
    return query
    select 0;
    return;
  end if;

  update public.game_sessions
  set
    status = 'resolved',
    final_count = p_final_count,
    resolved_at = now(),
    updated_at = now()
  where id = p_session_id;

  with resolved as (
    update public.predictions p
    set
      was_correct = case
        when p.side = 'over' then p_final_count > v_session.threshold
        else p_final_count < v_session.threshold
      end,
      token_delta = case
        when p.side = 'over' and p_final_count > v_session.threshold then p.wager_tokens
        when p.side = 'under' and p_final_count < v_session.threshold then p.wager_tokens
        else -p.wager_tokens
      end,
      resolved_at = now(),
      updated_at = now()
    where p.session_id = p_session_id and p.resolved_at is null
    returning p.id, p.user_id, p.token_delta
  ),
  ledger_insert as (
    insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
    select
      user_id,
      token_delta,
      case
        when token_delta > 0 then 'prediction_win'::public.ledger_reason
        else 'prediction_loss'::public.ledger_reason
      end,
      'prediction',
      id
    from resolved
    returning 1
  )
  select count(*)
  into processed_predictions
  from ledger_insert;

  return query
  select processed_predictions;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger user_streaks_set_updated_at
before update on public.user_streaks
for each row execute function public.set_updated_at();

create trigger game_sessions_set_updated_at
before update on public.game_sessions
for each row execute function public.set_updated_at();

create trigger predictions_set_updated_at
before update on public.predictions
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.user_streaks enable row level security;
alter table public.daily_login_claims enable row level security;
alter table public.achievements enable row level security;
alter table public.user_achievements enable row level security;
alter table public.game_sessions enable row level security;
alter table public.predictions enable row level security;
alter table public.token_ledger enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "streaks_select_own"
  on public.user_streaks for select
  using (auth.uid() = user_id);

create policy "login_claims_select_own"
  on public.daily_login_claims for select
  using (auth.uid() = user_id);

create policy "achievements_public_select"
  on public.achievements for select
  using (true);

create policy "user_achievements_select_own"
  on public.user_achievements for select
  using (auth.uid() = user_id);

create policy "sessions_public_select"
  on public.game_sessions for select
  using (true);

create policy "predictions_select_own"
  on public.predictions for select
  using (auth.uid() = user_id);

create policy "predictions_insert_own"
  on public.predictions for insert
  with check (auth.uid() = user_id);

create policy "token_ledger_select_own"
  on public.token_ledger for select
  using (auth.uid() = user_id);
