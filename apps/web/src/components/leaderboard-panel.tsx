type LeaderboardPanelVariant = "classic" | "spotlight";

export type LeaderboardRow = {
  rank: number;
  user_id: string;
  display_name: string;
  tier: string;
  token_balance: number;
  correct_predictions: number;
};

type LeaderboardPanelProps = {
  entries: LeaderboardRow[];
  currentUserId?: string | null;
  onSelect: (entry: LeaderboardRow) => void;
};

const LEADERBOARD_PANEL_VARIANT: LeaderboardPanelVariant = "spotlight";
const LEADERBOARD_ENTRY_LIMIT = 15;
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US");

function formatTokenBalance(value: number) {
  return TOKEN_FORMATTER.format(value);
}

function getFeaturedEntryLabel(rank: number) {
  if (rank === 1) {
    return "Front runner";
  }

  if (rank === 2) {
    return "Close behind";
  }

  return "Still climbing";
}

function ClassicLeaderboardPanel({
  entries,
  onSelect
}: Pick<LeaderboardPanelProps, "entries" | "onSelect">) {
  return (
    <>
      <p className="leaderboard-panel-note">
        Tap any bettor to open their public profile and recent betting history.
      </p>
      <ol className="leaderboard modal-leaderboard">
        {entries.map((entry) => (
          <li key={entry.user_id}>
            <button
              type="button"
              className="leaderboard-entry-button"
              onClick={() => onSelect(entry)}
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
      {entries.length === 0 ? <p className="hint">No leaderboard entries yet.</p> : null}
    </>
  );
}

function SpotlightLeaderboardPanel({
  entries,
  currentUserId,
  onSelect
}: LeaderboardPanelProps) {
  const visibleEntries = entries.slice(0, LEADERBOARD_ENTRY_LIMIT);
  const featuredEntries = visibleEntries.slice(0, 3);
  const remainingEntries = visibleEntries.slice(3);
  const leadingEntry = visibleEntries[0] ?? null;
  const currentUserEntry =
    currentUserId && currentUserId.length > 0
      ? visibleEntries.find((entry) => entry.user_id === currentUserId) ?? null
      : null;
  const heroStatItems = [
    {
      label: "Spots shown",
      value: visibleEntries.length > 0 ? `${visibleEntries.length}` : "--"
    },
    {
      label: "Top bankroll",
      value: leadingEntry ? formatTokenBalance(leadingEntry.token_balance) : "--"
    },
    currentUserEntry
      ? {
          label: "Your rank",
          value: `#${currentUserEntry.rank}`
        }
      : null
  ].filter((item): item is { label: string; value: string } => item !== null);

  if (visibleEntries.length === 0) {
    return (
      <section className="leaderboard-panel leaderboard-panel-spotlight">
        <header className="leaderboard-hero">
          <div className="leaderboard-hero-copy">
            <p className="leaderboard-kicker">Live standings</p>
            <h3 className="leaderboard-title">Leaderboard is warming up</h3>
            <p className="leaderboard-subtitle">
              The board will fill in automatically once bettors start placing picks.
            </p>
          </div>
        </header>

        <div className="leaderboard-empty-card">
          <span className="leaderboard-empty-kicker">No bettors yet</span>
          <strong>Stand by for the first names to hit the board.</strong>
          <p>
            Once the first round of bets lands, this panel will spotlight the leaders and let you
            open each public profile from here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="leaderboard-panel leaderboard-panel-spotlight">
      <header className="leaderboard-hero">
        <div className="leaderboard-hero-copy">
          <p className="leaderboard-kicker">Live standings</p>
          <h3 className="leaderboard-title">Top bettors on the board</h3>
          <p className="leaderboard-subtitle">
            Tap any bettor to open their public profile and recent betting history.
          </p>
        </div>

        <div className="leaderboard-hero-side">
          <div className="leaderboard-hero-stat-grid">
            {heroStatItems.map((item) => (
              <div className="leaderboard-hero-stat-card" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>

          {currentUserEntry ? (
            <div className="leaderboard-user-callout" aria-live="polite">
              <span className="leaderboard-user-callout-kicker">You are on the board</span>
              <strong>
                #{currentUserEntry.rank} · {formatTokenBalance(currentUserEntry.token_balance)} bankroll
              </strong>
              <span>
                {currentUserEntry.correct_predictions} correct picks · {currentUserEntry.tier}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      <div className="leaderboard-spotlight-grid">
        {featuredEntries.map((entry) => {
          const isCurrentUser = entry.user_id === currentUserId;

          return (
            <button
              key={entry.user_id}
              type="button"
              className={
                isCurrentUser
                  ? `leaderboard-podium-card leaderboard-podium-card-rank-${entry.rank} leaderboard-podium-card-self`
                  : `leaderboard-podium-card leaderboard-podium-card-rank-${entry.rank}`
              }
              onClick={() => onSelect(entry)}
              aria-label={`Open ${entry.display_name}'s betting profile`}
            >
              <div className="leaderboard-podium-topline">
                <span className={`leaderboard-rank-medallion leaderboard-rank-medallion-rank-${entry.rank}`}>
                  #{entry.rank}
                </span>
                <div className="leaderboard-podium-copy">
                  <span className="leaderboard-podium-kicker">{getFeaturedEntryLabel(entry.rank)}</span>
                  <strong className="leaderboard-podium-name">{entry.display_name}</strong>
                </div>
                {isCurrentUser ? <span className="leaderboard-self-chip">You</span> : null}
              </div>

              <div className="leaderboard-podium-footer">
                <div className="leaderboard-podium-meta">
                  <span className="leaderboard-tier-pill">{entry.tier}</span>
                  <span className="leaderboard-correct-picks">
                    {entry.correct_predictions} correct picks
                  </span>
                </div>

                <div className="leaderboard-bankroll-block">
                  <span>Bankroll</span>
                  <strong>{formatTokenBalance(entry.token_balance)}</strong>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {remainingEntries.length > 0 ? (
        <section className="leaderboard-pack-section">
          <div className="leaderboard-section-header">
            <div>
              <p className="leaderboard-section-kicker">Still climbing</p>
              <h4 className="leaderboard-section-title">More bettors on the board</h4>
            </div>
            <span className="leaderboard-section-note">Ranked by live bankroll</span>
          </div>

          <ol className="leaderboard-rank-list">
            {remainingEntries.map((entry) => {
              const isCurrentUser = entry.user_id === currentUserId;

              return (
                <li key={entry.user_id}>
                  <button
                    type="button"
                    className={
                      isCurrentUser
                        ? "leaderboard-rank-card leaderboard-rank-card-self"
                        : "leaderboard-rank-card"
                    }
                    onClick={() => onSelect(entry)}
                    aria-label={`Open ${entry.display_name}'s betting profile`}
                  >
                    <span className="leaderboard-rank-pill">#{entry.rank}</span>

                    <span className="leaderboard-rank-copy">
                      <span className="leaderboard-rank-name-row">
                        <strong>{entry.display_name}</strong>
                        {isCurrentUser ? <span className="leaderboard-self-chip">You</span> : null}
                      </span>
                      <span className="leaderboard-rank-meta-row">
                        <span className="leaderboard-tier-pill leaderboard-tier-pill-compact">
                          {entry.tier}
                        </span>
                        <span>{entry.correct_predictions} correct picks</span>
                      </span>
                    </span>

                    <span className="leaderboard-rank-score">
                      <span>Bankroll</span>
                      <strong>{formatTokenBalance(entry.token_balance)}</strong>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </section>
  );
}

export function LeaderboardPanel(props: LeaderboardPanelProps) {
  // Flip this back to "classic" for the original single-list leaderboard without deleting the new design.
  if (LEADERBOARD_PANEL_VARIANT === "classic") {
    return <ClassicLeaderboardPanel entries={props.entries} onSelect={props.onSelect} />;
  }

  return <SpotlightLeaderboardPanel {...props} />;
}
