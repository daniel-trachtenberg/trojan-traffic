"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { LiveFeed } from "@/components/live-feed";
import {
  bettingRegionsEqual,
  normalizeBettingRegion,
  type RegionPoint
} from "@/lib/betting-region";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";

type PredictionSide = "over" | "under";

type SessionState = "open" | "live" | "resolving" | "resolved" | "cancelled";

type SessionRow = {
  id: string;
  mode_seconds: number;
  threshold: number;
  starts_at: string;
  ends_at: string;
  status: string;
  final_count: number | null;
  resolved_at: string | null;
  region_polygon: unknown;
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

type MvpDashboardProps = {
  hlsUrl: string;
  initialRegion: RegionPoint[];
  regionEditorEnabled?: boolean;
  visionApiUrl?: string;
};

type ToastTone = "success" | "error" | "warning";

type ToastRecord = {
  id: number;
  tone: ToastTone;
  message: string;
  dedupeKey?: string;
};

const DEFAULT_WAGER = "10";
const WAGER_STEPS = [1, 5, 10, 20];
const DEFAULT_TOAST_DURATION_MS = 5000;
const SUCCESS_TOAST_DURATION_MS = 4200;
const ERROR_TOAST_DURATION_MS = 6200;
const MAX_VISIBLE_TOASTS = 4;

function formatCountdown(milliseconds: number) {
  const safeMilliseconds = Math.max(milliseconds, 0);
  const totalSeconds = Math.floor(safeMilliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
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

  if (nowMs < startsAt) {
    return "open";
  }

  if (nowMs <= endsAt) {
    return "live";
  }

  return "resolving";
}

function getSessionStateLabel(state: SessionState) {
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

function createFallbackSessions(region: RegionPoint[]): SessionRow[] {
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
      resolved_at: null,
      region_polygon: region
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
  regionEditorEnabled = false,
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
  const [openRightPanel, setOpenRightPanel] = useState<"account" | "leaderboard" | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authIntentSessionId, setAuthIntentSessionId] = useState<string | null>(null);
  const [liveDetections, setLiveDetections] = useState<LiveDetectionsResponse | null>(null);
  const [regionPoints, setRegionPoints] = useState(() => normalizeBettingRegion(initialRegion));
  const [savedRegionPoints, setSavedRegionPoints] = useState(() =>
    normalizeBettingRegion(initialRegion)
  );
  const [isSavingRegion, setIsSavingRegion] = useState(false);
  const nextToastIdRef = useRef(0);
  const toastsRef = useRef<ToastRecord[]>([]);
  const toastTimeoutsRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const predictionBySession = new Map(predictions.map((prediction) => [prediction.session_id, prediction]));
  const openRisk = predictions
    .filter((prediction) => prediction.resolved_at === null)
    .reduce((sum, prediction) => sum + prediction.wager_tokens, 0);
  const availableTokens = tokenBalance - openRisk;
  const focusedSession = sessions.find((session) => getSessionState(session, nowMs) === "open");
  const inFlightSession =
    sessions.find((session) => {
      const state = getSessionState(session, nowMs);
      return state === "live" || state === "resolving";
    }) ?? null;
  const selectedSession = focusedSession ?? inFlightSession;
  const hasSelectedSession = Boolean(selectedSession);
  const selectedPrediction = selectedSession
    ? predictionBySession.get(selectedSession.id) ?? null
    : null;
  const selectedState = selectedSession ? getSessionState(selectedSession, nowMs) : null;
  const displayedModeSeconds = selectedSession?.mode_seconds ?? 30;
  const displayedThreshold = selectedSession?.threshold ?? 5;
  const selectedCountdown = selectedSession
    ? formatCountdown(new Date(selectedSession.starts_at).getTime() - nowMs)
    : "00:00";
  const selectedWager = selectedSession ? (wagerBySession[selectedSession.id] ?? DEFAULT_WAGER) : DEFAULT_WAGER;
  const selectedSide = selectedSession ? (sideBySession[selectedSession.id] ?? "over") : "over";
  const canConfigureSelected = Boolean(selectedSession && selectedState === "open" && selectedPrediction === null);
  const showBettingControls = Boolean(selectedSession && selectedState === "open");
  const emptyStateSignupEnabled = !hasSelectedSession && !user;
  const betButtonDisabled = hasSelectedSession ? !canConfigureSelected : !emptyStateSignupEnabled;
  const betButtonLabel = hasSelectedSession
    ? selectedPrediction
      ? "Entered"
      : "Bet"
    : user
      ? "Waiting"
      : "Sign Up";
  const sessionMetricLabel =
    selectedState === "open"
      ? "Closes In"
      : selectedState === "live"
        ? "Betting"
        : selectedState === "resolving"
          ? "Round"
          : "Status";
  const sessionMetricValue =
    selectedState === "open"
      ? selectedCountdown
      : selectedState === "live"
        ? "Locked"
        : selectedState === "resolving"
          ? "Resolving"
          : selectedState
            ? getSessionStateLabel(selectedState)
            : "Waiting";
  const sessionMetricNote =
    selectedState === "open"
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
  const selectedEndsAtLabel = selectedSession
    ? new Date(selectedSession.ends_at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    : null;
  const standbyLabel = !selectedSession
    ? "Watching the board"
    : selectedState === "live"
      ? "Round in motion"
      : selectedState === "resolving"
        ? "Results incoming"
        : selectedState === "resolved"
          ? "Round complete"
          : "Board update";
  const standbyValue = !selectedSession
    ? "Stand by"
    : selectedState === "live"
      ? "In progress"
      : selectedState === "resolving"
        ? "Reviewing"
        : selectedState === "resolved"
          ? "Wrapped"
          : "Paused";
  const standbyTitle = !selectedSession
    ? "No new Tommy Walkway round has been posted yet."
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
    : selectedState === "live"
      ? `Started at ${selectedStartsAtLabel}. Check back here when the next window opens.`
      : selectedState === "resolving"
        ? `Window closed at ${selectedEndsAtLabel}. Final results should appear here shortly.`
        : selectedState === "resolved"
          ? `Last window ended at ${selectedEndsAtLabel}. We will post the next one here when it is ready.`
          : "We will surface the next playable window here as soon as it is available.";
  const hasUnsavedRegionChanges = !bettingRegionsEqual(regionPoints, savedRegionPoints);
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
      setSessions(createFallbackSessions(regionPoints));
      setPredictions([]);
      setLeaderboard([]);
      setProfile(null);
      setStreaks(null);
      setTokenBalance(0);
      return;
    }

    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const sessionResponse = await supabase
      .from("game_sessions")
      .select(
        "id,mode_seconds,threshold,starts_at,ends_at,status,final_count,resolved_at,region_polygon"
      )
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

    setSessions(sessionRows);
    setLeaderboard(leaderboardRows);
    setProfile((profileResponse.data as ProfileRow | null) ?? null);
    setStreaks((streakResponse.data as StreakRow | null) ?? null);
    setTokenBalance((balanceResponse.data as BalanceRow | null)?.token_balance ?? 0);
    setPredictions((predictionResponse.data as PredictionRow[]) ?? []);
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

    setNotice("Signed in.");
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
      ? (claimResponse.data[0] as { tokens_awarded: number; login_streak: number } | undefined)
      : undefined;

    if (claim) {
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

    setNotice(`Prediction submitted: ${side.toUpperCase()} ${session.threshold}.`);
    startTransition(() => {
      void load(activeUser);
    });
  }

  function closeAuthModal() {
    setShowAuthModal(false);
    setAuthIntentSessionId(null);
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
      setAuthMode("sign-in");
      setAuthIntentSessionId(session.id);
      setShowAuthModal(true);
      return;
    }

    void handlePlacePrediction(session, user);
  }

  function handleEmptyStateSignupAction() {
    if (!emptyStateSignupEnabled) {
      return;
    }

    if (!supabase) {
      setError("Configure Supabase before signing up.");
      return;
    }

    setError(null);
    setNotice(null);
    setAuthIntentSessionId(null);
    setAuthMode("sign-up");
    setShowAuthModal(true);
  }

  function handleAccountAction() {
    if (!user) {
      if (!supabase) {
        setError("Configure Supabase before signing in.");
        return;
      }

      setOpenRightPanel(null);
      setAuthIntentSessionId(null);
      setAuthMode("sign-in");
      setShowAuthModal(true);
      return;
    }

    toggleRightPanel("account");
  }

  function toggleRightPanel(panel: "account" | "leaderboard") {
    setOpenRightPanel((current) => (current === panel ? null : panel));
  }

  async function handleSaveRegion() {
    if (!regionEditorEnabled) {
      return;
    }

    setError(null);
    setNotice(null);
    setIsSavingRegion(true);

    try {
      const response = await fetch("/api/admin/region", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
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
      setNotice("Betting region saved. Disable REGION_EDITOR_ENABLED when you are done.");
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Failed to save betting region.";
      setError(message);
    } finally {
      setIsSavingRegion(false);
    }
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
        regionEditorEnabled={regionEditorEnabled}
        onRegionChange={regionEditorEnabled ? setRegionPoints : null}
      />
      <div className="feed-mask" />

      <div className="floating-widgets">
        <section className="floating-widget bet-widget">
          <header className="widget-header bet-widget-header">
            <div className="widget-title-block">
              <p className="widget-kicker">Tommy Walkway</p>
              <h2>Betting</h2>
            </div>
            <span className="status">{isRefreshing ? "Refreshing" : "Live"}</span>
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
            ) : (
              <div className="market-standby-card">
                <span className="market-standby-label">{standbyLabel}</span>
                <strong>{standbyValue}</strong>
                <p className="market-standby-title">{standbyTitle}</p>
                <span className="market-standby-note">{standbyNote}</span>
                {emptyStateSignupEnabled ? (
                  <button
                    type="button"
                    className="bet-submit-button market-standby-button"
                    onClick={handleEmptyStateSignupAction}
                  >
                    Get ready for next round
                  </button>
                ) : null}
              </div>
            )}
          </div>

          {selectedPrediction ? (
            <p className="session-result compact-result selection-summary">
              Locked in: <strong>{selectedPrediction.side.toUpperCase()}</strong> ·{" "}
              {selectedPrediction.wager_tokens} tokens
              {selectedPrediction.was_correct !== null
                ? selectedPrediction.was_correct
                  ? ` · Win +${selectedPrediction.token_delta ?? 0}`
                  : ` · Loss ${selectedPrediction.token_delta ?? 0}`
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
            <div className="quick-balance-chip" aria-label={`Token balance ${tokenBalance}`}>
              <span className="quick-balance-label">Tokens</span>
              <strong>{tokenBalance}</strong>
            </div>
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
          {regionEditorEnabled ? (
            <div className="region-editor-panel">
              <p className="region-editor-title">Region Editor</p>
              <p className="region-editor-hint">
                Drag the four handles on the video to fit the walkway, save the shape, then turn
                <code> REGION_EDITOR_ENABLED</code> back off.
              </p>
              <div className="region-editor-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setRegionPoints(savedRegionPoints)}
                  disabled={!hasUnsavedRegionChanges || isSavingRegion}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void handleSaveRegion()}
                  disabled={!hasUnsavedRegionChanges || isSavingRegion}
                >
                  {isSavingRegion ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {openRightPanel ? (
        <div className="center-modal-backdrop" onClick={() => setOpenRightPanel(null)} role="presentation">
          <section
            className="center-modal"
            role="dialog"
            aria-modal="true"
            aria-label={openRightPanel === "account" ? "Account panel" : "Leaderboard panel"}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="widget-header center-modal-header">
              <h2>{openRightPanel === "account" ? "Account" : "Leaderboard"}</h2>
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
                      <span>Available</span>
                      <strong>{availableTokens}</strong>
                    </div>
                    <div>
                      <span>Open Risk</span>
                      <strong>{openRisk}</strong>
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
            aria-label="Sign in to place your bet"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="widget-header center-modal-header">
              <h2>{authMode === "sign-in" ? "Sign In to Bet" : "Create Your Account"}</h2>
              <button
                type="button"
                className="panel-close-button"
                onClick={closeAuthModal}
                aria-label="Close sign-in modal"
              >
                ×
              </button>
            </header>

            <p className="hint auth-modal-hint">
              {authIntentSessionId ? "Sign in first, then your bet will be submitted automatically." : "Sign in to place bets and track tokens."}
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
                    {prediction.was_correct === null
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
