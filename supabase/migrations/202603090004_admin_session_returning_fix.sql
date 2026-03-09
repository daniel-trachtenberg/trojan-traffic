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

  if coalesce(jsonb_typeof(p_region_polygon), '') <> 'array' or jsonb_array_length(p_region_polygon) < 3 then
    raise exception 'Region polygon must contain at least three points.';
  end if;

  insert into public.game_sessions as gs (
    mode_seconds,
    threshold,
    starts_at,
    ends_at,
    status,
    camera_feed_url,
    region_polygon,
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

  if coalesce(jsonb_typeof(p_region_polygon), '') <> 'array' or jsonb_array_length(p_region_polygon) < 3 then
    raise exception 'Region polygon must contain at least three points.';
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
    from public.predictions
    where session_id = p_session_id
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
    updated_at = now()
  where gs.id = p_session_id
  returning gs.id, gs.ends_at
  into session_id, v_session_ends_at;

  ends_at := v_session_ends_at;
  return next;
end;
$$;
