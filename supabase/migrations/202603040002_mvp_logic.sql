create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(new.email, '@', 1),
      'trojan-player'
    )
  )
  on conflict (user_id) do nothing;

  insert into public.user_streaks (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.ensure_user_profile()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  select
    email,
    coalesce(nullif(trim(raw_user_meta_data ->> 'display_name'), ''), split_part(email, '@', 1))
  into
    v_email,
    v_name
  from auth.users
  where id = v_user_id;

  insert into public.profiles (user_id, display_name)
  values (v_user_id, coalesce(v_name, split_part(v_email, '@', 1), 'trojan-player'))
  on conflict (user_id) do nothing;

  insert into public.user_streaks (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;
end;
$$;

create or replace function public.claim_daily_login()
returns table(tokens_awarded int, token_balance int, login_streak int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_previous_date date;
  v_previous_streak int := 0;
  v_new_streak int := 1;
  v_tokens_awarded int;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  perform public.ensure_user_profile();

  select
    us.last_login_date,
    us.login_streak
  into
    v_previous_date,
    v_previous_streak
  from public.user_streaks us
  where us.user_id = v_user_id
  for update;

  if v_previous_date = v_today then
    raise exception 'Daily reward already claimed for today.';
  end if;

  if v_previous_date = (v_today - 1) then
    v_new_streak := v_previous_streak + 1;
  end if;

  v_tokens_awarded := 100 + least((v_new_streak - 1) * 10, 100);

  insert into public.daily_login_claims (user_id, claim_date, tokens_awarded)
  values (v_user_id, v_today, v_tokens_awarded);

  insert into public.token_ledger (user_id, delta, reason, reference_type)
  values (v_user_id, v_tokens_awarded, 'daily_grant', 'daily_login');

  update public.user_streaks
  set
    login_streak = v_new_streak,
    last_login_date = v_today,
    updated_at = now()
  where user_id = v_user_id;

  select coalesce(sum(delta), 0)::int
  into token_balance
  from public.token_ledger
  where user_id = v_user_id;

  tokens_awarded := v_tokens_awarded;
  login_streak := v_new_streak;
  return next;
end;
$$;

create or replace function public.place_prediction(
  p_session_id uuid,
  p_side public.prediction_side,
  p_wager_tokens int default 10
)
returns table(prediction_id uuid, available_tokens int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.game_sessions%rowtype;
  v_balance int := 0;
  v_open_risk int := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_wager_tokens <= 0 then
    raise exception 'Wager must be greater than zero.';
  end if;

  perform public.ensure_user_profile();

  select *
  into v_session
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Session not found.';
  end if;

  if v_session.status in ('resolved', 'cancelled') then
    raise exception 'Session is already closed.';
  end if;

  if now() >= v_session.starts_at then
    raise exception 'Betting is closed for this session.';
  end if;

  if exists (
    select 1
    from public.predictions
    where session_id = p_session_id
      and user_id = v_user_id
  ) then
    raise exception 'Prediction already exists for this session.';
  end if;

  select coalesce(sum(delta), 0)::int
  into v_balance
  from public.token_ledger
  where user_id = v_user_id;

  select coalesce(sum(wager_tokens), 0)::int
  into v_open_risk
  from public.predictions
  where user_id = v_user_id
    and resolved_at is null;

  if (v_balance - v_open_risk) < p_wager_tokens then
    raise exception 'Insufficient available tokens.';
  end if;

  insert into public.predictions (session_id, user_id, side, wager_tokens)
  values (p_session_id, v_user_id, p_side, p_wager_tokens)
  returning id into prediction_id;

  available_tokens := (v_balance - v_open_risk - p_wager_tokens);
  return next;
end;
$$;

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

  if v_session.status = 'cancelled' then
    raise exception 'Cancelled sessions cannot be resolved.';
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
    where p.session_id = p_session_id
      and p.resolved_at is null
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
    returning user_id, delta
  ),
  streak_update as (
    insert into public.user_streaks (user_id, prediction_streak)
    select
      user_id,
      case when delta > 0 then 1 else 0 end
    from ledger_insert
    on conflict (user_id) do update
    set
      prediction_streak = case
        when excluded.prediction_streak = 1 then public.user_streaks.prediction_streak + 1
        else 0
      end,
      updated_at = now()
    returning user_id
  )
  select count(*)
  into processed_predictions
  from streak_update;

  return query
  select processed_predictions;
end;
$$;

create or replace function public.get_leaderboard(p_limit int default 25)
returns table(
  rank bigint,
  user_id uuid,
  display_name text,
  tier text,
  token_balance int,
  correct_predictions bigint
)
language sql
security definer
set search_path = public
as $$
  with scored as (
    select
      p.user_id,
      p.display_name,
      p.tier,
      coalesce(sum(tl.delta), 0)::int as token_balance,
      coalesce(sum(case when pr.was_correct then 1 else 0 end), 0)::bigint as correct_predictions
    from public.profiles p
    left join public.token_ledger tl on tl.user_id = p.user_id
    left join public.predictions pr on pr.user_id = p.user_id
    group by p.user_id, p.display_name, p.tier
  )
  select
    row_number() over (
      order by scored.token_balance desc, scored.correct_predictions desc, scored.display_name asc
    ) as rank,
    scored.user_id,
    scored.display_name,
    scored.tier,
    scored.token_balance,
    scored.correct_predictions
  from scored
  order by rank
  limit greatest(1, least(p_limit, 100));
$$;

revoke all on function public.ensure_user_profile() from public, anon, authenticated;
revoke all on function public.claim_daily_login() from public, anon, authenticated;
revoke all on function public.place_prediction(uuid, public.prediction_side, int) from public, anon, authenticated;
revoke all on function public.resolve_session(uuid, int) from public, anon, authenticated;
revoke all on function public.get_leaderboard(int) from public, anon, authenticated;

grant execute on function public.ensure_user_profile() to authenticated;
grant execute on function public.claim_daily_login() to authenticated;
grant execute on function public.place_prediction(uuid, public.prediction_side, int) to authenticated;
grant execute on function public.resolve_session(uuid, int) to service_role;
grant execute on function public.get_leaderboard(int) to anon, authenticated;
