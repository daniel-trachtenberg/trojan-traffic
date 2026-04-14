"use client";

import NextImage from "next/image";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useEffect, useId, useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { AdminConsole } from "@/components/admin-console";
import { LiveFeed } from "@/components/live-feed";
import {
  bettingRegionsEqual,
  normalizeBettingRegion,
  type RegionPoint
} from "@/lib/betting-region";
import {
  formatPayoutMultiplier,
  getPredictionGrossPayoutTokens,
  getPredictionPayoutMultiplierBps
} from "@/lib/prediction-payouts";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";

type PredictionSide = "over" | "under" | "exact" | "range";
type AuthMode = "sign-in" | "sign-up" | "forgot-password";

type SessionState = "upcoming" | "open" | "live" | "resolving" | "resolved" | "cancelled";

type SessionRow = {
  id: string;
  mode_seconds: number;
  threshold: number;
  starts_at: string;
  ends_at: string;
  status: string;
  final_count: number | null;
  resolved_at: string | null;
};

type PredictionRow = {
  id: string;
  session_id: string;
  side: PredictionSide;
  wager_tokens: number;
  payout_multiplier_bps: number | null;
  exact_value: number | null;
  range_min: number | null;
  range_max: number | null;
  was_correct: boolean | null;
  token_delta: number | null;
  resolved_at: string | null;
  placed_at: string;
};

type LeaderboardRow = {
  rank: number;
  user_id: string;
  display_name: string;
  tier: string;
  token_balance: number;
  correct_predictions: number;
};

type ProfileAvatarType = "icon" | "upload";
type BuiltInProfileAvatarId = "signal" | "victory" | "shield" | "spark" | "laurel";
type PreferredModeSeconds = 30 | 60;
type AchievementCategory = "skill" | "accomplishment" | "participation";

type ProfileRow = {
  display_name: string;
  tier: string;
  created_at: string | null;
  preferred_mode_seconds: number | null;
  avatar_type: ProfileAvatarType | null;
  avatar_value: string | null;
};

type AchievementCriteria = {
  type?: string;
  minimum?: number;
};

type AchievementRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  criteria: AchievementCriteria | null;
};

type UserAchievementRow = {
  achievement_id: string;
  awarded_at: string;
};

type ProfileSettingsFormState = {
  displayName: string;
  preferredModeSeconds: PreferredModeSeconds;
  avatarType: ProfileAvatarType;
  avatarValue: string;
};

type PublicProfileSummaryRow = {
  rank: number;
  user_id: string;
  display_name: string;
  tier: string;
  token_balance: number;
  correct_predictions: number;
  total_predictions: number;
  settled_predictions: number;
};

type PublicPredictionHistoryRow = PredictionRow & {
  mode_seconds: number;
  threshold: number;
  starts_at: string;
  ends_at: string;
  status: string;
  final_count: number | null;
  session_resolved_at: string | null;
};

type StreakRow = {
  login_streak: number;
  prediction_streak: number;
  last_login_date: string | null;
};

type BalanceRow = {
  token_balance: number;
};

type AdminRow = {
  user_id: string;
};

type PublicProfileContext = {
  user_id: string;
  display_name: string;
  tier: string;
  rank: number | null;
};

type MvpDashboardProps = {
  hlsUrl: string;
  initialRegion: RegionPoint[];
  visionApiUrl?: string;
};

type ToastTone = "success" | "error" | "warning";

type ToastRecord = {
  id: number;
  tone: ToastTone;
  message: string;
  dedupeKey?: string;
};

type StandbyMetaItem = {
  label: string;
  value: string;
};

type AccountOverviewStat = {
  label: string;
  value: string;
  note: string;
};

type AccountProfileStat = AccountOverviewStat & {
  tone?: "gold" | "cardinal" | "slate";
};

type PredictionHistoryTone = "win" | "loss" | "pending" | "cancelled";
type PredictionHistoryFilter = "all" | "live" | "settled";
type SpotlightCardTone = "gold" | "sky" | "emerald" | "rose";

type SpotlightCardRecord = {
  label: string;
  value: string;
  note: string;
  tone: SpotlightCardTone;
};

const DEFAULT_WAGER = "10";
const DEFAULT_EXACT_VALUE = "5";
const DEFAULT_STANDBY_THRESHOLD = 5;
const HUMAN_OVERLAY_PREVIEW_ENABLED = false;
const BETTING_OPEN_WINDOW_MS = 5 * 60 * 1000;
const DAILY_CLAIM_TIMEZONE = "America/Los_Angeles";
const DAILY_CLAIM_START_HOUR = 8;
const DEFAULT_TOAST_DURATION_MS = 5000;
const SUCCESS_TOAST_DURATION_MS = 4200;
const ERROR_TOAST_DURATION_MS = 6200;
const MAX_VISIBLE_TOASTS = 4;
const RESULT_SPOTLIGHT_WINDOW_MS = 10_000;
const SESSION_SELECT_COLUMNS = "id,mode_seconds,threshold,starts_at,ends_at,status,final_count,resolved_at";
const DEFAULT_PROFILE_AVATAR_ID: BuiltInProfileAvatarId = "signal";
const DEFAULT_PREFERRED_MODE_SECONDS: PreferredModeSeconds = 30;
const MAX_PROFILE_AVATAR_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_PROFILE_AVATAR_DATA_URL_LENGTH = 180_000;
const PROFILE_PREVIEW_EMAIL = "traffic.trojan@usc.edu";
const PROFILE_PREVIEW_TOKEN_BALANCE = 480;
const BUILT_IN_PROFILE_AVATARS = [
  {
    id: "signal",
    label: "Signal",
    startColor: "#ffcf44",
    endColor: "#7f0f19",
    rimColor: "rgb(255 229 148 / 46%)"
  },
  {
    id: "victory",
    label: "Victory",
    startColor: "#ffd56b",
    endColor: "#9f2518",
    rimColor: "rgb(255 222 125 / 44%)"
  },
  {
    id: "shield",
    label: "Shield",
    startColor: "#f7b34f",
    endColor: "#702447",
    rimColor: "rgb(255 214 133 / 42%)"
  },
  {
    id: "spark",
    label: "Spark",
    startColor: "#ffe29b",
    endColor: "#6e0d24",
    rimColor: "rgb(255 238 186 / 44%)"
  },
  {
    id: "laurel",
    label: "Laurel",
    startColor: "#f7d36a",
    endColor: "#5d1928",
    rimColor: "rgb(255 222 131 / 42%)"
  }
] as const satisfies ReadonlyArray<{
  id: BuiltInProfileAvatarId;
  label: string;
  startColor: string;
  endColor: string;
  rimColor: string;
}>;
const SCREEN_CONFETTI_COLORS = ["#ffcc00", "#f8fafc", "#f59e0b", "#ef4444", "#22c55e", "#60a5fa"];
const SCREEN_CONFETTI_PIECES = Array.from({ length: 120 }, (_, index) => ({
  left: `${(((index * 73) % 1000) / 10).toFixed(1)}%`,
  delayMs: (index % 12) * 110,
  durationMs: 2600 + (index % 7) * 220 + Math.floor(index / 12) * 80,
  color: SCREEN_CONFETTI_COLORS[index % SCREEN_CONFETTI_COLORS.length],
  widthRem: 0.28 + ((index * 11) % 5) * 0.08,
  heightRem: 0.72 + ((index * 17) % 7) * 0.14
}));
const DAILY_CLAIM_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: DAILY_CLAIM_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
const PROFILE_PREVIEW_HISTORY_SESSIONS: SessionRow[] = [
  {
    id: "preview-session-win",
    mode_seconds: 30,
    threshold: 5,
    starts_at: "2026-04-10T18:00:00.000Z",
    ends_at: "2026-04-10T18:00:30.000Z",
    status: "resolved",
    final_count: 7,
    resolved_at: "2026-04-10T18:00:40.000Z"
  },
  {
    id: "preview-session-loss",
    mode_seconds: 60,
    threshold: 10,
    starts_at: "2026-04-11T19:15:00.000Z",
    ends_at: "2026-04-11T19:16:00.000Z",
    status: "resolved",
    final_count: 8,
    resolved_at: "2026-04-11T19:16:12.000Z"
  },
  {
    id: "preview-session-open",
    mode_seconds: 30,
    threshold: 6,
    starts_at: "2026-04-13T23:30:00.000Z",
    ends_at: "2026-04-13T23:30:30.000Z",
    status: "scheduled",
    final_count: null,
    resolved_at: null
  }
];
const PROFILE_PREVIEW_PROFILE: ProfileRow = {
  display_name: "TommyTraffic",
  tier: "Gold",
  created_at: "2026-03-04T17:15:00.000Z",
  preferred_mode_seconds: 60,
  avatar_type: "icon",
  avatar_value: DEFAULT_PROFILE_AVATAR_ID
};
const PROFILE_PREVIEW_STREAKS: StreakRow = {
  login_streak: 4,
  prediction_streak: 3,
  last_login_date: "2026-04-13"
};
const PROFILE_PREVIEW_PREDICTIONS: PredictionRow[] = [
  {
    id: "preview-prediction-pending",
    session_id: "preview-session-open",
    side: "range",
    wager_tokens: 24,
    payout_multiplier_bps: 20000,
    exact_value: null,
    range_min: 5,
    range_max: 7,
    was_correct: null,
    token_delta: null,
    resolved_at: null,
    placed_at: "2026-04-13T23:27:00.000Z"
  },
  {
    id: "preview-prediction-loss",
    session_id: "preview-session-loss",
    side: "exact",
    wager_tokens: 18,
    payout_multiplier_bps: 60000,
    exact_value: 10,
    range_min: null,
    range_max: null,
    was_correct: false,
    token_delta: -18,
    resolved_at: "2026-04-11T19:16:12.000Z",
    placed_at: "2026-04-11T19:12:00.000Z"
  },
  {
    id: "preview-prediction-win",
    session_id: "preview-session-win",
    side: "over",
    wager_tokens: 20,
    payout_multiplier_bps: 20000,
    exact_value: null,
    range_min: null,
    range_max: null,
    was_correct: true,
    token_delta: 20,
    resolved_at: "2026-04-10T18:00:40.000Z",
    placed_at: "2026-04-10T17:58:00.000Z"
  }
];
const PROFILE_PREVIEW_ACHIEVEMENTS: AchievementRow[] = [
  {
    id: "preview-achievement-first",
    slug: "first-prediction",
    name: "First Prediction",
    description: "Place your first over/under prediction.",
    criteria: { type: "prediction_count", minimum: 1 }
  },
  {
    id: "preview-achievement-streak",
    slug: "streak-7",
    name: "Seven Day Streak",
    description: "Claim daily login rewards for seven consecutive days.",
    criteria: { type: "login_streak", minimum: 7 }
  },
  {
    id: "preview-achievement-hot-hand",
    slug: "hot-hand-5",
    name: "Hot Hand",
    description: "Win five predictions in a row.",
    criteria: { type: "prediction_streak", minimum: 5 }
  }
];
const PROFILE_PREVIEW_USER_ACHIEVEMENTS: UserAchievementRow[] = [
  {
    achievement_id: "preview-achievement-first",
    awarded_at: "2026-03-04T17:18:00.000Z"
  }
];

function getDailyClaimClockParts(timestampMs: number) {
  const formattedParts = DAILY_CLAIM_CLOCK_FORMATTER.formatToParts(new Date(timestampMs));
  const year = formattedParts.find((part) => part.type === "year")?.value ?? "0000";
  const month = formattedParts.find((part) => part.type === "month")?.value ?? "00";
  const day = formattedParts.find((part) => part.type === "day")?.value ?? "00";
  const hour = Number.parseInt(
    formattedParts.find((part) => part.type === "hour")?.value ?? "0",
    10
  );

  return {
    claimDate: `${year}-${month}-${day}`,
    claimHour: Number.isNaN(hour) ? 0 : hour
  };
}

function getDailyClaimState(lastLoginDate: string | null, timestampMs: number) {
  const { claimDate, claimHour } = getDailyClaimClockParts(timestampMs);

  if (lastLoginDate === claimDate) {
    return {
      canClaim: false,
      hasClaimedToday: true,
      detail: "Can't claim right now. Try again after 8:00 AM PT tomorrow."
    };
  }

  if (claimHour < DAILY_CLAIM_START_HOUR) {
    return {
      canClaim: false,
      hasClaimedToday: false,
      detail: "Daily reward becomes available at 8:00 AM PT."
    };
  }

  return {
    canClaim: true,
    hasClaimedToday: false,
    detail: "Daily reward is ready to claim."
  };
}

function formatCountdown(milliseconds: number) {
  const safeMilliseconds = Math.max(milliseconds, 0);
  const totalSeconds = Math.floor(safeMilliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function getDefaultRangeMin(threshold: number) {
  return String(Math.max(0, threshold - 1));
}

function getDefaultRangeMax(threshold: number) {
  return String(threshold + 1);
}

function formatReadableDuration(milliseconds: number) {
  const safeMilliseconds = Math.max(milliseconds, 0);
  const totalMinutes = Math.floor(safeMilliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  if (totalMinutes > 0) {
    return `${totalMinutes}m`;
  }

  return "<1m";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function interpolate(start: number, end: number, ratio: number) {
  return start + (end - start) * clamp(ratio, 0, 1);
}

function getSessionReferenceTime(session: SessionRow) {
  return new Date(session.resolved_at ?? session.ends_at).getTime();
}

function getWinningSide(session: SessionRow): PredictionSide | null {
  if (session.final_count === null) {
    return null;
  }

  if (session.final_count > session.threshold) {
    return "over";
  }

  if (session.final_count < session.threshold) {
    return "under";
  }

  return null;
}

function formatPredictionLabel(prediction: PredictionRow, session: SessionRow | null) {
  if (prediction.side === "exact") {
    return prediction.exact_value !== null ? `EXACT ${prediction.exact_value}` : "EXACT";
  }

  if (prediction.side === "range") {
    if (prediction.range_min !== null && prediction.range_max !== null) {
      return `RANGE ${prediction.range_min}-${prediction.range_max}`;
    }

    return "RANGE";
  }

  if (!session) {
    return prediction.side.toUpperCase();
  }

  return `${prediction.side.toUpperCase()} ${session.threshold}`;
}

function formatPredictionSideTag(side: PredictionSide) {
  if (side === "exact") {
    return "Exact";
  }

  if (side === "range") {
    return "Range";
  }

  if (side === "under") {
    return "Under";
  }

  return "Over";
}

function formatTokenDelta(tokenDelta: number | null) {
  const safeTokenDelta = tokenDelta ?? 0;
  return safeTokenDelta > 0 ? `+${safeTokenDelta}` : `${safeTokenDelta}`;
}

function getStoredPredictionPayoutMultiplierBps(prediction: PredictionRow) {
  return (
    prediction.payout_multiplier_bps ??
    getPredictionPayoutMultiplierBps(prediction.side, prediction.range_min, prediction.range_max) ??
    20000
  );
}

function formatShortDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatShortTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRankLabel(rank: number | null | undefined) {
  return typeof rank === "number" && Number.isFinite(rank) ? `#${rank}` : "--";
}

function isSameLocalCalendarDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatScheduledTimeLabel(value: string | number, referenceMs: number) {
  const timestamp = typeof value === "number" ? value : new Date(value).getTime();

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const targetDate = new Date(timestamp);
  const referenceDate = new Date(referenceMs);

  return isSameLocalCalendarDay(targetDate, referenceDate)
    ? targetDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    : targetDate.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}

function mergeSessionRows(...groups: SessionRow[][]) {
  const mergedSessions = new Map<string, SessionRow>();

  for (const group of groups) {
    for (const session of group) {
      mergedSessions.set(session.id, session);
    }
  }

  return [...mergedSessions.values()].sort(
    (left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime()
  );
}

function getBuiltInProfileAvatar(iconId: string | null | undefined) {
  return (
    BUILT_IN_PROFILE_AVATARS.find((avatar) => avatar.id === iconId) ??
    BUILT_IN_PROFILE_AVATARS.find((avatar) => avatar.id === DEFAULT_PROFILE_AVATAR_ID) ??
    BUILT_IN_PROFILE_AVATARS[0]
  );
}

function normalizePreferredModeSeconds(value: number | null | undefined): PreferredModeSeconds {
  return value === 60 ? 60 : DEFAULT_PREFERRED_MODE_SECONDS;
}

function normalizeProfileAvatarType(value: ProfileAvatarType | null | undefined): ProfileAvatarType {
  return value === "upload" ? "upload" : "icon";
}

function resolveProfileAvatarValue(
  avatarType: ProfileAvatarType | null | undefined,
  avatarValue: string | null | undefined
) {
  if (avatarType === "upload" && avatarValue && avatarValue.startsWith("data:image/")) {
    return avatarValue;
  }

  return getBuiltInProfileAvatar(avatarValue).id;
}

function createProfileSettingsFormState(
  sourceProfile: ProfileRow | null,
  fallbackEmail: string
): ProfileSettingsFormState {
  const trimmedDisplayName = sourceProfile?.display_name?.trim();

  return {
    displayName:
      trimmedDisplayName && trimmedDisplayName.length > 0
        ? trimmedDisplayName
        : fallbackEmail.split("@")[0] ?? "",
    preferredModeSeconds: normalizePreferredModeSeconds(sourceProfile?.preferred_mode_seconds),
    avatarType: normalizeProfileAvatarType(sourceProfile?.avatar_type),
    avatarValue: resolveProfileAvatarValue(sourceProfile?.avatar_type, sourceProfile?.avatar_value)
  };
}

function profileSettingsFormEqual(left: ProfileSettingsFormState, right: ProfileSettingsFormState) {
  return (
    left.displayName === right.displayName &&
    left.preferredModeSeconds === right.preferredModeSeconds &&
    left.avatarType === right.avatarType &&
    left.avatarValue === right.avatarValue
  );
}

function formatJoinDateLabel(value: string | null | undefined) {
  if (!value) {
    return "Recently joined";
  }

  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function getPreferredModeLabel(modeSeconds: number | null | undefined) {
  return `${normalizePreferredModeSeconds(modeSeconds)}s rounds`;
}

function isMissingProfileAvatarColumnsError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) {
    return false;
  }

  const normalizedMessage = (error.message ?? "").toLowerCase();
  return (
    error.code === "PGRST204" &&
    (normalizedMessage.includes("avatar_type") || normalizedMessage.includes("avatar_value"))
  );
}

async function fetchProfileRowWithAvatarFallback(supabase: SupabaseClient, userId: string) {
  const profileResponse = await supabase
    .from("profiles")
    .select("display_name,tier,created_at,preferred_mode_seconds,avatar_type,avatar_value")
    .eq("user_id", userId)
    .maybeSingle();

  if (!isMissingProfileAvatarColumnsError(profileResponse.error)) {
    return profileResponse;
  }

  const legacyProfileResponse = await supabase
    .from("profiles")
    .select("display_name,tier,created_at,preferred_mode_seconds")
    .eq("user_id", userId)
    .maybeSingle();

  if (legacyProfileResponse.error) {
    return legacyProfileResponse;
  }

  return {
    data: legacyProfileResponse.data
      ? ({
          ...legacyProfileResponse.data,
          avatar_type: null,
          avatar_value: null
        } satisfies ProfileRow)
      : null,
    error: null
  };
}

async function updateProfileWithAvatarFallback(
  supabase: SupabaseClient,
  userId: string,
  payload: {
    display_name: string;
    preferred_mode_seconds: PreferredModeSeconds;
    avatar_type: ProfileAvatarType;
    avatar_value: string;
  }
) {
  const updateResponse = await supabase.from("profiles").update(payload).eq("user_id", userId);

  if (!isMissingProfileAvatarColumnsError(updateResponse.error)) {
    return {
      error: updateResponse.error,
      avatarPersisted: true
    };
  }

  const legacyUpdateResponse = await supabase
    .from("profiles")
    .update({
      display_name: payload.display_name,
      preferred_mode_seconds: payload.preferred_mode_seconds
    })
    .eq("user_id", userId);

  return {
    error: legacyUpdateResponse.error,
    avatarPersisted: false
  };
}

function getParticipationStreak(predictions: Pick<PredictionRow, "placed_at">[]) {
  const uniqueDateKeys = [...new Set(predictions.map((prediction) => getDailyClaimClockParts(new Date(prediction.placed_at).getTime()).claimDate))];

  if (uniqueDateKeys.length === 0) {
    return 0;
  }

  const sortedDays = uniqueDateKeys
    .map((dateKey) => new Date(`${dateKey}T00:00:00.000Z`).getTime())
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => right - left);

  if (sortedDays.length === 0) {
    return 0;
  }

  let streak = 1;

  for (let index = 1; index < sortedDays.length; index += 1) {
    const differenceDays = Math.round((sortedDays[index - 1] - sortedDays[index]) / 86_400_000);

    if (differenceDays !== 1) {
      break;
    }

    streak += 1;
  }

  return streak;
}

function getAchievementCategory(achievement: AchievementRow): AchievementCategory {
  const criteriaType = achievement.criteria?.type;

  if (criteriaType === "prediction_streak") {
    return "skill";
  }

  if (criteriaType === "login_streak") {
    return "participation";
  }

  if (achievement.slug.includes("streak")) {
    return "participation";
  }

  return "accomplishment";
}

function getAchievementCategoryLabel(category: AchievementCategory) {
  if (category === "skill") {
    return "Skill";
  }

  if (category === "participation") {
    return "Participation";
  }

  return "Accomplishment";
}

function getAchievementMetricProgress(
  achievement: AchievementRow,
  metrics: {
    predictionCount: number;
    loginStreak: number;
    winStreak: number;
    participationStreak: number;
  }
) {
  const minimum = Math.max(achievement.criteria?.minimum ?? 1, 1);
  const criteriaType = achievement.criteria?.type;
  const current =
    criteriaType === "login_streak"
      ? metrics.loginStreak
      : criteriaType === "prediction_streak"
        ? metrics.winStreak
        : criteriaType === "participation_streak"
          ? metrics.participationStreak
          : metrics.predictionCount;

  return {
    current,
    minimum,
    ratio: clamp(current / minimum, 0, 1)
  };
}

function ProfileAvatar({
  avatarType,
  avatarValue,
  label,
  className = ""
}: {
  avatarType: ProfileAvatarType;
  avatarValue: string;
  label: string;
  className?: string;
}) {
  const gradientId = useId().replace(/:/g, "");

  if (avatarType === "upload" && avatarValue.startsWith("data:image/")) {
    return (
      <div className={`profile-avatar ${className}`.trim()}>
        {/* Decorative frame keeps uploaded photos inside the product's gold/maroon identity. */}
        <NextImage src={avatarValue} alt={label} fill unoptimized sizes="96px" className="profile-avatar-image" />
      </div>
    );
  }

  const builtInAvatar = getBuiltInProfileAvatar(avatarValue);

  return (
    <div className={`profile-avatar ${className}`.trim()}>
      <svg viewBox="0 0 100 100" role="img" aria-label={label} className="profile-avatar-svg">
        <defs>
          <linearGradient id={`profile-avatar-gradient-${gradientId}`} x1="10%" x2="90%" y1="10%" y2="100%">
            <stop offset="0%" stopColor={builtInAvatar.startColor} />
            <stop offset="100%" stopColor={builtInAvatar.endColor} />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="47" fill="rgb(10 12 18 / 92%)" stroke={builtInAvatar.rimColor} strokeWidth="2.4" />
        <circle cx="50" cy="50" r="39" fill={`url(#profile-avatar-gradient-${gradientId})`} />
        <circle cx="50" cy="50" r="39" fill="rgb(255 255 255 / 0.06)" />
        {builtInAvatar.id === "signal" ? (
          <>
            <path
              d="M27 63c7-17 15-26 24-26s17 9 22 26"
              fill="none"
              stroke="rgb(255 245 218 / 0.9)"
              strokeLinecap="round"
              strokeWidth="6"
            />
            <path
              d="M38 44c4-7 8-10 12-10s8 3 12 10"
              fill="none"
              stroke="rgb(255 245 218 / 0.86)"
              strokeLinecap="round"
              strokeWidth="5"
            />
            <circle cx="50" cy="61" r="5.5" fill="rgb(255 245 218 / 0.95)" />
          </>
        ) : builtInAvatar.id === "victory" ? (
          <>
            <path
              d="M34 28h8l8 12 8-12h8l-12 20 12 24h-8L50 58 34 72h-8l12-24-12-20Z"
              fill="rgb(255 245 218 / 0.93)"
            />
          </>
        ) : builtInAvatar.id === "shield" ? (
          <>
            <path
              d="M50 24 70 31v16c0 13-8.6 23.5-20 29-11.4-5.5-20-16-20-29V31l20-7Z"
              fill="rgb(255 245 218 / 0.92)"
            />
            <path d="M50 32v34" stroke="rgb(123 18 30 / 0.85)" strokeLinecap="round" strokeWidth="5" />
            <path d="M37 49h26" stroke="rgb(123 18 30 / 0.85)" strokeLinecap="round" strokeWidth="5" />
          </>
        ) : builtInAvatar.id === "spark" ? (
          <>
            <path
              d="m50 22 7.4 17.8L76 47l-18.6 7.2L50 72l-7.4-17.8L24 47l18.6-7.2Z"
              fill="rgb(255 245 218 / 0.95)"
            />
            <circle cx="50" cy="47" r="7.4" fill="rgb(123 18 30 / 0.7)" />
          </>
        ) : (
          <>
            <path
              d="M30 60c7 10 13 15 20 15s13-5 20-15"
              fill="none"
              stroke="rgb(255 245 218 / 0.95)"
              strokeLinecap="round"
              strokeWidth="5.8"
            />
            <path
              d="M35 61c-6-5-10-12-11-20M65 61c6-5 10-12 11-20"
              fill="none"
              stroke="rgb(255 245 218 / 0.82)"
              strokeLinecap="round"
              strokeWidth="4.2"
            />
            <circle cx="50" cy="38" r="8.2" fill="rgb(255 245 218 / 0.94)" />
          </>
        )}
      </svg>
    </div>
  );
}

async function convertUploadedAvatarToDataUrl(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file for your profile photo.");
  }

  if (file.size > MAX_PROFILE_AVATAR_FILE_SIZE_BYTES) {
    throw new Error("Choose an image smaller than 8 MB.");
  }

  const fileDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not read that image."));
    };
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const nextImage = new Image();
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => reject(new Error("Could not process that image."));
    nextImage.src = fileDataUrl;
  });

  const cropSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = Math.max((image.naturalWidth - cropSize) / 2, 0);
  const sourceY = Math.max((image.naturalHeight - cropSize) / 2, 0);
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not process that image.");
  }

  context.fillStyle = "#150d11";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, canvas.width, canvas.height);

  const outputDataUrl = canvas.toDataURL("image/jpeg", 0.86);

  if (outputDataUrl.length > MAX_PROFILE_AVATAR_DATA_URL_LENGTH) {
    throw new Error("That image is too detailed. Try a smaller photo.");
  }

  return outputDataUrl;
}

function getResolvedMarketResultLabel(session: SessionRow | null) {
  if (!session || session.final_count === null) {
    return "Pending";
  }

  if (session.final_count > session.threshold) {
    return "OVER";
  }

  if (session.final_count < session.threshold) {
    return "UNDER";
  }

  return "Exact line";
}

function getPredictionHistoryStatus(
  prediction: PredictionRow,
  session: SessionRow | null,
  nowMs: number
): { label: string; tone: PredictionHistoryTone } {
  if (prediction.resolved_at && prediction.was_correct === null) {
    return {
      label: "Cancelled",
      tone: "cancelled"
    };
  }

  if (prediction.was_correct === true) {
    return {
      label: "Won",
      tone: "win"
    };
  }

  if (prediction.was_correct === false) {
    return {
      label: "Lost",
      tone: "loss"
    };
  }

  if (session) {
    const sessionState = getSessionState(session, nowMs);

    if (sessionState === "open" || sessionState === "upcoming") {
      return {
        label: "Locked In",
        tone: "pending"
      };
    }

    if (sessionState === "live") {
      return {
        label: "In Play",
        tone: "pending"
      };
    }

    if (sessionState === "resolving") {
      return {
        label: "Settling",
        tone: "pending"
      };
    }

    if (sessionState === "cancelled") {
      return {
        label: "Cancelled",
        tone: "cancelled"
      };
    }
  }

  return {
    label: "Pending",
    tone: "pending"
  };
}

function getPredictionHistoryNote(prediction: PredictionRow, session: SessionRow | null, nowMs: number) {
  if (!session) {
    return "Round details are still syncing to your history.";
  }

  if (prediction.resolved_at && prediction.was_correct === null) {
    return "This round was voided after betting locked.";
  }

  if (prediction.was_correct === true && session.final_count !== null) {
    if (prediction.side === "exact") {
      return `You nailed the exact count at ${session.final_count} people.`;
    }

    if (prediction.side === "range") {
      return `Final count of ${session.final_count} landed inside your ${prediction.range_min ?? "?"}-${prediction.range_max ?? "?"} range.`;
    }

    return `${prediction.side.toUpperCase()} cleared the ${session.threshold} line with ${session.final_count} people.`;
  }

  if (prediction.was_correct === false && session.final_count !== null) {
    if (prediction.side === "exact") {
      return `You called ${prediction.exact_value ?? "?"}, but ${session.final_count} people crossed the line.`;
    }

    if (prediction.side === "range") {
      return `You called ${prediction.range_min ?? "?"}-${prediction.range_max ?? "?"}, but ${session.final_count} people crossed the line.`;
    }

    if (session.final_count === session.threshold) {
      return `Final count landed exactly on the ${session.threshold} line.`;
    }

    return `${prediction.side.toUpperCase()} missed the ${session.threshold} line with ${session.final_count} people.`;
  }

  const sessionState = getSessionState(session, nowMs);

  if (sessionState === "open" || sessionState === "upcoming") {
    return `Entry is locked for the ${formatShortTime(session.starts_at)} round start.`;
  }

  if (sessionState === "live") {
    return `Round is live until ${formatShortTime(session.ends_at)}.`;
  }

  if (sessionState === "resolving") {
    return "Round closed. Settlement should post automatically.";
  }

  if (sessionState === "cancelled") {
    return "This round was cancelled.";
  }

  return "Outcome is syncing to your account.";
}

function shouldHidePredictionFromProfile(
  prediction: Pick<PredictionRow, "resolved_at" | "was_correct">,
  isCancelledSession: boolean
) {
  return isCancelledSession || (prediction.resolved_at !== null && prediction.was_correct === null);
}

function matchesPredictionHistoryFilter(
  prediction: Pick<PredictionRow, "resolved_at">,
  filter: PredictionHistoryFilter
) {
  if (filter === "all") {
    return true;
  }

  return filter === "live" ? prediction.resolved_at === null : prediction.resolved_at !== null;
}

function getSessionState(session: SessionRow, nowMs: number): SessionState {
  if (session.status === "cancelled") {
    return "cancelled";
  }

  if (session.status === "resolved" || session.resolved_at || session.final_count !== null) {
    return "resolved";
  }

  const startsAt = new Date(session.starts_at).getTime();
  const endsAt = new Date(session.ends_at).getTime();

  if (nowMs < startsAt - BETTING_OPEN_WINDOW_MS) {
    return "upcoming";
  }

  if (nowMs < startsAt) {
    return "open";
  }

  if (nowMs <= endsAt) {
    return "live";
  }

  return "resolving";
}

function getSessionStateLabel(state: SessionState) {
  if (state === "upcoming") {
    return "Upcoming";
  }

  if (state === "open") {
    return "Open";
  }

  if (state === "live") {
    return "Live";
  }

  if (state === "resolving") {
    return "Resolving";
  }

  if (state === "resolved") {
    return "Resolved";
  }

  return "Cancelled";
}

function createFallbackSessions(): SessionRow[] {
  const now = Date.now();
  return [0, 1, 2, 3].map((index) => {
    const startsAt = new Date(now + (index + 1) * 120_000);
    const modeSeconds = index % 2 === 0 ? 30 : 60;
    const endsAt = new Date(startsAt.getTime() + modeSeconds * 1_000);
    const threshold = modeSeconds === 30 ? 5 + index : 9 + index;

    return {
      id: `fallback-${index}`,
      mode_seconds: modeSeconds,
      threshold,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "scheduled",
      final_count: null,
      resolved_at: null
    };
  });
}

type LiveDetectionBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

type LiveDetectionsResponse = {
  status: string;
  updated_at?: string | null;
  frame_id?: string | null;
  frame_width?: number | null;
  frame_height?: number | null;
  boxes: LiveDetectionBox[];
};

const DETECTION_POLL_INTERVAL_MS = 300;
const DETECTION_OFFLINE_RETRY_INTERVAL_MS = 5000;
const MOBILE_BREAKPOINT_PX = 980;
const PHONE_BREAKPOINT_PX = 640;

function getDetectorStatusMessage(
  detections: LiveDetectionsResponse | null,
  hasDetectorFrame: boolean
) {
  if (!detections) {
    return "Connecting detector...";
  }

  if (detections.status === "online") {
    return hasDetectorFrame ? null : "Receiving detector frames...";
  }

  if (detections.status === "warming") {
    return "Warming detector...";
  }

  if (detections.status === "connecting") {
    return "Connecting to camera...";
  }

  return "Detector reconnecting...";
}

function getLeaderboardSpotlightLabel(rank: number) {
  if (rank === 1) {
    return "Rush hour royalty";
  }

  if (rank === 2) {
    return "Crosswalk closer";
  }

  if (rank === 3) {
    return "Campus climber";
  }

  return "Board runner";
}

function getLeaderboardSpotlightTone(rank: number): SpotlightCardTone {
  if (rank === 1) {
    return "gold";
  }

  if (rank === 2) {
    return "sky";
  }

  if (rank === 3) {
    return "emerald";
  }

  return "rose";
}

function getAccountPulseCard({
  predictionStreak,
  pendingPredictionCount,
  latestResolvedPrediction,
  tokenBalance
}: {
  predictionStreak: number;
  pendingPredictionCount: number;
  latestResolvedPrediction: PredictionRow | null;
  tokenBalance: number;
}): SpotlightCardRecord {
  if (predictionStreak >= 5) {
    return {
      label: "Pulse",
      value: "On fire",
      note: `${predictionStreak} straight wins and the heater is still alive.`,
      tone: "emerald"
    };
  }

  if (pendingPredictionCount >= 2) {
    return {
      label: "Pulse",
      value: "In motion",
      note: `${pendingPredictionCount} tickets are still riding on the tape.`,
      tone: "sky"
    };
  }

  if (latestResolvedPrediction?.was_correct === true) {
    return {
      label: "Pulse",
      value: "Heating up",
      note: "Your last ticket cashed. The next window is yours to press.",
      tone: "emerald"
    };
  }

  if (latestResolvedPrediction?.was_correct === false) {
    return {
      label: "Pulse",
      value: "Bounce back",
      note: "One sharp read flips the mood fast in this game.",
      tone: "rose"
    };
  }

  if (tokenBalance >= 100) {
    return {
      label: "Pulse",
      value: "Loaded",
      note: "Your bankroll is healthy and ready for the next traffic window.",
      tone: "gold"
    };
  }

  return {
    label: "Pulse",
    value: "Fresh start",
    note: "No pressure. Pick the right spot and build from there.",
    tone: "gold"
  };
}

function getPublicProfileScoutCard({
  displayName,
  rank,
  correctPredictions,
  totalPredictions,
  settledPredictions
}: {
  displayName: string;
  rank: number | null;
  correctPredictions: number;
  totalPredictions: number;
  settledPredictions: number;
}): SpotlightCardRecord {
  const hitRate = settledPredictions > 0 ? correctPredictions / settledPredictions : 0;

  if (rank === 1) {
    return {
      label: "Scout read",
      value: "Traffic titan",
      note: `${displayName} is sitting on top of the live bankroll ladder right now.`,
      tone: "gold"
    };
  }

  if (settledPredictions >= 12 && hitRate >= 0.6) {
    return {
      label: "Scout read",
      value: "Surgical",
      note: `${Math.round(hitRate * 100)}% hit rate across ${settledPredictions} settled picks.`,
      tone: "emerald"
    };
  }

  if (totalPredictions >= 20) {
    return {
      label: "Scout read",
      value: "Volume shooter",
      note: `${displayName} keeps the tape moving with ${totalPredictions} tracked bets.`,
      tone: "sky"
    };
  }

  if (settledPredictions >= 5) {
    return {
      label: "Scout read",
      value: "Steady read",
      note: `${correctPredictions} wins are already on the board and the sample is growing.`,
      tone: "sky"
    };
  }

  return {
    label: "Scout read",
    value: "Emerging",
    note: "A few more rounds and this bettor's pattern will be easier to read.",
    tone: "gold"
  };
}

type PredictionHistoryListProps = {
  predictions: PredictionRow[];
  sessionLookup: Map<string, SessionRow>;
  nowMs: number;
  emptyKicker: string;
  emptyTitle: string;
  emptyCopy: string;
  cancelablePredictionIds?: Set<string>;
  cancelingPredictionIds?: Set<string>;
  onCancelPrediction?: (prediction: PredictionRow) => void;
};

function PredictionHistoryList({
  predictions,
  sessionLookup,
  nowMs,
  emptyKicker,
  emptyTitle,
  emptyCopy,
  cancelablePredictionIds,
  cancelingPredictionIds,
  onCancelPrediction
}: PredictionHistoryListProps) {
  if (predictions.length === 0) {
    return (
      <div className="account-empty-state">
        <p className="account-section-kicker">{emptyKicker}</p>
        <h3 className="account-section-title">{emptyTitle}</h3>
        <p className="account-section-copy">{emptyCopy}</p>
      </div>
    );
  }

  return (
    <div className="account-history-list">
      {predictions.map((prediction) => {
        const session = sessionLookup.get(prediction.session_id) ?? null;
        const historyStatus = getPredictionHistoryStatus(prediction, session, nowMs);
        const marketLabel = formatPredictionLabel(prediction, session);
        const finalCountLabel =
          session?.final_count !== null && session?.final_count !== undefined
            ? `${session.final_count}`
            : "Pending";
        const netLabel =
          prediction.resolved_at && prediction.was_correct === null
            ? "Voided"
            : prediction.was_correct === null
              ? "Pending"
              : formatTokenDelta(prediction.token_delta);
        const isCancelable = Boolean(cancelablePredictionIds?.has(prediction.id) && onCancelPrediction);
        const isCanceling = Boolean(cancelingPredictionIds?.has(prediction.id));

        return (
          <article
            className={`bet-history-card bet-history-card-${historyStatus.tone}`}
            key={prediction.id}
          >
            <div className="bet-history-card-header">
              <div className="bet-history-card-title-block">
                <p className="bet-history-card-kicker">
                  {session ? `${session.mode_seconds}s round` : "Round"} · Placed{" "}
                  {formatShortDateTime(prediction.placed_at)}
                </p>
                <strong className="bet-history-card-title">{marketLabel}</strong>
              </div>
              <span className={`bet-history-status bet-history-status-${historyStatus.tone}`}>
                {historyStatus.label}
              </span>
            </div>

            <div className="bet-history-stat-row">
              <div className="bet-history-stat-card">
                <span>Stake</span>
                <strong>{prediction.wager_tokens}</strong>
              </div>
              <div className="bet-history-stat-card">
                <span>Final count</span>
                <strong>{finalCountLabel}</strong>
              </div>
              <div className="bet-history-stat-card">
                <span>Round result</span>
                <strong>{getResolvedMarketResultLabel(session)}</strong>
              </div>
              <div className="bet-history-stat-card">
                <span>Net</span>
                <strong className={`bet-history-net bet-history-net-${historyStatus.tone}`}>
                  {netLabel}
                </strong>
              </div>
            </div>

            <div className="bet-history-card-footer">
              <div className="bet-history-card-footer-copy">
                <p>{getPredictionHistoryNote(prediction, session, nowMs)}</p>
                <span>
                  {prediction.resolved_at
                    ? `Settled ${formatShortDateTime(prediction.resolved_at)}`
                    : session?.starts_at
                      ? `Round start ${formatShortDateTime(session.starts_at)}`
                      : "Waiting for round details"}
                </span>
              </div>
              {isCancelable ? (
                <button
                  type="button"
                  className="bet-history-cancel-button"
                  onClick={() => onCancelPrediction?.(prediction)}
                  disabled={isCanceling}
                >
                  {isCanceling ? "Removing..." : "Cancel Bet"}
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function AccountOverviewGrid({ stats }: { stats: AccountOverviewStat[] }) {
  return (
    <div className="account-overview-grid">
      {stats.map((stat) => (
        <article className="account-overview-card" key={stat.label}>
          <span>{stat.label}</span>
          <strong>{stat.value}</strong>
          <p>{stat.note}</p>
        </article>
      ))}
    </div>
  );
}

function SpotlightCardGrid({ cards }: { cards: SpotlightCardRecord[] }) {
  return (
    <div className="profile-spotlight-grid">
      {cards.map((card) => (
        <article className={`profile-spotlight-card profile-spotlight-card-${card.tone}`} key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <p>{card.note}</p>
        </article>
      ))}
    </div>
  );
}

function AccountProfileStatGrid({ stats }: { stats: AccountProfileStat[] }) {
  return (
    <div className="account-stat-grid">
      {stats.map((stat) => (
        <article className={`account-stat-card account-stat-card-${stat.tone ?? "slate"}`} key={stat.label}>
          <span>{stat.label}</span>
          <strong>{stat.value}</strong>
          <p>{stat.note}</p>
        </article>
      ))}
    </div>
  );
}

type PredictionHistoryFilterBarProps = {
  filter: PredictionHistoryFilter;
  onChange: (nextFilter: PredictionHistoryFilter) => void;
  totalCount: number;
  liveCount: number;
  settledCount: number;
};

function PredictionHistoryFilterBar({
  filter,
  onChange,
  totalCount,
  liveCount,
  settledCount
}: PredictionHistoryFilterBarProps) {
  const options = [
    {
      id: "all" as const,
      label: "All",
      count: totalCount
    },
    {
      id: "live" as const,
      label: "Live",
      count: liveCount
    },
    {
      id: "settled" as const,
      label: "Settled",
      count: settledCount
    }
  ];

  return (
    <div className="history-filter-row" role="tablist" aria-label="Bet history filter">
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          className={
            filter === option.id ? "history-filter-button history-filter-button-active" : "history-filter-button"
          }
          onClick={() => onChange(option.id)}
          aria-pressed={filter === option.id}
        >
          <span>{option.label}</span>
          <strong>{option.count}</strong>
        </button>
      ))}
    </div>
  );
}

function LeaderboardSpotlightCard({
  entry,
  onOpen
}: {
  entry: LeaderboardRow;
  onOpen: (entry: LeaderboardRow) => void;
}) {
  const tone = getLeaderboardSpotlightTone(entry.rank);

  return (
    <button
      type="button"
      className={`leaderboard-spotlight-card leaderboard-spotlight-card-${tone}`}
      onClick={() => onOpen(entry)}
      aria-label={`Open ${entry.display_name}'s betting profile`}
    >
      <span className="leaderboard-spotlight-rank">{formatRankLabel(entry.rank)}</span>
      <span className="leaderboard-spotlight-copy">
        <span className="leaderboard-spotlight-kicker">{getLeaderboardSpotlightLabel(entry.rank)}</span>
        <strong className="leaderboard-spotlight-name">{entry.display_name}</strong>
        <span className="leaderboard-spotlight-meta">
          {entry.tier} tier · {entry.correct_predictions} correct picks
        </span>
      </span>
      <span className="leaderboard-spotlight-score-shell">
        <span className="leaderboard-spotlight-score-label">Bankroll</span>
        <span className="leaderboard-spotlight-score">{entry.token_balance}</span>
      </span>
    </button>
  );
}
function isPredictionCancelable(prediction: PredictionRow, session: SessionRow | null, nowMs: number) {
  if (!session || prediction.resolved_at !== null) {
    return false;
  }

  return getSessionState(session, nowMs) === "open";
}

export function MvpDashboard({
  hlsUrl,
  initialRegion,
  visionApiUrl
}: MvpDashboardProps) {
  const supabase = getBrowserSupabaseClient();
  const [user, setUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [predictions, setPredictions] = useState<PredictionRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [streaks, setStreaks] = useState<StreakRow | null>(null);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);
  const [userAchievements, setUserAchievements] = useState<UserAchievementRow[]>([]);
  const [tokenBalance, setTokenBalance] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isClaimingDailyLogin, setIsClaimingDailyLogin] = useState(false);
  const [isSavingProfileSettings, setIsSavingProfileSettings] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [isRefreshing, startTransition] = useTransition();
  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [wagerBySession, setWagerBySession] = useState<Record<string, string>>({});
  const [sideBySession, setSideBySession] = useState<Record<string, PredictionSide>>({});
  const [exactValueBySession, setExactValueBySession] = useState<Record<string, string>>({});
  const [rangeMinBySession, setRangeMinBySession] = useState<Record<string, string>>({});
  const [rangeMaxBySession, setRangeMaxBySession] = useState<Record<string, string>>({});
  const [mobileStandbyWager, setMobileStandbyWager] = useState(DEFAULT_WAGER);
  const [mobileStandbySide, setMobileStandbySide] = useState<PredictionSide>("over");
  const [mobileStandbyExactValue, setMobileStandbyExactValue] = useState(DEFAULT_EXACT_VALUE);
  const [mobileStandbyRangeMin, setMobileStandbyRangeMin] = useState(
    getDefaultRangeMin(DEFAULT_STANDBY_THRESHOLD)
  );
  const [mobileStandbyRangeMax, setMobileStandbyRangeMax] = useState(
    getDefaultRangeMax(DEFAULT_STANDBY_THRESHOLD)
  );
  const [openRightPanel, setOpenRightPanel] = useState<"account" | "leaderboard" | "admin" | null>(
    null
  );
  const [publicProfileContext, setPublicProfileContext] = useState<PublicProfileContext | null>(null);
  const [publicProfileSummary, setPublicProfileSummary] = useState<PublicProfileSummaryRow | null>(null);
  const [publicProfilePredictions, setPublicProfilePredictions] = useState<PublicPredictionHistoryRow[]>([]);
  const [isPublicProfileLoading, setIsPublicProfileLoading] = useState(false);
  const [publicProfileError, setPublicProfileError] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authIntentSessionId, setAuthIntentSessionId] = useState<string | null>(null);
  const [liveDetections, setLiveDetections] = useState<LiveDetectionsResponse | null>(null);
  const [regionPoints, setRegionPoints] = useState(() => normalizeBettingRegion(initialRegion));
  const [savedRegionPoints, setSavedRegionPoints] = useState(() =>
    normalizeBettingRegion(initialRegion)
  );
  const [isRegionEditModeEnabled, setIsRegionEditModeEnabled] = useState(false);
  const [isSavingRegion, setIsSavingRegion] = useState(false);
  const [cancelingPredictionIds, setCancelingPredictionIds] = useState<string[]>([]);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isPhoneViewport, setIsPhoneViewport] = useState(false);
  const [accountHistoryFilter, setAccountHistoryFilter] = useState<PredictionHistoryFilter>("all");
  const [publicProfileHistoryFilter, setPublicProfileHistoryFilter] =
    useState<PredictionHistoryFilter>("all");
  const anonDisplayNameRequestRef = useRef(0);
  const nextToastIdRef = useRef(0);
  const toastsRef = useRef<ToastRecord[]>([]);
  const toastTimeoutsRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const avatarUploadInputRef = useRef<HTMLInputElement | null>(null);
  const liveTrainStopXRef = useRef<number | null>(null);
  const liveTrainStopSessionIdRef = useRef<string | null>(null);
  const publicProfileLoadIdRef = useRef(0);
  const [profileSettings, setProfileSettings] = useState<ProfileSettingsFormState>(() =>
    createProfileSettingsFormState(null, PROFILE_PREVIEW_EMAIL)
  );
  const [profileSettingsBaseline, setProfileSettingsBaseline] = useState<ProfileSettingsFormState>(() =>
    createProfileSettingsFormState(null, PROFILE_PREVIEW_EMAIL)
  );
  const profileSettingsDirtyRef = useRef(false);

  const sessionLookup = new Map(sessions.map((session) => [session.id, session]));
  const isProfilePreviewMode = !supabase && process.env.NODE_ENV !== "production";
  const accountProfile = isProfilePreviewMode ? PROFILE_PREVIEW_PROFILE : profile;
  const accountStreaks = isProfilePreviewMode ? PROFILE_PREVIEW_STREAKS : streaks;
  const accountAchievements = isProfilePreviewMode ? PROFILE_PREVIEW_ACHIEVEMENTS : achievements;
  const accountUserAchievements = isProfilePreviewMode
    ? PROFILE_PREVIEW_USER_ACHIEVEMENTS
    : userAchievements;
  const accountPredictions = isProfilePreviewMode ? PROFILE_PREVIEW_PREDICTIONS : predictions;
  const accountTokenBalance = isProfilePreviewMode ? PROFILE_PREVIEW_TOKEN_BALANCE : tokenBalance;
  const accountEmail = user?.email ?? (isProfilePreviewMode ? PROFILE_PREVIEW_EMAIL : "");
  const accountSessionLookup = new Map(
    mergeSessionRows(sessions, isProfilePreviewMode ? PROFILE_PREVIEW_HISTORY_SESSIONS : []).map((session) => [
      session.id,
      session
    ])
  );
  const visibleAccountPredictions = accountPredictions.filter((prediction) => {
    const session = accountSessionLookup.get(prediction.session_id) ?? null;
    return !shouldHidePredictionFromProfile(
      prediction,
      session ? getSessionState(session, nowMs) === "cancelled" : false
    );
  });
  const filteredAccountPredictions = visibleAccountPredictions.filter((prediction) =>
    matchesPredictionHistoryFilter(prediction, accountHistoryFilter)
  );
  const pendingPredictionCount = visibleAccountPredictions.filter(
    (prediction) => prediction.resolved_at === null
  ).length;
  const settledPredictions = visibleAccountPredictions.filter(
    (prediction) => prediction.was_correct !== null
  );
  const settledPredictionCount = visibleAccountPredictions.filter(
    (prediction) => prediction.resolved_at !== null
  ).length;
  const wonPredictionCount = settledPredictions.filter(
    (prediction) => prediction.was_correct === true
  ).length;
  const openRiskTokens = visibleAccountPredictions
    .filter((prediction) => prediction.resolved_at === null)
    .reduce((total, prediction) => total + prediction.wager_tokens, 0);
  const participationStreak = getParticipationStreak(visibleAccountPredictions);
  const hitRateLabel =
    settledPredictions.length > 0
      ? `${Math.round((wonPredictionCount / settledPredictions.length) * 100)}%`
      : "--";
  const latestResolvedPrediction =
    visibleAccountPredictions.find((prediction) => prediction.resolved_at !== null) ?? null;
  const currentUserLeaderboardEntry = user
    ? leaderboard.find((entry) => entry.user_id === user.id) ?? null
    : null;
  const latestResolvedResultLabel = latestResolvedPrediction?.resolved_at
    ? latestResolvedPrediction.was_correct === true
      ? "Last ticket won"
      : latestResolvedPrediction.was_correct === false
        ? "Last ticket lost"
        : "Last ticket voided"
    : pendingPredictionCount > 0
      ? pendingPredictionCount === 1
        ? "1 ticket still live"
        : `${pendingPredictionCount} tickets still live`
      : "No bets settled yet";
  const accountOverviewStats: AccountOverviewStat[] = [
    {
      label: "Balance",
      value: `${accountTokenBalance}`,
      note: "Ready for the next round"
    },
    {
      label: "Hit rate",
      value: hitRateLabel,
      note:
        settledPredictions.length > 0
          ? `${wonPredictionCount}/${settledPredictions.length} settled wins`
          : "Settled picks will show here"
    },
    {
      label: "Open risk",
      value: `${openRiskTokens}`,
      note:
        pendingPredictionCount > 0
          ? pendingPredictionCount === 1
            ? "1 active ticket"
            : `${pendingPredictionCount} active tickets`
          : "Nothing open right now"
    },
    {
      label: "Bets tracked",
      value: `${visibleAccountPredictions.length}`,
      note: latestResolvedResultLabel
    }
  ];
  const accountProfileStats: AccountProfileStat[] = [
    {
      label: "Daily login streak",
      value: `${accountStreaks?.login_streak ?? 0}`,
      note:
        accountStreaks?.last_login_date === getDailyClaimClockParts(nowMs).claimDate
          ? "Claimed today"
          : "Claim today to extend it",
      tone: "gold"
    },
    {
      label: "Win streak",
      value: `${accountStreaks?.prediction_streak ?? 0}`,
      note: "Consecutive settled wins",
      tone: "cardinal"
    },
    {
      label: "Participation streak",
      value: `${participationStreak}`,
      note: "Consecutive active betting days",
      tone: "slate"
    }
  ];
  const earnedAchievementIds = new Map(
    accountUserAchievements.map((achievement) => [achievement.achievement_id, achievement.awarded_at])
  );
  const achievementCards = accountAchievements.map((achievement) => {
    const progress = getAchievementMetricProgress(achievement, {
      predictionCount: visibleAccountPredictions.length,
      loginStreak: accountStreaks?.login_streak ?? 0,
      winStreak: accountStreaks?.prediction_streak ?? 0,
      participationStreak
    });
    const awardedAt = earnedAchievementIds.get(achievement.id) ?? null;

    return {
      ...achievement,
      category: getAchievementCategory(achievement),
      current: progress.current,
      minimum: progress.minimum,
      ratio: progress.ratio,
      isEarned: Boolean(awardedAt),
      awardedAt
    };
  });
  const achievementCardsByCategory = {
    skill: achievementCards.filter((achievement) => achievement.category === "skill"),
    accomplishment: achievementCards.filter((achievement) => achievement.category === "accomplishment"),
    participation: achievementCards.filter((achievement) => achievement.category === "participation")
  } satisfies Record<AchievementCategory, typeof achievementCards>;
  const totalEarnedAchievements = achievementCards.filter((achievement) => achievement.isEarned).length;
  const profileJoinDateLabel = formatJoinDateLabel(accountProfile?.created_at);
  const accountDisplayName = accountProfile?.display_name ?? accountEmail;
  const profileSettingsDirty = !profileSettingsFormEqual(profileSettings, profileSettingsBaseline);
  const canPersistProfileSettings = Boolean(user && supabase);
  const activeProfileAvatarType = profileSettings.avatarType;
  const activeProfileAvatarValue = profileSettings.avatarValue;
  const focusedSession = sessions.find((session) => getSessionState(session, nowMs) === "open");
  const upcomingSession = sessions.find((session) => getSessionState(session, nowMs) === "upcoming");
  const inFlightSession =
    sessions.find((session) => {
      const state = getSessionState(session, nowMs);
      return state === "live" || state === "resolving";
    }) ?? null;
  const resolvedSessions = sessions.filter((session) => getSessionState(session, nowMs) === "resolved");
  const spotlightResolvedSession =
    [...resolvedSessions].reverse().find((session) => {
      const resolvedAtMs = getSessionReferenceTime(session);
      return nowMs - resolvedAtMs <= RESULT_SPOTLIGHT_WINDOW_MS;
    }) ?? null;
  const selectedSession =
    focusedSession ?? inFlightSession ?? spotlightResolvedSession ?? upcomingSession ?? null;
  const hasSelectedSession = Boolean(selectedSession);
  const selectedSessionPredictions = selectedSession
    ? predictions.filter((prediction) => prediction.session_id === selectedSession.id)
    : [];
  const selectedPrediction = selectedSessionPredictions[0] ?? null;
  const selectedSessionPredictionCount = selectedSessionPredictions.length;
  const hasSelectedSessionPredictions = selectedSessionPredictionCount > 0;
  const selectedSessionPreviewPredictions = selectedSessionPredictions.slice(0, 3);
  const selectedSessionOverflowPredictionCount = Math.max(selectedSessionPredictionCount - 3, 0);
  const selectedSessionStakedTokens = selectedSessionPredictions.reduce(
    (total, prediction) => total + prediction.wager_tokens,
    0
  );
  const selectedSessionSettledPredictions = selectedSessionPredictions.filter(
    (prediction) => prediction.was_correct !== null
  );
  const selectedSessionCompletedCount = selectedSessionPredictions.filter(
    (prediction) => prediction.resolved_at !== null
  ).length;
  const selectedSessionWonCount = selectedSessionSettledPredictions.filter(
    (prediction) => prediction.was_correct === true
  ).length;
  const selectedSessionVoidedCount = selectedSessionPredictions.filter(
    (prediction) => prediction.resolved_at !== null && prediction.was_correct === null
  ).length;
  const selectedSessionNetDelta = selectedSessionPredictions.reduce(
    (total, prediction) => total + (prediction.token_delta ?? 0),
    0
  );
  const selectedState = selectedSession ? getSessionState(selectedSession, nowMs) : null;
  const displayedModeSeconds = selectedSession?.mode_seconds ?? 30;
  const displayedThreshold = selectedSession?.threshold ?? DEFAULT_STANDBY_THRESHOLD;
  const selectedStartsAtMs = selectedSession ? new Date(selectedSession.starts_at).getTime() : null;
  const selectedEndsAtMs = selectedSession ? new Date(selectedSession.ends_at).getTime() : null;
  const selectedCountdown = selectedStartsAtMs !== null ? formatCountdown(selectedStartsAtMs - nowMs) : "00:00";
  const selectedOpensInLabel = selectedSession
    ? formatReadableDuration(new Date(selectedSession.starts_at).getTime() - nowMs - BETTING_OPEN_WINDOW_MS)
    : "Soon";
  const selectedWager = selectedSession
    ? (wagerBySession[selectedSession.id] ?? DEFAULT_WAGER)
    : mobileStandbyWager;
  const selectedSide = selectedSession ? (sideBySession[selectedSession.id] ?? "over") : mobileStandbySide;
  const selectedExactValue = selectedSession
    ? (exactValueBySession[selectedSession.id] ?? DEFAULT_EXACT_VALUE)
    : mobileStandbyExactValue;
  const selectedRangeMin = selectedSession
    ? (rangeMinBySession[selectedSession.id] ?? getDefaultRangeMin(selectedSession.threshold))
    : mobileStandbyRangeMin;
  const selectedRangeMax = selectedSession
    ? (rangeMaxBySession[selectedSession.id] ?? getDefaultRangeMax(selectedSession.threshold))
    : mobileStandbyRangeMax;
  const selectedConfiguredWager = Number.parseInt(selectedWager, 10);
  const selectedConfiguredRangeMin = Number.parseInt(selectedRangeMin, 10);
  const selectedConfiguredRangeMax = Number.parseInt(selectedRangeMax, 10);
  const selectedPricingRangeMin =
    Number.isFinite(selectedConfiguredRangeMin) ? selectedConfiguredRangeMin : null;
  const selectedPricingRangeMax =
    Number.isFinite(selectedConfiguredRangeMax) ? selectedConfiguredRangeMax : null;
  const selectedWagerValue =
    Number.isFinite(selectedConfiguredWager) && selectedConfiguredWager > 0
      ? selectedConfiguredWager
      : Number.parseInt(DEFAULT_WAGER, 10);
  const selectedRangeMinValue = Number.isFinite(selectedConfiguredRangeMin)
    ? Math.max(selectedConfiguredRangeMin, 0)
    : Number.parseInt(getDefaultRangeMin(displayedThreshold), 10);
  const selectedRangeMaxValue = Number.isFinite(selectedConfiguredRangeMax)
    ? Math.max(selectedConfiguredRangeMax, selectedRangeMinValue)
    : Math.max(Number.parseInt(getDefaultRangeMax(displayedThreshold), 10), selectedRangeMinValue);
  const canPreviewSelected = Boolean(
    selectedSession && (selectedState === "open" || selectedState === "upcoming")
  );
  const canConfigureSelected = Boolean(selectedSession && selectedState === "open");
  const showBettingControls = Boolean(selectedSession && selectedState === "open");
  const dailyClaimState = getDailyClaimState(accountStreaks?.last_login_date ?? null, nowMs);
  const isDailyClaimDisabled =
    isProfilePreviewMode || loading || isRefreshing || isClaimingDailyLogin || !dailyClaimState.canClaim;
  const dailyClaimButtonLabel = isProfilePreviewMode
    ? "Preview Only"
    : isClaimingDailyLogin
      ? "Claiming..."
      : dailyClaimState.hasClaimedToday
        ? "Claimed Today"
        : "Claim Daily Tokens";
  const dailyClaimHelperText = isProfilePreviewMode
    ? "Connect Supabase to claim live streak rewards."
    : isClaimingDailyLogin
      ? "Submitting your daily reward claim."
      : loading || isRefreshing
        ? "Refreshing account status..."
        : dailyClaimState.detail;
  const accountSpotlightCards: SpotlightCardRecord[] = [
    {
      label: "Today",
      value: dailyClaimState.canClaim
        ? "Reward live"
        : dailyClaimState.hasClaimedToday
          ? "Claimed"
          : "Resets at 8AM",
      note: dailyClaimState.canClaim
        ? "Your daily token drop is ready right now."
        : dailyClaimState.detail,
      tone: dailyClaimState.canClaim ? "gold" : "sky"
    },
    {
      label: "Board",
      value: currentUserLeaderboardEntry
        ? formatRankLabel(currentUserLeaderboardEntry.rank)
        : leaderboard.length >= 10
          ? "Top 10 chase"
          : "Unranked",
      note: currentUserLeaderboardEntry
        ? `${currentUserLeaderboardEntry.correct_predictions} correct picks on the current board.`
        : "One hot round can push you into the current top 10.",
      tone:
        currentUserLeaderboardEntry && currentUserLeaderboardEntry.rank <= 3
          ? "gold"
          : currentUserLeaderboardEntry
            ? "sky"
            : "rose"
    },
    getAccountPulseCard({
      predictionStreak: accountStreaks?.prediction_streak ?? 0,
      pendingPredictionCount,
      latestResolvedPrediction,
      tokenBalance: accountTokenBalance
    })
  ];
  const showLiveRoundCard = Boolean(selectedSession && selectedState === "live");
  const showResolvedRoundCard = Boolean(selectedSession && selectedState === "resolved");
  const emptyStateSignInEnabled = !hasSelectedSession && !user;
  const betButtonDisabled = hasSelectedSession ? !canConfigureSelected : !emptyStateSignInEnabled;
  const betButtonLabel = hasSelectedSession
    ? !user
      ? "Sign In to Bet"
      : hasSelectedSessionPredictions
      ? "Add Bet"
      : "Bet"
    : user
      ? "Waiting"
      : "Sign In to Bet";
  const sessionMetricLabel =
    selectedState === "upcoming"
      ? "Opens In"
      : selectedState === "open"
      ? "Closes In"
      : selectedState === "live"
        ? "Betting"
        : selectedState === "resolving"
          ? "Round"
          : "Status";
  const sessionMetricValue =
    selectedState === "upcoming"
      ? selectedOpensInLabel
      : selectedState === "open"
      ? selectedCountdown
      : selectedState === "live"
        ? "Locked"
        : selectedState === "resolving"
          ? "Resolving"
        : selectedState
            ? getSessionStateLabel(selectedState)
            : "Waiting";
  const selectedStartsAtLabel = selectedSession
    ? formatScheduledTimeLabel(selectedSession.starts_at, nowMs)
    : null;
  const selectedOpensAtLabel = selectedSession
    ? formatScheduledTimeLabel(new Date(selectedSession.starts_at).getTime() - BETTING_OPEN_WINDOW_MS, nowMs)
    : null;
  const selectedEndsAtLabel = selectedSession
    ? formatScheduledTimeLabel(selectedSession.ends_at, nowMs)
    : null;
  const selectedSessionId = selectedSession?.id ?? null;
  const publicProfileDisplayName =
    publicProfileSummary?.display_name ?? publicProfileContext?.display_name ?? "Public Profile";
  const publicProfileTier = publicProfileSummary?.tier ?? publicProfileContext?.tier ?? "Trader";
  const publicProfileRank = publicProfileSummary?.rank ?? publicProfileContext?.rank ?? null;
  const allVisiblePublicProfilePredictions = publicProfilePredictions.filter(
    (prediction) => !shouldHidePredictionFromProfile(prediction, prediction.status === "cancelled")
  );
  const filteredPublicProfilePredictions = allVisiblePublicProfilePredictions.filter((prediction) =>
    matchesPredictionHistoryFilter(prediction, publicProfileHistoryFilter)
  );
  const publicProfileTotalPredictions =
    publicProfileSummary?.total_predictions ?? allVisiblePublicProfilePredictions.length;
  const publicProfileCorrectPredictions =
    publicProfileSummary?.correct_predictions ??
    allVisiblePublicProfilePredictions.filter((prediction) => prediction.was_correct === true).length;
  const publicProfileSettledPredictions =
    publicProfileSummary?.settled_predictions ??
    allVisiblePublicProfilePredictions.filter((prediction) => prediction.was_correct !== null).length;
  const publicProfileHitRateLabel =
    publicProfileSettledPredictions > 0
      ? `${Math.round((publicProfileCorrectPredictions / publicProfileSettledPredictions) * 100)}%`
      : "--";
  const publicProfileOverviewStats: AccountOverviewStat[] = [
    {
      label: "Leaderboard",
      value: publicProfileRank !== null ? `#${publicProfileRank}` : "--",
      note:
        publicProfileRank !== null
          ? "Live balance rank"
          : "Waiting for leaderboard placement"
    },
    {
      label: "Bankroll",
      value:
        publicProfileSummary?.token_balance !== null && publicProfileSummary?.token_balance !== undefined
          ? `${publicProfileSummary.token_balance}`
          : "--",
      note: "Visible to every bettor"
    },
    {
      label: "Hit rate",
      value: publicProfileHitRateLabel,
      note:
        publicProfileSettledPredictions > 0
          ? `${publicProfileSettledPredictions} settled picks`
          : "No settled picks yet"
    },
    {
      label: "Bets tracked",
      value: `${publicProfileTotalPredictions}`,
      note: `${publicProfileCorrectPredictions} correct picks`
    }
  ];
  const publicProfileSpotlightCards: SpotlightCardRecord[] = [
    {
      label: "Board",
      value: publicProfileRank !== null ? formatRankLabel(publicProfileRank) : "Unranked",
      note:
        publicProfileRank !== null
          ? `${publicProfileDisplayName} is on the live bankroll ladder.`
          : "Still building enough tape to push into the main board.",
      tone: publicProfileRank === 1 ? "gold" : publicProfileRank !== null ? "sky" : "rose"
    },
    getPublicProfileScoutCard({
      displayName: publicProfileDisplayName,
      rank: publicProfileRank,
      correctPredictions: publicProfileCorrectPredictions,
      totalPredictions: publicProfileTotalPredictions,
      settledPredictions: publicProfileSettledPredictions
    }),
    {
      label: "Tape",
      value: `${publicProfileTotalPredictions}`,
      note:
        publicProfileSettledPredictions > 0
          ? `${publicProfileSettledPredictions} settled picks and ${publicProfileCorrectPredictions} wins so far.`
          : "No settled rounds yet, so the story is still just getting started.",
      tone: publicProfileSettledPredictions > 0 ? "emerald" : "gold"
    }
  ];
  const publicProfileHistoryCountLabel =
    isPublicProfileLoading && !publicProfileSummary
      ? "Loading..."
      : publicProfileHistoryFilter === "all"
        ? publicProfileSummary && publicProfileSummary.total_predictions > allVisiblePublicProfilePredictions.length
          ? `Latest ${allVisiblePublicProfilePredictions.length} of ${publicProfileSummary.total_predictions} bets`
          : `${publicProfileTotalPredictions} bets`
        : `${filteredPublicProfilePredictions.length} shown`;
  const publicProfileSessionRows = mergeSessionRows(
    allVisiblePublicProfilePredictions.map((prediction) => ({
      id: prediction.session_id,
      mode_seconds: prediction.mode_seconds,
      threshold: prediction.threshold,
      starts_at: prediction.starts_at,
      ends_at: prediction.ends_at,
      status: prediction.status,
      final_count: prediction.final_count,
      resolved_at: prediction.session_resolved_at
    }))
  );
  const publicProfileSessionLookup = new Map(
    publicProfileSessionRows.map((session) => [session.id, session])
  );
  const cancelingPredictionIdSet = new Set(cancelingPredictionIds);
  const cancelablePredictionIdSet = new Set(
    predictions
      .filter((prediction) => isPredictionCancelable(prediction, sessionLookup.get(prediction.session_id) ?? null, nowMs))
      .map((prediction) => prediction.id)
  );
  const leaderboardSpotlightEntries = leaderboard.slice(0, 3);
  const leaderboardListEntries = leaderboard.slice(3, 15);
  const leaderboardUserSummary = user
    ? currentUserLeaderboardEntry
      ? {
          value: formatRankLabel(currentUserLeaderboardEntry.rank),
          note: `${currentUserLeaderboardEntry.token_balance} bankroll · ${currentUserLeaderboardEntry.correct_predictions} correct picks.`
        }
      : {
          value: leaderboard.length >= 10 ? "Outside top 10" : "Board warming up",
          note: "Land a couple of sharp rounds and this panel starts moving fast."
        }
    : null;
  const livePeopleCount = liveDetections?.boxes.length ?? null;
  const livePeopleCountDisplay = `${livePeopleCount ?? 0}`.padStart(2, "0");
  const selectedRoundCountdown =
    selectedEndsAtMs !== null ? formatCountdown(selectedEndsAtMs - nowMs) : "00:00";
  const liveSceneId = useId().replace(/:/g, "");
  const liveCountValue = livePeopleCount ?? 0;
  const liveCountRatio = displayedThreshold > 0 ? liveCountValue / displayedThreshold : 0;
  const liveTrackHasCrossedLine = livePeopleCount !== null && livePeopleCount >= displayedThreshold;
  const liveRoundDurationMs = Math.max(displayedModeSeconds * 1000, 1);
  const liveRoundRemainingMs = selectedEndsAtMs !== null ? Math.max(selectedEndsAtMs - nowMs, 0) : liveRoundDurationMs;
  const liveElapsedRatio = clamp(1 - liveRoundRemainingMs / liveRoundDurationMs, 0, 1);
  const liveSceneWidth = 1000;
  const liveSceneHeight = 200;
  const liveTrackStartX = 28;
  const liveTrackY = 82;
  const liveTrainLength = 188;
  const liveTrainFrontStartX = 148;
  const liveCliffEdgeX = 952;
  const liveSafeStopFrontX = liveCliffEdgeX - 32;
  const liveRunoutFrontX = 1118;
  const liveBridgeTopY = liveTrackY + 30;
  const liveBridgeBottomY = 200;
  const liveBridgeEndX = liveCliffEdgeX - 14;
  const liveBridgeArchCenters = [132, 336, 540, 744];
  const liveBridgeArchRadius = 54;
  const liveBaseTrainFrontX = interpolate(liveTrainFrontStartX, liveRunoutFrontX, liveElapsedRatio);
  const liveBrakeObjectSlots = Math.min(Math.max(displayedThreshold, 4), 7);
  const liveBrakeFill =
    displayedThreshold > 0
      ? clamp((liveCountValue / displayedThreshold) * liveBrakeObjectSlots, 0, liveBrakeObjectSlots)
      : 0;
  const liveBrakeObjectXs = Array.from(
    { length: liveBrakeObjectSlots },
    (_, index) => liveSafeStopFrontX - 242 + index * 36
  );
  const liveBrakeDistanceNeeded = liveRunoutFrontX - liveSafeStopFrontX;
  const liveBrakeDistancePerObject = liveBrakeDistanceNeeded / liveBrakeObjectSlots;
  const liveBrakeObjects = liveBrakeObjectXs.map((x, index) => {
    const slotFill = clamp(liveBrakeFill - index, 0, 1);
    const engageStart = x - 96;
    const engageEnd = x + 26;
    const engageRatio = clamp((liveBaseTrainFrontX - engageStart) / (engageEnd - engageStart), 0, 1);
    const engageEase = 1 - Math.pow(1 - engageRatio, 3);

    return {
      x,
      slotFill,
      engageRatio,
      brakeDistance: slotFill * engageEase * liveBrakeDistancePerObject
    };
  });
  const liveBrakeDistanceApplied = liveBrakeObjects.reduce(
    (total, block) => total + block.brakeDistance,
    0
  );
  const liveBrakeCoverage = clamp(liveBrakeDistanceApplied / liveBrakeDistanceNeeded, 0, 1);
  const liveComputedTrainFrontX = liveBaseTrainFrontX - liveBrakeDistanceApplied;
  const liveHardStopTriggerRatio = 1.3;
  const liveOverkillRatio = Math.max(liveCountRatio - liveHardStopTriggerRatio, 0);
  const liveHardStopRatio = clamp(liveOverkillRatio / 0.4, 0, 1);
  const liveTrainFrontX =
    liveTrainStopXRef.current !== null
      ? liveTrainStopXRef.current
      : liveComputedTrainFrontX;
  const liveTrainBodyX = liveTrainFrontX - liveTrainLength;
  const liveFallProgress = clamp((liveTrainFrontX - liveCliffEdgeX) / 92, 0, 1);
  const liveTrainTranslateY = liveFallProgress * 116;
  const liveTrainRotation = liveFallProgress * 60;
  const liveTrainDistanceTravelled = Math.max(liveTrainFrontX - liveTrainFrontStartX, 0);
  const liveWheelRotation = (liveTrainDistanceTravelled / (Math.PI * 28)) * 360;
  const liveTrainHasHardStopped = liveTrainStopXRef.current !== null;
  const liveSpeedRatio = liveTrainHasHardStopped
    ? 0
    : clamp(
        1 - liveBrakeCoverage * 0.82 - liveHardStopRatio * 0.24,
        liveFallProgress > 0 ? 0.2 : 0.04,
        1
      );
  const liveSparkOpacity = clamp(
    (liveBrakeCoverage * 0.72 + liveHardStopRatio * 0.5) * (0.32 + liveSpeedRatio * 0.78),
    0,
    1
  );
  const liveSmokeOpacity = clamp(0.18 + liveSpeedRatio * 0.46 + liveFallProgress * 0.1, 0.18, 0.74);
  const liveMotionLineOpacity = clamp(
    liveSpeedRatio * (1 - liveBrakeCoverage * 0.25) * (1 - liveFallProgress * 0.55) * 0.58,
    0,
    0.58
  );
  const liveHeadlightOpacity = clamp(0.22 + liveSpeedRatio * 0.26 - liveFallProgress * 0.12, 0.18, 0.6);
  const liveDangerZoneOpacity = clamp(
    0.26 + (1 - Math.min(liveCountRatio, 1)) * 0.36 + liveFallProgress * 0.28,
    0.24,
    0.88
  );
  const liveSafeZoneOpacity = clamp(0.08 + liveBrakeCoverage * 0.5 + liveHardStopRatio * 0.16, 0.08, 0.82);
  const liveThresholdLightOpacity = clamp(
    0.22 + liveBrakeCoverage * 0.54 + liveHardStopRatio * 0.22,
    0.22,
    0.86
  );
  const liveDangerZoneCenterX = liveCliffEdgeX + 10;
  const liveSafeZoneCenterX = liveSafeStopFrontX - 20;
  const liveSceneClipId = `${liveSceneId}-clip`;
  const liveSkyGradientId = `${liveSceneId}-sky-gradient`;
  const liveCanyonGradientId = `${liveSceneId}-canyon-gradient`;
  const liveAbyssGradientId = `${liveSceneId}-abyss-gradient`;
  const liveTrackPatternId = `${liveSceneId}-track-pattern`;
  const liveSmokeGradientId = `${liveSceneId}-smoke-gradient`;
  const liveHeadlightGradientId = `${liveSceneId}-headlight-gradient`;
  const liveTrackStateLabel =
    livePeopleCount === null
      ? "Counter ready"
      : liveTrainHasHardStopped
        ? "Emergency stop"
        : liveTrackHasCrossedLine
          ? "Safe stop"
          : "Runaway";

  useEffect(() => {
    if (!showLiveRoundCard || !selectedSessionId) {
      liveTrainStopSessionIdRef.current = null;
      liveTrainStopXRef.current = null;
      return;
    }

    if (liveTrainStopSessionIdRef.current !== selectedSessionId) {
      liveTrainStopSessionIdRef.current = selectedSessionId;
      liveTrainStopXRef.current = null;
    }

    if (livePeopleCount === null || displayedThreshold <= 0) {
      liveTrainStopXRef.current = null;
      return;
    }

    if (liveCountRatio >= liveHardStopTriggerRatio) {
      if (liveTrainStopXRef.current === null) {
        liveTrainStopXRef.current = liveComputedTrainFrontX;
      }
      return;
    }

    liveTrainStopXRef.current = null;
  }, [
    displayedThreshold,
    liveComputedTrainFrontX,
    liveCountRatio,
    liveHardStopTriggerRatio,
    livePeopleCount,
    selectedSessionId,
    showLiveRoundCard
  ]);

  const selectedWinningSide = selectedSession ? getWinningSide(selectedSession) : null;
  const selectedResultTone =
    selectedSessionPredictionCount > 1
      ? selectedSessionNetDelta > 0
        ? "win"
        : selectedSessionNetDelta < 0
          ? "loss"
          : "neutral"
      : selectedPrediction?.was_correct === true
        ? "win"
        : selectedPrediction?.was_correct === false
          ? "loss"
          : "neutral";
  const showWinConfetti = showResolvedRoundCard && selectedResultTone === "win";
  const selectedResultPresentation = (() => {
    if (!selectedSession) {
      return {
        eyebrow: "Round closed",
        headline: "Result incoming",
        copy: "Final count is being posted.",
        footer: "Check back in a moment.",
        secondaryLabel: "Status",
        secondaryValue: "Pending"
      };
    }

    const finalCountLabel = selectedSession.final_count !== null ? `${selectedSession.final_count}` : "--";
    const resolvedWinningSideLabel = selectedWinningSide ? selectedWinningSide.toUpperCase() : "Pending";
    const settledAtCopy = selectedEndsAtLabel ? `Round closed at ${selectedEndsAtLabel}.` : "Round closed.";
    const exactLineHit =
      selectedSession.final_count !== null && selectedSession.final_count === selectedSession.threshold;
    const selectedPredictionLabel = selectedPrediction
      ? formatPredictionLabel(selectedPrediction, selectedSession)
      : null;

    if (selectedSessionPredictionCount > 1) {
      if (selectedSessionVoidedCount === selectedSessionPredictionCount) {
        return {
          eyebrow: "Round cancelled",
          headline: "Entries voided",
          copy: `The ${displayedModeSeconds}s round was cancelled after betting closed. All ${selectedSessionPredictionCount} of your tickets were voided.`,
          footer: settledAtCopy,
          secondaryLabel: "Tickets",
          secondaryValue: `${selectedSessionPredictionCount}`
        };
      }

      if (selectedSessionCompletedCount < selectedSessionPredictionCount) {
        return {
          eyebrow: "Round finished",
          headline: "Results syncing",
          copy: `Final count posted at ${finalCountLabel}. ${selectedSessionPredictionCount} tickets are still settling.`,
          footer: "Payouts should land automatically in a moment.",
          secondaryLabel: "Tickets",
          secondaryValue: `${selectedSessionPredictionCount}`
        };
      }

      if (selectedSessionNetDelta > 0) {
        return {
          eyebrow: "Round settled",
          headline: "Net win",
          copy: `Final count hit ${finalCountLabel}. You won ${selectedSessionWonCount} of ${selectedSessionPredictionCount} tickets for ${formatTokenDelta(selectedSessionNetDelta)} net.`,
          footer: settledAtCopy,
          secondaryLabel: "Tickets won",
          secondaryValue: `${selectedSessionWonCount}/${selectedSessionPredictionCount}`
        };
      }

      if (selectedSessionNetDelta < 0) {
        return {
          eyebrow: "Round settled",
          headline: "Net loss",
          copy: `Final count landed at ${finalCountLabel}. You went ${selectedSessionWonCount} for ${selectedSessionPredictionCount} and lost ${Math.abs(selectedSessionNetDelta)} tokens net.`,
          footer: settledAtCopy,
          secondaryLabel: "Tickets won",
          secondaryValue: `${selectedSessionWonCount}/${selectedSessionPredictionCount}`
        };
      }

      return {
        eyebrow: "Round settled",
        headline: "Flat session",
        copy: `Final count landed at ${finalCountLabel}. Your ${selectedSessionPredictionCount} tickets finished flat overall.`,
        footer: settledAtCopy,
        secondaryLabel: "Net session",
        secondaryValue: formatTokenDelta(selectedSessionNetDelta)
      };
    }

    if (selectedPrediction?.resolved_at && selectedPrediction.was_correct === null) {
      return {
        eyebrow: "Round cancelled",
        headline: "Entry voided",
        copy: `The ${displayedModeSeconds}s round was cancelled after betting closed. Your ${selectedPredictionLabel ?? "bet"} will not count.`,
        footer: settledAtCopy,
        secondaryLabel: "Payout",
        secondaryValue: "Voided"
      };
    }

    if (selectedPrediction?.was_correct === true) {
      return {
        eyebrow: "Round settled",
        headline: "You won",
        copy: `Final count hit ${finalCountLabel}. Your ${selectedPredictionLabel ?? "bet"} paid ${formatTokenDelta(selectedPrediction.token_delta)} tokens.`,
        footer: settledAtCopy,
        secondaryLabel: "Token swing",
        secondaryValue: formatTokenDelta(selectedPrediction.token_delta)
      };
    }

    if (selectedPrediction?.was_correct === false) {
      return {
        eyebrow: "Round settled",
        headline: "You lost",
        copy: `Final count landed at ${finalCountLabel}. Your ${selectedPredictionLabel ?? "bet"} missed and cost ${Math.abs(selectedPrediction.token_delta ?? 0)} tokens.`,
        footer: settledAtCopy,
        secondaryLabel: "Token swing",
        secondaryValue: formatTokenDelta(selectedPrediction.token_delta)
      };
    }

    if (selectedPrediction) {
      return {
        eyebrow: "Round finished",
        headline: "Result syncing",
        copy: `Final count posted at ${finalCountLabel}. Your ${selectedPredictionLabel ?? "bet"} is waiting for settlement.`,
        footer: "Payout should land automatically in a moment.",
        secondaryLabel: "Status",
        secondaryValue: "Settling"
      };
    }

    return {
      eyebrow: "Round closed",
      headline: selectedWinningSide
        ? `${resolvedWinningSideLabel} hit`
        : exactLineHit
          ? "Exact line hit"
          : "Round closed",
      copy:
        selectedSession.final_count !== null
          ? `${finalCountLabel} people crossed into the box during the ${displayedModeSeconds}s round.`
          : `The ${displayedModeSeconds}s round has ended.`,
      footer: settledAtCopy,
      secondaryLabel: "Winning side",
      secondaryValue: selectedWinningSide ? resolvedWinningSideLabel : exactLineHit ? "Exact line" : "Pending"
    };
  })();
  const standbyLabel = !selectedSession
    ? "Watching the board"
    : selectedState === "upcoming"
      ? "Next betting window"
    : selectedState === "live"
      ? "Round in motion"
      : selectedState === "resolving"
        ? "Results incoming"
        : selectedState === "resolved"
          ? "Round complete"
          : "Board update";
  const standbyValue = !selectedSession
    ? "Stand by"
    : selectedState === "upcoming"
      ? selectedOpensInLabel
    : selectedState === "live"
      ? "In progress"
      : selectedState === "resolving"
        ? "Reviewing"
        : selectedState === "resolved"
          ? "Wrapped"
          : "Paused";
  const standbyTitle = !selectedSession
    ? "No new Tommy Walkway round has been posted yet."
    : selectedState === "upcoming"
      ? "This market stays locked until five minutes before the round begins."
    : selectedState === "live"
      ? "This count is already underway, so entries are closed for now."
      : selectedState === "resolving"
        ? "This round just closed and the final count is being checked."
        : selectedState === "resolved"
          ? "That round has already finished."
          : "This round is not taking entries.";
  const standbyNote = !selectedSession
    ? user
      ? "This card will refresh on its own as soon as the next window is announced."
      : "Create an account now so you can jump in as soon as the next window opens."
    : selectedState === "upcoming"
      ? `Betting opens at ${selectedOpensAtLabel ?? "soon"}. Round starts at ${selectedStartsAtLabel ?? "shortly after"}.`
    : selectedState === "live"
      ? `Started at ${selectedStartsAtLabel}. Check back here when the next window opens.`
      : selectedState === "resolving"
        ? `Window closed at ${selectedEndsAtLabel}. Final results should appear here shortly.`
        : selectedState === "resolved"
          ? `Last window ended at ${selectedEndsAtLabel}. We will post the next one here when it is ready.`
          : "We will surface the next playable window here as soon as it is available.";
  const standbyMetaItems: StandbyMetaItem[] = !selectedSession
    ? [
        { label: "Status", value: "Awaiting post" },
        { label: "Updates", value: "Auto refresh" }
      ]
    : selectedState === "upcoming"
      ? [
          { label: "Opens", value: selectedStartsAtLabel ?? "Soon" },
          { label: "Closes", value: selectedOpensAtLabel ?? "Soon" }
        ]
      : selectedState === "live"
        ? [
            { label: "Started", value: selectedStartsAtLabel ?? "Live now" },
            { label: "Entries", value: "Locked" }
          ]
        : selectedState === "resolving"
          ? [
              { label: "Closed", value: selectedEndsAtLabel ?? "Just now" },
              { label: "Status", value: "Checking result" }
            ]
          : selectedState === "resolved"
            ? [
                { label: "Ended", value: selectedEndsAtLabel ?? "Finished" },
                { label: "Status", value: "Awaiting next round" }
              ]
            : [
                { label: "Status", value: "Paused" },
                { label: "Updates", value: "Refresh soon" }
              ];
  const standbyActionLabel =
    !user ? "Sign In to Bet" : null;
  const hasUnsavedRegionChanges = !bettingRegionsEqual(regionPoints, savedRegionPoints);
  const canEditRegion = isAdmin && isRegionEditModeEnabled;
  const showRegionEditDock = isAdmin && (isRegionEditModeEnabled || hasUnsavedRegionChanges);
  const activeVisionApiUrl = HUMAN_OVERLAY_PREVIEW_ENABLED ? visionApiUrl : undefined;
  const visionApiBaseUrl = activeVisionApiUrl ? activeVisionApiUrl.replace(/\/+$/, "") : null;
  const liveFrameUrl =
    visionApiBaseUrl && liveDetections?.frame_id
      ? `${visionApiBaseUrl}/detections/live/frame.jpg?frame_id=${encodeURIComponent(
          liveDetections.frame_id
        )}`
      : null;
  const liveFeedAspectRatio =
    liveDetections?.frame_width && liveDetections.frame_height
      ? liveDetections.frame_width / liveDetections.frame_height
      : 16 / 9;
  const liveFeedStatusMessage = getDetectorStatusMessage(liveDetections, Boolean(liveFrameUrl));
  const livePersonBoxes = liveDetections?.boxes ?? [];
  const authModalTitle = authMode === "forgot-password"
    ? "Reset Your Password"
    : authIntentSessionId
    ? authMode === "sign-in"
      ? "Sign In to Join This Round"
      : "Create an Account to Join This Round"
    : authMode === "sign-in"
      ? "Sign In"
      : "Create Your Account";
  const authModalHint = authMode === "forgot-password"
    ? "Enter your account email and we’ll send a secure reset link."
    : authIntentSessionId
    ? authMode === "sign-in"
      ? "Sign in first, then your bet will be submitted automatically."
      : "Create your account first, then your bet will be submitted automatically."
    : authMode === "sign-in"
      ? "Sign in to place bets and track tokens."
      : "Create an account to track tokens and be ready for the next round.";
  const authSubmitLabel =
    authMode === "sign-in"
      ? "Sign In"
      : authMode === "sign-up"
        ? "Create Account"
        : "Send Reset Link";

  function dismissToast(toastId: number) {
    const activeTimeout = toastTimeoutsRef.current.get(toastId);
    if (activeTimeout) {
      clearTimeout(activeTimeout);
      toastTimeoutsRef.current.delete(toastId);
    }

    setToasts((current) => {
      const nextToasts = current.filter((toast) => toast.id !== toastId);
      toastsRef.current = nextToasts;
      return nextToasts;
    });
  }

  function dismissToastByKey(dedupeKey: string) {
    setToasts((current) => {
      const removedToastIds = current
        .filter((toast) => toast.dedupeKey === dedupeKey)
        .map((toast) => toast.id);

      for (const toastId of removedToastIds) {
        const activeTimeout = toastTimeoutsRef.current.get(toastId);
        if (activeTimeout) {
          clearTimeout(activeTimeout);
          toastTimeoutsRef.current.delete(toastId);
        }
      }

      const nextToasts = current.filter((toast) => toast.dedupeKey !== dedupeKey);
      toastsRef.current = nextToasts;
      return nextToasts;
    });
  }

  function pushToast(
    tone: ToastTone,
    message: string | null,
    options?: {
      durationMs?: number;
      persistent?: boolean;
      dedupeKey?: string;
    }
  ) {
    if (!message) {
      return;
    }

    const nextToastId = nextToastIdRef.current + 1;
    nextToastIdRef.current = nextToastId;

    const nextToast: ToastRecord = {
      id: nextToastId,
      tone,
      message,
      dedupeKey: options?.dedupeKey
    };

    if (
      options?.dedupeKey &&
      toastsRef.current.some(
        (toast) => toast.dedupeKey === options.dedupeKey && toast.message === message
      )
    ) {
      return;
    }

    const overflowCount = Math.max(toastsRef.current.length + 1 - MAX_VISIBLE_TOASTS, 0);
    if (overflowCount > 0) {
      const overflowToasts = toastsRef.current.slice(0, overflowCount);
      for (const toast of overflowToasts) {
        const activeTimeout = toastTimeoutsRef.current.get(toast.id);
        if (activeTimeout) {
          clearTimeout(activeTimeout);
          toastTimeoutsRef.current.delete(toast.id);
        }
      }
    }

    const nextToasts = [...toastsRef.current.slice(overflowCount), nextToast];
    toastsRef.current = nextToasts;
    setToasts(nextToasts);

    if (options?.persistent) {
      return;
    }

    const durationMs = options?.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    const timeoutId = setTimeout(() => {
      dismissToast(nextToastId);
    }, durationMs);
    toastTimeoutsRef.current.set(nextToastId, timeoutId);
  }

  function setError(message: string | null) {
    if (!message) {
      return;
    }

    pushToast("error", message, { durationMs: ERROR_TOAST_DURATION_MS });
  }

  function setNotice(message: string | null) {
    if (!message) {
      return;
    }

    pushToast("success", message, { durationMs: SUCCESS_TOAST_DURATION_MS });
  }

  async function refreshData(activeUser: User | null) {
    if (!supabase) {
      setSessions(createFallbackSessions());
      setPredictions([]);
      setLeaderboard([]);
      setProfile(null);
      setStreaks(null);
      setAchievements([]);
      setUserAchievements([]);
      setTokenBalance(0);
      setIsAdmin(false);
      return;
    }

    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const sessionResponse = await supabase
      .from("game_sessions")
      .select(SESSION_SELECT_COLUMNS)
      .gte("ends_at", since)
      .order("starts_at", { ascending: true })
      .limit(24);

    if (sessionResponse.error) {
      throw new Error(sessionResponse.error.message);
    }

    const leaderboardResponse = await supabase.rpc("get_leaderboard", { p_limit: 10 });
    if (leaderboardResponse.error) {
      throw new Error(leaderboardResponse.error.message);
    }

    const sessionRows = (sessionResponse.data as SessionRow[]) ?? [];
    const leaderboardRows = Array.isArray(leaderboardResponse.data)
      ? (leaderboardResponse.data as LeaderboardRow[])
      : [];

    if (!activeUser) {
      setSessions(sessionRows);
      setLeaderboard(leaderboardRows);
      setPredictions([]);
      setProfile(null);
      setStreaks(null);
      setAchievements([]);
      setUserAchievements([]);
      setTokenBalance(0);
      setIsAdmin(false);
      return;
    }

    await supabase.rpc("ensure_user_profile");

    const [
      profileResponse,
      streakResponse,
      balanceResponse,
      predictionResponse,
      adminResponse,
      achievementResponse,
      userAchievementResponse
    ] = await Promise.all([
      fetchProfileRowWithAvatarFallback(supabase, activeUser.id),
      supabase
        .from("user_streaks")
        .select("login_streak,prediction_streak,last_login_date")
        .eq("user_id", activeUser.id)
        .maybeSingle(),
      supabase
        .from("user_token_balances")
        .select("token_balance")
        .eq("user_id", activeUser.id)
        .maybeSingle(),
      supabase
        .from("predictions")
        .select(
          "id,session_id,side,wager_tokens,payout_multiplier_bps,exact_value,range_min,range_max,was_correct,token_delta,resolved_at,placed_at"
        )
        .eq("user_id", activeUser.id)
        .order("placed_at", { ascending: false }),
      supabase
        .from("admin_users")
        .select("user_id")
        .eq("user_id", activeUser.id)
        .maybeSingle(),
      supabase.from("achievements").select("id,slug,name,description,criteria").order("created_at"),
      supabase
        .from("user_achievements")
        .select("achievement_id,awarded_at")
        .eq("user_id", activeUser.id)
        .order("awarded_at", { ascending: true })
    ]);

    if (profileResponse.error) {
      throw new Error(profileResponse.error.message);
    }

    if (streakResponse.error) {
      throw new Error(streakResponse.error.message);
    }

    if (balanceResponse.error) {
      throw new Error(balanceResponse.error.message);
    }

    if (predictionResponse.error) {
      throw new Error(predictionResponse.error.message);
    }

    if (adminResponse.error) {
      throw new Error(adminResponse.error.message);
    }

    if (achievementResponse.error) {
      throw new Error(achievementResponse.error.message);
    }

    if (userAchievementResponse.error) {
      throw new Error(userAchievementResponse.error.message);
    }

    const predictionRows = (predictionResponse.data as PredictionRow[]) ?? [];
    const recentSessionIds = new Set(sessionRows.map((session) => session.id));
    const missingPredictionSessionIds = [...new Set(predictionRows.map((prediction) => prediction.session_id))].filter(
      (sessionId) => !recentSessionIds.has(sessionId)
    );
    let allSessionRows = sessionRows;

    if (missingPredictionSessionIds.length > 0) {
      const predictionSessionResponse = await supabase
        .from("game_sessions")
        .select(SESSION_SELECT_COLUMNS)
        .in("id", missingPredictionSessionIds);

      if (predictionSessionResponse.error) {
        throw new Error(predictionSessionResponse.error.message);
      }

      allSessionRows = mergeSessionRows(
        sessionRows,
        (predictionSessionResponse.data as SessionRow[]) ?? []
      );
    }

    setSessions(allSessionRows);
    setLeaderboard(leaderboardRows);
    setProfile((profileResponse.data as ProfileRow | null) ?? null);
    setStreaks((streakResponse.data as StreakRow | null) ?? null);
    setAchievements((achievementResponse.data as AchievementRow[] | null) ?? []);
    setUserAchievements((userAchievementResponse.data as UserAchievementRow[] | null) ?? []);
    setTokenBalance((balanceResponse.data as BalanceRow | null)?.token_balance ?? 0);
    setPredictions(predictionRows);
    setIsAdmin(Boolean((adminResponse.data as AdminRow | null)?.user_id));
  }

  async function load(activeUser: User | null) {
    try {
      setError(null);
      await refreshData(activeUser);
    } catch (refreshError) {
      const message =
        refreshError instanceof Error ? refreshError.message : "Failed to refresh dashboard.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const normalizedRegion = normalizeBettingRegion(initialRegion);
    setRegionPoints(normalizedRegion);
    setSavedRegionPoints(normalizedRegion);
  }, [initialRegion]);

  useEffect(() => {
    let cancelled = false;

    async function refreshStoredRegion() {
      try {
        const response = await fetch("/api/admin/region", {
          cache: "no-store"
        });
        const payload = (await response.json()) as { points?: RegionPoint[] } | undefined;
        if (!response.ok || !payload?.points || cancelled) {
          return;
        }

        const normalizedRegion = normalizeBettingRegion(payload.points);
        setRegionPoints(normalizedRegion);
        setSavedRegionPoints(normalizedRegion);
      } catch {
        // Keep the seeded default region if the live fetch fails.
      }
    }

    void refreshStoredRegion();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mobileMediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    const phoneMediaQuery = window.matchMedia(`(max-width: ${PHONE_BREAKPOINT_PX}px)`);
    const updateViewport = () => {
      setIsMobileViewport(mobileMediaQuery.matches);
      setIsPhoneViewport(phoneMediaQuery.matches);
    };

    updateViewport();

    if (
      typeof mobileMediaQuery.addEventListener === "function" &&
      typeof phoneMediaQuery.addEventListener === "function"
    ) {
      mobileMediaQuery.addEventListener("change", updateViewport);
      phoneMediaQuery.addEventListener("change", updateViewport);
      return () => {
        mobileMediaQuery.removeEventListener("change", updateViewport);
        phoneMediaQuery.removeEventListener("change", updateViewport);
      };
    }

    mobileMediaQuery.addListener(updateViewport);
    phoneMediaQuery.addListener(updateViewport);
    return () => {
      mobileMediaQuery.removeListener(updateViewport);
      phoneMediaQuery.removeListener(updateViewport);
    };
  }, []);

  useEffect(() => {
    const activeToastTimeouts = toastTimeoutsRef.current;

    return () => {
      for (const timeoutId of activeToastTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      activeToastTimeouts.clear();
    };
  }, []);

  useEffect(() => {
    profileSettingsDirtyRef.current = profileSettingsDirty;
  }, [profileSettingsDirty]);

  useEffect(() => {
    const sourceProfile = isProfilePreviewMode ? PROFILE_PREVIEW_PROFILE : profile;
    const nextForm = createProfileSettingsFormState(sourceProfile, accountEmail || PROFILE_PREVIEW_EMAIL);

    if (!user && !isProfilePreviewMode) {
      setProfileSettings(nextForm);
      setProfileSettingsBaseline(nextForm);
      return;
    }

    setProfileSettingsBaseline(nextForm);

    if (!profileSettingsDirtyRef.current) {
      setProfileSettings(nextForm);
    }
  }, [accountEmail, isProfilePreviewMode, profile, user]);

  useEffect(() => {
    if (!supabase) {
      pushToast(
        "warning",
        "Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in apps/web/.env.local.",
        {
          persistent: true,
          dedupeKey: "supabase-config"
        }
      );
      return;
    }

    dismissToastByKey("supabase-config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  useEffect(() => {
    if (!supabase) {
      void load(null);
      return;
    }

    const client = supabase;
    let isMounted = true;

    async function bootstrap() {
      const userResponse = await client.auth.getUser();
      if (!isMounted) {
        return;
      }

      const nextUser = userResponse.data.user ?? null;
      setUser(nextUser);
      await load(nextUser);
    }

    void bootstrap();

    const {
      data: { subscription }
    } = client.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      startTransition(() => {
        void load(nextUser);
      });
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const refreshInterval = setInterval(() => {
      startTransition(() => {
        void load(user);
      });
    }, 20_000);

    return () => {
      clearInterval(refreshInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, user]);

  useEffect(() => {
    if (!activeVisionApiUrl) {
      setLiveDetections(null);
      return;
    }

    const endpoint = `${activeVisionApiUrl.replace(/\/+$/, "")}/detections/live`;
    let isMounted = true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    async function fetchDetections() {
      activeController?.abort();
      activeController = new AbortController();
      let nextPollDelay = DETECTION_POLL_INTERVAL_MS;

      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: activeController.signal
        });
        if (!response.ok) {
          if (!isMounted) {
            return;
          }

          nextPollDelay = DETECTION_OFFLINE_RETRY_INTERVAL_MS;
          setLiveDetections((current) =>
            current
              ? {
                  ...current,
                  status: "offline"
                }
              : {
                  status: "offline",
                  boxes: []
                }
          );
          return;
        }

        const payload = (await response.json()) as LiveDetectionsResponse;
        if (!isMounted) {
          return;
        }

        setLiveDetections({
          status: payload.status ?? "online",
          updated_at: payload.updated_at ?? null,
          frame_id: payload.frame_id ?? null,
          frame_width: payload.frame_width ?? null,
          frame_height: payload.frame_height ?? null,
          boxes: Array.isArray(payload.boxes) ? payload.boxes : []
        });
      } catch (fetchError) {
        if (!isMounted) {
          return;
        }

        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }

        nextPollDelay = DETECTION_OFFLINE_RETRY_INTERVAL_MS;
        setLiveDetections((current) =>
          current
            ? {
                ...current,
                status: "offline"
              }
            : {
                status: "offline",
                boxes: []
              }
        );
      } finally {
        if (isMounted) {
          timeoutId = setTimeout(() => {
            void fetchDetections();
          }, nextPollDelay);
        }
      }
    }

    void fetchDetections();

    return () => {
      isMounted = false;
      activeController?.abort();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [activeVisionApiUrl]);

  useEffect(() => {
    if (isAdmin) {
      return;
    }

    if (openRightPanel === "admin") {
      setOpenRightPanel(null);
    }

    setIsRegionEditModeEnabled(false);
    setRegionPoints(savedRegionPoints);
  }, [isAdmin, openRightPanel, savedRegionPoints]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) {
      return;
    }

    setError(null);
    setNotice(null);
    const normalizedEmail = email.trim();

    if (authMode === "forgot-password") {
      const redirectTo = new URL("/reset-password", window.location.origin).toString();
      const resetResponse = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo
      });

      if (resetResponse.error) {
        setError(resetResponse.error.message);
        return;
      }

      setPassword("");
      setAuthModalMode("sign-in");
      setNotice(`Password reset link sent to ${normalizedEmail}.`);
      return;
    }

    if (authMode === "sign-up") {
      const signUpResponse = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          data: {
            display_name: displayName.trim()
          }
        }
      });

      if (signUpResponse.error) {
        setError(signUpResponse.error.message);
        return;
      }

      if (!signUpResponse.data.session) {
        setNotice("Account created. Check your inbox to verify your email before signing in.");
        return;
      }

      setNotice("Account created. You are signed in.");
      const nextUser = signUpResponse.data.session.user;
      setUser(nextUser);
      await load(nextUser);
      closeAuthModal();

      const intendedSession = sessions.find((session) => session.id === authIntentSessionId);
      if (intendedSession) {
        await handlePlacePrediction(intendedSession, nextUser);
      }
      return;
    }

    const signInResponse = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password
    });

    if (signInResponse.error) {
      setError(signInResponse.error.message);
      return;
    }

    const nextUser = signInResponse.data.user;
    setUser(nextUser);
    await load(nextUser);
    closeAuthModal();

    const intendedSession = sessions.find((session) => session.id === authIntentSessionId);
    if (intendedSession) {
      await handlePlacePrediction(intendedSession, nextUser);
    }
  }

  async function handleSignOut() {
    if (!supabase) {
      return;
    }

    setError(null);
    setNotice(null);
    const signOutResponse = await supabase.auth.signOut();
    if (signOutResponse.error) {
      setError(signOutResponse.error.message);
      return;
    }

    setUser(null);
    setIsAdmin(false);
    setOpenRightPanel(null);
    setNotice("Signed out.");
    await load(null);
  }

  async function handleClaimDailyLogin() {
    if (!supabase || !user || isClaimingDailyLogin || !dailyClaimState.canClaim) {
      return;
    }

    setIsClaimingDailyLogin(true);

    try {
      setError(null);
      setNotice(null);

      const claimResponse = await supabase.rpc("claim_daily_login");
      if (claimResponse.error) {
        setError(claimResponse.error.message);
        startTransition(() => {
          void load(user);
        });
        return;
      }

      const claim = Array.isArray(claimResponse.data)
        ? (claimResponse.data[0] as
            | { tokens_awarded: number; token_balance: number; login_streak: number }
            | undefined)
        : undefined;

      if (claim) {
        setTokenBalance(claim.token_balance);
        setStreaks((current) => ({
          login_streak: claim.login_streak,
          prediction_streak: current?.prediction_streak ?? 0,
          last_login_date: getDailyClaimClockParts(Date.now()).claimDate
        }));
        setNotice(`Daily reward claimed: +${claim.tokens_awarded} tokens (streak ${claim.login_streak}).`);
      }

      startTransition(() => {
        void load(user);
      });
    } finally {
      setIsClaimingDailyLogin(false);
    }
  }

  function handleResetProfileSettings() {
    setProfileSettings(profileSettingsBaseline);
  }

  async function handleSaveProfileSettings() {
    if (!supabase || !user || isSavingProfileSettings) {
      return;
    }

    const trimmedDisplayName = profileSettings.displayName.trim();

    if (trimmedDisplayName.length < 2 || trimmedDisplayName.length > 64) {
      setError("Display name must be between 2 and 64 characters.");
      return;
    }

    if (profileSettings.avatarType === "upload" && !profileSettings.avatarValue.startsWith("data:image/")) {
      setError("Upload a photo or choose one of the built-in icons.");
      return;
    }

    setIsSavingProfileSettings(true);
    setError(null);

    try {
      const nextProfilePayload = {
        display_name: trimmedDisplayName,
        preferred_mode_seconds: profileSettings.preferredModeSeconds,
        avatar_type: profileSettings.avatarType,
        avatar_value: profileSettings.avatarValue
      };

      const updateResponse = await updateProfileWithAvatarFallback(supabase, user.id, nextProfilePayload);

      if (updateResponse.error) {
        setError(updateResponse.error.message);
        return;
      }

      setProfile((current) => ({
        display_name: trimmedDisplayName,
        tier: current?.tier ?? "Bronze",
        created_at: current?.created_at ?? new Date().toISOString(),
        preferred_mode_seconds: profileSettings.preferredModeSeconds,
        avatar_type: profileSettings.avatarType,
        avatar_value: profileSettings.avatarValue
      }));
      setProfileSettingsBaseline(profileSettings);
      setNotice(updateResponse.avatarPersisted ? "Profile updated." : "Profile updated. Avatar changes require latest DB migration.");

      startTransition(() => {
        void load(user);
      });
    } finally {
      setIsSavingProfileSettings(false);
    }
  }

  function handleOpenAvatarUploadPicker() {
    avatarUploadInputRef.current?.click();
  }

  async function handleProfileAvatarUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const normalizedAvatarDataUrl = await convertUploadedAvatarToDataUrl(file);
      setProfileSettings((current) => ({
        ...current,
        avatarType: "upload",
        avatarValue: normalizedAvatarDataUrl
      }));
      setNotice("Photo ready to save.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not prepare that photo.");
    }
  }

  async function handlePlacePrediction(session: SessionRow, activeUser: User | null = user) {
    if (!supabase || !activeUser) {
      return;
    }

    const wagerRaw = wagerBySession[session.id] ?? DEFAULT_WAGER;
    const wagerTokens = Number.parseInt(wagerRaw, 10);

    if (!Number.isFinite(wagerTokens) || wagerTokens <= 0) {
      setError("Wager must be a positive integer.");
      return;
    }

    const side = sideBySession[session.id] ?? "over";
    const exactValueRaw = exactValueBySession[session.id] ?? String(session.threshold);
    const exactValue = Number.parseInt(exactValueRaw, 10);
    const rangeMinRaw = rangeMinBySession[session.id] ?? getDefaultRangeMin(session.threshold);
    const rangeMaxRaw = rangeMaxBySession[session.id] ?? getDefaultRangeMax(session.threshold);
    const rangeMin = Number.parseInt(rangeMinRaw, 10);
    const rangeMax = Number.parseInt(rangeMaxRaw, 10);

    if (side === "exact" && (!Number.isFinite(exactValue) || exactValue < 0)) {
      setError("Exact bets need a whole-number count of zero or more.");
      return;
    }

    if (
      side === "range" &&
      (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax) || rangeMin < 0 || rangeMax < rangeMin)
    ) {
      setError("Range bets need whole-number bounds with a minimum that is not above the maximum.");
      return;
    }

    setError(null);
    setNotice(null);

    const predictionResponse = await supabase.rpc("place_prediction", {
      p_session_id: session.id,
      p_side: side,
      p_wager_tokens: wagerTokens,
      p_exact_value: side === "exact" ? exactValue : null,
      p_range_min: side === "range" ? rangeMin : null,
      p_range_max: side === "range" ? rangeMax : null
    });

    if (predictionResponse.error) {
      setError(predictionResponse.error.message);
      return;
    }

    const predictionResult = Array.isArray(predictionResponse.data)
      ? (predictionResponse.data[0] as { available_tokens: number } | undefined)
      : undefined;

    if (predictionResult) {
      setTokenBalance(predictionResult.available_tokens);
    }

    startTransition(() => {
      void load(activeUser);
    });
  }

  async function handleCancelPrediction(prediction: PredictionRow, activeUser: User | null = user) {
    if (!supabase || !activeUser) {
      return;
    }

    setCancelingPredictionIds((current) => [...current, prediction.id]);
    setError(null);
    setNotice(null);

    try {
      const cancelResponse = await supabase.rpc("cancel_prediction", {
        p_prediction_id: prediction.id
      });

      if (cancelResponse.error) {
        setError(cancelResponse.error.message);
        return;
      }

      const cancelResult = Array.isArray(cancelResponse.data)
        ? (cancelResponse.data[0] as { available_tokens: number } | undefined)
        : undefined;

      if (cancelResult) {
        setTokenBalance(cancelResult.available_tokens);
      }

      setNotice(`Bet removed. ${prediction.wager_tokens} tokens refunded.`);
      startTransition(() => {
        void load(activeUser);
      });
    } finally {
      setCancelingPredictionIds((current) => current.filter((id) => id !== prediction.id));
    }
  }

  async function startSignUpMode(forcePrefill = false) {
    setAuthMode("sign-up");

    const trimmedDisplayName = displayName.trim();
    if (!forcePrefill && trimmedDisplayName.length > 0 && !/^anon#\d+$/i.test(trimmedDisplayName)) {
      return;
    }

    const requestId = anonDisplayNameRequestRef.current + 1;
    anonDisplayNameRequestRef.current = requestId;
    setDisplayName("anon#1");

    if (!supabase) {
      return;
    }

    const suggestedNameResponse = await supabase.rpc("suggest_anon_display_name");

    if (anonDisplayNameRequestRef.current !== requestId) {
      return;
    }

    if (suggestedNameResponse.error) {
      return;
    }

    if (typeof suggestedNameResponse.data === "string" && suggestedNameResponse.data.trim().length > 0) {
      setDisplayName(suggestedNameResponse.data.trim());
    }
  }

  function setAuthModalMode(nextMode: AuthMode) {
    if (nextMode === "sign-up") {
      void startSignUpMode();
      return;
    }

    anonDisplayNameRequestRef.current += 1;
    setAuthMode(nextMode);
  }

  function closeAuthModal() {
    anonDisplayNameRequestRef.current += 1;
    setShowAuthModal(false);
    setAuthIntentSessionId(null);
    setAuthMode("sign-in");
    setPassword("");
  }

  function closePublicProfile() {
    publicProfileLoadIdRef.current += 1;
    setPublicProfileContext(null);
    setPublicProfileSummary(null);
    setPublicProfilePredictions([]);
    setPublicProfileError(null);
    setIsPublicProfileLoading(false);
    setPublicProfileHistoryFilter("all");
  }

  function openAuthModal(mode: "sign-in" | "sign-up", sessionId: string | null = null) {
    if (!supabase) {
      setError(`Configure Supabase before ${mode === "sign-in" ? "signing in" : "creating an account"}.`);
      return;
    }

    setError(null);
    setNotice(null);
    setAuthIntentSessionId(sessionId);
    setShowAuthModal(true);

    if (mode === "sign-up") {
      void startSignUpMode(true);
      return;
    }

    setAuthModalMode(mode);
  }

  async function handleOpenPublicProfile(entry: LeaderboardRow) {
    if (!supabase) {
      setError("Configure Supabase before opening public bettor profiles.");
      return;
    }

    const nextLoadId = publicProfileLoadIdRef.current + 1;
    publicProfileLoadIdRef.current = nextLoadId;
    setPublicProfileContext({
      user_id: entry.user_id,
      display_name: entry.display_name,
      tier: entry.tier,
      rank: entry.rank
    });
    setPublicProfileSummary(null);
    setPublicProfilePredictions([]);
    setPublicProfileError(null);
    setIsPublicProfileLoading(true);
    setPublicProfileHistoryFilter("all");

    try {
      const [profileResponse, historyResponse] = await Promise.all([
        supabase.rpc("get_public_profile", {
          p_user_id: entry.user_id
        }),
        supabase.rpc("get_public_prediction_history", {
          p_user_id: entry.user_id,
          p_limit: 40
        })
      ]);

      if (publicProfileLoadIdRef.current !== nextLoadId) {
        return;
      }

      if (profileResponse.error) {
        throw new Error(profileResponse.error.message);
      }

      if (historyResponse.error) {
        throw new Error(historyResponse.error.message);
      }

      const nextSummary = Array.isArray(profileResponse.data)
        ? ((profileResponse.data[0] as PublicProfileSummaryRow | undefined) ?? null)
        : null;

      if (!nextSummary) {
        throw new Error("This bettor profile is not available right now.");
      }

      setPublicProfileSummary(nextSummary);
      setPublicProfilePredictions(
        Array.isArray(historyResponse.data)
          ? (historyResponse.data as PublicPredictionHistoryRow[])
          : []
      );
    } catch (profileError) {
      if (publicProfileLoadIdRef.current !== nextLoadId) {
        return;
      }

      const message =
        profileError instanceof Error ? profileError.message : "Failed to load this bettor profile.";
      setPublicProfileError(message);
    } finally {
      if (publicProfileLoadIdRef.current === nextLoadId) {
        setIsPublicProfileLoading(false);
      }
    }
  }

  function updateSelectedSide(sessionId: string, nextSide: PredictionSide) {
    setSideBySession((current) => ({
      ...current,
      [sessionId]: nextSide
    }));
  }

  function updateSelectedExactValue(sessionId: string, nextExactValue: string) {
    setExactValueBySession((current) => ({
      ...current,
      [sessionId]: nextExactValue
    }));
  }

  function updateSelectedRangeMin(sessionId: string, nextRangeMin: string) {
    setRangeMinBySession((current) => ({
      ...current,
      [sessionId]: nextRangeMin
    }));
  }

  function updateSelectedRangeMax(sessionId: string, nextRangeMax: string) {
    setRangeMaxBySession((current) => ({
      ...current,
      [sessionId]: nextRangeMax
    }));
  }

  function updateSelectedWager(sessionId: string, nextWager: string) {
    setWagerBySession((current) => ({
      ...current,
      [sessionId]: nextWager
    }));
  }

  function updateMobileDockSide(nextSide: PredictionSide) {
    if (selectedSession) {
      updateSelectedSide(selectedSession.id, nextSide);
      return;
    }

    setMobileStandbySide(nextSide);
  }

  function updateMobileDockExactValue(nextExactValue: string) {
    if (selectedSession) {
      updateSelectedExactValue(selectedSession.id, nextExactValue);
      return;
    }

    setMobileStandbyExactValue(nextExactValue);
  }

  function updateMobileDockRangeMin(nextRangeMin: string) {
    if (selectedSession) {
      updateSelectedRangeMin(selectedSession.id, nextRangeMin);
      return;
    }

    setMobileStandbyRangeMin(nextRangeMin);
  }

  function updateMobileDockRangeMax(nextRangeMax: string) {
    if (selectedSession) {
      updateSelectedRangeMax(selectedSession.id, nextRangeMax);
      return;
    }

    setMobileStandbyRangeMax(nextRangeMax);
  }

  function updateMobileDockWager(nextWager: string) {
    if (selectedSession) {
      updateSelectedWager(selectedSession.id, nextWager);
      return;
    }

    setMobileStandbyWager(nextWager);
  }

  function adjustSelectedWager(sessionId: string, delta: number) {
    const currentWager = Number.parseInt(wagerBySession[sessionId] ?? DEFAULT_WAGER, 10);
    const safeWager = Number.isFinite(currentWager) ? currentWager : Number.parseInt(DEFAULT_WAGER, 10);
    updateSelectedWager(sessionId, String(Math.max(1, safeWager + delta)));
  }

  function handleBetAction(session: SessionRow) {
    if (!canConfigureSelected) {
      return;
    }

    if (!supabase && !user) {
      setError("Configure Supabase before signing in and placing bets.");
      return;
    }

    if (!user) {
      openAuthModal("sign-in", session.id);
      return;
    }

    void handlePlacePrediction(session, user);
  }

  function handleEmptyStateSignInAction() {
    if (!emptyStateSignInEnabled) {
      return;
    }

    openAuthModal("sign-in");
  }

  function handleRoundAuthAction() {
    openAuthModal("sign-in");
  }

  function applyMobileWagerPreset(preset: "min" | "double" | number) {
    if (selectedSession && !canPreviewSelected) {
      return;
    }

    if (preset === "min") {
      updateMobileDockWager("1");
      return;
    }

    if (preset === "double") {
      const parsedCurrentWager = Number.parseInt(selectedWager, 10);
      const nextWager = Math.max(Number.isFinite(parsedCurrentWager) ? parsedCurrentWager : 1, 1) * 2;
      updateMobileDockWager(String(nextWager));
      return;
    }

    if (selectedSession) {
      adjustSelectedWager(selectedSession.id, preset);
      return;
    }

    const currentWager = Number.parseInt(selectedWager, 10);
    const safeWager = Number.isFinite(currentWager) ? currentWager : Number.parseInt(DEFAULT_WAGER, 10);
    updateMobileDockWager(String(Math.max(1, safeWager + preset)));
  }

  function adjustMobileDockWager(delta: number) {
    const currentWager = Number.parseInt(selectedWager, 10);
    const safeWager = Number.isFinite(currentWager) ? currentWager : Number.parseInt(DEFAULT_WAGER, 10);
    updateMobileDockWager(String(Math.max(1, safeWager + delta)));
  }

  function adjustMobileDockExactValue(delta: number) {
    const currentExactValue = Number.parseInt(selectedExactValue, 10);
    const safeExactValue = Number.isFinite(currentExactValue)
      ? currentExactValue
      : Number.parseInt(DEFAULT_EXACT_VALUE, 10);
    updateMobileDockExactValue(String(Math.max(0, safeExactValue + delta)));
  }

  function adjustMobileDockRangeMin(delta: number) {
    const currentMin = Number.parseInt(selectedRangeMin, 10);
    const currentMax = Number.parseInt(selectedRangeMax, 10);
    const fallbackMin = Number.parseInt(getDefaultRangeMin(displayedThreshold), 10);
    const fallbackMax = Number.parseInt(getDefaultRangeMax(displayedThreshold), 10);
    const safeMin = Number.isFinite(currentMin) ? Math.max(currentMin, 0) : fallbackMin;
    const safeMaxBase = Number.isFinite(currentMax) ? Math.max(currentMax, 0) : fallbackMax;
    const safeMax = Math.max(safeMaxBase, safeMin);
    const nextMin = clamp(safeMin + delta, 0, safeMax);

    updateMobileDockRangeMin(String(nextMin));
  }

  function adjustMobileDockRangeMax(delta: number) {
    const currentMin = Number.parseInt(selectedRangeMin, 10);
    const currentMax = Number.parseInt(selectedRangeMax, 10);
    const fallbackMin = Number.parseInt(getDefaultRangeMin(displayedThreshold), 10);
    const fallbackMax = Number.parseInt(getDefaultRangeMax(displayedThreshold), 10);
    const safeMin = Number.isFinite(currentMin) ? Math.max(currentMin, 0) : fallbackMin;
    const safeMaxBase = Number.isFinite(currentMax) ? Math.max(currentMax, 0) : fallbackMax;
    const safeMax = Math.max(safeMaxBase, safeMin);
    const nextMax = Math.max(safeMin, safeMax + delta);

    updateMobileDockRangeMax(String(nextMax));
  }

  function handleAccountAction() {
    if (!user) {
      setOpenRightPanel(null);
      openAuthModal("sign-in");
      return;
    }

    toggleRightPanel("account");
  }

  function toggleRightPanel(panel: "account" | "leaderboard" | "admin") {
    setOpenRightPanel((current) => (current === panel ? null : panel));
  }

  async function handleSaveRegion() {
    if (!isAdmin || !supabase || !user) {
      return;
    }

    setError(null);
    setNotice(null);
    setIsSavingRegion(true);

    try {
      const sessionResponse = await supabase.auth.getSession();
      const accessToken = sessionResponse.data.session?.access_token;
      if (!accessToken) {
        throw new Error("Admin session expired. Sign in again to save the region.");
      }

      const response = await fetch("/api/admin/region", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          points: regionPoints
        })
      });
      const payload = (await response.json()) as
        | { points?: RegionPoint[]; error?: string }
        | undefined;

      if (!response.ok || !payload?.points) {
        throw new Error(payload?.error ?? "Failed to save betting region.");
      }

      const normalizedRegion = normalizeBettingRegion(payload.points);
      setRegionPoints(normalizedRegion);
      setSavedRegionPoints(normalizedRegion);
      setIsRegionEditModeEnabled(false);
      setNotice("Betting region saved.");
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Failed to save betting region.";
      setError(message);
    } finally {
      setIsSavingRegion(false);
    }
  }

  function handleResetRegion() {
    setRegionPoints(savedRegionPoints);
  }

  function handleToggleRegionEditMode() {
    setIsRegionEditModeEnabled((current) => !current);
  }

  function handleStartRegionEditModeFromAdmin() {
    setIsRegionEditModeEnabled(true);
    setOpenRightPanel(null);
  }

  const mobileMarketChoices = [
    {
      side: "under" as const,
      accent: "under",
      icon: "↓",
      label: "Under",
      detail: `Below ${displayedThreshold}`,
      multiplier: formatPayoutMultiplier(getPredictionPayoutMultiplierBps("under"))
    },
    {
      side: "over" as const,
      accent: "over",
      icon: "↑",
      label: "Over",
      detail: `${displayedThreshold} or more`,
      multiplier: formatPayoutMultiplier(getPredictionPayoutMultiplierBps("over"))
    },
    {
      side: "exact" as const,
      accent: "exact",
      icon: "=",
      label: "Exact",
      detail: selectedExactValue ? `Call ${selectedExactValue}` : "Name the final count",
      multiplier: formatPayoutMultiplier(getPredictionPayoutMultiplierBps("exact"))
    },
    {
      side: "range" as const,
      accent: "range",
      icon: "≈",
      label: "Range",
      detail:
        selectedRangeMin && selectedRangeMax
          ? `${selectedRangeMin} to ${selectedRangeMax}`
          : "Pick a min and max",
      multiplier: formatPayoutMultiplier(
        getPredictionPayoutMultiplierBps("range", selectedPricingRangeMin, selectedPricingRangeMax)
      )
    }
  ];
  const mobileSelectedChoice =
    mobileMarketChoices.find((choice) => choice.side === selectedSide) ?? mobileMarketChoices[2];
  const shouldFocusMobileFeed = regionPoints.length >= 3 && !canEditRegion;
  const mobileFeedStatusLabel = showResolvedRoundCard ? "Result posted" : "Live feed";
  const mobileFeedMetaLabel = hasSelectedSession
    ? `${sessionMetricLabel} ${sessionMetricValue}`
    : "Tommy Walkway";
  const mobileDockTitle = showBettingControls
    ? "Place your bet"
    : showResolvedRoundCard
      ? selectedResultPresentation.headline
      : selectedState === "upcoming"
        ? "Next betting window"
        : standbyValue;
  const mobileDockCopy = showBettingControls
    ? "Choose a market, set your stake, and lock it in before the window closes."
    : !user && !hasSelectedSession
      ? "Sign in now so you're ready when the next round is posted."
      : standbyNote;
  const mobileOpenOverlayCopy = [
    selectedStartsAtLabel ? `Closes at ${selectedStartsAtLabel}` : null,
    hasSelectedSession ? `${displayedModeSeconds}s round` : null,
    hasSelectedSession ? `Line ${displayedThreshold}` : null
  ]
    .filter(Boolean)
    .join(" • ");
  const showMobileOpenBetWidget = showBettingControls && selectedSessionPredictionCount > 0;
  const mobileLiveCountDisplay = livePeopleCount === null ? "--" : livePeopleCountDisplay;
  const mobileLiveCountNote =
    livePeopleCount === null
      ? selectedState === "resolving"
        ? "Final count syncing from the live feed."
        : "Counter syncing to the live feed."
      : livePeopleCount === displayedThreshold
        ? "Exactly on the betting line."
        : livePeopleCount > displayedThreshold
          ? `${livePeopleCount - displayedThreshold} above the betting line.`
          : `${displayedThreshold - livePeopleCount} below the betting line.`;
  const mobileLiveMeterStateTone =
    livePeopleCount === null
      ? "syncing"
      : livePeopleCount === displayedThreshold
        ? "exact"
        : livePeopleCount > displayedThreshold
          ? "over"
          : "under";
  const mobileLiveMeterStateLabel =
    livePeopleCount === null
      ? "Counter syncing"
      : livePeopleCount === displayedThreshold
        ? "On the line"
        : livePeopleCount > displayedThreshold
          ? `${livePeopleCount - displayedThreshold} above line`
          : `${displayedThreshold - livePeopleCount} below line`;
  const mobileLiveMeterSummary =
    livePeopleCount === null
      ? "Tracking live movement"
      : livePeopleCount === displayedThreshold
        ? "Exact line live right now"
        : livePeopleCount > displayedThreshold
          ? "Over is ahead right now"
          : "Under is ahead right now";
  const mobileLiveThresholdMarkerPercent = 72;
  const mobileLiveMeterFillPercent =
    livePeopleCount === null
      ? 24 + liveElapsedRatio * 20
      : displayedThreshold > 0
        ? clamp((liveCountValue / displayedThreshold) * mobileLiveThresholdMarkerPercent, 0, 100)
        : 0;
  const showMobileUpcomingDock = Boolean(selectedSession && selectedState === "upcoming");
  const showMobileIdleDock = !selectedSession;
  const showMobileDisabledDock = showMobileIdleDock || showMobileUpcomingDock;
  const showIdleSignInCta = showMobileIdleDock && !user;
  const showUpcomingSignInCta = showMobileUpcomingDock && !user;
  const showMobileOpenDock = showBettingControls || showMobileDisabledDock;
  const canInteractWithMobileDockControls = canPreviewSelected || showMobileIdleDock;
  const showMobileLiveDock = Boolean(selectedSession && selectedState === "live");
  const showMobileResolvingDock = Boolean(selectedSession && selectedState === "resolving");
  const mobileNoGameOverlayCopy =
    "There is no game right now. Waiting for an admin to post the next round.";
  const mobileUpcomingOverlayTitle = selectedOpensAtLabel ? `Opens at ${selectedOpensAtLabel}` : "Opening soon";
  const mobileUpcomingOverlayCopy = selectedStartsAtLabel
    ? `Round starts at ${selectedStartsAtLabel}.`
    : "This preview unlocks automatically when betting opens.";
  const mobileDockBetButtonDisabled = showMobileIdleDock
    ? !showIdleSignInCta
    : showMobileUpcomingDock
      ? !showUpcomingSignInCta
      : betButtonDisabled;
  const mobileDockBetButtonLabel = showIdleSignInCta || showUpcomingSignInCta
    ? "Sign In to Bet"
    : showMobileIdleDock
      ? "Waiting for next round"
      : showMobileUpcomingDock
        ? "Waiting for betting window"
      : betButtonLabel;
  const mobileDockBetButtonAccent = showIdleSignInCta || showUpcomingSignInCta
    ? "Sign In"
    : showMobileIdleDock
      ? "Standby"
      : showMobileUpcomingDock
        ? "Scheduled"
      : mobileSelectedChoice.label;
  const mobileOpenInfoTitle = `${mobileSelectedChoice.label} • Line ${displayedThreshold} • ${mobileSelectedChoice.multiplier}`;
  const mobileOpenInfoCopy =
    selectedSide === "under"
      ? `Wins below ${displayedThreshold}.`
      : selectedSide === "over"
        ? `Wins at ${displayedThreshold} or above.`
        : selectedSide === "exact"
          ? "Pick the exact final count."
          : "Set the min and max you want to cover.";
  const showMobileParameterInputs = selectedSide === "exact" || selectedSide === "range";
  const mobileOpenControlGridClassName = showMobileParameterInputs
    ? "mobile-open-control-grid mobile-open-control-grid-split"
    : "mobile-open-control-grid mobile-open-control-grid-stake-only";
  const showDesktopBettingScreen = showBettingControls || showMobileDisabledDock;
  const desktopOpenTimerLabel = showMobileIdleDock
    ? "Betting window"
    : showMobileUpcomingDock
      ? "Opens at"
      : "Closes in";
  const desktopOpenTimerValue = showMobileIdleDock
    ? "Waiting for next round"
    : showMobileUpcomingDock
      ? (selectedOpensAtLabel ?? "Soon")
      : selectedCountdown;
  const mobileLiveOverlayTimeNote = selectedEndsAtLabel
    ? `Closes at ${selectedEndsAtLabel}`
    : `${displayedModeSeconds}s round`;
  const mobileLiveOverlayTicketSummary =
    selectedSessionPredictionCount > 1
      ? `${selectedSessionPredictionCount} bets live`
      : selectedPrediction && selectedSession
        ? formatPredictionLabel(selectedPrediction, selectedSession)
        : "Watch mode";
  const mobileResolvedPrimaryStatLabel =
    selectedSessionPredictionCount > 1
      ? "Tickets settled"
      : selectedPrediction
        ? "Your ticket"
        : "Winning side";
  const mobileResolvedPrimaryStatValue =
    selectedSessionPredictionCount > 1
      ? `${selectedSessionPredictionCount}`
      : selectedPrediction && selectedSession
        ? formatPredictionLabel(selectedPrediction, selectedSession)
        : selectedWinningSide
          ? selectedWinningSide.toUpperCase()
          : "Pending";
  const mobileDockMetaItems =
    showResolvedRoundCard && selectedSession
      ? [
          { label: "Final count", value: `${selectedSession.final_count ?? "--"}` },
          { label: "Betting line", value: `${displayedThreshold}` }
        ]
      : standbyMetaItems;
  const mobileFloatingActions = (
    <div className="mobile-floating-actions">
      {user ? (
        <div className="mobile-hud-balance" aria-label={`Token balance ${tokenBalance}`}>
          <span className="mobile-hud-balance-icon" aria-hidden="true">
            $
          </span>
          <strong>{tokenBalance}</strong>
        </div>
      ) : null}
      {isAdmin ? (
        <button
          type="button"
          className="mobile-floating-icon-button"
          onClick={() => toggleRightPanel("admin")}
          aria-label="Open admin panel"
        >
          <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
            <path d="M12 2.5 4.5 5.3v5.5c0 4.9 3 9.4 7.5 10.7 4.5-1.3 7.5-5.8 7.5-10.7V5.3L12 2.5Zm0 2.1 5.3 2v4.2c0 3.9-2.2 7.3-5.3 8.5-3.1-1.2-5.3-4.6-5.3-8.5V6.6l5.3-2Zm-2 4.1h4v1.4H10V8.7Zm0 3.1h4v1.4H10v-1.4Zm0 3.1h4v1.4H10v-1.4Z" />
          </svg>
        </button>
      ) : null}
      <button
        type="button"
        className="mobile-floating-icon-button mobile-floating-icon-button-leaderboard"
        onClick={() => toggleRightPanel("leaderboard")}
        aria-label="Open leaderboard panel"
      >
        <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
          <path d="M7 4h10v3a5 5 0 0 1-4 4.9V14h3v2H8v-2h3v-2.1A5 5 0 0 1 7 7V4Zm2 2v1a3 3 0 0 0 6 0V6H9Zm-3 1h1a4.9 4.9 0 0 0 .6 2.3A3 3 0 0 1 6 7Zm12 0a3 3 0 0 1-1.6 2.3A4.9 4.9 0 0 0 17 7h1Z" />
        </svg>
      </button>
      <button
        type="button"
        className="mobile-floating-icon-button"
        onClick={handleAccountAction}
        aria-label={user ? "Open account panel" : "Open sign in panel"}
      >
        <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
          <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.33 0-6 2.01-6 4.5V20h12v-1.5c0-2.49-2.67-4.5-6-4.5Z" />
        </svg>
      </button>
    </div>
  );
  const sharedOpenDockSections = (
    <>
      <div className="mobile-market-tab-row" role="tablist" aria-label="Market types">
        {mobileMarketChoices.map((choice) => (
          <button
            key={choice.side}
            type="button"
            role="tab"
            aria-selected={selectedSide === choice.side}
            className={
              selectedSide === choice.side
                ? `mobile-market-tab mobile-market-tab-${choice.accent} active`
                : `mobile-market-tab mobile-market-tab-${choice.accent}`
            }
            onClick={() => updateMobileDockSide(choice.side)}
            disabled={!canInteractWithMobileDockControls}
          >
            <span className="mobile-market-tab-icon" aria-hidden="true">
              {choice.icon}
            </span>
            <span className="mobile-market-tab-label">{choice.label}</span>
          </button>
        ))}
      </div>

      <div className="mobile-open-dock-body">
        <div className={`mobile-open-info-strip mobile-open-info-strip-${mobileSelectedChoice.accent}`}>
          <strong>{mobileOpenInfoTitle}</strong>
          <p>{mobileOpenInfoCopy}</p>
        </div>

        <div className={mobileOpenControlGridClassName}>
          {showMobileParameterInputs ? (
            <div className={`mobile-open-panel mobile-open-panel-parameter mobile-open-panel-${mobileSelectedChoice.accent}`}>
              <div className="mobile-open-panel-header">
                <span>{selectedSide === "exact" ? "Exact count" : "Set range"}</span>
              </div>

              {selectedSide === "exact" ? (
                <div className="mobile-touch-stepper mobile-touch-stepper-panel">
                  <button
                    type="button"
                    className="mobile-touch-stepper-button"
                    aria-label="Decrease exact count"
                    onClick={() => adjustMobileDockExactValue(-1)}
                    disabled={!canInteractWithMobileDockControls}
                  >
                    -
                  </button>

                  <label className="mobile-touch-stepper-field mobile-touch-stepper-field-value-only">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      aria-label="Exact count"
                      value={selectedExactValue}
                      onChange={(event) => updateMobileDockExactValue(event.target.value)}
                      disabled={!canInteractWithMobileDockControls}
                    />
                  </label>

                  <button
                    type="button"
                    className="mobile-touch-stepper-button"
                    aria-label="Increase exact count"
                    onClick={() => adjustMobileDockExactValue(1)}
                    disabled={!canInteractWithMobileDockControls}
                  >
                    +
                  </button>
                </div>
              ) : (
                <div className="mobile-range-picker" role="group" aria-label="Set range">
                  <div className="mobile-range-picker-grid">
                    <div className="mobile-range-picker-card">
                      <span className="mobile-range-picker-label">Min</span>
                      <strong className="mobile-range-picker-value">{selectedRangeMinValue}</strong>
                      <div className="mobile-range-picker-controls">
                        <button
                          type="button"
                          className="mobile-range-picker-button"
                          aria-label="Decrease minimum range"
                          onClick={() => adjustMobileDockRangeMin(-1)}
                          disabled={!canInteractWithMobileDockControls || selectedRangeMinValue <= 0}
                        >
                          -
                        </button>
                        <button
                          type="button"
                          className="mobile-range-picker-button"
                          aria-label="Increase minimum range"
                          onClick={() => adjustMobileDockRangeMin(1)}
                          disabled={
                            !canInteractWithMobileDockControls || selectedRangeMinValue >= selectedRangeMaxValue
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>

                    <div className="mobile-range-picker-card">
                      <span className="mobile-range-picker-label">Max</span>
                      <strong className="mobile-range-picker-value">{selectedRangeMaxValue}</strong>
                      <div className="mobile-range-picker-controls">
                        <button
                          type="button"
                          className="mobile-range-picker-button"
                          aria-label="Decrease maximum range"
                          onClick={() => adjustMobileDockRangeMax(-1)}
                          disabled={
                            !canInteractWithMobileDockControls || selectedRangeMaxValue <= selectedRangeMinValue
                          }
                        >
                          -
                        </button>
                        <button
                          type="button"
                          className="mobile-range-picker-button"
                          aria-label="Increase maximum range"
                          onClick={() => adjustMobileDockRangeMax(1)}
                          disabled={!canInteractWithMobileDockControls}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>

                  <div
                    className="mobile-range-picker-summary"
                    aria-live="polite"
                    aria-label={`Selected range ${selectedRangeMinValue} to ${selectedRangeMaxValue}`}
                  >
                    <strong>
                      {selectedRangeMinValue} to {selectedRangeMaxValue}
                    </strong>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          <div className="mobile-open-panel mobile-open-panel-stake">
            <div className="mobile-open-panel-header">
              <span>Stake</span>
            </div>

            <div className="mobile-touch-stepper mobile-touch-stepper-panel">
              <button
                type="button"
                className="mobile-touch-stepper-button"
                aria-label="Decrease wager"
                onClick={() => adjustMobileDockWager(-1)}
                disabled={!canInteractWithMobileDockControls}
              >
                -
              </button>

              <label className="mobile-touch-stepper-field mobile-touch-stepper-field-value-only">
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  aria-label="Stake amount"
                  value={selectedWager}
                  onChange={(event) => updateMobileDockWager(event.target.value)}
                  disabled={!canInteractWithMobileDockControls}
                />
              </label>

              <button
                type="button"
                className="mobile-touch-stepper-button"
                aria-label="Increase wager"
                onClick={() => adjustMobileDockWager(1)}
                disabled={!canInteractWithMobileDockControls}
              >
                +
              </button>
            </div>

            <div className="mobile-touch-chip-row mobile-touch-chip-row-stake" aria-label="Stake shortcuts">
              <button
                type="button"
                className={selectedWagerValue === 1 ? "mobile-touch-chip mobile-touch-chip-active" : "mobile-touch-chip"}
                onClick={() => applyMobileWagerPreset("min")}
                disabled={!canInteractWithMobileDockControls}
              >
                Min
              </button>
              <button
                type="button"
                className="mobile-touch-chip"
                onClick={() => applyMobileWagerPreset(5)}
                disabled={!canInteractWithMobileDockControls}
              >
                +5
              </button>
              <button
                type="button"
                className="mobile-touch-chip"
                onClick={() => applyMobileWagerPreset(10)}
                disabled={!canInteractWithMobileDockControls}
              >
                +10
              </button>
              <button
                type="button"
                className="mobile-touch-chip"
                onClick={() => applyMobileWagerPreset("double")}
                disabled={!canInteractWithMobileDockControls}
              >
                2x
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mobile-open-dock-footer">
        <button
          type="button"
          className="mobile-bet-cta mobile-bet-cta-inline mobile-bet-cta-mobile-open"
          disabled={mobileDockBetButtonDisabled}
          onClick={() => {
            if (selectedSession && canConfigureSelected) {
              handleBetAction(selectedSession);
              return;
            }

            if (!user) {
              handleRoundAuthAction();
            }
          }}
        >
          <span className="mobile-bet-cta-accent">{mobileDockBetButtonAccent}</span>
          <strong>{mobileDockBetButtonLabel}</strong>
        </button>
      </div>
    </>
  );
  const desktopOpenFloatingTickets =
    showDesktopBettingScreen && selectedSession && selectedSessionPredictionCount > 0 ? (
      <div className="desktop-open-floating-bets" aria-label="Placed bets">
        {selectedSessionPredictions.map((prediction, index) => {
          const predictionPayout = getPredictionGrossPayoutTokens(
            prediction.wager_tokens,
            getStoredPredictionPayoutMultiplierBps(prediction)
          );

          return (
            <div
              className={`desktop-open-ticket-card desktop-open-ticket-card-${prediction.side}`}
              key={prediction.id}
            >
              <div className="desktop-open-ticket-card-topline">
                <span className="desktop-open-ticket-card-kicker">
                  {selectedSessionPredictionCount > 1 ? `Bet ${index + 1}` : "Your bet"}
                </span>
                <span
                  className={`desktop-open-ticket-card-market desktop-open-ticket-card-market-${prediction.side}`}
                >
                  {formatPredictionSideTag(prediction.side)}
                </span>
              </div>

              {isPredictionCancelable(prediction, selectedSession, nowMs) ? (
                <button
                  type="button"
                  className="desktop-open-ticket-card-remove"
                  onClick={() => void handleCancelPrediction(prediction)}
                  disabled={cancelingPredictionIdSet.has(prediction.id)}
                  aria-label={`Remove ${formatPredictionLabel(prediction, selectedSession)}`}
                >
                  {cancelingPredictionIdSet.has(prediction.id) ? "..." : "×"}
                </button>
              ) : null}

              <strong className="desktop-open-ticket-card-title">
                {formatPredictionLabel(prediction, selectedSession)}
              </strong>

              <div className="desktop-open-ticket-card-stats">
                <div className="desktop-open-ticket-card-stat">
                  <span>Stake</span>
                  <strong>{prediction.wager_tokens}</strong>
                </div>
                <div className="desktop-open-ticket-card-stat">
                  <span>Win</span>
                  <strong>{predictionPayout}</strong>
                </div>
                <div className="desktop-open-ticket-card-stat desktop-open-ticket-card-stat-odds">
                  <span>Odds</span>
                  <strong>{formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(prediction))}</strong>
                </div>
              </div>
            </div>
          );
        })}
        
      </div>
    ) : null;
  const bettingWidgetContent = (
    <div
      className={
        showMobileOpenDock
          ? "mobile-betting-dock-shell mobile-betting-dock-shell-betting"
          : "mobile-betting-dock-shell"
      }
    >
      {showMobileOpenDock ? (
        <div className="mobile-open-dock">
          {sharedOpenDockSections}
        </div>
      ) : showMobileLiveDock && selectedSession ? (
        <div className="mobile-round-dock mobile-round-dock-live">
          <div className="mobile-round-dock-header">
            <div className="mobile-round-dock-copy">
              <span className="mobile-round-dock-kicker">Round live</span>
              <strong>Line {displayedThreshold} is in play</strong>
              <p>
                Bets are locked while the live counter runs. We will settle every ticket as soon as
                the official count posts.
              </p>
            </div>
            <span className="status status-live-badge mobile-round-dock-status">
              <span className="status-live-dot" aria-hidden="true" />
              Live
            </span>
          </div>

          <div className={`mobile-live-dock-meter-card mobile-live-dock-meter-card-${mobileLiveMeterStateTone}`}>
            <div className="mobile-live-dock-meter-header">
              <div>
                <span>Betting line</span>
                <strong>{displayedThreshold} people</strong>
              </div>
              <span className={`mobile-live-dock-meter-state mobile-live-dock-meter-state-${mobileLiveMeterStateTone}`}>
                {mobileLiveMeterStateLabel}
              </span>
            </div>

            <div className="mobile-live-dock-meter-track" aria-hidden="true">
              <span style={{ width: `${mobileLiveMeterFillPercent}%` }} />
              <i style={{ left: `${mobileLiveThresholdMarkerPercent}%` }} />
            </div>

            <div className="mobile-live-dock-meter-scale">
              <span>0</span>
              <span>Line {displayedThreshold}</span>
              <span>{mobileLiveMeterSummary}</span>
            </div>
          </div>

          <div className="mobile-round-dock-footer-grid">
            <div className="mobile-round-dock-footer-card">
              <span>{selectedSessionPredictionCount > 0 ? "Your position" : "Watching"}</span>
              <strong>
                {selectedSessionPredictionCount > 1
                  ? `${selectedSessionPredictionCount} bets • ${selectedSessionStakedTokens} tokens`
                  : selectedPrediction
                    ? `${selectedPrediction.wager_tokens} tokens • ${formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(selectedPrediction))}`
                    : "No tickets on this round"}
              </strong>
            </div>
            <div className="mobile-round-dock-footer-card">
              <span>Window</span>
              <strong>{mobileLiveOverlayTimeNote}</strong>
            </div>
          </div>
        </div>
      ) : showMobileResolvingDock && selectedSession ? (
        <div className="mobile-review-dock">
          <div className="mobile-review-dock-copy">
            <span className="mobile-review-dock-kicker">Resolving</span>
            <strong>Checking the final box count</strong>
            <p>
              The round is closed and we are reviewing the live feed now. Your result will appear
              here automatically.
            </p>
          </div>

          <div className="mobile-review-dock-meta-grid">
            <div className="mobile-review-dock-meta-card">
              <span>Closed</span>
              <strong>{selectedEndsAtLabel ?? "Just now"}</strong>
            </div>
            <div className="mobile-review-dock-meta-card">
              <span>Betting line</span>
              <strong>{displayedThreshold}</strong>
            </div>
          </div>

          <div className="mobile-review-dock-ticket">
            <span>{selectedSessionPredictionCount > 0 ? "Settling" : "Watch mode"}</span>
            <strong>
              {selectedSessionPredictionCount > 1
                ? `${selectedSessionPredictionCount} bets are waiting for settlement`
                : selectedPrediction && selectedSession
                  ? `${formatPredictionLabel(selectedPrediction, selectedSession)} is waiting for the result`
                  : "Final count is syncing from the live feed"}
            </strong>
            <span>
              {selectedSessionPredictionCount > 0
                ? `${selectedSessionStakedTokens} tokens in play`
                : "We will post the official result as soon as it lands."}
            </span>
          </div>
        </div>
      ) : showResolvedRoundCard && selectedSession ? (
        <div className={`mobile-result-dock mobile-result-dock-${selectedResultTone}`}>
          <div className="mobile-result-dock-topline">
            <span className="mobile-result-dock-kicker">{selectedResultPresentation.eyebrow}</span>
            <strong>{selectedResultPresentation.headline}</strong>
            <p>{selectedResultPresentation.copy}</p>
          </div>

          <div className="mobile-result-dock-scoreboard">
            <div className="mobile-result-dock-score-card">
              <span>Final count</span>
              <strong>{selectedSession.final_count ?? "--"}</strong>
            </div>
            <div className="mobile-result-dock-score-card">
              <span>Betting line</span>
              <strong>{displayedThreshold}</strong>
            </div>
          </div>

          <div className="mobile-result-dock-summary">
            <span>{mobileResolvedPrimaryStatLabel}</span>
            <strong>{mobileResolvedPrimaryStatValue}</strong>
            <span>
              {selectedResultPresentation.secondaryLabel}: {selectedResultPresentation.secondaryValue}
            </span>
          </div>

          {selectedSessionPredictionCount > 0 ? (
            <div className="mobile-result-dock-ticket-row">
              {selectedSessionPreviewPredictions.map((prediction) => (
                <div
                  className={`mobile-result-dock-ticket-chip mobile-result-dock-ticket-chip-${prediction.side}`}
                  key={prediction.id}
                >
                  <strong>{formatPredictionLabel(prediction, selectedSession)}</strong>
                  <span>{prediction.wager_tokens} tokens</span>
                </div>
              ))}
              {selectedSessionOverflowPredictionCount > 0 ? (
                <span className="mobile-result-dock-ticket-more">
                  +{selectedSessionOverflowPredictionCount} more
                </span>
              ) : null}
            </div>
          ) : null}

          <span className="mobile-result-dock-footer">{selectedResultPresentation.footer}</span>
        </div>
      ) : (
        <div
          className={
            !selectedSession
              ? "mobile-idle-dock mobile-idle-dock-idle"
              : selectedState
                ? `mobile-idle-dock mobile-idle-dock-${selectedState}`
                : "mobile-idle-dock"
          }
        >
          <div className="mobile-idle-dock-hero">
            <span className="mobile-idle-dock-kicker">
              {showMobileUpcomingDock ? "Next round scheduled" : standbyLabel}
            </span>
            <strong>
              {showMobileIdleDock
                ? "No live game posted"
                : showMobileUpcomingDock
                  ? "Waiting for the betting window"
                  : mobileDockTitle}
            </strong>
            <p>
              {showMobileIdleDock
                ? "We are waiting for an admin to post the next Tommy Walkway live game. This screen updates automatically the moment a new round is ready."
                : standbyTitle}
            </p>
          </div>

          <div className="mobile-idle-dock-meta-grid">
            {mobileDockMetaItems.map((item) => (
              <div className="mobile-idle-dock-meta-card" key={`${item.label}-${item.value}`}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>

          <p className="mobile-idle-dock-note">
            {showMobileIdleDock
              ? standbyNote
              : showMobileUpcomingDock
                ? standbyNote
                : mobileDockCopy}
          </p>

          {!user || isAdmin ? (
            <div className="mobile-dock-state-actions">
              {!user ? (
                <button
                  type="button"
                  className="mobile-bet-cta mobile-bet-cta-secondary"
                  onClick={hasSelectedSession ? handleRoundAuthAction : handleEmptyStateSignInAction}
                >
                  <span className="mobile-bet-cta-accent">Sign In</span>
                  <strong>{standbyActionLabel ?? "Sign In to Bet"}</strong>
                </button>
              ) : null}
              {isAdmin ? (
                <button
                  type="button"
                  className="mobile-dock-inline-action"
                  onClick={() => toggleRightPanel("admin")}
                >
                  Open Admin
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
  const regionEditorDock = showRegionEditDock ? (
    <section className="region-editor-dock">
      <div className="region-editor-dock-header">
        <div>
          <p className="region-editor-dock-kicker">Region Editor</p>
          <h3 className="region-editor-dock-title">
            {isRegionEditModeEnabled ? "Edit Mode Active" : "Unsaved Region Changes"}
          </h3>
        </div>
        <span
          className={
            isRegionEditModeEnabled
              ? "status status-open"
              : hasUnsavedRegionChanges
                ? "status status-upcoming"
                : "status"
          }
        >
          {isRegionEditModeEnabled ? "Handles On" : "Pending Save"}
        </span>
      </div>

      <p className="region-editor-dock-copy">
        {isRegionEditModeEnabled
          ? "Drag the feed corner points to adjust the betting area. You can save or reset here without reopening the admin console."
          : "You still have unsaved region changes. Save them, reset them, or resume edit mode to keep adjusting."}
      </p>

      <div className="region-editor-dock-actions">
        <button
          type="button"
          className="secondary-button region-editor-dock-toggle"
          onClick={handleToggleRegionEditMode}
          disabled={isSavingRegion}
        >
          {isRegionEditModeEnabled ? "Disable Edit Mode" : "Resume Edit Mode"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={handleResetRegion}
          disabled={!hasUnsavedRegionChanges || isSavingRegion}
        >
          Reset Region
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            void handleSaveRegion();
          }}
          disabled={!hasUnsavedRegionChanges || isSavingRegion}
        >
          {isSavingRegion ? "Saving..." : "Save Region"}
        </button>
      </div>
    </section>
  ) : null;

  const mobileScreenClassName = isMobileViewport
    ? [
        "betting-screen",
        "betting-screen-mobile",
        isPhoneViewport ? "betting-screen-mobile-phone" : null,
        showBettingControls ? "betting-screen-mobile-open" : null,
        showMobileLiveDock ? "betting-screen-mobile-live" : null,
        showMobileResolvingDock ? "betting-screen-mobile-resolving" : null,
        showResolvedRoundCard ? "betting-screen-mobile-resolved" : null,
        showMobileUpcomingDock ? "betting-screen-mobile-upcoming" : null,
        showMobileIdleDock ? "betting-screen-mobile-idle" : null,
        showBettingControls && (selectedSide === "exact" || selectedSide === "range")
          ? "betting-screen-mobile-open-parameterized"
          : null
      ]
        .filter(Boolean)
        .join(" ")
    : "betting-screen";

  return (
    <main
      className={mobileScreenClassName}
    >
      {isMobileViewport && showResolvedRoundCard && selectedResultTone !== "neutral" ? (
        <div className={`screen-result-aura screen-result-aura-${selectedResultTone}`} aria-hidden="true" />
      ) : null}
      {showWinConfetti ? (
        <div className="screen-confetti" aria-hidden="true">
          {SCREEN_CONFETTI_PIECES.map((piece, index) => (
            <span
              key={`${piece.left}-${piece.delayMs}-${index}`}
              className="screen-confetti-piece"
              style={{
                left: piece.left,
                background: piece.color,
                animationDelay: `${piece.delayMs}ms`,
                animationDuration: `${piece.durationMs}ms`,
                width: `${piece.widthRem}rem`,
                height: `${piece.heightRem}rem`
              }}
            />
          ))}
        </div>
      ) : null}
      {isMobileViewport ? (
        <>
          <div className="mobile-screen-shell">
            <section className="mobile-game-stage">
              <div className="mobile-stage-hero">
                <div
                  className={
                    shouldFocusMobileFeed
                      ? "mobile-feed-frame mobile-feed-frame-focused"
                      : "mobile-feed-frame"
                  }
                >
                  <div className="mobile-game-feed">
                    <LiveFeed
                      src={hlsUrl}
                      imageSrc={liveFrameUrl}
                      mediaAspectRatio={liveFeedAspectRatio}
                      region={regionPoints}
                      fullScreen
                      fullScreenStageFit="fill"
                      stageWindow={{ left: 0, top: 0, width: 1, height: 3 / 4 }}
                      personBoxes={livePersonBoxes}
                      statusMessage={activeVisionApiUrl ? liveFeedStatusMessage : null}
                      regionEditorEnabled={canEditRegion}
                      onRegionChange={canEditRegion ? setRegionPoints : null}
                      displayWindow={{ left: 1 / 2, top: 1 / 8, width: 1 / 2, height: 3 / 4 }}
                    />
                    <div className="feed-mask mobile-arena-mask" />
                  </div>

                  <div
                    className={
                      showBettingControls || showMobileUpcomingDock || showMobileLiveDock || showMobileResolvingDock
                        ? "mobile-feed-overlay mobile-feed-overlay-scroll"
                        : "mobile-feed-overlay"
                    }
                  >
                    {showMobileIdleDock ? (
                      <div className="mobile-review-floating-card mobile-review-floating-card-idle">
                        <span className="mobile-review-floating-card-kicker">No game live</span>
                        <strong>Waiting for the next post</strong>
                        <span>{mobileNoGameOverlayCopy}</span>
                      </div>
                    ) : showMobileUpcomingDock ? (
                      <div className="mobile-review-floating-card mobile-review-floating-card-upcoming">
                        <span className="mobile-review-floating-card-kicker">Next betting window</span>
                        <strong>{mobileUpcomingOverlayTitle}</strong>
                        <span>{mobileUpcomingOverlayCopy}</span>
                      </div>
                    ) : showBettingControls ? (
                      <>
                        <div className="mobile-open-market-widget">
                          <span className="mobile-open-market-widget-kicker">Bets open</span>
                          <strong>{sessionMetricLabel} {sessionMetricValue}</strong>
                          {mobileOpenOverlayCopy ? <span>{mobileOpenOverlayCopy}</span> : null}
                        </div>

                        {showMobileOpenBetWidget ? (
                          selectedSessionPredictions.map((prediction, index) => (
                            <div
                              className={`mobile-open-bet-card mobile-open-bet-card-${prediction.side}`}
                              key={prediction.id}
                            >
                              <div className="mobile-open-bet-card-header">
                                <span className="mobile-open-bet-card-kicker">
                                  {selectedSessionPredictionCount > 1 ? `Bet ${index + 1}` : "Your bet"}
                                </span>
                                {isPredictionCancelable(prediction, selectedSession, nowMs) ? (
                                  <button
                                    type="button"
                                    className="mobile-open-bet-card-remove"
                                    onClick={() => void handleCancelPrediction(prediction)}
                                    disabled={cancelingPredictionIdSet.has(prediction.id)}
                                    aria-label={`Remove ${formatPredictionLabel(prediction, selectedSession)}`}
                                  >
                                    {cancelingPredictionIdSet.has(prediction.id) ? "..." : "×"}
                                  </button>
                                ) : null}
                              </div>

                              <strong className="mobile-open-bet-card-title">
                                {formatPredictionLabel(prediction, selectedSession)}
                              </strong>

                              <div className="mobile-open-bet-card-meta">
                                <span>{prediction.wager_tokens} tokens</span>
                                <span>
                                  {formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(prediction))}
                                </span>
                              </div>
                            </div>
                          ))
                        ) : null}
                      </>
                    ) : showMobileLiveDock && selectedSession ? (
                      <>
                        <div className="mobile-live-floating-card mobile-live-floating-card-time">
                          <span className="mobile-live-floating-card-kicker">Round live</span>
                          <strong>{selectedRoundCountdown}</strong>
                          <span>{mobileLiveOverlayTimeNote}</span>
                        </div>

                        <div
                          className={`mobile-live-floating-card mobile-live-floating-card-count mobile-live-floating-card-${mobileLiveMeterStateTone}`}
                        >
                          <span className="mobile-live-floating-card-kicker">People in box</span>
                          <strong>{mobileLiveCountDisplay}</strong>
                          <span>{mobileLiveCountNote}</span>
                        </div>

                        {selectedSessionPredictionCount > 0 ? (
                          selectedSessionPredictions.map((prediction, index) => (
                            <div
                              className={`mobile-live-ticket-card mobile-live-ticket-card-${prediction.side}`}
                              key={prediction.id}
                            >
                              <span className="mobile-live-ticket-card-kicker">
                                {selectedSessionPredictionCount > 1 ? `Bet ${index + 1}` : "Your bet"}
                              </span>
                              <strong>{formatPredictionLabel(prediction, selectedSession)}</strong>
                              <span>
                                {prediction.wager_tokens} tokens •{" "}
                                {formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(prediction))}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="mobile-live-ticket-card mobile-live-ticket-card-watch">
                            <span className="mobile-live-ticket-card-kicker">Watch mode</span>
                            <strong>{mobileLiveOverlayTicketSummary}</strong>
                            <span>Track the live counter above the dock while this round runs.</span>
                          </div>
                        )}
                      </>
                    ) : showMobileResolvingDock && selectedSession ? (
                      <>
                        <div className="mobile-review-floating-card">
                          <span className="mobile-review-floating-card-kicker">Resolving</span>
                          <strong>Reviewing the final box count</strong>
                          <span>
                            {selectedEndsAtLabel ? `Window closed at ${selectedEndsAtLabel}` : "Window closed"}
                          </span>
                        </div>

                        {selectedSessionPredictionCount > 0 ? (
                          selectedSessionPredictions.map((prediction) => (
                            <div
                              className={`mobile-live-ticket-card mobile-live-ticket-card-${prediction.side}`}
                              key={prediction.id}
                            >
                              <span className="mobile-live-ticket-card-kicker">Settling</span>
                              <strong>{formatPredictionLabel(prediction, selectedSession)}</strong>
                              <span>
                                {prediction.wager_tokens} tokens •{" "}
                                {formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(prediction))}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="mobile-live-ticket-card mobile-live-ticket-card-watch">
                            <span className="mobile-live-ticket-card-kicker">Reviewing</span>
                            <strong>Final count syncing</strong>
                            <span>The result card below updates automatically when the official count lands.</span>
                          </div>
                        )}
                      </>
                    ) : showResolvedRoundCard ? (
                      <div className="mobile-feed-badge-row">
                        <span
                          className={
                            selectedState === "live"
                              ? "status status-live-badge mobile-feed-live-badge"
                              : selectedState
                                ? `status status-${selectedState}`
                                : "status"
                          }
                        >
                          {selectedState === "live" ? (
                            <span className="status-live-dot" aria-hidden="true" />
                          ) : null}
                          {mobileFeedStatusLabel}
                        </span>
                        <span className="round-chip mobile-feed-meta-chip">{mobileFeedMetaLabel}</span>
                      </div>
                    ) : null}
                    {showResolvedRoundCard ? (
                      <div className="mobile-feed-result-pill">
                        <span>Final</span>
                        <strong>{selectedSession?.final_count ?? "--"}</strong>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {mobileFloatingActions}
              {regionEditorDock ? (
                <div className="mobile-region-editor-shell">{regionEditorDock}</div>
              ) : null}
            </section>

            <section
              className={
                showBettingControls
                  ? "mobile-betting-dock mobile-betting-dock-open"
                  : "mobile-betting-dock"
              }
            >
              {bettingWidgetContent}
            </section>
          </div>
        </>
      ) : (
        <>
          <LiveFeed
            src={hlsUrl}
            imageSrc={liveFrameUrl}
            mediaAspectRatio={liveFeedAspectRatio}
            region={regionPoints}
            fullScreen
            personBoxes={livePersonBoxes}
            statusMessage={activeVisionApiUrl ? liveFeedStatusMessage : null}
            regionEditorEnabled={canEditRegion}
            onRegionChange={canEditRegion ? setRegionPoints : null}
          />
          <div className="feed-mask" />
          {showLiveRoundCard && selectedSession ? (
        <section className="live-round-overlay" aria-label="Live round status">
          <div className="live-round-overlay-panel">
            <div className="live-round-overlay-header">
              <div className="live-round-overlay-clock">
                <span>Time left</span>
                <strong>{selectedRoundCountdown}</strong>
                <p>{displayedModeSeconds}s round live now</p>
              </div>

              <div className="live-round-overlay-count">
                <span>People in box</span>
                <strong>{livePeopleCountDisplay}</strong>
                <p>Live counter placeholder</p>
              </div>
            </div>

            <div className="live-round-overlay-track-card">
              <div className="live-round-overlay-track-header">
                <div>
                  <span>Betting line</span>
                  <strong>{displayedThreshold} people</strong>
                </div>
                {livePeopleCount === null ? null : (
                  <div className="live-round-overlay-track-state">{liveTrackStateLabel}</div>
                )}
              </div>

              <div className="live-round-overlay-track-lane">
                <svg
                  viewBox={`0 0 ${liveSceneWidth} ${liveSceneHeight}`}
                  preserveAspectRatio="none"
                  className={
                    liveFallProgress > 0 ? "live-round-overlay-train-svg live-round-overlay-train-svg-falling" : "live-round-overlay-train-svg"
                  }
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id={liveSkyGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="rgb(33 40 53)" />
                      <stop offset="100%" stopColor="rgb(13 18 27)" />
                    </linearGradient>
                    <linearGradient id={liveCanyonGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="rgb(132 78 61)" />
                      <stop offset="100%" stopColor="rgb(28 14 20)" />
                    </linearGradient>
                    <linearGradient id={liveAbyssGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="rgb(25 32 44 / 92%)" />
                      <stop offset="45%" stopColor="rgb(14 18 28 / 96%)" />
                      <stop offset="100%" stopColor="rgb(5 7 12 / 100%)" />
                    </linearGradient>
                    <linearGradient id={liveSmokeGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="rgb(255 255 255 / 92%)" />
                      <stop offset="100%" stopColor="rgb(255 255 255 / 0%)" />
                    </linearGradient>
                    <linearGradient id={liveHeadlightGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgb(255 246 201 / 64%)" />
                      <stop offset="40%" stopColor="rgb(255 215 112 / 22%)" />
                      <stop offset="100%" stopColor="rgb(255 215 112 / 0%)" />
                    </linearGradient>
                    <clipPath id={liveSceneClipId}>
                      <rect x="8" y="10" width="984" height="180" rx="30" />
                    </clipPath>
                    <pattern id={liveTrackPatternId} width="32" height="32" patternUnits="userSpaceOnUse">
                      <rect x="10" y="0" width="12" height="32" className="live-round-overlay-train-sleeper" />
                    </pattern>
                  </defs>

                  <g clipPath={`url(#${liveSceneClipId})`}>
                    <rect x="8" y="10" width="984" height="180" rx="30" fill={`url(#${liveSkyGradientId})`} />
                    <rect
                      x="8"
                      y={liveBridgeTopY - 2}
                      width="984"
                      height={liveSceneHeight - liveBridgeTopY + 2}
                      fill={`url(#${liveAbyssGradientId})`}
                    />
                    <ellipse
                      cx={liveDangerZoneCenterX}
                      cy={liveBridgeTopY + 52}
                      rx="146"
                      ry="74"
                      className="live-round-overlay-train-danger-glow"
                      opacity={liveDangerZoneOpacity}
                    />
                    <ellipse
                      cx={liveSafeZoneCenterX}
                      cy={liveBridgeTopY + 18}
                      rx="108"
                      ry="42"
                      className="live-round-overlay-train-safe-glow"
                      opacity={liveSafeZoneOpacity}
                    />
                    <path
                      d={`M 8 ${liveBridgeBottomY} V ${liveBridgeTopY} H ${liveBridgeEndX - 24} L ${liveBridgeEndX} ${liveBridgeTopY + 10} V ${liveBridgeBottomY} H 8 Z`}
                      className="live-round-overlay-train-ground"
                    />
                    <path
                      d={`M 8 ${liveBridgeTopY + 10} H ${liveBridgeEndX - 20} L ${liveBridgeEndX} ${liveBridgeTopY + 18}`}
                      className="live-round-overlay-train-ground-ridge"
                    />
                    {liveBridgeArchCenters.map((centerX) => (
                      <path
                        key={centerX}
                        d={`M ${centerX - liveBridgeArchRadius} ${liveBridgeBottomY} V ${liveBridgeTopY + liveBridgeArchRadius + 12} A ${liveBridgeArchRadius} ${liveBridgeArchRadius} 0 0 1 ${centerX + liveBridgeArchRadius} ${liveBridgeTopY + liveBridgeArchRadius + 12} V ${liveBridgeBottomY} Z`}
                        className="live-round-overlay-train-bridge-arch"
                        fill={`url(#${liveAbyssGradientId})`}
                      />
                    ))}
                    <path
                      d={`M ${liveBridgeEndX - 4} ${liveBridgeTopY + 8} L ${liveCliffEdgeX + 28} 54 L ${liveSceneWidth} 32 L ${liveSceneWidth} ${liveSceneHeight} H ${liveCliffEdgeX + 68} C ${liveCliffEdgeX + 36} 182, ${liveCliffEdgeX + 12} 168, ${liveBridgeEndX - 4} ${liveBridgeTopY + 8} Z`}
                      fill={`url(#${liveCanyonGradientId})`}
                    />
                    <path
                      d={`M ${liveBridgeEndX - 4} ${liveBridgeTopY + 8} L ${liveCliffEdgeX + 24} 56 L ${liveCliffEdgeX + 52} 200`}
                      className="live-round-overlay-train-cliff-face"
                    />
                    <path
                      d={`M ${liveTrackStartX - 4} ${liveTrackY + 44} H ${liveCliffEdgeX - 18}`}
                      className="live-round-overlay-train-track-bed"
                    />
                    <rect
                      x={liveTrackStartX}
                      y={liveTrackY - 4}
                      width={liveCliffEdgeX - liveTrackStartX - 20}
                      height="38"
                      fill={`url(#${liveTrackPatternId})`}
                      opacity="0.92"
                    />
                    <path
                      d={`M ${liveTrackStartX} ${liveTrackY + 2} H ${liveCliffEdgeX - 22} M ${liveTrackStartX} ${liveTrackY + 26} H ${liveCliffEdgeX - 26}`}
                      className="live-round-overlay-train-rails"
                    />
                    <path
                      d={`M ${liveCliffEdgeX - 34} ${liveTrackY + 2} L ${liveCliffEdgeX - 2} ${liveTrackY - 10} M ${liveCliffEdgeX - 38} ${liveTrackY + 26} L ${liveCliffEdgeX - 6} ${liveTrackY + 16}`}
                      className="live-round-overlay-train-broken-rail"
                    />
                    <path
                      d={`M ${liveCliffEdgeX - 42} ${liveTrackY + 12} L ${liveCliffEdgeX + 2} ${liveTrackY + 6}`}
                      className="live-round-overlay-train-ledge-warning"
                    />

                    <g transform={`translate(${liveSafeStopFrontX + 6} ${liveTrackY - 2})`}>
                      <path d="M 0 32 V -28" className="live-round-overlay-train-threshold-post" />
                      <circle
                        cx="0"
                        cy="-34"
                        r="9"
                        className="live-round-overlay-train-threshold-light"
                        opacity={liveThresholdLightOpacity}
                      />
                      <circle cx="0" cy="-34" r="3.5" className="live-round-overlay-train-threshold-light-core" />
                    </g>

                    <g opacity={liveMotionLineOpacity}>
                      <path
                        d={`M ${liveTrainBodyX - 54} ${liveTrackY - 16} H ${liveTrainBodyX - 10}`}
                        className="live-round-overlay-train-motion-line"
                      />
                      <path
                        d={`M ${liveTrainBodyX - 78} ${liveTrackY + 2} H ${liveTrainBodyX - 18}`}
                        className="live-round-overlay-train-motion-line"
                      />
                      <path
                        d={`M ${liveTrainBodyX - 50} ${liveTrackY + 18} H ${liveTrainBodyX - 6}`}
                        className="live-round-overlay-train-motion-line"
                      />
                    </g>

                    {liveBrakeObjects.map((block) =>
                      block.slotFill > 0.02 ? (
                        <g
                          key={block.x}
                          transform={`translate(${block.x} ${liveTrackY + 8})`}
                          opacity={0.18 + block.slotFill * 0.82}
                        >
                          <path
                            d={`M -12 10 L -4 ${-8 - block.slotFill * 10} H 10 L 4 10 Z`}
                            className="live-round-overlay-train-brake-block"
                          />
                          <path
                            d={`M -7 3 H 6`}
                            className="live-round-overlay-train-brake-block-top"
                          />
                          <circle
                            cx="0"
                            cy={-6 - block.slotFill * 8}
                            r={1.4 + block.slotFill * 1.6}
                            className="live-round-overlay-train-brake-block-glow"
                            opacity={0.24 + block.engageRatio * 0.62}
                          />
                        </g>
                      ) : null
                    )}

                    <g
                      transform={`translate(${liveTrainBodyX} ${liveTrackY - 74 + liveTrainTranslateY}) rotate(${liveTrainRotation} 94 72)`}
                      className={
                        liveTrainHasHardStopped
                          ? "live-round-overlay-train-group live-round-overlay-train-group-hard-stop"
                          : "live-round-overlay-train-group"
                      }
                    >
                      <ellipse
                        cx="88"
                        cy="110"
                        rx="80"
                        ry="10"
                        className="live-round-overlay-train-shadow"
                        opacity={0.24 - liveFallProgress * 0.08}
                      />
                      <path
                        d="M 164 68 L 246 48 L 246 88 Z"
                        fill={`url(#${liveHeadlightGradientId})`}
                        className="live-round-overlay-train-headlight"
                        opacity={liveHeadlightOpacity}
                      />

                      <g opacity={liveSmokeOpacity}>
                        <circle
                          cx="120"
                          cy="20"
                          r="13"
                          fill={`url(#${liveSmokeGradientId})`}
                          className="live-round-overlay-train-smoke live-round-overlay-train-smoke-a"
                        />
                        <circle
                          cx="134"
                          cy="4"
                          r="10"
                          fill={`url(#${liveSmokeGradientId})`}
                          className="live-round-overlay-train-smoke live-round-overlay-train-smoke-b"
                        />
                        <circle
                          cx="108"
                          cy="-2"
                          r="8"
                          fill={`url(#${liveSmokeGradientId})`}
                          className="live-round-overlay-train-smoke live-round-overlay-train-smoke-c"
                        />
                      </g>

                      <rect x="12" y="58" width="42" height="22" rx="6" className="live-round-overlay-train-car" />
                      <path d="M 44 80 H 92 V 28 H 116 V 80 Z" className="live-round-overlay-train-cab" />
                      <path
                        d="M 82 80 H 146 C 154 80 160 74 160 66 V 58 C 160 50 154 44 146 44 H 88 C 80 44 76 50 76 58 V 70 C 76 76 78 80 82 80 Z"
                        className="live-round-overlay-train-engine"
                      />
                      <rect x="112" y="22" width="16" height="24" rx="4" className="live-round-overlay-train-stack" />
                      <path d="M 150 80 L 166 54 H 174 L 162 80 Z" className="live-round-overlay-train-cowcatcher" />
                      <circle cx="164" cy="60" r="6" className="live-round-overlay-train-lamp" />
                      <path d="M 18 58 H 48 M 58 54 H 104 M 116 48 H 148" className="live-round-overlay-train-roof-line" />
                      <rect x="58" y="38" width="10" height="12" rx="2.5" className="live-round-overlay-train-window" />
                      <rect x="72" y="38" width="10" height="12" rx="2.5" className="live-round-overlay-train-window" />
                      <rect x="92" y="54" width="46" height="8" rx="4" className="live-round-overlay-train-trim" />
                      <path d="M 28 86 H 144" className="live-round-overlay-train-coupler" />

                      <circle cx="32" cy="94" r="11" className="live-round-overlay-train-wheel live-round-overlay-train-wheel-small" />
                      <g transform={`rotate(${liveWheelRotation} 32 94)`}>
                        <path d="M 32 84 V 104 M 22 94 H 42 M 25 87 L 39 101 M 39 87 L 25 101" className="live-round-overlay-train-wheel-spokes" />
                      </g>
                      <circle cx="32" cy="94" r="4" className="live-round-overlay-train-wheel-core" />
                      <circle cx="84" cy="96" r="14" className="live-round-overlay-train-wheel" />
                      <g transform={`rotate(${liveWheelRotation} 84 96)`}>
                        <path d="M 84 82 V 110 M 70 96 H 98 M 74 86 L 94 106 M 94 86 L 74 106" className="live-round-overlay-train-wheel-spokes" />
                      </g>
                      <circle cx="84" cy="96" r="5" className="live-round-overlay-train-wheel-core" />
                      <circle cx="134" cy="96" r="14" className="live-round-overlay-train-wheel" />
                      <g transform={`rotate(${liveWheelRotation} 134 96)`}>
                        <path d="M 134 82 V 110 M 120 96 H 148 M 124 86 L 144 106 M 144 86 L 124 106" className="live-round-overlay-train-wheel-spokes" />
                      </g>
                      <circle cx="134" cy="96" r="5" className="live-round-overlay-train-wheel-core" />

                      <g style={{ opacity: liveSparkOpacity }}>
                        <path
                          d="M 80 108 L 64 122 M 82 108 L 58 114 M 134 108 L 150 124 M 136 108 L 158 114"
                          className="live-round-overlay-train-sparks"
                        />
                        <path
                          d="M 82 116 L 72 126 M 136 116 L 148 126"
                          className="live-round-overlay-train-sparks live-round-overlay-train-sparks-soft"
                        />
                      </g>
                    </g>

                    <path
                      d={`M ${liveCliffEdgeX + 12} 112 C ${liveCliffEdgeX + 54} 154, ${liveCliffEdgeX + 118} 180, ${liveSceneWidth} 194`}
                      className="live-round-overlay-train-canyon-haze"
                    />
                  </g>
                </svg>
              </div>

              <div className="live-round-overlay-track-scale">
                <span>Full speed</span>
                <span>Threshold</span>
                <span>Cliff edge</span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="floating-widgets">
        <div className="bet-widget-stack">
          <section
            className={
              showDesktopBettingScreen
                ? "floating-widget bet-widget bet-widget-open-dock"
                : "floating-widget bet-widget"
            }
          >
            <header className="widget-header bet-widget-header">
              <div className="widget-title-block">
                <p className="widget-kicker">Tommy Walkway</p>
                <h2>Betting</h2>
              </div>
              <span className="status status-live-badge">
                <span className="status-live-dot" aria-hidden="true" />
                {isRefreshing ? "Refreshing" : "Live"}
              </span>
            </header>

            {!showDesktopBettingScreen ? (
              <div className="market-meta-row">
                <span className={selectedState ? `status status-${selectedState}` : "status"}>
                  {selectedState ? getSessionStateLabel(selectedState) : "Standby"}
                </span>
                {hasSelectedSession ? <span className="round-chip">{displayedModeSeconds}s round</span> : null}
                {hasSelectedSession ? <span className="round-chip">Threshold {displayedThreshold}</span> : null}
              </div>
            ) : null}

            <div className="market-board">
              {showDesktopBettingScreen ? (
                <div className="mobile-open-dock desktop-open-dock">
                  <div
                    className={
                      showMobileUpcomingDock
                        ? "desktop-open-timer-bar desktop-open-timer-bar-upcoming"
                        : "desktop-open-timer-bar"
                    }
                    aria-live="polite"
                  >
                    <span className="desktop-open-timer-label">{desktopOpenTimerLabel}</span>
                    <strong className="desktop-open-timer-value">{desktopOpenTimerValue}</strong>
                  </div>
                  {sharedOpenDockSections}
                </div>
              ) : showLiveRoundCard && selectedSession ? (
                <div className="market-live-summary-card">
                  <span className="market-live-summary-kicker">Round live</span>
                  <strong className="market-live-summary-headline">
                    {selectedSessionPredictionCount > 1
                      ? `${selectedSessionPredictionCount} tickets live · ${selectedSessionStakedTokens} tokens staked`
                      : selectedPrediction
                      ? `${formatPredictionLabel(selectedPrediction, selectedSession)} · ${selectedPrediction.wager_tokens} tokens · ${formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(selectedPrediction))}`
                      : "Watching this round"}
                  </strong>
                  <div className="market-live-summary-grid">
                    <div className="market-live-summary-pill">
                      <span>Betting line</span>
                      <strong>{displayedThreshold}</strong>
                    </div>
                    <div className="market-live-summary-pill">
                      <span>Closes</span>
                      <strong>{selectedEndsAtLabel ?? "soon"}</strong>
                    </div>
                  </div>
                  <p className="market-live-summary-note">
                    The live countdown and crowd animation are centered on the feed while this round runs.
                  </p>
                </div>
              ) : showResolvedRoundCard && selectedSession ? (
                <div className={`market-result-card market-result-card-${selectedResultTone}`}>
                  <div className="market-result-topline">
                    <span className="market-result-kicker">{selectedResultPresentation.eyebrow}</span>
                    <strong className="market-result-headline">{selectedResultPresentation.headline}</strong>
                    <p className="market-result-copy">{selectedResultPresentation.copy}</p>
                  </div>

                  <div className="market-result-scoreboard">
                    <div className="market-result-score-card">
                      <span>Final count</span>
                      <strong>{selectedSession.final_count ?? "--"}</strong>
                    </div>
                    <div className="market-result-score-card">
                      <span>Betting line</span>
                      <strong>{displayedThreshold}</strong>
                    </div>
                  </div>

                  <div className="market-result-stat-grid">
                    <div className="market-result-stat-card">
                      <span>
                        {selectedSessionPredictionCount > 1
                          ? "Tickets placed"
                          : selectedPrediction
                            ? "Your pick"
                            : "Winning side"}
                      </span>
                      <strong>
                        {selectedSessionPredictionCount > 1
                          ? `${selectedSessionPredictionCount}`
                          : selectedPrediction
                          ? formatPredictionLabel(selectedPrediction, selectedSession)
                          : selectedWinningSide
                            ? selectedWinningSide.toUpperCase()
                            : "Pending"}
                      </strong>
                    </div>
                    <div className="market-result-stat-card">
                      <span>{selectedResultPresentation.secondaryLabel}</span>
                      <strong>{selectedResultPresentation.secondaryValue}</strong>
                    </div>
                  </div>

                  <span className="market-result-footer">{selectedResultPresentation.footer}</span>
                </div>
              ) : (
                <div
                  className={
                    !selectedSession
                      ? "market-standby-card market-standby-card-idle"
                      : selectedState
                        ? `market-standby-card market-standby-card-${selectedState}`
                        : "market-standby-card"
                  }
                >
                  <span className="market-standby-label">{standbyLabel}</span>
                  <strong className="market-standby-value">{standbyValue}</strong>
                  <p className="market-standby-title">{standbyTitle}</p>
                  <div className="market-standby-meta-grid">
                    {standbyMetaItems.map((item) => (
                      <div className="market-standby-meta-card" key={item.label}>
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                  <span className="market-standby-note">{standbyNote}</span>
                  {standbyActionLabel ? (
                    <div className="market-standby-actions">
                      <button
                        type="button"
                        className="bet-submit-button market-standby-button"
                        onClick={
                          emptyStateSignInEnabled
                            ? handleEmptyStateSignInAction
                            : handleRoundAuthAction
                        }
                      >
                        {standbyActionLabel}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {selectedSessionPredictionCount > 0 &&
            !showDesktopBettingScreen &&
            !showLiveRoundCard &&
            !showResolvedRoundCard ? (
              <div className="session-result compact-result selection-summary selection-summary-stack">
                <div className="selection-summary-header">
                  <span className="selection-summary-kicker">
                    {selectedSessionPredictionCount > 1 ? "Round tickets" : "Locked in"}
                  </span>
                  <strong className="selection-summary-title">
                    {selectedSessionPredictionCount > 1
                      ? `${selectedSessionPredictionCount} bets placed`
                      : formatPredictionLabel(selectedPrediction, selectedSession)}
                  </strong>
                  <span className="selection-summary-meta">
                    {selectedSessionStakedTokens} tokens total
                  </span>
                </div>

                <div className="selection-ticket-list">
                  {selectedSessionPreviewPredictions.map((prediction) => (
                    <div className="selection-ticket-chip" key={prediction.id}>
                      <div className="selection-ticket-chip-copy">
                        <strong>{formatPredictionLabel(prediction, selectedSession)}</strong>
                        <span>
                          {prediction.wager_tokens} tokens ·{" "}
                          {formatPayoutMultiplier(getStoredPredictionPayoutMultiplierBps(prediction))}
                        </span>
                      </div>
                      {isPredictionCancelable(prediction, selectedSession, nowMs) ? (
                        <button
                          type="button"
                          className="selection-ticket-cancel-button"
                          onClick={() => void handleCancelPrediction(prediction)}
                          disabled={cancelingPredictionIdSet.has(prediction.id)}
                        >
                          {cancelingPredictionIdSet.has(prediction.id) ? "Removing..." : "Remove"}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {selectedSessionOverflowPredictionCount > 0 ? (
                  <span className="selection-summary-more">
                    +{selectedSessionOverflowPredictionCount} more tickets in this round
                  </span>
                ) : null}
              </div>
            ) : null}
          </section>

          {desktopOpenFloatingTickets}
        </div>

        <div className="right-rail">
          <div className="quick-actions">
            {user ? (
              <div className="quick-balance-chip" aria-label={`Token balance ${tokenBalance}`}>
                <span className="quick-balance-chip-icon" aria-hidden="true">
                  $
                </span>
                <strong>{tokenBalance}</strong>
              </div>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                className={openRightPanel === "admin" ? "icon-admin-button active" : "icon-admin-button"}
                onClick={() => toggleRightPanel("admin")}
                aria-label="Open admin panel"
              >
                <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                  <path d="M12 2.5 4.5 5.3v5.5c0 4.9 3 9.4 7.5 10.7 4.5-1.3 7.5-5.8 7.5-10.7V5.3L12 2.5Zm0 2.1 5.3 2v4.2c0 3.9-2.2 7.3-5.3 8.5-3.1-1.2-5.3-4.6-5.3-8.5V6.6l5.3-2Zm-2 4.1h4v1.4H10V8.7Zm0 3.1h4v1.4H10v-1.4Zm0 3.1h4v1.4H10v-1.4Z" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              className={
                openRightPanel === "leaderboard"
                  ? "icon-leaderboard-button active"
                  : "icon-leaderboard-button"
              }
              onClick={() => toggleRightPanel("leaderboard")}
              aria-label="Open leaderboard panel"
            >
              <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                <path d="M7 4h10v3a5 5 0 0 1-4 4.9V14h3v2H8v-2h3v-2.1A5 5 0 0 1 7 7V4Zm2 2v1a3 3 0 0 0 6 0V6H9Zm-3 1h1a4.9 4.9 0 0 0 .6 2.3A3 3 0 0 1 6 7Zm12 0a3 3 0 0 1-1.6 2.3A4.9 4.9 0 0 0 17 7h1Z" />
              </svg>
            </button>
            <button
              type="button"
              className={
                openRightPanel === "account" ? "icon-account-button active" : "icon-account-button"
              }
              onClick={handleAccountAction}
              aria-label={user ? "Open account panel" : "Open sign in panel"}
            >
              <span className="icon-account-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="img" aria-hidden="true" className="icon-account-glyph">
                  <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.33 0-6 2.01-6 4.5V20h12v-1.5c0-2.49-2.67-4.5-6-4.5Z" />
                </svg>
              </span>
            </button>
          </div>
          {showRegionEditDock ? (
            <section className="region-editor-dock">
              <div className="region-editor-dock-header">
                <div>
                  <p className="region-editor-dock-kicker">Region Editor</p>
                  <h3 className="region-editor-dock-title">
                    {isRegionEditModeEnabled ? "Edit Mode Active" : "Unsaved Region Changes"}
                  </h3>
                </div>
                <span
                  className={
                    isRegionEditModeEnabled
                      ? "status status-open"
                      : hasUnsavedRegionChanges
                        ? "status status-upcoming"
                        : "status"
                  }
                >
                  {isRegionEditModeEnabled ? "Handles On" : "Pending Save"}
                </span>
              </div>

              <p className="region-editor-dock-copy">
                {isRegionEditModeEnabled
                  ? "Drag the feed corner points to adjust the betting area. You can save or reset here without reopening the admin console."
                  : "You still have unsaved region changes. Save them, reset them, or resume edit mode to keep adjusting."}
              </p>

              <div className="region-editor-dock-actions">
                <button
                  type="button"
                  className="secondary-button region-editor-dock-toggle"
                  onClick={handleToggleRegionEditMode}
                  disabled={isSavingRegion}
                >
                  {isRegionEditModeEnabled ? "Disable Edit Mode" : "Resume Edit Mode"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleResetRegion}
                  disabled={!hasUnsavedRegionChanges || isSavingRegion}
                >
                  Reset Region
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    void handleSaveRegion();
                  }}
                  disabled={!hasUnsavedRegionChanges || isSavingRegion}
                >
                  {isSavingRegion ? "Saving..." : "Save Region"}
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
        </>
      )}

      {openRightPanel ? (
        <div className="center-modal-backdrop" onClick={() => setOpenRightPanel(null)} role="presentation">
          <section
            className={
              openRightPanel === "account"
                ? "center-modal account-modal"
                : openRightPanel === "admin"
                  ? "center-modal admin-modal"
                  : "center-modal"
            }
            role="dialog"
            aria-modal="true"
            aria-label={
              openRightPanel === "account"
                ? "Account panel"
                : openRightPanel === "admin"
                  ? "Admin panel"
                  : "Leaderboard panel"
            }
            onClick={(event) => event.stopPropagation()}
          >
            <header className="widget-header center-modal-header">
              <h2>
                {openRightPanel === "account"
                  ? "Account & History"
                  : openRightPanel === "admin"
                    ? "Admin Console"
                    : "Leaderboard"}
              </h2>
              <button
                type="button"
                className="panel-close-button"
                onClick={() => setOpenRightPanel(null)}
                aria-label="Close panel"
              >
                ×
              </button>
            </header>

            <div className="center-modal-body">
            {openRightPanel === "account" ? (
              user || isProfilePreviewMode ? (
                <div className="account-panel">
                  <section className="account-hero">
                    <div className="account-hero-head">
                      <div className="account-hero-identity">
                        <ProfileAvatar
                          avatarType={activeProfileAvatarType}
                          avatarValue={activeProfileAvatarValue}
                          label={`${accountDisplayName} profile picture`}
                          className="profile-avatar-large"
                        />
                        <div className="account-hero-copy">
                          <p className="account-kicker">Player account</p>
                          <p className="account-name">{accountDisplayName}</p>
                          <p className="account-subtitle">{accountEmail}</p>
                          <div className="account-badge-row">
                            <span className="account-badge">{accountProfile?.tier ?? "Bronze"} Tier</span>
                            <span className="account-badge">Joined {profileJoinDateLabel}</span>
                            <span className="account-badge">
                              Preferred {getPreferredModeLabel(accountProfile?.preferred_mode_seconds)}
                            </span>
                            <span className="account-badge">{totalEarnedAchievements} badges earned</span>
                            <span
                              className={
                                latestResolvedPrediction?.was_correct === true
                                  ? "account-badge account-badge-win"
                                  : latestResolvedPrediction?.was_correct === false
                                    ? "account-badge account-badge-loss"
                                    : "account-badge"
                              }
                            >
                              Last result{" "}
                              {latestResolvedPrediction?.resolved_at
                                ? latestResolvedPrediction.was_correct === true
                                  ? "won"
                                  : latestResolvedPrediction.was_correct === false
                                    ? "lost"
                                    : "cancelled"
                                : "pending"}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="account-actions">
                        <div className="account-action-tooltip-shell">
                          <button
                            type="button"
                            className="primary-button"
                            onClick={handleClaimDailyLogin}
                            disabled={isDailyClaimDisabled}
                            aria-describedby={isDailyClaimDisabled ? "daily-claim-tooltip" : undefined}
                          >
                            {dailyClaimButtonLabel}
                          </button>
                          {isDailyClaimDisabled ? (
                            <span id="daily-claim-tooltip" role="tooltip" className="account-action-tooltip">
                              {dailyClaimHelperText}
                            </span>
                          ) : null}
                        </div>
                        {user ? (
                          <button type="button" className="secondary-button" onClick={handleSignOut}>
                            Sign Out
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <SpotlightCardGrid cards={accountSpotlightCards} />
                    <AccountOverviewGrid stats={accountOverviewStats} />
                  </section>

                  <section className="account-history-section">
                    <div className="account-history-header">
                      <div>
                        <p className="account-section-kicker">Profile momentum</p>
                        <h3 className="account-section-title">Current streaks</h3>
                        <p className="account-section-copy">
                          Login, win, and participation streaks refresh from the same profile data that powers your account.
                        </p>
                      </div>
                    </div>
                    <AccountProfileStatGrid stats={accountProfileStats} />
                  </section>

                  <section className="account-history-section">
                    <div className="account-history-header">
                      <div>
                        <p className="account-section-kicker">Achievements</p>
                        <h3 className="account-section-title">Badges & progress</h3>
                        <p className="account-section-copy">
                          Skill, accomplishment, and participation badges track automatically as your profile grows.
                        </p>
                      </div>
                      <span className="account-history-count">
                        {achievementCards.length > 0
                          ? `${totalEarnedAchievements}/${achievementCards.length} earned`
                          : "No badges yet"}
                      </span>
                    </div>
                    {achievementCards.length > 0 ? (
                      <div className="achievement-category-grid">
                        {(["skill", "accomplishment", "participation"] as const).map((category) => (
                          <article className="achievement-category-card" key={category}>
                            <div className="achievement-category-header">
                              <div>
                                <p className="account-section-kicker">{getAchievementCategoryLabel(category)}</p>
                                <h4 className="achievement-category-title">
                                  {achievementCardsByCategory[category].filter((achievement) => achievement.isEarned).length} earned
                                </h4>
                              </div>
                              <span className="account-history-count">
                                {achievementCardsByCategory[category].length}
                              </span>
                            </div>
                            <div className="achievement-card-list">
                              {achievementCardsByCategory[category].map((achievement) => (
                                <article
                                  className={
                                    achievement.isEarned
                                      ? "achievement-progress-card achievement-progress-card-earned"
                                      : "achievement-progress-card"
                                  }
                                  key={achievement.id}
                                >
                                  <div className="achievement-progress-head">
                                    <div>
                                      <strong>{achievement.name}</strong>
                                      <p>{achievement.description}</p>
                                    </div>
                                    <span
                                      className={
                                        achievement.isEarned
                                          ? "account-badge account-badge-win"
                                          : "account-badge"
                                      }
                                    >
                                      {achievement.isEarned ? "Earned" : `${achievement.current}/${achievement.minimum}`}
                                    </span>
                                  </div>
                                  <div className="achievement-progress-track" aria-hidden="true">
                                    <span style={{ width: `${Math.max(achievement.ratio * 100, achievement.isEarned ? 100 : 0)}%` }} />
                                  </div>
                                  <div className="achievement-progress-foot">
                                    <span>
                                      {achievement.isEarned && achievement.awardedAt
                                        ? `Awarded ${formatShortDateTime(achievement.awardedAt)}`
                                        : `Need ${achievement.minimum - achievement.current > 0 ? achievement.minimum - achievement.current : 0} more`}
                                    </span>
                                  </div>
                                </article>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="account-empty-state">
                        <p className="account-section-kicker">No badges yet</p>
                        <h3 className="account-section-title">Achievements will appear here</h3>
                        <p className="account-section-copy">
                          Place a few rounds and claim daily rewards to start unlocking badge progress.
                        </p>
                      </div>
                    )}
                  </section>

                  <section className="account-history-section">
                    <div className="account-history-header">
                      <div>
                        <p className="account-section-kicker">Profile settings</p>
                        <h3 className="account-section-title">Identity & preferences</h3>
                        <p className="account-section-copy">
                          Update your display name, pick a default round mode, and choose a built-in icon or your own profile photo.
                        </p>
                      </div>
                    </div>
                    <div className="profile-settings-layout">
                      <div className="profile-settings-form">
                        <label className="profile-settings-field">
                          <span>Display name</span>
                          <input
                            type="text"
                            value={profileSettings.displayName}
                            onChange={(event) =>
                              setProfileSettings((current) => ({
                                ...current,
                                displayName: event.target.value
                              }))
                            }
                            placeholder="Choose a display name"
                            maxLength={64}
                          />
                        </label>

                        <div className="profile-settings-field">
                          <span>Preferred game mode</span>
                          <div className="profile-mode-toggle" role="group" aria-label="Preferred game mode">
                            {[30, 60].map((modeSeconds) => (
                              <button
                                key={modeSeconds}
                                type="button"
                                className={
                                  profileSettings.preferredModeSeconds === modeSeconds
                                    ? "profile-mode-toggle-button active"
                                    : "profile-mode-toggle-button"
                                }
                                onClick={() =>
                                  setProfileSettings((current) => ({
                                    ...current,
                                    preferredModeSeconds: modeSeconds as PreferredModeSeconds
                                  }))
                                }
                              >
                                <strong>{modeSeconds}s</strong>
                                <span>{modeSeconds === 30 ? "Fast rounds" : "Extended rounds"}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="profile-settings-actions">
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => void handleSaveProfileSettings()}
                            disabled={!canPersistProfileSettings || !profileSettingsDirty || isSavingProfileSettings}
                          >
                            {isSavingProfileSettings ? "Saving..." : "Save profile"}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={handleResetProfileSettings}
                            disabled={!profileSettingsDirty}
                          >
                            Reset
                          </button>
                        </div>

                        {!canPersistProfileSettings ? (
                          <p className="profile-settings-hint">
                            Local preview mode is showing the profile UI. Connect Supabase to save live changes.
                          </p>
                        ) : null}
                      </div>

                      <div className="profile-avatar-picker-panel">
                        <div className="profile-avatar-picker-preview">
                          <ProfileAvatar
                            avatarType={activeProfileAvatarType}
                            avatarValue={activeProfileAvatarValue}
                            label={`${accountDisplayName} selected profile picture`}
                            className="profile-avatar-feature"
                          />
                          <div className="profile-avatar-picker-copy">
                            <p className="account-section-kicker">Profile picture</p>
                            <h4 className="achievement-category-title">
                              {profileSettings.avatarType === "upload"
                                ? "Uploaded photo"
                                : `${getBuiltInProfileAvatar(profileSettings.avatarValue).label} icon`}
                            </h4>
                            <p className="account-section-copy">
                              Built-in icons keep the same gold-cardinal tone as the rest of the account panel.
                            </p>
                          </div>
                        </div>

                        <div className="profile-avatar-option-grid">
                          {BUILT_IN_PROFILE_AVATARS.map((avatar) => (
                            <button
                              key={avatar.id}
                              type="button"
                              className={
                                profileSettings.avatarType === "icon" && profileSettings.avatarValue === avatar.id
                                  ? "profile-avatar-option active"
                                  : "profile-avatar-option"
                              }
                              onClick={() =>
                                setProfileSettings((current) => ({
                                  ...current,
                                  avatarType: "icon",
                                  avatarValue: avatar.id
                                }))
                              }
                            >
                              <ProfileAvatar
                                avatarType="icon"
                                avatarValue={avatar.id}
                                label={`${avatar.label} icon`}
                                className="profile-avatar-option-icon"
                              />
                              <span>{avatar.label}</span>
                            </button>
                          ))}
                          <button
                            type="button"
                            className={profileSettings.avatarType === "upload" ? "profile-avatar-option active" : "profile-avatar-option"}
                            onClick={handleOpenAvatarUploadPicker}
                          >
                            <span className="profile-avatar-upload-glyph" aria-hidden="true">
                              ↑
                            </span>
                            <span>{profileSettings.avatarType === "upload" ? "Replace photo" : "Upload photo"}</span>
                          </button>
                        </div>
                        <input
                          ref={avatarUploadInputRef}
                          type="file"
                          accept="image/*"
                          className="profile-avatar-input"
                          onChange={(event) => void handleProfileAvatarUpload(event)}
                        />
                      </div>
                    </div>
                  </section>

                  <section className="account-history-section">
                    <div className="account-history-header">
                      <div>
                        <p className="account-section-kicker">Betting history</p>
                        <h3 className="account-section-title">All past bids</h3>
                        <p className="account-section-copy">
                          Flip between live slips and settled heat without losing the full tape.
                        </p>
                      </div>
                      <span className="account-history-count">
                        {loading ? "Refreshing..." : `${filteredAccountPredictions.length} shown`}
                      </span>
                    </div>
                    <PredictionHistoryFilterBar
                      filter={accountHistoryFilter}
                      onChange={setAccountHistoryFilter}
                      totalCount={visibleAccountPredictions.length}
                      liveCount={pendingPredictionCount}
                      settledCount={settledPredictionCount}
                    />
                    <PredictionHistoryList
                      predictions={filteredAccountPredictions}
                      sessionLookup={accountSessionLookup}
                      nowMs={nowMs}
                      emptyKicker="No bets yet"
                      emptyTitle="Your history will land here"
                      emptyCopy="Place a round and this panel will start tracking your side, stake, final count, and payout."
                      cancelablePredictionIds={cancelablePredictionIdSet}
                      cancelingPredictionIds={cancelingPredictionIdSet}
                      onCancelPrediction={(prediction) => {
                        void handleCancelPrediction(prediction);
                      }}
                    />
                  </section>
                </div>
              ) : (
                <p className="hint">Sign in to track tokens and place bets.</p>
              )
            ) : openRightPanel === "admin" ? (
              user && isAdmin && supabase ? (
                <AdminConsole
                  supabase={supabase}
                  defaultCameraFeedUrl={hlsUrl}
                  isRegionEditModeEnabled={isRegionEditModeEnabled}
                  regionPoints={regionPoints}
                  hasUnsavedRegionChanges={hasUnsavedRegionChanges}
                  onStartRegionEditMode={handleStartRegionEditModeFromAdmin}
                  onToggleRegionEditMode={handleToggleRegionEditMode}
                  onError={setError}
                  onPublicDataRefresh={() => load(user)}
                />
              ) : (
                <p className="hint">Admin access is required for this panel.</p>
              )
            ) : (
              <>
                <div className="leaderboard-panel-header">
                  <div>
                    <p className="leaderboard-panel-kicker">Live bankroll ladder</p>
                    <p className="leaderboard-panel-note">
                      Tap any bettor to open their public profile and recent betting history.
                    </p>
                  </div>
                  {leaderboardUserSummary ? (
                    <div className="leaderboard-user-summary">
                      <span>Your lane</span>
                      <strong>{leaderboardUserSummary.value}</strong>
                      <p>{leaderboardUserSummary.note}</p>
                    </div>
                  ) : null}
                </div>
                {leaderboardSpotlightEntries.length > 0 ? (
                  <section className="leaderboard-spotlight-grid">
                    {leaderboardSpotlightEntries.map((entry) => (
                      <LeaderboardSpotlightCard
                        key={entry.user_id}
                        entry={entry}
                        onOpen={(nextEntry) => {
                          void handleOpenPublicProfile(nextEntry);
                        }}
                      />
                    ))}
                  </section>
                ) : null}
                {leaderboardListEntries.length > 0 ? (
                  <section className="leaderboard-list-shell">
                    <div className="leaderboard-section-header">
                      <div>
                        <p className="leaderboard-section-kicker">Chase pack</p>
                        <h3 className="leaderboard-section-title">Everyone hunting the podium</h3>
                      </div>
                    </div>
                    <ol className="leaderboard modal-leaderboard">
                      {leaderboardListEntries.map((entry) => (
                        <li key={entry.user_id}>
                          <button
                            type="button"
                            className="leaderboard-entry-button"
                            onClick={() => void handleOpenPublicProfile(entry)}
                            aria-label={`Open ${entry.display_name}'s betting profile`}
                          >
                            <span className="leaderboard-entry-rank">{formatRankLabel(entry.rank)}</span>
                            <span className="leaderboard-entry-copy">
                              <span className="leaderboard-entry-name-row">
                                <span className="leaderboard-entry-name">{entry.display_name}</span>
                                <span className="leaderboard-entry-tier">{entry.tier}</span>
                              </span>
                              <span className="leaderboard-entry-meta">
                                {entry.correct_predictions} correct picks
                              </span>
                            </span>
                            <span className="leaderboard-entry-score-shell">
                              <span className="leaderboard-entry-score-label">Bankroll</span>
                              <span className="leaderboard-entry-score">{entry.token_balance}</span>
                              <span className="leaderboard-entry-action">View profile</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
                {leaderboard.length > 0 && leaderboard.length <= 3 ? (
                  <p className="leaderboard-panel-empty-copy">
                    More bettors will show up here as soon as fresh rounds settle.
                  </p>
                ) : null}
                {leaderboard.length === 0 ? <p className="hint">No leaderboard entries yet.</p> : null}
              </>
            )}
            </div>
          </section>
        </div>
      ) : null}

      {publicProfileContext ? (
        <div className="center-modal-backdrop" onClick={closePublicProfile} role="presentation">
          <section
            className="center-modal account-modal public-profile-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${publicProfileDisplayName} betting profile`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="widget-header center-modal-header">
              <h2>Public Profile</h2>
              <button
                type="button"
                className="panel-close-button"
                onClick={closePublicProfile}
                aria-label="Close public profile"
              >
                ×
              </button>
            </header>

            <div className="center-modal-body">
            <div className="account-panel">
              <section className="account-hero">
                <div className="account-hero-head">
                  <div className="account-hero-copy">
                    <p className="account-kicker">
                      {publicProfileRank !== null
                        ? `Public betting profile · Rank #${publicProfileRank}`
                        : "Public betting profile"}
                    </p>
                    <h3 className="account-name">{publicProfileDisplayName}</h3>
                    <p className="account-subtitle">
                      {user && publicProfileContext.user_id === user.id
                        ? `${publicProfileTier} bettor · This is you`
                        : `${publicProfileTier} bettor`}
                    </p>
                    <div className="account-badge-row">
                      <span className="account-badge">{publicProfileCorrectPredictions} correct picks</span>
                      <span className="account-badge">{publicProfileTotalPredictions} bets tracked</span>
                      <span className="account-badge">Hit rate {publicProfileHitRateLabel}</span>
                    </div>
                  </div>
                </div>

                <SpotlightCardGrid cards={publicProfileSpotlightCards} />
                <AccountOverviewGrid stats={publicProfileOverviewStats} />
              </section>

              <section className="account-history-section">
                <div className="account-history-header">
                  <div>
                    <p className="account-section-kicker">Public history</p>
                    <h3 className="account-section-title">{publicProfileDisplayName}&rsquo;s recent bets</h3>
                    <p className="account-section-copy">
                      Filter the tape to read this bettor&apos;s live positions or settled results faster.
                    </p>
                  </div>
                  <span className="account-history-count">{publicProfileHistoryCountLabel}</span>
                </div>
                <PredictionHistoryFilterBar
                  filter={publicProfileHistoryFilter}
                  onChange={setPublicProfileHistoryFilter}
                  totalCount={allVisiblePublicProfilePredictions.length}
                  liveCount={
                    allVisiblePublicProfilePredictions.filter((prediction) => prediction.resolved_at === null).length
                  }
                  settledCount={
                    allVisiblePublicProfilePredictions.filter((prediction) => prediction.resolved_at !== null).length
                  }
                />

                {publicProfileError ? (
                  <p className="public-profile-status-card">{publicProfileError}</p>
                ) : isPublicProfileLoading && !publicProfileSummary ? (
                  <p className="public-profile-status-card">Loading recent activity...</p>
                ) : (
                  <PredictionHistoryList
                    predictions={filteredPublicProfilePredictions}
                    sessionLookup={publicProfileSessionLookup}
                    nowMs={nowMs}
                    emptyKicker="No public bets yet"
                    emptyTitle="This bettor has not opened a position yet"
                    emptyCopy="Once they place a round, their market history will show up here."
                  />
                )}
              </section>
            </div>
            </div>
          </section>
        </div>
      ) : null}

      {showAuthModal ? (
        <div className="center-modal-backdrop" onClick={closeAuthModal} role="presentation">
          <section
            className="center-modal auth-modal"
            role="dialog"
            aria-modal="true"
            aria-label={authModalTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="widget-header center-modal-header">
              <h2>{authModalTitle}</h2>
              <button
                type="button"
                className="panel-close-button"
                onClick={closeAuthModal}
                aria-label="Close account access modal"
              >
                ×
              </button>
            </header>

            <div className="center-modal-body">
            <p className="hint auth-modal-hint">
              {authModalHint}
            </p>

            <form className="auth-form auth-modal-form" onSubmit={handleAuthSubmit}>
              {authMode === "forgot-password" ? (
                <div className="auth-helper-row">
                  <button
                    type="button"
                    className="auth-inline-action"
                    onClick={() => setAuthModalMode("sign-in")}
                  >
                    Back to Sign In
                  </button>
                  <button
                    type="button"
                    className="auth-inline-action"
                    onClick={() => setAuthModalMode("sign-up")}
                  >
                    Need an account?
                  </button>
                </div>
              ) : (
                <div className="mode-row">
                  <button
                    type="button"
                    className={authMode === "sign-in" ? "mode-button active" : "mode-button"}
                    onClick={() => setAuthModalMode("sign-in")}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    className={authMode === "sign-up" ? "mode-button active" : "mode-button"}
                    onClick={() => setAuthModalMode("sign-up")}
                  >
                    Sign Up
                  </button>
                </div>
              )}
              <label>
                Email
                <input
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              {authMode === "forgot-password" ? (
                <p className="hint auth-helper-note">
                  We’ll send the reset link to this inbox and you can choose a new password there.
                </p>
              ) : (
                <>
                  <label>
                    Password
                    <input
                      required
                      minLength={6}
                      type="password"
                      autoComplete={authMode === "sign-up" ? "new-password" : "current-password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  {authMode === "sign-in" ? (
                    <div className="auth-helper-row">
                      <span className="hint auth-helper-note">Forgot your password?</span>
                      <button
                        type="button"
                        className="auth-inline-action"
                        onClick={() => {
                          setPassword("");
                          setAuthModalMode("forgot-password");
                        }}
                      >
                        Send reset link
                      </button>
                    </div>
                  ) : null}
                </>
              )}
              {authMode === "sign-up" ? (
                <label>
                  Display Name
                  <input
                    required
                    minLength={2}
                    autoComplete="nickname"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="auth-submit-stack">
                <button type="submit" className="primary-button">
                  {authSubmitLabel}
                </button>
                {authMode === "forgot-password" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setAuthModalMode("sign-in")}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </form>
            </div>
          </section>
        </div>
      ) : null}

      {toasts.length > 0 ? (
        <div className="toast-stack" aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
              <div className="toast-copy">
                <span className="toast-label">
                  {toast.tone === "error"
                    ? "Error"
                    : toast.tone === "warning"
                      ? "Notice"
                      : "Success"}
                </span>
                <p>{toast.message}</p>
              </div>
              <button
                type="button"
                className="toast-close-button"
                onClick={() => dismissToast(toast.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}
