alter table public.predictions
  drop constraint if exists predictions_exact_value_consistency;

alter table public.predictions
  drop constraint if exists predictions_prediction_value_consistency;

alter table public.predictions
  add constraint predictions_prediction_value_consistency
  check (
    (
      side in ('over', 'under')
      and exact_value is null
      and range_min is null
      and range_max is null
    )
    or (
      side = 'exact'
      and exact_value is not null
      and range_min is null
      and range_max is null
    )
    or (
      side = 'range'
      and exact_value is null
      and range_min is not null
      and range_max is not null
      and range_min <= range_max
    )
  );

drop function if exists public.place_prediction(uuid, public.prediction_side, int);
drop function if exists public.place_prediction(uuid, public.prediction_side, int, int);
drop function if exists public.place_prediction(uuid, public.prediction_side, int, int, int, int);

create function public.place_prediction(
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

  if v_balance < p_wager_tokens then
    raise exception 'Insufficient token balance.';
  end if;

  insert into public.predictions (
    session_id,
    user_id,
    side,
    wager_tokens,
    stake_charged,
    exact_value,
    range_min,
    range_max
  )
  values (
    p_session_id,
    v_user_id,
    p_side,
    p_wager_tokens,
    true,
    case when p_side = 'exact' then p_exact_value else null end,
    case when p_side = 'range' then p_range_min else null end,
    case when p_side = 'range' then p_range_max else null end
  )
  returning id into prediction_id;

  insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
  values (v_user_id, -p_wager_tokens, 'prediction_wager', 'prediction', prediction_id);

  available_tokens := (v_balance - p_wager_tokens);
  return next;
end;
$$;

revoke all on function public.place_prediction(uuid, public.prediction_side, int, int, int, int)
from public, anon, authenticated;

grant execute on function public.place_prediction(uuid, public.prediction_side, int, int, int, int)
to authenticated;

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
        when p.side = 'under' then p_final_count < v_session.threshold
        when p.side = 'exact' then p_final_count = p.exact_value
        when p.side = 'range' then p_final_count between p.range_min and p.range_max
        else false
      end,
      token_delta = case
        when p.side = 'over' and p_final_count > v_session.threshold then p.wager_tokens
        when p.side = 'under' and p_final_count < v_session.threshold then p.wager_tokens
        when p.side = 'exact' and p_final_count = p.exact_value then p.wager_tokens
        when p.side = 'range' and p_final_count between p.range_min and p.range_max then p.wager_tokens
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
      p.was_correct
  ),
  ledger_insert as (
    insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
    select
      user_id,
      case
        when was_correct and stake_charged then wager_tokens * 2
        when was_correct and not stake_charged then wager_tokens
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
      when was_correct and stake_charged then wager_tokens * 2
      when was_correct and not stake_charged then wager_tokens
      when not was_correct and not stake_charged then -wager_tokens
      else null
    end is not null
  ),
  streak_update as (
    insert into public.user_streaks (user_id, prediction_streak)
    select
      user_id,
      case when was_correct then 1 else 0 end
    from resolved
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
  from resolved;

  return query
  select processed_predictions;
end;
$$;
