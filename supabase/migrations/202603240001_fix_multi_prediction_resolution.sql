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
  )
  select count(*)
  into processed_predictions
  from resolved;

  return query
  select processed_predictions;
end;
$$;
