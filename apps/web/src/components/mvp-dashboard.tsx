"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { LiveFeed } from "@/components/live-feed";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";

type PredictionSide = "over" | "under";

type RegionPoint = {
  x: number;
  y: number;
};

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
};

const DEFAULT_WAGER = "10";
const CENTER_REGION: RegionPoint[] = [
  { x: 0.4, y: 0.32 },
  { x: 0.6, y: 0.32 },
  { x: 0.6, y: 0.68 },
  { x: 0.4, y: 0.68 }
];

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
      resolved_at: null,
      region_polygon: CENTER_REGION
    };
  });
}

export function MvpDashboard({ hlsUrl }: MvpDashboardProps) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startTransition] = useTransition();
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [wagerBySession, setWagerBySession] = useState<Record<string, string>>({});
  const [sideBySession, setSideBySession] = useState<Record<string, PredictionSide>>({});
  const [openRightPanel, setOpenRightPanel] = useState<"account" | "leaderboard" | null>(null);

  const predictionBySession = new Map(predictions.map((prediction) => [prediction.session_id, prediction]));
  const openRisk = predictions
    .filter((prediction) => prediction.resolved_at === null)
    .reduce((sum, prediction) => sum + prediction.wager_tokens, 0);
  const availableTokens = tokenBalance - openRisk;
  const focusedSession = sessions.find((session) => getSessionState(session, nowMs) === "open");
  const selectedSession = focusedSession ?? sessions[0] ?? null;
  const selectedPrediction = selectedSession
    ? predictionBySession.get(selectedSession.id) ?? null
    : null;
  const selectedState = selectedSession ? getSessionState(selectedSession, nowMs) : null;
  const selectedCountdown = selectedSession
    ? formatCountdown(new Date(selectedSession.starts_at).getTime() - nowMs)
    : "00:00";
  const selectedWager = selectedSession ? (wagerBySession[selectedSession.id] ?? DEFAULT_WAGER) : DEFAULT_WAGER;
  const selectedSide = selectedSession ? (sideBySession[selectedSession.id] ?? "over") : "over";
  const canPlaceSelected = Boolean(
    user && selectedSession && selectedState === "open" && selectedPrediction === null
  );
  const accountInitial = user
    ? (profile?.display_name ?? user.email ?? "A").charAt(0).toUpperCase()
    : "?";

  async function refreshData(activeUser: User | null) {
    if (!supabase) {
      setSessions(createFallbackSessions());
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
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

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
      setUser(signUpResponse.data.session.user);
      await load(signUpResponse.data.session.user);
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
    setUser(signInResponse.data.user);
    await load(signInResponse.data.user);
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

  async function handlePlacePrediction(session: SessionRow) {
    if (!supabase || !user) {
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
      void load(user);
    });
  }

  function toggleRightPanel(panel: "account" | "leaderboard") {
    setOpenRightPanel((current) => (current === panel ? null : panel));
  }

  const sessionLookup = new Map(sessions.map((session) => [session.id, session]));

  return (
    <main className="betting-screen">
      <LiveFeed src={hlsUrl} region={CENTER_REGION} fullScreen />
      <div className="feed-mask" />

      <div className="floating-widgets">
        <section className="floating-widget bet-widget">
          <header className="widget-header">
            <h2>Betting Screen</h2>
            <span className="status">{isRefreshing ? "Refreshing" : "Live"}</span>
          </header>

          {selectedSession ? (
            <>
              <div className="round-chip-row">
                <span className={`status status-${selectedState ?? "open"}`}>
                  {selectedState ? getSessionStateLabel(selectedState) : "Open"}
                </span>
                <span className="round-chip">
                  {selectedSession.mode_seconds}s · Threshold {selectedSession.threshold}
                </span>
              </div>
              <p className="countdown-text">
                {selectedState === "open"
                  ? `Betting closes in ${selectedCountdown}`
                  : selectedState === "live"
                    ? "Round is live. Betting locked."
                    : selectedState === "resolving"
                      ? "Round ended. Resolving..."
                      : `Resolved at ${new Date(selectedSession.ends_at).toLocaleTimeString()}`}
              </p>

              <div className="bet-controls overlay-bet-controls">
                <label>
                  Side
                  <select
                    value={selectedSide}
                    onChange={(event) => {
                      const nextSide = event.target.value as PredictionSide;
                      setSideBySession((current) => ({
                        ...current,
                        [selectedSession.id]: nextSide
                      }));
                    }}
                    disabled={!canPlaceSelected}
                  >
                    <option value="over">Over</option>
                    <option value="under">Under</option>
                  </select>
                </label>
                <label>
                  Wager
                  <input
                    type="number"
                    min={1}
                    value={selectedWager}
                    onChange={(event) =>
                      setWagerBySession((current) => ({
                        ...current,
                        [selectedSession.id]: event.target.value
                      }))
                    }
                    disabled={!canPlaceSelected}
                  />
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canPlaceSelected}
                  onClick={() => {
                    void handlePlacePrediction(selectedSession);
                  }}
                >
                  {selectedPrediction
                    ? "Already Entered"
                    : user
                      ? "Place Prediction"
                      : "Sign In to Bet"}
                </button>
              </div>

              {selectedPrediction ? (
                <p className="session-result compact-result">
                  Pick: <strong>{selectedPrediction.side.toUpperCase()}</strong> ·{" "}
                  {selectedPrediction.wager_tokens} tokens
                  {selectedPrediction.was_correct !== null
                    ? selectedPrediction.was_correct
                      ? ` · Win +${selectedPrediction.token_delta ?? 0}`
                      : ` · Loss ${selectedPrediction.token_delta ?? 0}`
                    : " · Pending"}
                </p>
              ) : null}
            </>
          ) : (
            <p className="hint">No upcoming rounds yet.</p>
          )}

          {!user ? (
            <form className="auth-form inline-auth" onSubmit={handleAuthSubmit}>
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
          ) : null}
        </section>

        <div className="right-rail">
          <div className="quick-actions">
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
              onClick={() => toggleRightPanel("account")}
              aria-label="Open account panel"
            >
              <span className="icon-avatar">{accountInitial}</span>
            </button>
          </div>
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

      <div className="bottom-ribbon">
        {!supabase ? (
          <div className="alert alert-warning">
            Configure <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>apps/web/.env.local</code>.
          </div>
        ) : null}
        {error ? <div className="alert alert-error">{error}</div> : null}
        {notice ? <div className="alert alert-success">{notice}</div> : null}

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
