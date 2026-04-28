alter table public.game_sessions
  add column if not exists live_count int not null default 0
  check (live_count >= 0);

update public.game_sessions
set live_count = coalesce(final_count, live_count, 0)
where status = 'resolved'
  and final_count is not null;

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
  )
  select count(*)
  into processed_predictions
  from resolved;

  return query
  select processed_predictions;
end;
$$;

create or replace function public.admin_create_game_session(
  p_mode_seconds int,
  p_threshold int,
  p_starts_at timestamptz,
  p_camera_feed_url text,
  p_region_polygon jsonb
)
returns table(session_id uuid, ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_ends_at timestamptz;
begin
  if v_user_id is null or not public.is_admin(v_user_id) then
    raise exception 'Admin permissions required.';
  end if;

  if p_mode_seconds not in (30, 60) then
    raise exception 'Mode must be 30 or 60 seconds.';
  end if;

  if p_threshold <= 0 then
    raise exception 'Threshold must be greater than zero.';
  end if;

  if p_starts_at <= now() then
    raise exception 'Session start time must be in the future.';
  end if;

  if coalesce(length(trim(p_camera_feed_url)), 0) = 0 then
    raise exception 'Camera feed URL is required.';
  end if;

  if coalesce(jsonb_typeof(p_region_polygon), '') <> 'array' or jsonb_array_length(p_region_polygon) < 2 then
    raise exception 'Region must contain at least two points.';
  end if;

  insert into public.game_sessions as gs (
    mode_seconds,
    threshold,
    starts_at,
    ends_at,
    status,
    camera_feed_url,
    region_polygon,
    live_count,
    created_by
  )
  values (
    p_mode_seconds,
    p_threshold,
    p_starts_at,
    p_starts_at + make_interval(secs => p_mode_seconds),
    'scheduled',
    trim(p_camera_feed_url),
    p_region_polygon,
    0,
    v_user_id
  )
  returning gs.id, gs.ends_at
  into session_id, v_session_ends_at;

  ends_at := v_session_ends_at;
  return next;
end;
$$;

create or replace function public.admin_update_game_session(
  p_session_id uuid,
  p_mode_seconds int,
  p_threshold int,
  p_starts_at timestamptz,
  p_camera_feed_url text,
  p_region_polygon jsonb
)
returns table(session_id uuid, ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.game_sessions%rowtype;
  v_session_ends_at timestamptz;
begin
  if v_user_id is null or not public.is_admin(v_user_id) then
    raise exception 'Admin permissions required.';
  end if;

  if p_mode_seconds not in (30, 60) then
    raise exception 'Mode must be 30 or 60 seconds.';
  end if;

  if p_threshold <= 0 then
    raise exception 'Threshold must be greater than zero.';
  end if;

  if p_starts_at <= now() then
    raise exception 'Session start time must be in the future.';
  end if;

  if coalesce(length(trim(p_camera_feed_url)), 0) = 0 then
    raise exception 'Camera feed URL is required.';
  end if;

  if coalesce(jsonb_typeof(p_region_polygon), '') <> 'array' or jsonb_array_length(p_region_polygon) < 2 then
    raise exception 'Region must contain at least two points.';
  end if;

  select *
  into v_session
  from public.game_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Session not found.';
  end if;

  if v_session.status in ('resolved', 'cancelled') then
    raise exception 'Closed sessions cannot be edited.';
  end if;

  if now() >= v_session.starts_at then
    raise exception 'Started sessions cannot be edited.';
  end if;

  if exists (
    select 1
    from public.predictions as p
    where p.session_id = p_session_id
    limit 1
  ) then
    raise exception 'Sessions with predictions cannot be edited. Cancel and recreate the session instead.';
  end if;

  update public.game_sessions as gs
  set
    mode_seconds = p_mode_seconds,
    threshold = p_threshold,
    starts_at = p_starts_at,
    ends_at = p_starts_at + make_interval(secs => p_mode_seconds),
    camera_feed_url = trim(p_camera_feed_url),
    region_polygon = p_region_polygon,
    status = 'scheduled',
    live_count = 0,
    updated_at = now()
  where gs.id = p_session_id
  returning gs.id, gs.ends_at
  into session_id, v_session_ends_at;

  ends_at := v_session_ends_at;
  return next;
end;
$$;

drop function if exists public.admin_list_game_sessions(int);

create function public.admin_list_game_sessions(p_limit int default 60)
returns table(
  id uuid,
  mode_seconds int,
  threshold int,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.session_status,
  live_count int,
  final_count int,
  resolved_at timestamptz,
  created_at timestamptz,
  created_by uuid,
  camera_feed_url text,
  region_polygon jsonb,
  prediction_count int,
  open_prediction_count int,
  wager_total int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not public.is_admin(v_user_id) then
    raise exception 'Admin permissions required.';
  end if;

  return query
  select
    gs.id,
    gs.mode_seconds,
    gs.threshold,
    gs.starts_at,
    gs.ends_at,
    gs.status,
    gs.live_count,
    gs.final_count,
    gs.resolved_at,
    gs.created_at,
    gs.created_by,
    gs.camera_feed_url,
    gs.region_polygon,
    count(pr.id)::int as prediction_count,
    count(pr.id) filter (where pr.resolved_at is null)::int as open_prediction_count,
    coalesce(sum(pr.wager_tokens), 0)::int as wager_total
  from public.game_sessions gs
  left join public.predictions pr on pr.session_id = gs.id
  group by
    gs.id,
    gs.mode_seconds,
    gs.threshold,
    gs.starts_at,
    gs.ends_at,
    gs.status,
    gs.live_count,
    gs.final_count,
    gs.resolved_at,
    gs.created_at,
    gs.created_by,
    gs.camera_feed_url,
    gs.region_polygon
  order by gs.starts_at desc
  limit greatest(1, least(p_limit, 200));
end;
$$;

revoke all on function public.admin_list_game_sessions(int) from public, anon, authenticated;
grant execute on function public.admin_list_game_sessions(int) to authenticated;
