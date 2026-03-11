"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
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

const DEFAULT_WAGER = "10";
const WAGER_STEPS = [1, 5, 10, 20];
const BETTING_OPEN_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_TOAST_DURATION_MS = 5000;
const SUCCESS_TOAST_DURATION_MS = 4200;
const ERROR_TOAST_DURATION_MS = 6200;
const MAX_VISIBLE_TOASTS = 4;
const RESULT_SPOTLIGHT_WINDOW_MS = 10_000;
const LIVE_TRACK_LINE_PROGRESS = 0.68;
const SCREEN_CONFETTI_COLORS = ["#ffcc00", "#f8fafc", "#f59e0b", "#ef4444", "#22c55e", "#60a5fa"];
const SCREEN_CONFETTI_PIECES = Array.from({ length: 120 }, (_, index) => ({
  left: `${(((index * 73) % 1000) / 10).toFixed(1)}%`,
  delayMs: (index % 12) * 110,
  durationMs: 2600 + (index % 7) * 220 + Math.floor(index / 12) * 80,
  color: SCREEN_CONFETTI_COLORS[index % SCREEN_CONFETTI_COLORS.length],
  widthRem: 0.28 + ((index * 11) % 5) * 0.08,
  heightRem: 0.72 + ((index * 17) % 7) * 0.14
}));

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

  return session.final_count >= session.threshold ? "over" : "under";
}

function formatTokenDelta(tokenDelta: number | null) {
  const safeTokenDelta = tokenDelta ?? 0;
  return safeTokenDelta > 0 ? `+${safeTokenDelta}` : `${safeTokenDelta}`;
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

  const predictionBySession = new Map(predictions.map((prediction) => [prediction.session_id, prediction]));
  const pendingPredictionCount = predictions.filter((prediction) => prediction.resolved_at === null).length;
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
  const liveCountTrackProgress =
    livePeopleCount !== null && displayedThreshold > 0
      ? clamp((livePeopleCount / displayedThreshold) * LIVE_TRACK_LINE_PROGRESS, 0.08, 0.95)
      : 0.08;
  const liveTrackProgressPercent = liveCountTrackProgress * 100;
  const liveTrackHasCrossedLine = livePeopleCount !== null && livePeopleCount >= displayedThreshold;
  const liveTrackStateLabel =
    livePeopleCount === null ? "Counter ready" : liveTrackHasCrossedLine ? "Line crossed" : "Below line";
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
      headline: selectedWinningSide ? `${resolvedWinningSideLabel} hit` : "Round closed",
      copy:
        selectedSession.final_count !== null
          ? `${finalCountLabel} people crossed into the box during the ${displayedModeSeconds}s round.`
          : `The ${displayedModeSeconds}s round has ended.`,
      footer: settledAtCopy,
      secondaryLabel: "Winning side",
      secondaryValue: resolvedWinningSideLabel
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
      .select("id,mode_seconds,threshold,starts_at,ends_at,status,final_count,resolved_at")
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
      .select("login_streak,prediction_streak")
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
      .order("placed_at", { ascending: false })
      .limit(40);
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

    setSessions(sessionRows);
    setLeaderboard(leaderboardRows);
    setProfile((profileResponse.data as ProfileRow | null) ?? null);
    setStreaks((streakResponse.data as StreakRow | null) ?? null);
    setTokenBalance((balanceResponse.data as BalanceRow | null)?.token_balance ?? 0);
    setPredictions((predictionResponse.data as PredictionRow[]) ?? []);
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

      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: activeController.signal
        });
        if (!response.ok) {
          if (!isMounted) {
            return;
          }

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
          }, DETECTION_POLL_INTERVAL_MS);
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
    if (!supabase || !user) {
      return;
    }

    setError(null);
    setNotice(null);

    const claimResponse = await supabase.rpc("claim_daily_login");
    if (claimResponse.error) {
      setError(claimResponse.error.message);
      return;
    }

    const claim = Array.isArray(claimResponse.data)
      ? (claimResponse.data[0] as
          | { tokens_awarded: number; token_balance: number; login_streak: number }
          | undefined)
      : undefined;

    if (claim) {
      setTokenBalance(claim.token_balance);
      setNotice(`Daily reward claimed: +${claim.tokens_awarded} tokens (streak ${claim.login_streak}).`);
    }

    startTransition(() => {
      void load(user);
    });
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

  const sessionLookup = new Map(sessions.map((session) => [session.id, session]));

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
                <div className="live-round-overlay-track-state">{liveTrackStateLabel}</div>
              </div>

              <div className="live-round-overlay-track-lane">
                <div
                  className={
                    liveTrackHasCrossedLine
                      ? "live-round-overlay-track-progress live-round-overlay-track-progress-crossed"
                      : "live-round-overlay-track-progress"
                  }
                  style={{ width: `${liveTrackProgressPercent}%` }}
                />
                <div
                  className="live-round-overlay-track-threshold"
                  style={{ left: `${LIVE_TRACK_LINE_PROGRESS * 100}%` }}
                >
                  <span>Line</span>
                </div>
                <div
                  className={
                    liveTrackHasCrossedLine
                      ? "live-round-overlay-track-pack live-round-overlay-track-pack-crossed"
                      : "live-round-overlay-track-pack"
                  }
                  style={{ left: `${liveTrackProgressPercent}%` }}
                >
                  <span className="live-round-overlay-track-pack-dot" />
                  <span className="live-round-overlay-track-pack-dot" />
                  <span className="live-round-overlay-track-pack-dot" />
                </div>
              </div>

              <div className="live-round-overlay-track-scale">
                <span>Under</span>
                <span>Line</span>
                <span>Over</span>
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
            className={openRightPanel === "admin" ? "center-modal admin-modal" : "center-modal"}
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
                  ? "Account"
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
                <div className="account-card">
                  <p className="account-name">{profile?.display_name ?? user.email}</p>
                  <p className="account-subtitle">{profile?.tier ?? "Bronze"} Tier</p>
                  <div className="stat-grid compact-stats">
                    <div>
                      <span>Balance</span>
                      <strong>{tokenBalance}</strong>
                    </div>
                    <div>
                      <span>Pending Bets</span>
                      <strong>{pendingPredictionCount}</strong>
                    </div>
                    <div>
                      <span>Prediction Streak</span>
                      <strong>{streaks?.prediction_streak ?? 0}</strong>
                    </div>
                    <div>
                      <span>Login Streak</span>
                      <strong>{streaks?.login_streak ?? 0}</strong>
                    </div>
                  </div>
                  <div className="account-actions">
                    <button type="button" className="primary-button" onClick={handleClaimDailyLogin}>
                      Claim Daily Tokens
                    </button>
                    <button type="button" className="secondary-button" onClick={handleSignOut}>
                      Sign Out
                    </button>
                  </div>
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

      <div className="bottom-ribbon">
        {user ? (
          <div className="history-strip">
            {predictions.slice(0, 5).map((prediction) => {
              const session = sessionLookup.get(prediction.session_id);
              return (
                <div className="history-pill" key={prediction.id}>
                  <span>
                    {session ? `${session.mode_seconds}s` : "Round"} · {prediction.side.toUpperCase()} ·{" "}
                    {prediction.wager_tokens}
                  </span>
                  <span>
                    {prediction.resolved_at && prediction.was_correct === null
                      ? "Cancelled"
                      : prediction.was_correct === null
                      ? "Pending"
                      : prediction.was_correct
                        ? `+${prediction.token_delta ?? 0}`
                        : `${prediction.token_delta ?? 0}`}
                  </span>
                </div>
              );
            })}
            {predictions.length === 0 ? (
              <div className="history-pill">
                <span>No predictions yet</span>
                <span>{loading ? "Loading..." : "Ready"}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  );
}
