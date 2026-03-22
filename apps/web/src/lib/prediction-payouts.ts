const OVER_UNDER_PAYOUT_MULTIPLIER_BPS = 19091;
const EXACT_PAYOUT_MULTIPLIER_BPS = 60000;
const MIN_RANGE_PAYOUT_MULTIPLIER_BPS = 11000;

export type PredictionPricingSide = "over" | "under" | "exact" | "range";

export function getRangeWidth(rangeMin: number | null, rangeMax: number | null) {
  if (rangeMin === null || rangeMax === null || rangeMax < rangeMin) {
    return null;
  }

  return rangeMax - rangeMin + 1;
}

// Keep this in sync with the database helper in 202603210001_prediction_mode_pricing.sql.
export function getPredictionPayoutMultiplierBps(
  side: PredictionPricingSide,
  rangeMin: number | null = null,
  rangeMax: number | null = null
) {
  if (side === "over" || side === "under") {
    return OVER_UNDER_PAYOUT_MULTIPLIER_BPS;
  }

  if (side === "exact") {
    return EXACT_PAYOUT_MULTIPLIER_BPS;
  }

  const rangeWidth = getRangeWidth(rangeMin, rangeMax);
  if (rangeWidth === null) {
    return null;
  }

  return Math.max(MIN_RANGE_PAYOUT_MULTIPLIER_BPS, Math.ceil(EXACT_PAYOUT_MULTIPLIER_BPS / rangeWidth));
}

export function formatPayoutMultiplier(multiplierBps: number | null) {
  if (multiplierBps === null) {
    return "--";
  }

  return `${(multiplierBps / 10000).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}x`;
}

export function getPredictionGrossPayoutTokens(wagerTokens: number, multiplierBps: number | null) {
  if (!Number.isFinite(wagerTokens) || wagerTokens <= 0 || multiplierBps === null) {
    return null;
  }

  return Math.max(wagerTokens, Math.round((wagerTokens * multiplierBps) / 10000));
}

export function getPredictionNetWinTokens(wagerTokens: number, multiplierBps: number | null) {
  const grossPayoutTokens = getPredictionGrossPayoutTokens(wagerTokens, multiplierBps);
  if (grossPayoutTokens === null) {
    return null;
  }

  return grossPayoutTokens - wagerTokens;
}
