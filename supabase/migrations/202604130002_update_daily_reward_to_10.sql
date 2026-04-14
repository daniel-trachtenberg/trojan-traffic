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

  select coalesce(sum(delta), 0)::int
  into token_balance
  from public.token_ledger
  where user_id = v_user_id;

  tokens_awarded := v_tokens_awarded;
  login_streak := v_new_streak;
  return next;
end;
$$;
