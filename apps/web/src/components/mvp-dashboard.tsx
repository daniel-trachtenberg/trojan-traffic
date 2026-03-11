"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { AdminConsole } from "@/components/admin-console";
import { LiveFeed } from "@/components/live-feed";
import {
  bettingRegionsEqual,
  normalizeBettingRegion,
  type RegionPoint
} from "@/lib/betting-region";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";

type PredictionSide = "over" | "under";

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

type ProfileRow = {
  display_name: string;
  tier: string;
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

type PredictionHistoryTone = "win" | "loss" | "pending" | "cancelled";

const DEFAULT_WAGER = "10";
const WAGER_STEPS = [1, 5, 10, 20];
const BETTING_OPEN_WINDOW_MS = 5 * 60 * 1000;
const DAILY_CLAIM_TIMEZONE = "America/Los_Angeles";
const DAILY_CLAIM_START_HOUR = 8;
const DEFAULT_TOAST_DURATION_MS = 5000;
const SUCCESS_TOAST_DURATION_MS = 4200;
const ERROR_TOAST_DURATION_MS = 6200;
const MAX_VISIBLE_TOASTS = 4;
const RESULT_SPOTLIGHT_WINDOW_MS = 10_000;
const LIVE_TRACK_LINE_PROGRESS = 0.68;
const SESSION_SELECT_COLUMNS = "id,mode_seconds,threshold,starts_at,ends_at,status,final_count,resolved_at";
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

function formatTokenDelta(tokenDelta: number | null) {
  const safeTokenDelta = tokenDelta ?? 0;
  return safeTokenDelta > 0 ? `+${safeTokenDelta}` : `${safeTokenDelta}`;
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
    return `${prediction.side.toUpperCase()} cleared the ${session.threshold} line with ${session.final_count} people.`;
  }

  if (prediction.was_correct === false && session.final_count !== null) {
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
  const [tokenBalance, setTokenBalance] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isClaimingDailyLogin, setIsClaimingDailyLogin] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [isRefreshing, startTransition] = useTransition();
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [wagerBySession, setWagerBySession] = useState<Record<string, string>>({});
  const [sideBySession, setSideBySession] = useState<Record<string, PredictionSide>>({});
  const [openRightPanel, setOpenRightPanel] = useState<"account" | "leaderboard" | "admin" | null>(
    null
  );
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authIntentSessionId, setAuthIntentSessionId] = useState<string | null>(null);
  const [liveDetections, setLiveDetections] = useState<LiveDetectionsResponse | null>(null);
  const [regionPoints, setRegionPoints] = useState(() => normalizeBettingRegion(initialRegion));
  const [savedRegionPoints, setSavedRegionPoints] = useState(() =>
    normalizeBettingRegion(initialRegion)
  );
  const [isRegionEditModeEnabled, setIsRegionEditModeEnabled] = useState(false);
  const [isSavingRegion, setIsSavingRegion] = useState(false);
  const nextToastIdRef = useRef(0);
  const toastsRef = useRef<ToastRecord[]>([]);
  const toastTimeoutsRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const sessionLookup = new Map(sessions.map((session) => [session.id, session]));
  const predictionBySession = new Map(predictions.map((prediction) => [prediction.session_id, prediction]));
  const pendingPredictionCount = predictions.filter((prediction) => prediction.resolved_at === null).length;
  const settledPredictions = predictions.filter((prediction) => prediction.was_correct !== null);
  const wonPredictionCount = settledPredictions.filter(
    (prediction) => prediction.was_correct === true
  ).length;
  const openRiskTokens = predictions
    .filter((prediction) => prediction.resolved_at === null)
    .reduce((total, prediction) => total + prediction.wager_tokens, 0);
  const hitRateLabel =
    settledPredictions.length > 0
      ? `${Math.round((wonPredictionCount / settledPredictions.length) * 100)}%`
      : "--";
  const latestResolvedPrediction = predictions.find((prediction) => prediction.resolved_at !== null) ?? null;
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
  const selectedPrediction = selectedSession
    ? predictionBySession.get(selectedSession.id) ?? null
    : null;
  const selectedState = selectedSession ? getSessionState(selectedSession, nowMs) : null;
  const displayedModeSeconds = selectedSession?.mode_seconds ?? 30;
  const displayedThreshold = selectedSession?.threshold ?? 5;
  const selectedStartsAtMs = selectedSession ? new Date(selectedSession.starts_at).getTime() : null;
  const selectedEndsAtMs = selectedSession ? new Date(selectedSession.ends_at).getTime() : null;
  const selectedCountdown = selectedStartsAtMs !== null ? formatCountdown(selectedStartsAtMs - nowMs) : "00:00";
  const selectedOpensInLabel = selectedSession
    ? formatReadableDuration(new Date(selectedSession.starts_at).getTime() - nowMs - BETTING_OPEN_WINDOW_MS)
    : "Soon";
  const selectedWager = selectedSession ? (wagerBySession[selectedSession.id] ?? DEFAULT_WAGER) : DEFAULT_WAGER;
  const selectedSide = selectedSession ? (sideBySession[selectedSession.id] ?? "over") : "over";
  const canConfigureSelected = Boolean(selectedSession && selectedState === "open" && selectedPrediction === null);
  const showBettingControls = Boolean(selectedSession && selectedState === "open");
  const dailyClaimState = getDailyClaimState(streaks?.last_login_date ?? null, nowMs);
  const isDailyClaimDisabled =
    loading || isRefreshing || isClaimingDailyLogin || !dailyClaimState.canClaim;
  const dailyClaimButtonLabel = isClaimingDailyLogin
    ? "Claiming..."
    : dailyClaimState.hasClaimedToday
      ? "Claimed Today"
      : "Claim Daily Tokens";
  const dailyClaimHelperText = isClaimingDailyLogin
    ? "Submitting your daily reward claim."
    : loading || isRefreshing
      ? "Refreshing account status..."
      : dailyClaimState.detail;
  const showLiveRoundCard = Boolean(selectedSession && selectedState === "live");
  const showResolvedRoundCard = Boolean(selectedSession && selectedState === "resolved");
  const emptyStateSignupEnabled = !hasSelectedSession && !user;
  const betButtonDisabled = hasSelectedSession ? !canConfigureSelected : !emptyStateSignupEnabled;
  const betButtonLabel = hasSelectedSession
    ? !user
      ? "Sign In to Bet"
      : selectedPrediction
      ? "Entered"
      : "Bet"
    : user
      ? "Waiting"
      : "Sign Up";
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
  const sessionMetricNote =
    selectedState === "upcoming"
      ? selectedSession
        ? `Betting unlocks at ${new Date(
            new Date(selectedSession.starts_at).getTime() - BETTING_OPEN_WINDOW_MS
          ).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
          })}`
        : "Betting opens shortly before the round begins."
      : selectedState === "open"
      ? `${displayedModeSeconds}s window`
      : selectedState === "resolved" && selectedSession
        ? new Date(selectedSession.ends_at).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit"
          })
        : selectedSession
          ? `${displayedModeSeconds}s round`
          : "Next round not scheduled yet";
  const selectedStartsAtLabel = selectedSession
    ? new Date(selectedSession.starts_at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    : null;
  const selectedOpensAtLabel = selectedSession
    ? new Date(new Date(selectedSession.starts_at).getTime() - BETTING_OPEN_WINDOW_MS).toLocaleTimeString(
        [],
        {
          hour: "numeric",
          minute: "2-digit"
        }
      )
    : null;
  const selectedEndsAtLabel = selectedSession
    ? new Date(selectedSession.ends_at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    : null;
  const livePeopleCount = null as number | null;
  const livePeopleCountDisplay = `${livePeopleCount ?? 0}`.padStart(2, "0");
  const selectedRoundCountdown =
    selectedEndsAtMs !== null ? formatCountdown(selectedEndsAtMs - nowMs) : "00:00";
  const liveSceneId = useId().replace(/:/g, "");
  const liveGateProgress =
    livePeopleCount !== null && displayedThreshold > 0 ? clamp(livePeopleCount / displayedThreshold, 0, 1) : 0;
  const liveTrackHasCrossedLine = livePeopleCount !== null && livePeopleCount >= displayedThreshold;
  const liveSceneWidth = 1000;
  const liveSceneHeight = 180;
  const liveGateX = LIVE_TRACK_LINE_PROGRESS * liveSceneWidth;
  const liveReservoirRight = liveGateX - 38;
  const liveWaterSurfaceY = 88 - liveGateProgress * 10;
  const liveGateDoorHeight = 36 + liveGateProgress * 84;
  const liveGateDoorY = 150 - liveGateDoorHeight;
  const liveSpillLength = liveTrackHasCrossedLine ? 24 : 128 + (1 - liveGateProgress) * 156;
  const liveSpillOpacity = liveTrackHasCrossedLine ? 0 : 0.28 + (1 - liveGateProgress) * 0.48;
  const liveSpillStrokeWidth = liveTrackHasCrossedLine ? 8 : 18 + (1 - liveGateProgress) * 18;
  const liveSafeZoneOpacity = 0.24 + liveGateProgress * 0.72;
  const liveDangerZoneOpacity = 0.34 + (1 - liveGateProgress) * 0.42;
  const liveSpillStartX = liveGateX + 34;
  const liveSpillEndX = liveSpillStartX + liveSpillLength;
  const liveSpillPath = `M ${liveSpillStartX} 114 C ${liveSpillStartX + liveSpillLength * 0.18} ${92 - (1 - liveGateProgress) * 18}, ${liveSpillStartX + liveSpillLength * 0.58} ${122 + (1 - liveGateProgress) * 10}, ${liveSpillEndX} 108`;
  const liveSpillAccentPath = `M ${liveSpillStartX} 102 C ${liveSpillStartX + liveSpillLength * 0.22} ${88 - (1 - liveGateProgress) * 12}, ${liveSpillStartX + liveSpillLength * 0.6} 112, ${liveSpillEndX} 101`;
  const liveWaterClipId = `${liveSceneId}-water-clip`;
  const liveGridPatternId = `${liveSceneId}-grid`;
  const livePanelGradientId = `${liveSceneId}-panel-gradient`;
  const liveWaterGradientId = `${liveSceneId}-water-gradient`;
  const liveDangerGradientId = `${liveSceneId}-danger-gradient`;
  const liveSafeGradientId = `${liveSceneId}-safe-gradient`;
  const liveLeakGlowId = `${liveSceneId}-leak-glow`;
  const liveSafeGlowId = `${liveSceneId}-safe-glow`;
  const liveTrackStateLabel =
    livePeopleCount === null ? "Counter ready" : liveTrackHasCrossedLine ? "Gate sealed" : "Sealing";
  const selectedWinningSide = selectedSession ? getWinningSide(selectedSession) : null;
  const selectedResultTone =
    selectedPrediction?.was_correct === true
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

    if (selectedPrediction?.resolved_at && selectedPrediction.was_correct === null) {
      return {
        eyebrow: "Round cancelled",
        headline: "Entry voided",
        copy: `The ${displayedModeSeconds}s round was cancelled after betting closed. Your ${selectedPrediction.side.toUpperCase()} entry will not count.`,
        footer: settledAtCopy,
        secondaryLabel: "Payout",
        secondaryValue: "Voided"
      };
    }

    if (selectedPrediction?.was_correct === true) {
      return {
        eyebrow: "Round settled",
        headline: "You won",
        copy: `Final count hit ${finalCountLabel}. Your ${selectedPrediction.side.toUpperCase()} pick cleared the line and paid ${formatTokenDelta(selectedPrediction.token_delta)} tokens.`,
        footer: settledAtCopy,
        secondaryLabel: "Token swing",
        secondaryValue: formatTokenDelta(selectedPrediction.token_delta)
      };
    }

    if (selectedPrediction?.was_correct === false) {
      return {
        eyebrow: "Round settled",
        headline: "You lost",
        copy: `Final count landed at ${finalCountLabel}. Your ${selectedPrediction.side.toUpperCase()} call missed the line and cost ${Math.abs(selectedPrediction.token_delta ?? 0)} tokens.`,
        footer: settledAtCopy,
        secondaryLabel: "Token swing",
        secondaryValue: formatTokenDelta(selectedPrediction.token_delta)
      };
    }

    if (selectedPrediction) {
      return {
        eyebrow: "Round finished",
        headline: "Result syncing",
        copy: `Final count posted at ${finalCountLabel}. Your ${selectedPrediction.side.toUpperCase()} entry is waiting for settlement.`,
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
      ? `Betting opens at ${selectedStartsAtLabel}. Entries close at ${selectedOpensAtLabel}.`
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
    !user && !selectedSession
      ? "Create Account to Be Ready"
      : !user && hasSelectedSession
        ? "Sign In or Create Account"
        : null;
  const hasUnsavedRegionChanges = !bettingRegionsEqual(regionPoints, savedRegionPoints);
  const canEditRegion = isAdmin && isRegionEditModeEnabled;
  const showRegionEditDock = isAdmin && (isRegionEditModeEnabled || hasUnsavedRegionChanges);
  const visionApiBaseUrl = visionApiUrl ? visionApiUrl.replace(/\/+$/, "") : null;
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
  const authModalTitle = authIntentSessionId
    ? authMode === "sign-in"
      ? "Sign In to Join This Round"
      : "Create an Account to Join This Round"
    : authMode === "sign-in"
      ? "Sign In"
      : "Create Your Account";
  const authModalHint = authIntentSessionId
    ? authMode === "sign-in"
      ? "Sign in first, then your bet will be submitted automatically."
      : "Create your account first, then your bet will be submitted automatically."
    : authMode === "sign-in"
      ? "Sign in to place bets and track tokens."
      : "Create an account to track tokens and be ready for the next round.";

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
      setTokenBalance(0);
      setIsAdmin(false);
      return;
    }

    await supabase.rpc("ensure_user_profile");

    const profileResponse = await supabase
      .from("profiles")
      .select("display_name,tier")
      .eq("user_id", activeUser.id)
      .maybeSingle();
    if (profileResponse.error) {
      throw new Error(profileResponse.error.message);
    }

    const streakResponse = await supabase
      .from("user_streaks")
      .select("login_streak,prediction_streak,last_login_date")
      .eq("user_id", activeUser.id)
      .maybeSingle();
    if (streakResponse.error) {
      throw new Error(streakResponse.error.message);
    }

    const balanceResponse = await supabase
      .from("user_token_balances")
      .select("token_balance")
      .eq("user_id", activeUser.id)
      .maybeSingle();
    if (balanceResponse.error) {
      throw new Error(balanceResponse.error.message);
    }

    const predictionResponse = await supabase
      .from("predictions")
      .select("id,session_id,side,wager_tokens,was_correct,token_delta,resolved_at,placed_at")
      .eq("user_id", activeUser.id)
      .order("placed_at", { ascending: false });
    if (predictionResponse.error) {
      throw new Error(predictionResponse.error.message);
    }

    const adminResponse = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("user_id", activeUser.id)
      .maybeSingle();
    if (adminResponse.error) {
      throw new Error(adminResponse.error.message);
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
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);

    return () => clearInterval(timer);
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
    if (!visionApiUrl) {
      setLiveDetections(null);
      return;
    }

    const endpoint = `${visionApiUrl.replace(/\/+$/, "")}/detections/live`;
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
  }, [visionApiUrl]);

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

    if (authMode === "sign-up") {
      const signUpResponse = await supabase.auth.signUp({
        email,
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
      email,
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
    setError(null);
    setNotice(null);

    const predictionResponse = await supabase.rpc("place_prediction", {
      p_session_id: session.id,
      p_side: side,
      p_wager_tokens: wagerTokens
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

  function closeAuthModal() {
    setShowAuthModal(false);
    setAuthIntentSessionId(null);
  }

  function openAuthModal(mode: "sign-in" | "sign-up", sessionId: string | null = null) {
    if (!supabase) {
      setError(`Configure Supabase before ${mode === "sign-in" ? "signing in" : "creating an account"}.`);
      return;
    }

    setError(null);
    setNotice(null);
    setAuthIntentSessionId(sessionId);
    setAuthMode(mode);
    setShowAuthModal(true);
  }

  function updateSelectedSide(sessionId: string, nextSide: PredictionSide) {
    setSideBySession((current) => ({
      ...current,
      [sessionId]: nextSide
    }));
  }

  function updateSelectedWager(sessionId: string, nextWager: string) {
    setWagerBySession((current) => ({
      ...current,
      [sessionId]: nextWager
    }));
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

  function handleEmptyStateSignupAction() {
    if (!emptyStateSignupEnabled) {
      return;
    }

    openAuthModal("sign-up");
  }

  function handleRoundAuthAction() {
    openAuthModal("sign-in");
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

  return (
    <main className="betting-screen">
      <LiveFeed
        src={hlsUrl}
        imageSrc={liveFrameUrl}
        mediaAspectRatio={liveFeedAspectRatio}
        region={regionPoints}
        fullScreen
        personBoxes={livePersonBoxes}
        statusMessage={visionApiUrl ? liveFeedStatusMessage : null}
        regionEditorEnabled={canEditRegion}
        onRegionChange={canEditRegion ? setRegionPoints : null}
      />
      <div className="feed-mask" />
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
                  className={
                    liveTrackHasCrossedLine
                      ? "live-round-overlay-dam-svg live-round-overlay-dam-svg-sealed"
                      : "live-round-overlay-dam-svg"
                  }
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id={livePanelGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="rgb(23 30 46)" />
                      <stop offset="52%" stopColor="rgb(11 15 25)" />
                      <stop offset="100%" stopColor="rgb(18 25 20)" />
                    </linearGradient>
                    <linearGradient id={liveWaterGradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" stopColor="rgb(172 232 255)" />
                      <stop offset="52%" stopColor="rgb(62 152 255)" />
                      <stop offset="100%" stopColor="rgb(12 59 173)" />
                    </linearGradient>
                    <linearGradient id={liveDangerGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgb(123 23 33)" />
                      <stop offset="100%" stopColor="rgb(123 23 33 / 0)" />
                    </linearGradient>
                    <linearGradient id={liveSafeGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="rgb(37 82 52 / 0)" />
                      <stop offset="100%" stopColor="rgb(104 230 154)" />
                    </linearGradient>
                    <pattern
                      id={liveGridPatternId}
                      width="40"
                      height="40"
                      patternUnits="userSpaceOnUse"
                    >
                      <path d="M 40 0 L 0 0 0 40" className="live-round-overlay-dam-grid-line" />
                    </pattern>
                    <clipPath id={liveWaterClipId}>
                      <rect x="26" y="24" width={liveReservoirRight - 2} height="132" rx="30" />
                    </clipPath>
                    <filter id={liveLeakGlowId}>
                      <feGaussianBlur stdDeviation="7" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id={liveSafeGlowId}>
                      <feGaussianBlur stdDeviation="10" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  <rect x="18" y="16" width="964" height="148" rx="34" fill={`url(#${livePanelGradientId})`} />
                  <rect x="18" y="16" width="964" height="148" rx="34" fill={`url(#${liveGridPatternId})`} opacity="0.18" />
                  <rect
                    x="26"
                    y="24"
                    width={liveReservoirRight - 2}
                    height="132"
                    rx="30"
                    fill={`url(#${liveDangerGradientId})`}
                    opacity={liveDangerZoneOpacity}
                  />
                  <rect
                    x={liveGateX + 24}
                    y="24"
                    width={liveSceneWidth - liveGateX - 50}
                    height="132"
                    rx="30"
                    fill={`url(#${liveSafeGradientId})`}
                    opacity={liveSafeZoneOpacity}
                  />

                  <g clipPath={`url(#${liveWaterClipId})`}>
                    <rect
                      x="26"
                      y={liveWaterSurfaceY}
                      width={liveReservoirRight - 2}
                      height={160 - liveWaterSurfaceY}
                      rx="26"
                      fill={`url(#${liveWaterGradientId})`}
                    />
                    <path
                      d="M -160 0 C -90 22, -10 -18, 70 0 S 230 22 310 0 S 470 -18 550 0 S 710 22 790 0 S 950 -18 1030 0 S 1190 22 1270 0 V 88 H -160 Z"
                      transform={`translate(0 ${liveWaterSurfaceY - 4})`}
                      className="live-round-overlay-dam-wave live-round-overlay-dam-wave-back"
                    />
                    <path
                      d="M -180 0 C -110 18, -20 -14, 60 0 S 220 18 300 0 S 460 -14 540 0 S 700 18 780 0 S 940 -14 1020 0 S 1180 18 1260 0 V 76 H -180 Z"
                      transform={`translate(0 ${liveWaterSurfaceY + 4})`}
                      className="live-round-overlay-dam-wave live-round-overlay-dam-wave-front"
                    />
                    <path
                      d={`M 28 ${liveWaterSurfaceY + 8} H ${liveReservoirRight - 12}`}
                      className="live-round-overlay-dam-foam"
                    />
                  </g>

                  <path
                    d={liveSpillPath}
                    className="live-round-overlay-dam-spill live-round-overlay-dam-spill-main"
                    style={{ opacity: liveSpillOpacity, strokeWidth: liveSpillStrokeWidth }}
                    filter={`url(#${liveLeakGlowId})`}
                  />
                  <path
                    d={liveSpillAccentPath}
                    className="live-round-overlay-dam-spill live-round-overlay-dam-spill-accent"
                    style={{ opacity: liveSpillOpacity * 0.82, strokeWidth: liveSpillStrokeWidth * 0.48 }}
                  />
                  <circle
                    cx={liveSpillEndX + 10}
                    cy="106"
                    r={8 + (1 - liveGateProgress) * 6}
                    className="live-round-overlay-dam-splash"
                    style={{ opacity: liveSpillOpacity * 0.78 }}
                  />

                  <g transform={`translate(${liveGateX} 0)`}>
                    <rect x="-60" y="36" width="22" height="112" rx="11" className="live-round-overlay-dam-tower" />
                    <rect x="38" y="36" width="22" height="112" rx="11" className="live-round-overlay-dam-tower" />
                    <rect x="-44" y="54" width="88" height="8" rx="4" className="live-round-overlay-dam-beam" />
                    <rect
                      x="-28"
                      y={liveGateDoorY}
                      width="56"
                      height={liveGateDoorHeight}
                      rx="16"
                      className={
                        liveTrackHasCrossedLine
                          ? "live-round-overlay-dam-door live-round-overlay-dam-door-sealed"
                          : "live-round-overlay-dam-door"
                      }
                    />
                    <path d={`M -20 ${liveGateDoorY + 20} H 20 M -20 ${liveGateDoorY + 40} H 20 M -20 ${liveGateDoorY + 60} H 20`} className="live-round-overlay-dam-door-slats" />
                    <circle
                      cx="0"
                      cy="82"
                      r="9"
                      className={
                        liveTrackHasCrossedLine
                          ? "live-round-overlay-dam-sensor live-round-overlay-dam-sensor-sealed"
                          : "live-round-overlay-dam-sensor"
                      }
                    />
                    <rect x="-38" y="12" width="76" height="26" rx="13" className="live-round-overlay-dam-badge" />
                    <text x="0" y="30" textAnchor="middle" className="live-round-overlay-dam-badge-text">
                      {displayedThreshold}
                    </text>
                  </g>

                  <g opacity={liveSafeZoneOpacity} filter={`url(#${liveSafeGlowId})`}>
                    <ellipse cx="860" cy="142" rx="84" ry="18" className="live-round-overlay-dam-refuge-glow" />
                  </g>
                  <g className="live-round-overlay-dam-refuge" opacity={0.42 + liveSafeZoneOpacity * 0.58}>
                    <path d="M 776 148 Q 842 126 934 148" className="live-round-overlay-dam-refuge-ground" />
                    <rect x="810" y="98" width="20" height="40" rx="5" className="live-round-overlay-dam-refuge-building" />
                    <rect x="840" y="84" width="24" height="54" rx="5" className="live-round-overlay-dam-refuge-building live-round-overlay-dam-refuge-building-tall" />
                    <rect x="874" y="104" width="18" height="34" rx="5" className="live-round-overlay-dam-refuge-building" />
                    <path d="M 928 138 L 944 102 L 960 138 Z" className="live-round-overlay-dam-refuge-tree" />
                    <circle cx="948" cy="88" r="8" className="live-round-overlay-dam-refuge-beacon" />
                  </g>
                </svg>
              </div>

              <div className="live-round-overlay-track-scale">
                <span>Pressure</span>
                <span>Threshold</span>
                <span>Safe</span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="floating-widgets">
        <section className="floating-widget bet-widget">
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

          <div className="market-meta-row">
            <span className={selectedState ? `status status-${selectedState}` : "status"}>
              {selectedState ? getSessionStateLabel(selectedState) : "Standby"}
            </span>
            {hasSelectedSession ? <span className="round-chip">{displayedModeSeconds}s round</span> : null}
            {hasSelectedSession ? <span className="round-chip">Threshold {displayedThreshold}</span> : null}
          </div>

          <div className="market-board">
            {showBettingControls ? (
              <>
                <div className="market-choice-grid">
                  <button
                    type="button"
                    className={
                      hasSelectedSession && selectedSide === "under"
                        ? "market-choice-card market-choice-under active"
                        : "market-choice-card market-choice-under"
                    }
                    onClick={() => {
                      if (selectedSession) {
                        updateSelectedSide(selectedSession.id, "under");
                      }
                    }}
                    disabled={!canConfigureSelected}
                  >
                    <span className="market-choice-icon" aria-hidden="true">
                      ↓
                    </span>
                    <span className="market-choice-title">Under</span>
                    <span className="market-choice-subtitle">Below {displayedThreshold}</span>
                  </button>

                  <div className="market-center-card">
                    <span className="market-center-label">Threshold</span>
                    <strong>{displayedThreshold}</strong>
                    <span>{displayedModeSeconds}s window</span>
                  </div>

                  <button
                    type="button"
                    className={
                      hasSelectedSession && selectedSide === "over"
                        ? "market-choice-card market-choice-over active"
                        : "market-choice-card market-choice-over"
                    }
                    onClick={() => {
                      if (selectedSession) {
                        updateSelectedSide(selectedSession.id, "over");
                      }
                    }}
                    disabled={!canConfigureSelected}
                  >
                    <span className="market-choice-icon" aria-hidden="true">
                      ↑
                    </span>
                    <span className="market-choice-title">Over</span>
                    <span className="market-choice-subtitle">{displayedThreshold} or more</span>
                  </button>
                </div>

                <div className="market-metrics-row">
                  <div className="market-metric">
                    <span className="market-metric-label">{sessionMetricLabel}</span>
                    <strong>{sessionMetricValue}</strong>
                    <span className="market-metric-note">{sessionMetricNote}</span>
                  </div>
                </div>

                <div className="stake-toolbar">
                  <div className="stake-step-row">
                    <span className="stake-label">Stake</span>
                    <div className="stake-step-buttons">
                      {WAGER_STEPS.map((step) => (
                        <button
                          key={step}
                          type="button"
                          className="stake-step-button"
                          disabled={!canConfigureSelected}
                          onClick={() => {
                            if (selectedSession) {
                              adjustSelectedWager(selectedSession.id, step);
                            }
                          }}
                        >
                          +{step}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="stake-step-button"
                        disabled={!canConfigureSelected}
                        onClick={() => {
                          if (selectedSession) {
                            updateSelectedWager(selectedSession.id, DEFAULT_WAGER);
                          }
                        }}
                      >
                        Reset
                      </button>
                    </div>
                  </div>

                  <div className="stake-summary-row compact-stake-summary-row">
                    <label className="stake-input-card">
                      <span>Stake</span>
                      <input
                        type="number"
                        min={1}
                        value={selectedWager}
                        onChange={(event) => {
                          if (selectedSession) {
                            updateSelectedWager(selectedSession.id, event.target.value);
                          }
                        }}
                        disabled={!canConfigureSelected}
                      />
                    </label>
                  </div>
                </div>
              </>
            ) : showLiveRoundCard && selectedSession ? (
              <div className="market-live-summary-card">
                <span className="market-live-summary-kicker">Round live</span>
                <strong className="market-live-summary-headline">
                  {selectedPrediction
                    ? `${selectedPrediction.side.toUpperCase()} · ${selectedPrediction.wager_tokens} tokens`
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
                    <span>{selectedPrediction ? "Your pick" : "Winning side"}</span>
                    <strong>
                      {selectedPrediction
                        ? selectedPrediction.side.toUpperCase()
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
                        emptyStateSignupEnabled
                          ? handleEmptyStateSignupAction
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

          {selectedPrediction && !showLiveRoundCard && !showResolvedRoundCard ? (
            <p className="session-result compact-result selection-summary">
              Locked in: <strong>{selectedPrediction.side.toUpperCase()}</strong> ·{" "}
              {selectedPrediction.wager_tokens} tokens
              {selectedPrediction.resolved_at && selectedPrediction.was_correct === null
                ? " · Cancelled"
                : selectedPrediction.was_correct !== null
                ? selectedPrediction.was_correct
                  ? ` · Win ${formatTokenDelta(selectedPrediction.token_delta)}`
                  : ` · Loss ${formatTokenDelta(selectedPrediction.token_delta)}`
                : " · Pending"}
            </p>
          ) : null}

          {showBettingControls ? (
            <div className="bet-card-footer">
              <button
                type="button"
                className="bet-submit-button"
                disabled={betButtonDisabled}
                onClick={() => {
                  if (selectedSession) {
                    handleBetAction(selectedSession);
                    return;
                  }

                  handleEmptyStateSignupAction();
                }}
              >
                {betButtonLabel}
              </button>
            </div>
          ) : null}
        </section>

        <div className="right-rail">
          <div className="quick-actions">
            {user ? (
              <div className="quick-balance-chip" aria-label={`Token balance ${tokenBalance}`}>
                <span className="quick-balance-label">Tokens</span>
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

            {openRightPanel === "account" ? (
              user ? (
                <div className="account-panel">
                  <section className="account-hero">
                    <div className="account-hero-copy">
                      <p className="account-kicker">Player account</p>
                      <p className="account-name">{profile?.display_name ?? user.email}</p>
                      <p className="account-subtitle">{user.email}</p>
                      <div className="account-badge-row">
                        <span className="account-badge">{profile?.tier ?? "Bronze"} Tier</span>
                        <span className="account-badge">
                          Prediction streak {streaks?.prediction_streak ?? 0}
                        </span>
                        <span className="account-badge">Login streak {streaks?.login_streak ?? 0}</span>
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
                      <button type="button" className="secondary-button" onClick={handleSignOut}>
                        Sign Out
                      </button>
                    </div>
                  </section>

                  <section className="account-stat-grid">
                    <article className="account-stat-card">
                      <span>Token balance</span>
                      <strong>{tokenBalance}</strong>
                      <p>Available to back the next round.</p>
                    </article>
                    <article className="account-stat-card">
                      <span>Bets tracked</span>
                      <strong>{predictions.length}</strong>
                      <p>Every pick from this account, newest first.</p>
                    </article>
                    <article className="account-stat-card">
                      <span>Hit rate</span>
                      <strong>{hitRateLabel}</strong>
                      <p>{settledPredictions.length} settled picks in view.</p>
                    </article>
                    <article className="account-stat-card">
                      <span>Tokens in play</span>
                      <strong>{openRiskTokens}</strong>
                      <p>{pendingPredictionCount} open or unsettled tickets.</p>
                    </article>
                  </section>

                  <section className="account-history-section">
                    <div className="account-history-header">
                      <div>
                        <p className="account-section-kicker">Betting history</p>
                        <h3 className="account-section-title">Every round, settled cleanly</h3>
                        <p className="account-section-copy">
                          Stake, line, final count, and token swing all live in one place now.
                        </p>
                      </div>
                      <span className="account-history-count">
                        {loading ? "Refreshing..." : `${predictions.length} bets`}
                      </span>
                    </div>

                    {predictions.length > 0 ? (
                      <div className="account-history-list">
                        {predictions.map((prediction) => {
                          const session = sessionLookup.get(prediction.session_id) ?? null;
                          const historyStatus = getPredictionHistoryStatus(prediction, session, nowMs);
                          const marketLabel = session
                            ? `${prediction.side.toUpperCase()} ${session.threshold}`
                            : prediction.side.toUpperCase();
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
                                <span
                                  className={`bet-history-status bet-history-status-${historyStatus.tone}`}
                                >
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
                                <p>{getPredictionHistoryNote(prediction, session, nowMs)}</p>
                                <span>
                                  {prediction.resolved_at
                                    ? `Settled ${formatShortDateTime(prediction.resolved_at)}`
                                    : session?.starts_at
                                      ? `Round start ${formatShortDateTime(session.starts_at)}`
                                      : "Waiting for round details"}
                                </span>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="account-empty-state">
                        <p className="account-section-kicker">No bets yet</p>
                        <h3 className="account-section-title">Your history will land here</h3>
                        <p className="account-section-copy">
                          Place a round and this panel will start tracking your side, stake, final count,
                          and payout.
                        </p>
                      </div>
                    )}
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
                <ol className="leaderboard modal-leaderboard">
                  {leaderboard.slice(0, 15).map((entry) => (
                    <li key={entry.user_id}>
                      <span>
                        #{entry.rank} {entry.display_name}
                      </span>
                      <span>{entry.token_balance}</span>
                    </li>
                  ))}
                </ol>
                {leaderboard.length === 0 ? <p className="hint">No leaderboard entries yet.</p> : null}
              </>
            )}
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

            <p className="hint auth-modal-hint">
              {authModalHint}
            </p>

            <form className="auth-form auth-modal-form" onSubmit={handleAuthSubmit}>
              <div className="mode-row">
                <button
                  type="button"
                  className={authMode === "sign-in" ? "mode-button active" : "mode-button"}
                  onClick={() => setAuthMode("sign-in")}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  className={authMode === "sign-up" ? "mode-button active" : "mode-button"}
                  onClick={() => setAuthMode("sign-up")}
                >
                  Sign Up
                </button>
              </div>
              <label>
                Email
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  required
                  minLength={6}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {authMode === "sign-up" ? (
                <label>
                  Display Name
                  <input
                    required
                    minLength={2}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </label>
              ) : null}
              <button type="submit" className="primary-button">
                {authMode === "sign-in" ? "Sign In" : "Create Account"}
              </button>
            </form>
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
