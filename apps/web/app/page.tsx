import { getPublicEnvironment } from "@/lib/env";
import { LiveFeed } from "@/components/live-feed";

const UPCOMING_SESSIONS = [
  { label: "30s Sprint", startsIn: "Starts in 04:12", threshold: 5 },
  { label: "60s Run", startsIn: "Starts in 10:45", threshold: 9 }
];

export default function HomePage() {
  const env = getPublicEnvironment();

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Trojan Traffic</p>
        <h1>Predict USC foot traffic before each timed session starts.</h1>
        <p className="body-copy">
          This scaffold includes feed playback, session cards, and environment wiring so you
          can connect Supabase auth, live rounds, and token settlement logic.
        </p>
      </section>

      <section className="layout-grid">
        <article className="panel feed-panel">
          <header className="panel-header">
            <h2>Live Feed</h2>
            <span className="status status-live">Streaming</span>
          </header>
          <LiveFeed src={env.NEXT_PUBLIC_HLS_URL} />
          <p className="hint">
            Bets should resolve from server-authoritative session timestamps, not client playback
            time, to account for HLS buffering.
          </p>
        </article>

        <article className="panel">
          <header className="panel-header">
            <h2>Upcoming Rounds</h2>
            <span className="status">Read only scaffold</span>
          </header>
          <div className="session-list">
            {UPCOMING_SESSIONS.map((session) => (
              <div className="session-card" key={session.label}>
                <h3>{session.label}</h3>
                <p>{session.startsIn}</p>
                <p>Threshold: {session.threshold}</p>
                <button type="button" disabled>
                  Place prediction
                </button>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
