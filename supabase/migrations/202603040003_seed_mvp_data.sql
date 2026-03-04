insert into public.achievements (slug, name, description, criteria)
values
  (
    'first-prediction',
    'First Prediction',
    'Place your first over/under prediction.',
    '{"type":"prediction_count","minimum":1}'::jsonb
  ),
  (
    'streak-7',
    'Seven Day Streak',
    'Claim daily login rewards for seven consecutive days.',
    '{"type":"login_streak","minimum":7}'::jsonb
  ),
  (
    'hot-hand-5',
    'Hot Hand',
    'Win five predictions in a row.',
    '{"type":"prediction_streak","minimum":5}'::jsonb
  )
on conflict (slug) do nothing;

with existing_upcoming as (
  select count(*)::int as count
  from public.game_sessions
  where starts_at >= now()
    and starts_at <= now() + interval '6 hours'
),
generated as (
  select
    gs as slot,
    date_trunc('minute', now()) + interval '2 minutes' + ((gs - 1) * interval '3 minutes') as starts_at
  from generate_series(1, 24) gs
)
insert into public.game_sessions (
  mode_seconds,
  threshold,
  starts_at,
  ends_at,
  status,
  camera_feed_url,
  region_polygon
)
select
  case when generated.slot % 2 = 0 then 60 else 30 end as mode_seconds,
  case
    when generated.slot % 2 = 0 then 9 + (generated.slot % 4)
    else 5 + (generated.slot % 4)
  end as threshold,
  generated.starts_at,
  generated.starts_at + make_interval(secs => case when generated.slot % 2 = 0 then 60 else 30 end),
  'scheduled'::public.session_status,
  'https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8',
  jsonb_build_array(
    jsonb_build_object('x', 0.08 + ((generated.slot % 4) * 0.04), 'y', 0.18 + ((generated.slot % 3) * 0.04)),
    jsonb_build_object('x', 0.32 + ((generated.slot % 4) * 0.04), 'y', 0.18 + ((generated.slot % 3) * 0.04)),
    jsonb_build_object('x', 0.32 + ((generated.slot % 4) * 0.04), 'y', 0.52 + ((generated.slot % 3) * 0.04)),
    jsonb_build_object('x', 0.08 + ((generated.slot % 4) * 0.04), 'y', 0.52 + ((generated.slot % 3) * 0.04))
  )
from generated
where (select count from existing_upcoming) = 0;
