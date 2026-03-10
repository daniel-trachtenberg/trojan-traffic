alter type public.ledger_reason add value if not exists 'prediction_wager';
alter type public.ledger_reason add value if not exists 'prediction_refund';

alter table public.predictions
  add column if not exists stake_charged boolean not null default false;

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

create or replace function public.admin_cancel_game_session(p_session_id uuid)
returns table(processed_predictions int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.game_sessions%rowtype;
begin
  if v_user_id is null or not public.is_admin(v_user_id) then
    raise exception 'Admin permissions required.';
  end if;

  select *
  into v_session
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Session not found.';
  end if;

  if v_session.status = 'resolved' then
    raise exception 'Resolved sessions cannot be cancelled.';
  end if;

  if v_session.status = 'cancelled' then
    processed_predictions := 0;
    return next;
    return;
  end if;

  update public.game_sessions
  set
    status = 'cancelled',
    final_count = null,
    resolved_at = now(),
    updated_at = now()
  where id = p_session_id;

  with cancelled as (
    update public.predictions p
    set
      was_correct = null,
      token_delta = 0,
      resolved_at = now(),
      updated_at = now()
    where p.session_id = p_session_id
      and p.resolved_at is null
    returning
      p.id,
      p.user_id,
      p.wager_tokens,
      p.stake_charged
  ),
  refund_insert as (
    insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
    select
      user_id,
      wager_tokens,
      'prediction_refund'::public.ledger_reason,
      'prediction',
      id
    from cancelled
    where stake_charged
  )
  select count(*)
  into processed_predictions
  from cancelled;

  return next;
end;
$$;
