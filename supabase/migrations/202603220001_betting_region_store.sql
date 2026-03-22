create table if not exists public.betting_regions (
  id smallint primary key default 1 check (id = 1),
  points jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  check (
    jsonb_typeof(points) = 'array'
    and jsonb_array_length(points) = 4
  )
);

alter table public.betting_regions enable row level security;

drop policy if exists "betting_regions_public_read" on public.betting_regions;
create policy "betting_regions_public_read"
  on public.betting_regions for select
  to anon, authenticated
  using (true);

drop policy if exists "betting_regions_admin_insert" on public.betting_regions;
create policy "betting_regions_admin_insert"
  on public.betting_regions for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.admin_users au
      where au.user_id = auth.uid()
    )
  );

drop policy if exists "betting_regions_admin_update" on public.betting_regions;
create policy "betting_regions_admin_update"
  on public.betting_regions for update
  to authenticated
  using (
    exists (
      select 1
      from public.admin_users au
      where au.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.admin_users au
      where au.user_id = auth.uid()
    )
  );

create or replace function public.set_betting_region_metadata()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists betting_regions_set_metadata on public.betting_regions;
create trigger betting_regions_set_metadata
before insert or update on public.betting_regions
for each row
execute function public.set_betting_region_metadata();

insert into public.betting_regions (id, points)
values (
  1,
  jsonb_build_array(
    jsonb_build_object('x', 0.7672, 'y', 0.4928),
    jsonb_build_object('x', 0.8643, 'y', 0.5085),
    jsonb_build_object('x', 0.8865, 'y', 0.5816),
    jsonb_build_object('x', 0.7763, 'y', 0.5608)
  )
)
on conflict (id) do nothing;
