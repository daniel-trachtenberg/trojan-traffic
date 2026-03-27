create or replace function public.suggest_anon_display_name()
returns text
language sql
security definer
set search_path = public
as $$
  select
    'anon#' || (
      coalesce(
        max(
          case
            when p.display_name ~* '^anon#([0-9]+)$'
              then (regexp_match(p.display_name, '^anon#([0-9]+)$', 'i'))[1]::int
            else null
          end
        ),
        0
      ) + 1
    )::text
  from public.profiles p;
$$;

revoke all on function public.suggest_anon_display_name() from public, anon, authenticated;
grant execute on function public.suggest_anon_display_name() to anon, authenticated;
