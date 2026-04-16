alter table public.profiles
  add column if not exists preferred_mode_seconds int not null default 30;

alter table public.profiles
  drop constraint if exists profiles_preferred_mode_seconds_check;

alter table public.profiles
  add constraint profiles_preferred_mode_seconds_check
  check (preferred_mode_seconds in (30, 60));
