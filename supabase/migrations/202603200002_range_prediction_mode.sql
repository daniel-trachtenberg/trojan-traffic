alter type public.prediction_side add value if not exists 'range';

alter table public.predictions
  add column if not exists range_min int check (range_min is null or range_min >= 0),
  add column if not exists range_max int check (range_max is null or range_max >= 0);
