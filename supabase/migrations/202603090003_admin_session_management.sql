create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create policy "admin_users_select_own"
  on public.admin_users for select
  using (auth.uid() = user_id);

create or replace function public.is_admin(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1
    from public.admin_users au
    where au.user_id = p_user_id
  );
$$;

create or replace function public.admin_list_game_sessions(p_limit int default 60)
returns table(
  id uuid,
  mode_seconds int,
  threshold int,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.session_status,
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

  update public.predictions
  set
    was_correct = null,
    token_delta = 0,
    resolved_at = now(),
    updated_at = now()
  where session_id = p_session_id
    and resolved_at is null;

  get diagnostics processed_predictions = row_count;

  return next;
end;
$$;

create or replace function public.admin_resolve_game_session(
  p_session_id uuid,
  p_final_count int
)
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

  if now() < v_session.ends_at then
    raise exception 'Session cannot be resolved before it ends.';
  end if;

  return query
  select *
  from public.resolve_session(p_session_id, p_final_count);
end;
$$;

revoke all on function public.is_admin(uuid) from public, anon, authenticated;
revoke all on function public.admin_list_game_sessions(int) from public, anon, authenticated;
revoke all on function public.admin_create_game_session(int, int, timestamptz, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_update_game_session(uuid, int, int, timestamptz, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_cancel_game_session(uuid) from public, anon, authenticated;
revoke all on function public.admin_resolve_game_session(uuid, int) from public, anon, authenticated;

grant execute on function public.admin_list_game_sessions(int) to authenticated;
grant execute on function public.admin_create_game_session(int, int, timestamptz, text, jsonb) to authenticated;
grant execute on function public.admin_update_game_session(uuid, int, int, timestamptz, text, jsonb) to authenticated;
grant execute on function public.admin_cancel_game_session(uuid) to authenticated;
grant execute on function public.admin_resolve_game_session(uuid, int) to authenticated;
