create or replace function public.cancel_prediction(
  p_prediction_id uuid
)
returns table(available_tokens int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_prediction public.predictions%rowtype;
  v_session public.game_sessions%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  select *
  into v_prediction
  from public.predictions
  where id = p_prediction_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Prediction not found.';
  end if;

  if v_prediction.resolved_at is not null then
    raise exception 'This bet is already settled.';
  end if;

  select *
  into v_session
  from public.game_sessions
  where id = v_prediction.session_id
  for update;

  if not found then
    raise exception 'Session not found.';
  end if;

  if v_session.status in ('resolved', 'cancelled') or now() >= v_session.starts_at then
    raise exception 'Bet cancellation is closed for this session.';
  end if;

  if now() < (v_session.starts_at - interval '5 minutes') then
    raise exception 'Bet cancellation is only available during the betting window.';
  end if;

  delete from public.predictions
  where id = v_prediction.id;

  if coalesce(v_prediction.stake_charged, false) then
    insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
    values (v_user_id, v_prediction.wager_tokens, 'prediction_refund', 'prediction', v_prediction.id);
  end if;

  select coalesce(sum(delta), 0)::int
  into available_tokens
  from public.token_ledger
  where user_id = v_user_id;

  return next;
end;
$$;

revoke all on function public.cancel_prediction(uuid) from public, anon, authenticated;
grant execute on function public.cancel_prediction(uuid) to authenticated;
