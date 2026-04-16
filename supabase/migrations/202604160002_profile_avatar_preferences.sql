alter table public.profiles
  add column if not exists preferred_mode_seconds int,
  add column if not exists avatar_type text,
  add column if not exists avatar_value text;

update public.profiles
set
  preferred_mode_seconds = coalesce(preferred_mode_seconds, 30),
  avatar_type = coalesce(avatar_type, 'icon'),
  avatar_value = coalesce(nullif(trim(avatar_value), ''), 'signal');

alter table public.profiles
  alter column preferred_mode_seconds set default 30,
  alter column preferred_mode_seconds set not null,
  alter column avatar_type set default 'icon',
  alter column avatar_type set not null,
  alter column avatar_value set default 'signal',
  alter column avatar_value set not null;

alter table public.profiles
  drop constraint if exists profiles_preferred_mode_seconds_check;

alter table public.profiles
  add constraint profiles_preferred_mode_seconds_check
  check (preferred_mode_seconds in (30, 60));

alter table public.profiles
  drop constraint if exists profiles_avatar_type_check;

alter table public.profiles
  add constraint profiles_avatar_type_check
  check (avatar_type in ('icon', 'upload'));
