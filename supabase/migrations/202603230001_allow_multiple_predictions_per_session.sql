alter table public.predictions
  drop constraint if exists predictions_session_id_user_id_key;

create index if not exists predictions_session_user_idx
  on public.predictions(session_id, user_id, placed_at desc);

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

  available_tokens := (v_balance - p_wager_tokens);
  return next;
end;
$$;
