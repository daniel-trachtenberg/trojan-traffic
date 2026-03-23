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
      p.tier,
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
    scored.tier,
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
  prediction_totals as (
    select
      pr.user_id,
      count(*)::bigint as total_predictions,
      count(*) filter (where pr.was_correct is not null)::bigint as settled_predictions,
      coalesce(sum(case when pr.was_correct then 1 else 0 end), 0)::bigint as correct_predictions
    from public.predictions pr
    group by pr.user_id
  ),
  scored as (
    select
      p.user_id,
      p.display_name,
      p.tier,
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
      scored.tier,
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
    ranked.tier,
    ranked.token_balance,
    ranked.correct_predictions,
    ranked.total_predictions,
    ranked.settled_predictions
  from ranked
  where ranked.user_id = p_user_id;
$$;

create or replace function public.get_public_prediction_history(
  p_user_id uuid,
  p_limit int default 40
)
returns table(
  id uuid,
  session_id uuid,
  side public.prediction_side,
  wager_tokens int,
  payout_multiplier_bps int,
  exact_value int,
  range_min int,
  range_max int,
  was_correct boolean,
  token_delta int,
  resolved_at timestamptz,
  placed_at timestamptz,
  mode_seconds int,
  threshold int,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.session_status,
  final_count int,
  session_resolved_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    pr.id,
    pr.session_id,
    pr.side,
    pr.wager_tokens,
    pr.payout_multiplier_bps,
    pr.exact_value,
    pr.range_min,
    pr.range_max,
    pr.was_correct,
    pr.token_delta,
    pr.resolved_at,
    pr.placed_at,
    gs.mode_seconds,
    gs.threshold,
    gs.starts_at,
    gs.ends_at,
    gs.status,
    gs.final_count,
    gs.resolved_at as session_resolved_at
  from public.predictions pr
  join public.game_sessions gs on gs.id = pr.session_id
  where pr.user_id = p_user_id
  order by pr.placed_at desc
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

revoke all on function public.get_leaderboard(int) from public, anon, authenticated;
revoke all on function public.get_public_profile(uuid) from public, anon, authenticated;
revoke all on function public.get_public_prediction_history(uuid, int) from public, anon, authenticated;

grant execute on function public.get_leaderboard(int) to anon, authenticated;
grant execute on function public.get_public_profile(uuid) to anon, authenticated;
grant execute on function public.get_public_prediction_history(uuid, int) to anon, authenticated;
