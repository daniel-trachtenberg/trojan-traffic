create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(new.email, '@', 1),
      'trojan-player'
    )
  )
  on conflict (user_id) do nothing;

  insert into public.user_streaks (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.token_ledger (user_id, delta, reason, reference_type, reference_id)
  select
    new.id,
    100,
    'signup_bonus'::public.ledger_reason,
    'account_creation',
    new.id
  where not exists (
    select 1
    from public.token_ledger tl
    where tl.user_id = new.id
      and tl.reason = 'signup_bonus'::public.ledger_reason
      and tl.reference_type = 'account_creation'
      and tl.reference_id = new.id
  );

  return new;
end;
$$;
