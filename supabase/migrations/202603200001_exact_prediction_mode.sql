alter type public.prediction_side add value if not exists 'exact';

alter table public.predictions
  add column if not exists exact_value int check (exact_value is null or exact_value >= 0);
