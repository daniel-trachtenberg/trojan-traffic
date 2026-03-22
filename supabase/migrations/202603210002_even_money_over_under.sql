update public.predictions
set payout_multiplier_bps = 20000
where side in ('over', 'under')
  and resolved_at is null
  and payout_multiplier_bps <> 20000;

create or replace function public.get_prediction_payout_multiplier_bps(
  p_side public.prediction_side,
  p_range_min int default null,
  p_range_max int default null
)
returns int
language plpgsql
immutable
as $$
declare
  v_range_width int;
begin
  if p_side in ('over', 'under') then
    return 20000;
  end if;

  if p_side = 'exact' then
    return 60000;
  end if;

  if p_side = 'range' then
    if p_range_min is null or p_range_max is null or p_range_max < p_range_min then
      raise exception 'Range pricing requires a valid minimum and maximum.';
    end if;

    v_range_width := (p_range_max - p_range_min) + 1;
    return greatest(11000, ceil(60000.0 / v_range_width)::int);
  end if;

  raise exception 'Unsupported prediction side: %', p_side;
end;
$$;
