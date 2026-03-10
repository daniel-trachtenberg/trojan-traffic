"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RegionPoint } from "@/lib/betting-region";

type AdminSessionRow = {
  id: string;
  mode_seconds: number;
  threshold: number;
  starts_at: string;
  ends_at: string;
  status: string;
  final_count: number | null;
  resolved_at: string | null;
  camera_feed_url: string;
  prediction_count: number;
  open_prediction_count: number;
  wager_total: number;
};

type AdminConsoleProps = {
  supabase: SupabaseClient;
  defaultCameraFeedUrl: string;
  isRegionEditModeEnabled: boolean;
  regionPoints: RegionPoint[];
  hasUnsavedRegionChanges: boolean;
  onStartRegionEditMode: () => void;
  onToggleRegionEditMode: () => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onPublicDataRefresh: () => Promise<void>;
};

type SessionFormState = {
  modeSeconds: "30" | "60";
  threshold: string;
  startsAt: string;
  cameraFeedUrl: string;
};

const ADMIN_SESSION_LIMIT = 80;

async function listAdminSessions(supabase: SupabaseClient) {
  const response = await supabase.rpc("admin_list_game_sessions", {
    p_limit: ADMIN_SESSION_LIMIT
  });

  if (response.error) {
    throw new Error(response.error.message);
  }

  return Array.isArray(response.data) ? (response.data as AdminSessionRow[]) : [];
}

function formatDateTimeForInput(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function createDefaultFormState(defaultCameraFeedUrl: string): SessionFormState {
  const startsAt = new Date(Date.now() + 10 * 60 * 1000);
  startsAt.setSeconds(0, 0);

  return {
    modeSeconds: "30",
    threshold: "5",
    startsAt: formatDateTimeForInput(startsAt),
    cameraFeedUrl: defaultCameraFeedUrl
  };
}

function formatAdminDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getSessionPhase(session: AdminSessionRow) {
  if (session.status === "cancelled") {
    return "cancelled";
  }

  if (session.status === "resolved" || session.resolved_at || session.final_count !== null) {
    return "resolved";
  }

  const now = Date.now();
  const startsAt = new Date(session.starts_at).getTime();
  const endsAt = new Date(session.ends_at).getTime();

  if (now < startsAt) {
    return "scheduled";
  }

  if (now <= endsAt) {
    return "live";
  }

  return "awaiting-resolution";
}

function getSessionPhaseLabel(phase: ReturnType<typeof getSessionPhase>) {
  if (phase === "scheduled") {
    return "Scheduled";
  }

  if (phase === "live") {
    return "Live";
  }

  if (phase === "awaiting-resolution") {
    return "Awaiting Result";
  }

  if (phase === "resolved") {
    return "Resolved";
  }

  return "Cancelled";
}

function sortAdminSessions(left: AdminSessionRow, right: AdminSessionRow) {
  const leftPhase = getSessionPhase(left);
  const rightPhase = getSessionPhase(right);

  const leftBucket = leftPhase === "scheduled" ? 0 : leftPhase === "live" || leftPhase === "awaiting-resolution" ? 1 : 2;
  const rightBucket =
    rightPhase === "scheduled" ? 0 : rightPhase === "live" || rightPhase === "awaiting-resolution" ? 1 : 2;

  if (leftBucket !== rightBucket) {
    return leftBucket - rightBucket;
  }

  const leftTime = new Date(left.starts_at).getTime();
  const rightTime = new Date(right.starts_at).getTime();

  if (leftBucket === 0) {
    return leftTime - rightTime;
  }

  return rightTime - leftTime;
}

export function AdminConsole({
  supabase,
  defaultCameraFeedUrl,
  isRegionEditModeEnabled,
  regionPoints,
  hasUnsavedRegionChanges,
  onStartRegionEditMode,
  onToggleRegionEditMode,
  onError,
  onNotice,
  onPublicDataRefresh
}: AdminConsoleProps) {
  const [sessions, setSessions] = useState<AdminSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [resolveCounts, setResolveCounts] = useState<Record<string, string>>({});
  const [formState, setFormState] = useState(() => createDefaultFormState(defaultCameraFeedUrl));
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const orderedSessions = sessions.slice().sort(sortAdminSessions);
  const scheduledCount = orderedSessions.filter((session) => getSessionPhase(session) === "scheduled").length;
  const unresolvedCount = orderedSessions.filter((session) => {
    const phase = getSessionPhase(session);
    return phase === "live" || phase === "awaiting-resolution";
  }).length;
  const pendingPredictions = orderedSessions.reduce(
    (sum, session) => sum + Number(session.open_prediction_count ?? 0),
    0
  );

  async function loadAdminSessions() {
    setLoading(true);

    try {
      setSessions(await listAdminSessions(supabase));
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : "Failed to load admin sessions.");
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }

  async function refreshAdminData() {
    await Promise.all([loadAdminSessions(), onPublicDataRefresh()]);
  }

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        const nextSessions = await listAdminSessions(supabase);
        if (!isMounted) {
          return;
        }

        setSessions(nextSessions);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        onErrorRef.current(error instanceof Error ? error.message : "Failed to load admin sessions.");
        setSessions([]);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      isMounted = false;
    };
  }, [supabase]);

  function resetForm() {
    setEditingSessionId(null);
    setFormState(createDefaultFormState(defaultCameraFeedUrl));
  }

  function beginEditing(session: AdminSessionRow) {
    setEditingSessionId(session.id);
    setFormState({
      modeSeconds: session.mode_seconds === 60 ? "60" : "30",
      threshold: String(session.threshold),
      startsAt: formatDateTimeForInput(session.starts_at),
      cameraFeedUrl: session.camera_feed_url
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const threshold = Number.parseInt(formState.threshold, 10);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      onError("Threshold must be a positive whole number.");
      return;
    }

    const startsAt = new Date(formState.startsAt);
    if (Number.isNaN(startsAt.getTime())) {
      onError("Choose a valid session start time.");
      return;
    }

    if (regionPoints.length < 3) {
      onError("Region must contain at least three points.");
      return;
    }

    setSubmitting(true);

    const payload = {
      p_mode_seconds: Number.parseInt(formState.modeSeconds, 10),
      p_threshold: threshold,
      p_starts_at: startsAt.toISOString(),
      p_camera_feed_url: formState.cameraFeedUrl.trim(),
      p_region_polygon: regionPoints
    };

    const response = editingSessionId
      ? await supabase.rpc("admin_update_game_session", {
          p_session_id: editingSessionId,
          ...payload
        })
      : await supabase.rpc("admin_create_game_session", payload);

    setSubmitting(false);

    if (response.error) {
      onError(response.error.message);
      return;
    }

    onNotice(editingSessionId ? "Session updated." : "Session created.");
    resetForm();
    await refreshAdminData();
  }

  async function handleCancelSession(session: AdminSessionRow) {
    if (
      !window.confirm(
        `Cancel the ${session.mode_seconds}s session scheduled for ${formatAdminDateTime(session.starts_at)}?`
      )
    ) {
      return;
    }

    setBusyAction(`cancel:${session.id}`);

    const response = await supabase.rpc("admin_cancel_game_session", {
      p_session_id: session.id
    });

    setBusyAction(null);

    if (response.error) {
      onError(response.error.message);
      return;
    }

    onNotice("Session cancelled.");
    await refreshAdminData();
  }

  async function handleResolveSession(session: AdminSessionRow) {
    const rawCount = resolveCounts[session.id] ?? "";
    const finalCount = Number.parseInt(rawCount, 10);

    if (!Number.isFinite(finalCount) || finalCount < 0) {
      onError("Enter a valid final count before resolving the session.");
      return;
    }

    if (
      !window.confirm(
        `Resolve the ${session.mode_seconds}s session from ${formatAdminDateTime(session.starts_at)} with a final count of ${finalCount}?`
      )
    ) {
      return;
    }

    setBusyAction(`resolve:${session.id}`);

    const response = await supabase.rpc("admin_resolve_game_session", {
      p_session_id: session.id,
      p_final_count: finalCount
    });

    setBusyAction(null);

    if (response.error) {
      onError(response.error.message);
      return;
    }

    setResolveCounts((current) => ({
      ...current,
      [session.id]: ""
    }));
    onNotice("Session resolved.");
    await refreshAdminData();
  }

  return (
    <div className="admin-console">
      <section className="admin-summary-grid">
        <div className="admin-summary-card">
          <span>Scheduled</span>
          <strong>{scheduledCount}</strong>
        </div>
        <div className="admin-summary-card">
          <span>Needs Result</span>
          <strong>{unresolvedCount}</strong>
        </div>
        <div className="admin-summary-card">
          <span>Open Bets</span>
          <strong>{pendingPredictions}</strong>
        </div>
      </section>

      <section className="admin-section-card">
        <div className="admin-section-header">
          <div>
            <p className="admin-section-kicker">Game Control</p>
            <h3>{editingSessionId ? "Edit Scheduled Session" : "Create Session"}</h3>
          </div>
          <div className="admin-inline-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void loadAdminSessions();
              }}
              disabled={loading || submitting || busyAction !== null}
            >
              Refresh
            </button>
            {editingSessionId ? (
              <button
                type="button"
                className="secondary-button"
                onClick={resetForm}
                disabled={submitting}
              >
                New Session
              </button>
            ) : null}
          </div>
        </div>

        <form className="admin-form-grid" onSubmit={handleSubmit}>
          <label>
            Mode
            <select
              value={formState.modeSeconds}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  modeSeconds: event.target.value === "60" ? "60" : "30"
                }))
              }
              disabled={submitting}
            >
              <option value="30">30 seconds</option>
              <option value="60">60 seconds</option>
            </select>
          </label>

          <label>
            Threshold
            <input
              type="number"
              min={1}
              step={1}
              value={formState.threshold}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  threshold: event.target.value
                }))
              }
              disabled={submitting}
            />
          </label>

          <label>
            Starts At
            <input
              type="datetime-local"
              step={60}
              value={formState.startsAt}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  startsAt: event.target.value
                }))
              }
              disabled={submitting}
            />
          </label>

          <label className="admin-form-wide">
            Camera Feed URL
            <input
              type="url"
              value={formState.cameraFeedUrl}
              onChange={(event) =>
                setFormState((current) => ({
                  ...current,
                  cameraFeedUrl: event.target.value
                }))
              }
              disabled={submitting}
            />
          </label>

          <div className="admin-form-note admin-form-wide">
            <strong>Region snapshot:</strong> this session will use the overlay currently shown on the feed.
            {isRegionEditModeEnabled ? (
              hasUnsavedRegionChanges ? (
                <span> Save or reset your current edits before creating a session that should use them.</span>
              ) : (
                <span> Live region editing is enabled right now.</span>
              )
            ) : (
              <span> Enable edit mode if you want to adjust the live polygon before saving a session.</span>
            )}
          </div>

          <div className="admin-form-actions admin-form-wide">
            <button type="submit" className="primary-button" disabled={submitting}>
              {submitting ? "Saving..." : editingSessionId ? "Save Changes" : "Create Session"}
            </button>
          </div>
        </form>
      </section>

      <section className="admin-section-card">
        <div className="admin-section-header">
          <div>
            <p className="admin-section-kicker">Region Controls</p>
            <h3>Betting Region</h3>
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
            {isRegionEditModeEnabled
              ? "Edit Mode On"
              : hasUnsavedRegionChanges
                ? "Unsaved Changes"
                : "Edit Mode Off"}
          </span>
        </div>

        <p className="admin-section-copy">
          {isRegionEditModeEnabled
            ? "Drag the live feed corner handles to adjust the polygon. Save or reset from the floating controls beside the player."
            : hasUnsavedRegionChanges
              ? "Your last drag changes are still unsaved. Save, reset, or re-enable edit mode from the floating controls."
              : "Only admins can drag and save the live feed region. Turn on edit mode when you want to adjust the polygon."}
        </p>

        <div className="admin-inline-actions">
          <button
            type="button"
            className={isRegionEditModeEnabled ? "secondary-button" : "primary-button"}
            onClick={isRegionEditModeEnabled ? onToggleRegionEditMode : onStartRegionEditMode}
          >
            {isRegionEditModeEnabled ? "Disable Edit Mode" : "Enable Edit Mode"}
          </button>
        </div>
      </section>

      <section className="admin-section-card">
        <div className="admin-section-header">
          <div>
            <p className="admin-section-kicker">Session Queue</p>
            <h3>Manage Games</h3>
          </div>
          <span className="status">{loading ? "Loading" : `${orderedSessions.length} sessions`}</span>
        </div>

        {loading ? <p className="hint">Loading admin sessions...</p> : null}

        {!loading && orderedSessions.length === 0 ? (
          <p className="hint">No sessions have been scheduled yet.</p>
        ) : null}

        <div className="admin-session-list">
          {orderedSessions.map((session) => {
            const phase = getSessionPhase(session);
            const canEdit = phase === "scheduled" && Number(session.prediction_count ?? 0) === 0;
            const canCancel = phase !== "resolved" && phase !== "cancelled";
            const canResolve = phase === "awaiting-resolution";
            const statusClass =
              phase === "scheduled"
                ? "status status-open"
                : phase === "live"
                  ? "status status-live"
                  : phase === "awaiting-resolution"
                    ? "status status-resolving"
                    : phase === "resolved"
                      ? "status status-resolved"
                      : "status status-cancelled";

            return (
              <article key={session.id} className="admin-session-card">
                <div className="admin-session-head">
                  <div>
                    <p className="admin-session-title">
                      {session.mode_seconds}s round · threshold {session.threshold}
                    </p>
                    <p className="admin-session-time">
                      {formatAdminDateTime(session.starts_at)} to {formatAdminDateTime(session.ends_at)}
                    </p>
                  </div>
                  <span className={statusClass}>{getSessionPhaseLabel(phase)}</span>
                </div>

                <div className="admin-session-stats">
                  <span>{Number(session.prediction_count ?? 0)} total predictions</span>
                  <span>{Number(session.open_prediction_count ?? 0)} unresolved</span>
                  <span>{Number(session.wager_total ?? 0)} wagered</span>
                  <span>{session.final_count === null ? "Final count pending" : `Final count ${session.final_count}`}</span>
                </div>

                <p className="admin-session-url">{session.camera_feed_url}</p>

                <div className="admin-session-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => beginEditing(session)}
                    disabled={!canEdit || submitting || busyAction !== null}
                  >
                    Edit
                  </button>

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      void handleCancelSession(session);
                    }}
                    disabled={!canCancel || submitting || busyAction !== null}
                  >
                    {busyAction === `cancel:${session.id}` ? "Cancelling..." : "Cancel"}
                  </button>

                  <label className="admin-resolve-input">
                    <span>Final Count</span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={resolveCounts[session.id] ?? ""}
                      onChange={(event) =>
                        setResolveCounts((current) => ({
                          ...current,
                          [session.id]: event.target.value
                        }))
                      }
                      disabled={!canResolve || submitting || busyAction !== null}
                    />
                  </label>

                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => {
                      void handleResolveSession(session);
                    }}
                    disabled={!canResolve || submitting || busyAction !== null}
                  >
                    {busyAction === `resolve:${session.id}` ? "Resolving..." : "Resolve"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
