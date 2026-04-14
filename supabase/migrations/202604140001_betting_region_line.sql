-- Replace the 4-point polygon region with a 2-point line region.

-- Drop the existing check constraint that required exactly 4 points.
alter table public.betting_regions
  drop constraint if exists betting_regions_points_check;

-- Add a new check constraint requiring exactly 2 points (line endpoints).
alter table public.betting_regions
  add constraint betting_regions_points_check check (
    jsonb_typeof(points) = 'array'
    and jsonb_array_length(points) = 2
  );

-- Convert the stored region to 2 points (midpoints of the left and right edges
-- of the previous quadrilateral, spanning the same area).
update public.betting_regions
set points = jsonb_build_array(
  jsonb_build_object('x', 0.7718, 'y', 0.5268),
  jsonb_build_object('x', 0.8754, 'y', 0.5451)
)
where id = 1;

-- Update admin_create_game_session: accept >= 2 points instead of >= 3.
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
  session_id uuid;
  ends_at timestamptz;
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

  insert into public.game_sessions (
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
  returning id, ends_at
  into session_id, ends_at;

  return next;
end;
$$;

-- Update admin_update_game_session: accept >= 2 points instead of >= 3.
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
    from public.predictions
    where session_id = p_session_id
    limit 1
  ) then
    raise exception 'Sessions with predictions cannot be edited. Cancel and recreate the session instead.';
  end if;

  update public.game_sessions
  set
    mode_seconds = p_mode_seconds,
    threshold = p_threshold,
    starts_at = p_starts_at,
    ends_at = p_starts_at + make_interval(secs => p_mode_seconds),
    camera_feed_url = trim(p_camera_feed_url),
    region_polygon = p_region_polygon,
    status = 'scheduled',
    updated_at = now()
  where id = p_session_id
  returning id, ends_at
  into session_id, ends_at;

  return next;
end;
$$;
