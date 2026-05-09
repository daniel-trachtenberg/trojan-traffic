create or replace function public.get_tier_for_credits(p_credits int)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_credits, 0) >= 5000 then 'Platinum'
    when coalesce(p_credits, 0) >= 3000 then 'Gold'
    when coalesce(p_credits, 0) >= 1000 then 'Silver'
    else 'Bronze'
  end;
$$;

create or replace function public.sync_profile_tier(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token_balance int := 0;
  v_tier text;
begin
  if p_user_id is null then
    return 'Bronze';
  end if;

  select coalesce(sum(delta), 0)::int
  into v_token_balance
  from public.token_ledger
  where user_id = p_user_id;

  v_tier := public.get_tier_for_credits(v_token_balance);

  update public.profiles
  set
    tier = v_tier,
    updated_at = now()
  where user_id = p_user_id
    and tier is distinct from v_tier;

  return v_tier;
end;
$$;

create or replace function public.award_user_achievements(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prediction_count int := 0;
  v_correct_prediction_count int := 0;
  v_login_streak int := 0;
  v_prediction_streak int := 0;
  v_token_balance int := 0;
  v_awarded_count int := 0;
begin
  if p_user_id is null then
    return 0;
  end if;

  select
    count(*)::int,
    count(*) filter (where was_correct is true)::int
  into v_prediction_count, v_correct_prediction_count
  from public.predictions
  where user_id = p_user_id;

  select
    coalesce(login_streak, 0),
    coalesce(prediction_streak, 0)
  into v_login_streak, v_prediction_streak
  from public.user_streaks
  where user_id = p_user_id;

  select coalesce(sum(delta), 0)::int
  into v_token_balance
  from public.token_ledger
  where user_id = p_user_id;

  with eligible_achievements as (
    select
      a.id,
      coalesce(a.criteria ->> 'type', 'prediction_count') as criteria_type,
      case
        when coalesce(a.criteria ->> 'minimum', '') ~ '^[0-9]+$'
          then (a.criteria ->> 'minimum')::int
        else 1
      end as minimum
    from public.achievements a
    where not exists (
      select 1
      from public.user_achievements ua
      where ua.user_id = p_user_id
        and ua.achievement_id = a.id
    )
  ),
  newly_awarded as (
    insert into public.user_achievements (user_id, achievement_id)
    select
      p_user_id,
      ea.id
    from eligible_achievements ea
    where case ea.criteria_type
      when 'prediction_count' then v_prediction_count >= ea.minimum
      when 'correct_prediction_count' then v_correct_prediction_count >= ea.minimum
      when 'login_streak' then v_login_streak >= ea.minimum
      when 'prediction_streak' then v_prediction_streak >= ea.minimum
      when 'token_balance' then v_token_balance >= ea.minimum
      else false
    end
    on conflict do nothing
    returning 1
  )
  select count(*)::int
  into v_awarded_count
  from newly_awarded;

  return v_awarded_count;
end;
$$;

revoke all on function public.award_user_achievements(uuid) from public, anon, authenticated;
revoke all on function public.sync_profile_tier(uuid) from public, anon, authenticated;
revoke all on function public.get_tier_for_credits(int) from public, anon, authenticated;
grant execute on function public.get_tier_for_credits(int) to anon, authenticated, service_role;

update public.achievements
set description = 'Place your first prediction.'
where slug = 'first-prediction';

insert into public.achievements (slug, name, description, criteria)
values
  (
    'sharp-eye-10',
    'Sharp Eye',
    'Get ten predictions right.',
    '{"type":"correct_prediction_count","minimum":10}'::jsonb
  ),
  (
    'bank-builder-1000',
    'Bank Builder',
    'Reach one thousand credits.',
    '{"type":"token_balance","minimum":1000}'::jsonb
  )
on conflict (slug) do update
set
  name = excluded.name,
  description = excluded.description,
  criteria = excluded.criteria;

create or replace function public.claim_daily_login()
returns table(tokens_awarded int, token_balance int, login_streak int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim_timezone constant text := 'America/Los_Angeles';
  v_now_local timestamp := now() at time zone v_claim_timezone;
  v_claim_date date := v_now_local::date;
  v_claim_time time := v_now_local::time;
  v_previous_date date;
  v_previous_streak int := 0;
  v_new_streak int := 1;
  v_tokens_awarded int;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if v_claim_time < time '08:00:00' then
    raise exception 'Daily reward can only be claimed between 8:00 AM and 11:59 PM PT.';
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

  if v_previous_date = v_claim_date then
    raise exception 'Daily reward already claimed for today. Claim again tomorrow after 8:00 AM PT.';
  end if;

  if v_previous_date = (v_claim_date - 1) then
    v_new_streak := v_previous_streak + 1;
  end if;

  v_tokens_awarded := 10;

  insert into public.daily_login_claims (user_id, claim_date, tokens_awarded)
  values (v_user_id, v_claim_date, v_tokens_awarded);

  insert into public.token_ledger (user_id, delta, reason, reference_type)
  values (v_user_id, v_tokens_awarded, 'daily_grant', 'daily_login');

  update public.user_streaks
  set
    login_streak = v_new_streak,
    last_login_date = v_claim_date,
    updated_at = now()
  where user_id = v_user_id;

  perform public.sync_profile_tier(v_user_id);
  perform public.award_user_achievements(v_user_id);

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
  p_wager_tokens int default 10,
  p_exact_value int default null,
  p_range_min int default null,
  p_range_max int default null
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
  v_payout_multiplier_bps int;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_wager_tokens <= 0 then
    raise exception 'Wager must be greater than zero.';
  end if;

  if p_side = 'exact' then
    if p_exact_value is null or p_exact_value < 0 then
      raise exception 'Exact prediction must be a whole number zero or greater.';
    end if;

    if p_range_min is not null or p_range_max is not null then
      raise exception 'Range bounds are only allowed for range entries.';
    end if;
  elsif p_side = 'range' then
    if p_range_min is null or p_range_max is null then
      raise exception 'Range predictions require both a minimum and maximum.';
    end if;

    if p_range_min < 0 or p_range_max < 0 or p_range_min > p_range_max then
      raise exception 'Range predictions must use whole numbers with min less than or equal to max.';
    end if;

    if p_exact_value is not null then
      raise exception 'Exact prediction value is only allowed for exact entries.';
    end if;
  else
    if p_exact_value is not null then
      raise exception 'Exact prediction value is only allowed for exact entries.';
    end if;

    if p_range_min is not null or p_range_max is not null then
      raise exception 'Range bounds are only allowed for range entries.';
    end if;
  end if;

  perform public.ensure_user_profile();

  perform 1
  from public.user_streaks
  where user_id = v_user_id
  for update;

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

  if now() < (v_session.starts_at - interval '5 minutes') then
    raise exception 'Betting opens 5 minutes before this session starts.';
  end if;

  if now() >= v_session.starts_at then
    raise exception 'Betting is closed for this session.';
  end if;

  select coalesce(sum(delta), 0)::int
  into v_balance
  from public.token_ledger
  where user_id = v_user_id;

  if v_balance < p_wager_tokens then
    raise exception 'Insufficient token balance.';
  end if;

  v_payout_multiplier_bps := public.get_prediction_payout_multiplier_bps(
    p_side,
    p_range_min,
    p_range_max
  );

  insert into public.predictions (
    session_id,
    user_id,
    side,
    wager_tokens,
    stake_charged,
    exact_value,
    range_min,
    range_max,
    payout_multiplier_bps
  )
  values (
    p_session_id,
    v_user_id,
    p_side,
    p_wager_tokens,
    true,
    case when p_side = 'exact' then p_exact_value else null end,
    case when p_side = 'range' then p_range_min else null end,
    case when p_side = 'range' then p_range_max else null end,
    v_payout_multiplier_bps
  )
  returning id into prediction_id;

  insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
  values (v_user_id, -p_wager_tokens, 'prediction_wager', 'prediction', prediction_id);

  perform public.sync_profile_tier(v_user_id);
  perform public.award_user_achievements(v_user_id);

  available_tokens := (v_balance - p_wager_tokens);
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
  v_resolved_user_ids uuid[] := array[]::uuid[];
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
    live_count = p_final_count,
    final_count = p_final_count,
    resolved_at = now(),
    updated_at = now()
  where id = p_session_id;

  with resolved as (
    update public.predictions p
    set
      was_correct = case
        when p.side = 'over' then p_final_count > v_session.threshold
        when p.side = 'under' then p_final_count < v_session.threshold
        when p.side = 'exact' then p_final_count = p.exact_value
        when p.side = 'range' then p_final_count between p.range_min and p.range_max
        else false
      end,
      token_delta = case
        when p.side = 'over' and p_final_count > v_session.threshold then
          public.get_prediction_gross_payout_tokens(p.wager_tokens, p.payout_multiplier_bps) - p.wager_tokens
        when p.side = 'under' and p_final_count < v_session.threshold then
          public.get_prediction_gross_payout_tokens(p.wager_tokens, p.payout_multiplier_bps) - p.wager_tokens
        when p.side = 'exact' and p_final_count = p.exact_value then
          public.get_prediction_gross_payout_tokens(p.wager_tokens, p.payout_multiplier_bps) - p.wager_tokens
        when p.side = 'range' and p_final_count between p.range_min and p.range_max then
          public.get_prediction_gross_payout_tokens(p.wager_tokens, p.payout_multiplier_bps) - p.wager_tokens
        else -p.wager_tokens
      end,
      resolved_at = now(),
      updated_at = now()
    where p.session_id = p_session_id
      and p.resolved_at is null
    returning
      p.id,
      p.user_id,
      p.wager_tokens,
      p.stake_charged,
      p.was_correct,
      p.token_delta,
      p.payout_multiplier_bps,
      public.get_prediction_gross_payout_tokens(p.wager_tokens, p.payout_multiplier_bps) as gross_payout_tokens
  ),
  ledger_insert as (
    insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
    select
      user_id,
      case
        when was_correct and stake_charged then gross_payout_tokens
        when was_correct and not stake_charged then gross_payout_tokens - wager_tokens
        when not was_correct and not stake_charged then -wager_tokens
        else null
      end,
      case
        when was_correct then 'prediction_win'::public.ledger_reason
        else 'prediction_loss'::public.ledger_reason
      end,
      'prediction',
      id
    from resolved
    where case
      when was_correct and stake_charged then gross_payout_tokens
      when was_correct and not stake_charged then gross_payout_tokens - wager_tokens
      when not was_correct and not stake_charged then -wager_tokens
      else null
    end is not null
  ),
  user_session_outcomes as (
    select
      user_id,
      coalesce(sum(token_delta), 0)::int as net_token_delta
    from resolved
    group by user_id
  ),
  streak_update as (
    insert into public.user_streaks (user_id, prediction_streak)
    select
      user_id,
      case when net_token_delta > 0 then 1 else 0 end
    from user_session_outcomes
    on conflict (user_id) do update
    set
      prediction_streak = case
        when excluded.prediction_streak = 1 then public.user_streaks.prediction_streak + 1
        else 0
      end,
      updated_at = now()
    returning user_id
  )
  select
    count(*)::int,
    coalesce(array_agg(distinct user_id), array[]::uuid[])
  into processed_predictions, v_resolved_user_ids
  from resolved;

  perform public.sync_profile_tier(resolved_user_id)
  from unnest(v_resolved_user_ids) as resolved_users(resolved_user_id);

  perform public.award_user_achievements(resolved_user_id)
  from unnest(v_resolved_user_ids) as resolved_users(resolved_user_id);

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
  with token_totals as (
    select
      tl.user_id,
      coalesce(sum(tl.delta), 0)::int as token_balance
    from public.token_ledger tl
    group by tl.user_id
  ),
  prediction_totals as (
    select
      pr.user_id,
      count(*)::bigint as total_predictions,
      coalesce(sum(case when pr.was_correct then 1 else 0 end), 0)::bigint as correct_predictions
    from public.predictions pr
    group by pr.user_id
  ),
  scored as (
    select
      p.user_id,
      p.display_name,
      coalesce(tt.token_balance, 0)::int as token_balance,
      coalesce(pt.correct_predictions, 0)::bigint as correct_predictions,
      coalesce(pt.total_predictions, 0)::bigint as total_predictions
    from public.profiles p
    left join token_totals tt on tt.user_id = p.user_id
    left join prediction_totals pt on pt.user_id = p.user_id
  )
  select
    row_number() over (
      order by scored.token_balance desc, scored.correct_predictions desc, scored.display_name asc
    ) as rank,
    scored.user_id,
    scored.display_name,
    public.get_tier_for_credits(scored.token_balance) as tier,
    scored.token_balance,
    scored.correct_predictions
  from scored
  order by rank
  limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;

create or replace function public.get_public_profile(p_user_id uuid)
returns table(
  rank bigint,
  user_id uuid,
  display_name text,
  tier text,
  token_balance int,
  correct_predictions bigint,
  total_predictions bigint,
  settled_predictions bigint
)
language sql
security definer
set search_path = public
as $$
  with token_totals as (
    select
      tl.user_id,
      coalesce(sum(tl.delta), 0)::int as token_balance
    from public.token_ledger tl
    group by tl.user_id
  ),
  visible_predictions as (
    select
      pr.user_id,
      pr.was_correct
    from public.predictions pr
    join public.game_sessions gs on gs.id = pr.session_id
    where gs.status <> 'cancelled'
      and not (pr.resolved_at is not null and pr.was_correct is null)
  ),
  prediction_totals as (
    select
      vp.user_id,
      count(*)::bigint as total_predictions,
      count(*) filter (where vp.was_correct is not null)::bigint as settled_predictions,
      coalesce(sum(case when vp.was_correct then 1 else 0 end), 0)::bigint as correct_predictions
    from visible_predictions vp
    group by vp.user_id
  ),
  scored as (
    select
      p.user_id,
      p.display_name,
      coalesce(tt.token_balance, 0)::int as token_balance,
      coalesce(pt.correct_predictions, 0)::bigint as correct_predictions,
      coalesce(pt.total_predictions, 0)::bigint as total_predictions,
      coalesce(pt.settled_predictions, 0)::bigint as settled_predictions
    from public.profiles p
    left join token_totals tt on tt.user_id = p.user_id
    left join prediction_totals pt on pt.user_id = p.user_id
  ),
  ranked as (
    select
      row_number() over (
        order by scored.token_balance desc, scored.correct_predictions desc, scored.display_name asc
      ) as rank,
      scored.user_id,
      scored.display_name,
      scored.token_balance,
      scored.correct_predictions,
      scored.total_predictions,
      scored.settled_predictions
    from scored
  )
  select
    ranked.rank,
    ranked.user_id,
    ranked.display_name,
    public.get_tier_for_credits(ranked.token_balance) as tier,
    ranked.token_balance,
    ranked.correct_predictions,
    ranked.total_predictions,
    ranked.settled_predictions
  from ranked
  where ranked.user_id = p_user_id;
$$;

do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select p.user_id
    from public.profiles p
  loop
    perform public.sync_profile_tier(v_user_id);
    perform public.award_user_achievements(v_user_id);
  end loop;
end;
$$;

revoke all on function public.claim_daily_login() from public, anon, authenticated;
revoke all on function public.place_prediction(uuid, public.prediction_side, int, int, int, int) from public, anon, authenticated;
revoke all on function public.resolve_session(uuid, int) from public, anon, authenticated;
revoke all on function public.get_leaderboard(int) from public, anon, authenticated;
revoke all on function public.get_public_profile(uuid) from public, anon, authenticated;

grant execute on function public.claim_daily_login() to authenticated;
grant execute on function public.place_prediction(uuid, public.prediction_side, int, int, int, int) to authenticated;
grant execute on function public.resolve_session(uuid, int) to service_role;
grant execute on function public.get_leaderboard(int) to anon, authenticated;
grant execute on function public.get_public_profile(uuid) to anon, authenticated;
