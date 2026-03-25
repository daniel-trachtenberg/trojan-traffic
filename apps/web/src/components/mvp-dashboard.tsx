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
import {
  formatPayoutMultiplier,
  getPredictionGrossPayoutTokens,
  getPredictionNetWinTokens,
  getPredictionPayoutMultiplierBps,
  getRangeWidth
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

type ProfileRow = {
  display_name: string;
  tier: string;
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

type PredictionHistoryTone = "win" | "loss" | "pending" | "cancelled";

const DEFAULT_WAGER = "10";
const DEFAULT_EXACT_VALUE = "0";
const WAGER_STEPS = [1, 5, 10, 20];
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
  const [tokenBalance, setTokenBalance] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isClaimingDailyLogin, setIsClaimingDailyLogin] = useState(false);
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
  const nextToastIdRef = useRef(0);
  const toastsRef = useRef<ToastRecord[]>([]);
  const toastTimeoutsRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const liveTrainStopXRef = useRef<number | null>(null);
  const liveTrainStopSessionIdRef = useRef<string | null>(null);
  const publicProfileLoadIdRef = useRef(0);

  const sessionLookup = new Map(sessions.map((session) => [session.id, session]));
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
  const displayedThreshold = selectedSession?.threshold ?? 5;
  const selectedStartsAtMs = selectedSession ? new Date(selectedSession.starts_at).getTime() : null;
  const selectedEndsAtMs = selectedSession ? new Date(selectedSession.ends_at).getTime() : null;
  const selectedCountdown = selectedStartsAtMs !== null ? formatCountdown(selectedStartsAtMs - nowMs) : "00:00";
  const selectedOpensInLabel = selectedSession
    ? formatReadableDuration(new Date(selectedSession.starts_at).getTime() - nowMs - BETTING_OPEN_WINDOW_MS)
    : "Soon";
  const selectedWager = selectedSession ? (wagerBySession[selectedSession.id] ?? DEFAULT_WAGER) : DEFAULT_WAGER;
  const selectedSide = selectedSession ? (sideBySession[selectedSession.id] ?? "over") : "over";
  const selectedExactValue = selectedSession
    ? (exactValueBySession[selectedSession.id] ?? String(selectedSession.threshold ?? DEFAULT_EXACT_VALUE))
    : DEFAULT_EXACT_VALUE;
  const selectedRangeMin = selectedSession
    ? (rangeMinBySession[selectedSession.id] ?? getDefaultRangeMin(selectedSession.threshold))
    : DEFAULT_EXACT_VALUE;
  const selectedRangeMax = selectedSession
    ? (rangeMaxBySession[selectedSession.id] ?? getDefaultRangeMax(selectedSession.threshold))
    : DEFAULT_EXACT_VALUE;
  const selectedConfiguredWager = Number.parseInt(selectedWager, 10);
  const selectedConfiguredRangeMin = Number.parseInt(selectedRangeMin, 10);
  const selectedConfiguredRangeMax = Number.parseInt(selectedRangeMax, 10);
  const selectedPricingSide = selectedSide;
  const selectedPricingWager =
    Number.isFinite(selectedConfiguredWager) && selectedConfiguredWager > 0 ? selectedConfiguredWager : null;
  const selectedPricingRangeMin =
    Number.isFinite(selectedConfiguredRangeMin) ? selectedConfiguredRangeMin : null;
  const selectedPricingRangeMax =
    Number.isFinite(selectedConfiguredRangeMax) ? selectedConfiguredRangeMax : null;
  const selectedPricingRangeWidth = getRangeWidth(selectedPricingRangeMin, selectedPricingRangeMax);
  const selectedPricingMultiplierBps =
    getPredictionPayoutMultiplierBps(selectedPricingSide, selectedPricingRangeMin, selectedPricingRangeMax);
  const selectedPricingGrossPayout =
    selectedPricingWager !== null
      ? getPredictionGrossPayoutTokens(selectedPricingWager, selectedPricingMultiplierBps)
      : null;
  const selectedPricingNetWin =
    selectedPricingWager !== null
      ? getPredictionNetWinTokens(selectedPricingWager, selectedPricingMultiplierBps)
      : null;
  const selectedPricingLabel = hasSelectedSessionPredictions ? "Next Ticket" : "Odds";
  const selectedPricingNote =
    selectedPricingWager === null || selectedPricingMultiplierBps === null || selectedPricingGrossPayout === null
      ? "Set a valid wager to preview the payout."
      : selectedPricingSide === "range" && selectedPricingRangeWidth !== null
        ? `${selectedPricingWager} in, ${selectedPricingGrossPayout} back. Covers ${selectedPricingRangeWidth} exact counts.`
        : `${selectedPricingWager} in, ${selectedPricingGrossPayout} back. Profit +${selectedPricingNetWin ?? 0}.`;
  const canConfigureSelected = Boolean(selectedSession && selectedState === "open");
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
      : hasSelectedSessionPredictions
      ? "Add Bet"
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
  const selectedSessionId = selectedSession?.id ?? null;
  const publicProfileDisplayName =
    publicProfileSummary?.display_name ?? publicProfileContext?.display_name ?? "Public Profile";
  const publicProfileTier = publicProfileSummary?.tier ?? publicProfileContext?.tier ?? "Trader";
  const publicProfileRank = publicProfileSummary?.rank ?? publicProfileContext?.rank ?? null;
  const publicProfileTotalPredictions =
    publicProfileSummary?.total_predictions ?? publicProfilePredictions.length;
  const publicProfileCorrectPredictions =
    publicProfileSummary?.correct_predictions ??
    publicProfilePredictions.filter((prediction) => prediction.was_correct === true).length;
  const publicProfileSettledPredictions =
    publicProfileSummary?.settled_predictions ??
    publicProfilePredictions.filter((prediction) => prediction.was_correct !== null).length;
  const publicProfileHitRateLabel =
    publicProfileSettledPredictions > 0
      ? `${Math.round((publicProfileCorrectPredictions / publicProfileSettledPredictions) * 100)}%`
      : "--";
  const publicProfileHistoryCountLabel =
    isPublicProfileLoading && !publicProfileSummary
      ? "Loading..."
      : publicProfileSummary && publicProfileSummary.total_predictions > publicProfilePredictions.length
        ? `Latest ${publicProfilePredictions.length} of ${publicProfileSummary.total_predictions} bets`
        : `${publicProfileTotalPredictions} bets`;
  const publicProfileSessionRows = mergeSessionRows(
    publicProfilePredictions.map((prediction) => ({
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
  const livePeopleCount = null as number | null;
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
      ? "Sign In / Sign Up"
      : !user && hasSelectedSession
        ? "Sign In / Sign Up to Join"
        : null;
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
      .select(
        "id,session_id,side,wager_tokens,payout_multiplier_bps,exact_value,range_min,range_max,was_correct,token_delta,resolved_at,placed_at"
      )
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
      setAuthMode("sign-in");
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

  function closeAuthModal() {
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

  function applyMobileWagerPreset(preset: "min" | "double" | number) {
    if (!selectedSession || !canConfigureSelected) {
      return;
    }

    if (preset === "min") {
      updateSelectedWager(selectedSession.id, "1");
      return;
    }

    if (preset === "double") {
      const parsedCurrentWager = Number.parseInt(selectedWager, 10);
      const nextWager = Math.max(Number.isFinite(parsedCurrentWager) ? parsedCurrentWager : 1, 1) * 2;
      updateSelectedWager(selectedSession.id, String(nextWager));
      return;
    }

    adjustSelectedWager(selectedSession.id, preset);
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

  const rangeMarketLabel = `${selectedRangeMin || getDefaultRangeMin(displayedThreshold)}-${selectedRangeMax || getDefaultRangeMax(displayedThreshold)}`;
  const exactMarketLabel = selectedExactValue || `${displayedThreshold}`;
  const mobileRoundProgressRatio = (() => {
    if (!selectedSession || !selectedState) {
      return 0;
    }

    if (selectedState === "open" && selectedStartsAtMs !== null) {
      const bettingOpensAtMs = selectedStartsAtMs - BETTING_OPEN_WINDOW_MS;
      return clamp((nowMs - bettingOpensAtMs) / BETTING_OPEN_WINDOW_MS, 0, 1);
    }

    if (selectedState === "live" && selectedStartsAtMs !== null && selectedEndsAtMs !== null) {
      return clamp(
        (nowMs - selectedStartsAtMs) / Math.max(selectedEndsAtMs - selectedStartsAtMs, 1),
        0,
        1
      );
    }

    if (selectedState === "resolving" || selectedState === "resolved") {
      return 1;
    }

    return 0;
  })();
  const mobileSpotlightTitle = showResolvedRoundCard
    ? selectedResultPresentation.headline
    : showBettingControls
      ? "How many walkers?"
      : showLiveRoundCard
        ? "Track the live walkway"
        : standbyValue;
  const mobileSpotlightCopy = showResolvedRoundCard
    ? selectedResultPresentation.copy
    : showLiveRoundCard
      ? `Focused on the yellow box while the ${displayedModeSeconds}s round runs.`
      : showBettingControls
        ? "Pick your market, tune the stake, and fire before the window closes."
        : standbyNote;
  const mobileMarketChoices = [
    {
      side: "under" as const,
      accent: "under",
      icon: "v",
      label: "Under",
      detail: `Below ${displayedThreshold}`,
      multiplier: formatPayoutMultiplier(getPredictionPayoutMultiplierBps("under"))
    },
    {
      side: "range" as const,
      accent: "range",
      icon: "<>",
      label: "Range",
      detail: rangeMarketLabel,
      multiplier: formatPayoutMultiplier(
        getPredictionPayoutMultiplierBps("range", selectedPricingRangeMin, selectedPricingRangeMax)
      )
    },
    {
      side: "over" as const,
      accent: "over",
      icon: "^",
      label: "Over",
      detail: `${displayedThreshold}+`,
      multiplier: formatPayoutMultiplier(getPredictionPayoutMultiplierBps("over"))
    },
    {
      side: "exact" as const,
      accent: "exact",
      icon: "*",
      label: "Exact",
      detail: exactMarketLabel,
      multiplier: formatPayoutMultiplier(getPredictionPayoutMultiplierBps("exact"))
    }
  ];
  const mobileSelectedChoice =
    mobileMarketChoices.find((choice) => choice.side === selectedSide) ?? mobileMarketChoices[2];
  const mobileBetAmountLabel =
    Number.isFinite(selectedConfiguredWager) && selectedConfiguredWager > 0
      ? `${selectedConfiguredWager}`
      : "--";
  const mobilePotentialWinLabel =
    selectedPricingGrossPayout !== null ? `${selectedPricingGrossPayout}` : "--";
  const mobileFeedStatusLabel = showResolvedRoundCard
    ? "Result posted"
    : showBettingControls
      ? "Bets open"
      : showLiveRoundCard
        ? "Round live"
        : "Live feed";
  const mobileFeedMetaLabel = hasSelectedSession
    ? `${sessionMetricLabel} ${sessionMetricValue}`
    : "Tommy Walkway";
  const mobileDockTitle = showBettingControls
    ? "Place your bet"
    : showResolvedRoundCard
      ? selectedResultPresentation.headline
      : showLiveRoundCard
        ? "Round in progress"
        : mobileSpotlightTitle;
  const mobileDockCopy = showBettingControls
    ? "Choose a market, set your stake, and lock it in before the window closes."
    : !user && !hasSelectedSession
      ? "Sign in now so you're ready when the next round is posted."
      : mobileSpotlightCopy;
  const bettingWidgetContent = (
    <div className="mobile-betting-dock-shell">
      {showBettingControls ? (
        <>
          <div className="mobile-dock-header">
            <div className="mobile-dock-header-copy">
              <strong>{mobileDockTitle}</strong>
              <span>{mobileDockCopy}</span>
            </div>
          </div>

          <div className="mobile-dock-chip-row">
            <span className={selectedState ? `status status-${selectedState}` : "status"}>
              {selectedState ? getSessionStateLabel(selectedState) : "Standby"}
            </span>
            {hasSelectedSession ? <span className="round-chip">{mobileFeedMetaLabel}</span> : null}
            {hasSelectedSession ? <span className="round-chip">{displayedThreshold}+ over line</span> : null}
          </div>

          <div className="mobile-stage-progress-track" aria-hidden="true">
            <span style={{ width: `${mobileRoundProgressRatio * 100}%` }} />
          </div>

          <div className="mobile-betting-dock-topline">
            <div className="mobile-betting-dock-stat">
              <span>Bet amount</span>
              <strong>{mobileBetAmountLabel}</strong>
            </div>
            <div className="mobile-betting-dock-stat mobile-betting-dock-stat-highlight">
              <span>Potential win</span>
              <strong>{mobilePotentialWinLabel}</strong>
            </div>
          </div>

          <div className="mobile-choice-grid">
            {mobileMarketChoices.map((choice) => (
              <button
                key={choice.side}
                type="button"
                className={
                  selectedSide === choice.side
                    ? `mobile-choice-button mobile-choice-${choice.accent} active`
                    : `mobile-choice-button mobile-choice-${choice.accent}`
                }
                onClick={() => {
                  if (selectedSession) {
                    updateSelectedSide(selectedSession.id, choice.side);
                  }
                  }}
                  disabled={!canConfigureSelected}
              >
                <span className={`mobile-choice-icon mobile-choice-icon-${choice.accent}`} aria-hidden="true">
                  {choice.icon}
                </span>
                <span className="mobile-choice-copy">
                  <span className="mobile-choice-label">{choice.label}</span>
                  <span className="mobile-choice-detail">{choice.detail}</span>
                </span>
                <span className="mobile-choice-multiplier">{choice.multiplier}</span>
              </button>
            ))}
          </div>

          {selectedSide === "exact" ? (
            <div className="mobile-config-row mobile-config-row-single">
              <label className="mobile-config-field">
                <span>Exact call</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={selectedExactValue}
                  onChange={(event) => {
                    if (selectedSession) {
                      updateSelectedExactValue(selectedSession.id, event.target.value);
                    }
                  }}
                  disabled={!canConfigureSelected}
                />
              </label>
            </div>
          ) : null}

          {selectedSide === "range" ? (
            <div className="mobile-config-row">
              <label className="mobile-config-field">
                <span>Min</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={selectedRangeMin}
                  onChange={(event) => {
                    if (selectedSession) {
                      updateSelectedRangeMin(selectedSession.id, event.target.value);
                    }
                  }}
                  disabled={!canConfigureSelected}
                />
              </label>
              <label className="mobile-config-field">
                <span>Max</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={selectedRangeMax}
                  onChange={(event) => {
                    if (selectedSession) {
                      updateSelectedRangeMax(selectedSession.id, event.target.value);
                    }
                  }}
                  disabled={!canConfigureSelected}
                />
              </label>
            </div>
          ) : null}

          {selectedSessionPredictionCount > 0 ? (
            <div className="mobile-slip-banner">
              <span>Current slips</span>
              <strong>
                {selectedSessionPredictionCount > 1
                  ? `${selectedSessionPredictionCount} live tickets`
                  : formatPredictionLabel(selectedPrediction, selectedSession)}
              </strong>
              <span>{selectedSessionStakedTokens} tokens already committed</span>
            </div>
          ) : null}

          <div className="mobile-stake-control-row">
            <label className="mobile-stake-panel">
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

            <div className="mobile-stake-chip-row">
              <button type="button" className="mobile-stake-chip" onClick={() => applyMobileWagerPreset("min")}>
                MIN
              </button>
              <button type="button" className="mobile-stake-chip" onClick={() => applyMobileWagerPreset(1)}>
                +1
              </button>
              <button type="button" className="mobile-stake-chip" onClick={() => applyMobileWagerPreset(5)}>
                +5
              </button>
              <button type="button" className="mobile-stake-chip" onClick={() => applyMobileWagerPreset(10)}>
                +10
              </button>
              <button type="button" className="mobile-stake-chip" onClick={() => applyMobileWagerPreset("double")}>
                2x
              </button>
            </div>
          </div>

          <div className="mobile-bet-footer">
            <div className="mobile-bet-summary">
              <span>{mobileSelectedChoice.label}</span>
              <strong>
                {mobilePotentialWinLabel === "--"
                  ? "Set stake"
                  : `${mobilePotentialWinLabel} return`}
              </strong>
            </div>
            <button
              type="button"
              className="mobile-bet-cta"
              disabled={betButtonDisabled}
              onClick={() => {
                if (selectedSession) {
                  handleBetAction(selectedSession);
                  return;
                }

                handleEmptyStateSignupAction();
              }}
            >
              <span className="mobile-bet-cta-accent">{mobileSelectedChoice.label}</span>
              <strong>{betButtonLabel}</strong>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mobile-dock-status-card">
            <div className="mobile-dock-header">
              <div className="mobile-dock-header-copy">
                <strong>{mobileDockTitle}</strong>
                <span>{mobileDockCopy}</span>
              </div>
              <span className={selectedState ? `status status-${selectedState}` : "status"}>
                {selectedState ? getSessionStateLabel(selectedState) : "Standby"}
              </span>
            </div>
            {selectedSessionPredictionCount > 0 ? (
              <div className="mobile-slip-banner">
                <span>Your live slips</span>
                <strong>
                  {selectedSessionPredictionCount > 1
                    ? `${selectedSessionPredictionCount} tickets on this round`
                    : formatPredictionLabel(selectedPrediction, selectedSession)}
                </strong>
                <span>{selectedSessionStakedTokens} tokens committed</span>
              </div>
            ) : null}
            {!user ? (
              <button
                type="button"
                className="mobile-bet-cta mobile-bet-cta-secondary"
                  onClick={hasSelectedSession ? handleRoundAuthAction : handleEmptyStateSignupAction}
              >
                <span className="mobile-bet-cta-accent">Join</span>
                <strong>{standbyActionLabel ?? "Sign In / Sign Up"}</strong>
                <span>Be ready as soon as the next window opens.</span>
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
        </>
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

  return (
    <main
      className={
        isMobileViewport
          ? isPhoneViewport
            ? "betting-screen betting-screen-mobile betting-screen-mobile-phone"
            : "betting-screen betting-screen-mobile"
          : "betting-screen"
      }
    >
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
              <header className="mobile-stage-header">
                <div className="mobile-stage-brand">
                  <p className="mobile-stage-kicker">Tommy Walkway</p>
                  <strong>Live betting</strong>
                  <span>
                    {hasSelectedSession
                      ? `${displayedModeSeconds}s round · ${selectedState ? getSessionStateLabel(selectedState) : "Standby"}`
                      : "Live campus feed"}
                  </span>
                </div>

                <div className="mobile-stage-header-actions">
                  {user ? (
                    <div className="mobile-stage-balance">
                      <span>Balance</span>
                      <strong>{tokenBalance}</strong>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="mobile-stage-pill"
                    onClick={() => toggleRightPanel("leaderboard")}
                  >
                    Leaderboard
                  </button>
                  <button
                    type="button"
                    className="mobile-stage-pill"
                    onClick={handleAccountAction}
                  >
                    {user ? "Account" : "Sign In"}
                  </button>
                  {isAdmin ? (
                    <button
                      type="button"
                      className="mobile-stage-pill"
                      onClick={() => toggleRightPanel("admin")}
                    >
                      Admin
                    </button>
                  ) : null}
                </div>
              </header>

              <div className="mobile-stage-hero">
                <div className="mobile-feed-frame">
                  <div className="mobile-game-feed">
                    <LiveFeed
                      src={hlsUrl}
                      imageSrc={liveFrameUrl}
                      mediaAspectRatio={liveFeedAspectRatio}
                      region={regionPoints}
                      personBoxes={livePersonBoxes}
                      statusMessage={activeVisionApiUrl ? liveFeedStatusMessage : null}
                      regionEditorEnabled={canEditRegion}
                      onRegionChange={canEditRegion ? setRegionPoints : null}
                    />
                    <div className="feed-mask mobile-arena-mask" />
                  </div>

                  <div className="mobile-feed-overlay">
                    {showBettingControls || showLiveRoundCard || showResolvedRoundCard ? (
                      <div className="mobile-feed-badge-row">
                        <span
                          className={
                            showBettingControls
                              ? "status status-live-badge mobile-feed-live-badge"
                              : selectedState
                                ? `status status-${selectedState}`
                                : "status"
                          }
                        >
                          {showBettingControls ? <span className="status-live-dot" aria-hidden="true" /> : null}
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

              {regionEditorDock ? (
                <div className="mobile-region-editor-shell">{regionEditorDock}</div>
              ) : null}
            </section>

            <section className="mobile-betting-dock">{bettingWidgetContent}</section>
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

                  <button
                    type="button"
                    className={
                      hasSelectedSession && selectedSide === "exact"
                        ? "market-choice-card market-choice-exact active"
                        : "market-choice-card market-choice-exact"
                    }
                    onClick={() => {
                      if (selectedSession) {
                        updateSelectedSide(selectedSession.id, "exact");
                      }
                    }}
                    disabled={!canConfigureSelected}
                  >
                    <span className="market-choice-icon" aria-hidden="true">
                      =
                    </span>
                    <span className="market-choice-title">Exact</span>
                    <span className="market-choice-subtitle">
                      {selectedExactValue ? `Call ${selectedExactValue}` : "Name the final count"}
                    </span>
                  </button>

                  <button
                    type="button"
                    className={
                      hasSelectedSession && selectedSide === "range"
                        ? "market-choice-card market-choice-range active"
                        : "market-choice-card market-choice-range"
                    }
                    onClick={() => {
                      if (selectedSession) {
                        updateSelectedSide(selectedSession.id, "range");
                      }
                    }}
                    disabled={!canConfigureSelected}
                  >
                    <span className="market-choice-icon" aria-hidden="true">
                      ≈
                    </span>
                    <span className="market-choice-title">Range</span>
                    <span className="market-choice-subtitle">
                      {selectedRangeMin && selectedRangeMax
                        ? `${selectedRangeMin} to ${selectedRangeMax}`
                        : "Pick a min and max"}
                    </span>
                  </button>
                </div>

                {hasSelectedSession && selectedSide === "exact" ? (
                  <div className="market-config-card">
                    <div className="market-config-header">
                      <span className="market-config-label">Exact count</span>
                      <span className="market-config-hint">Whole number, zero or higher</span>
                    </div>

                    <div className="market-config-field-grid market-config-field-grid-single">
                      <label className="market-config-field">
                        <span>Your call</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={selectedExactValue}
                          onChange={(event) => {
                            if (selectedSession) {
                              updateSelectedExactValue(selectedSession.id, event.target.value);
                            }
                          }}
                          disabled={!canConfigureSelected}
                        />
                      </label>
                    </div>
                  </div>
                ) : null}

                {hasSelectedSession && selectedSide === "range" ? (
                  <div className="market-config-card">
                    <div className="market-config-header">
                      <span className="market-config-label">Inclusive range</span>
                      <span className="market-config-hint">Whole numbers, zero or higher</span>
                    </div>

                    <div className="market-config-field-grid">
                      <label className="market-config-field">
                        <span>Minimum</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={selectedRangeMin}
                          onChange={(event) => {
                            if (selectedSession) {
                              updateSelectedRangeMin(selectedSession.id, event.target.value);
                            }
                          }}
                          disabled={!canConfigureSelected}
                        />
                      </label>

                      <label className="market-config-field">
                        <span>Maximum</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={selectedRangeMax}
                          onChange={(event) => {
                            if (selectedSession) {
                              updateSelectedRangeMax(selectedSession.id, event.target.value);
                            }
                          }}
                          disabled={!canConfigureSelected}
                        />
                      </label>
                    </div>
                  </div>
                ) : null}

                <div className="market-metrics-row">
                  <div className="market-metric">
                    <span className="market-metric-label">{sessionMetricLabel}</span>
                    <strong>{sessionMetricValue}</strong>
                    <span className="market-metric-note">{sessionMetricNote}</span>
                  </div>
                  <div className="market-metric">
                    <span className="market-metric-label">{selectedPricingLabel}</span>
                    <strong>{formatPayoutMultiplier(selectedPricingMultiplierBps)}</strong>
                    <span className="market-metric-note">{selectedPricingNote}</span>
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

          {selectedSessionPredictionCount > 0 && !showLiveRoundCard && !showResolvedRoundCard ? (
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
                    <PredictionHistoryList
                      predictions={predictions}
                      sessionLookup={sessionLookup}
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
                <p className="leaderboard-panel-note">
                  Tap any bettor to open their public profile and recent betting history.
                </p>
                <ol className="leaderboard modal-leaderboard">
                  {leaderboard.slice(0, 15).map((entry) => (
                    <li key={entry.user_id}>
                      <button
                        type="button"
                        className="leaderboard-entry-button"
                        onClick={() => void handleOpenPublicProfile(entry)}
                        aria-label={`Open ${entry.display_name}'s betting profile`}
                      >
                        <span className="leaderboard-entry-rank">#{entry.rank}</span>
                        <span className="leaderboard-entry-copy">
                          <span className="leaderboard-entry-name">{entry.display_name}</span>
                          <span className="leaderboard-entry-meta">
                            {entry.correct_predictions} correct picks · {entry.tier}
                          </span>
                        </span>
                        <span className="leaderboard-entry-score-shell">
                          <span className="leaderboard-entry-score-label">Bankroll</span>
                          <span className="leaderboard-entry-score">{entry.token_balance}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
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
              </section>

              <section className="account-stat-grid">
                <article className="account-stat-card">
                  <span>Leaderboard rank</span>
                  <strong>{publicProfileRank !== null ? `#${publicProfileRank}` : "--"}</strong>
                  <p>Ranked by live token balance, then correct picks.</p>
                </article>
                <article className="account-stat-card">
                  <span>Token balance</span>
                  <strong>{publicProfileSummary?.token_balance ?? "--"}</strong>
                  <p>Current bankroll visible to the whole market.</p>
                </article>
                <article className="account-stat-card">
                  <span>Bets tracked</span>
                  <strong>{publicProfileTotalPredictions}</strong>
                  <p>Every visible ticket from this bettor.</p>
                </article>
                <article className="account-stat-card">
                  <span>Hit rate</span>
                  <strong>{publicProfileHitRateLabel}</strong>
                  <p>{publicProfileSettledPredictions} settled picks on record.</p>
                </article>
              </section>

              <section className="account-history-section">
                <div className="account-history-header">
                  <div>
                    <p className="account-section-kicker">Public history</p>
                    <h3 className="account-section-title">{publicProfileDisplayName}&rsquo;s recent bets</h3>
                    <p className="account-section-copy">
                      Open positions and settled rounds stay visible together in one clean tape.
                    </p>
                  </div>
                  <span className="account-history-count">{publicProfileHistoryCountLabel}</span>
                </div>

                {publicProfileError ? (
                  <p className="public-profile-status-card">{publicProfileError}</p>
                ) : isPublicProfileLoading && !publicProfileSummary ? (
                  <p className="public-profile-status-card">Loading recent activity...</p>
                ) : (
                  <PredictionHistoryList
                    predictions={publicProfilePredictions}
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
                    onClick={() => setAuthMode("sign-in")}
                  >
                    Back to Sign In
                  </button>
                  <button
                    type="button"
                    className="auth-inline-action"
                    onClick={() => setAuthMode("sign-up")}
                  >
                    Need an account?
                  </button>
                </div>
              ) : (
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
                          setAuthMode("forgot-password");
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
                    onClick={() => setAuthMode("sign-in")}
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
