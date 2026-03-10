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
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_wager_tokens <= 0 then
    raise exception 'Wager must be greater than zero.';
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

  insert into public.predictions (session_id, user_id, side, wager_tokens, stake_charged)
  values (p_session_id, v_user_id, p_side, p_wager_tokens, true)
  returning id into prediction_id;

  insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
  values (v_user_id, -p_wager_tokens, 'prediction_wager', 'prediction', prediction_id);

  available_tokens := (v_balance - p_wager_tokens);
  return next;
end;
$$;
