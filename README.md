# trojan-traffic

## Project Name

**Trojan Traffic**

---

## Short Description

A web platform that allows users to place token-based over or under predictions on how many people cross a defined line on the USC live camera feed within a set time window.

---

## High-Level Description

Trojan Traffic is a web app that overlays a defined crossing line on top of the USC live camera feed (Tommy Trojan and/or USC Village) and tracks foot traffic to count how many people cross that line.

Users place predictions on whether the number of people crossing the line during a selected time window will be over or under a specified threshold. The system automatically counts crossings and resolves outcomes at the end of each timed session.

Correct predictions earn tokens. Incorrect predictions deduct tokens.

Users can:
- Sign up and create an account
- Log in to place predictions
- Earn daily tokens
- View rankings and achievements

We anticipate most users will be USC students.

**Camera Feed:**  
https://cs9.pixelcaster.com/live/usc-tommy.stream/playlist.m3u8

---

## Core Features

### User & Profile

#### Authentication
- Email and password login
- Optional Google authentication
- Secure session management

#### Profile Page
- Name
- Overall ranking tier (Platinum, Gold, Silver, etc.)
- Total token balance
- Current streak
- Total correct predictions
- Achievements and badges earned
- Betting and performance history

---

### Token & Streak System

#### Token System
- Users receive a set number of daily tokens
- Tokens are required to place predictions
- Tokens are awarded or deducted based on results

#### Daily Login Reward
- Daily token bonus for logging in
- Bonus increases with login streak length

#### Streak System
- Consecutive days logged in
- Consecutive correct predictions

Streaks unlock:
- Ranking upgrades
- Special badges
- Bonus tokens

Examples:
- 7-day streak
- 20-day streak
- 50-day streak

---

### Game Modes

Predetermined game times. Bets must be placed before the session starts.

Available modes:
- 30 seconds
- 60 seconds

Each mode:
- Starts a timed counting session
- Locks betting once countdown begins
- Automatically resolves when timer ends

---

### Betting System

#### Betting Screen Includes:
- Live camera feed
- Overlayed betting region
- Token balance display
- Over / Under input selection
- Submit button
- Visible countdown timer

#### Region Placement
- The active betting region can be repositioned by an admin
- Admins can use a disabled-by-default editor to drag the two crossing-line endpoints on top of the live feed
- The saved region is shared across all users for fairness

---

### ML Tracking

- Real-time human detection
- Tracking across frames
- Count crossings over the defined line
- Automatic result resolution

---

### Leaderboard

- Daily rankings
- Weekly rankings
- All-time rankings

---

### Loading & System Feedback

- Loading screen while ML model initializes
- Status indicator during live counting
- Clear result screen showing:
  - Final count
  - User prediction
  - Win or loss
  - Token change

---

## MVP Stack (March 4, 2026)

### `apps/web`

- Next.js 15 + React 19 + TypeScript
- Supabase auth + RPC-driven game actions
- HLS playback with highlighted betting region
- Dashboard with rounds, leaderboard, history, and token state
- API health endpoint

### `services/vision`

- Python 3.12 FastAPI service scaffold
- Typed request/response contracts for counting sessions
- Session resolution endpoint that calls Supabase `resolve_session` RPC
- Stub counting pipeline entrypoint with tests

### `supabase`

- SQL migrations with:
  - profiles
  - token ledger and derived token balance view
  - sessions
  - predictions
  - streak and login tables
  - achievements
  - automatic profile bootstrap trigger from `auth.users`
  - `claim_daily_login`, `place_prediction`, and `get_leaderboard` RPCs
  - `resolve_session` function for server-authoritative settlement
  - seeded achievements and scheduled demo sessions
  - row-level security policies

---

## Repository Layout

```text
apps/web                 # Next.js product app
services/vision          # FastAPI vision service
supabase/migrations      # Database schema and server-side logic
```

---

## Deployment

Production deployment is split by workload:

- `apps/web` deploys to Vercel
- `services/vision` deploys to Render as a single-instance private Docker service

Deployment setup, environment variables, and smoke-test steps live in
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

---

## Quick Start

### 1) Install Node dependencies

```bash
npm install
```

### 2) Run web app

```bash
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

Keep real credentials in local `.env` or `.env.local` files only. The checked-in
`.env.example` files are placeholders for public setup.

Optional one-off admin region editor:

```bash
echo 'REGION_EDITOR_ENABLED=true' >> apps/web/.env.local
```

When enabled, the web app exposes draggable line endpoint handles and a save panel. The editor should
normally remain disabled and only be turned on temporarily when an admin needs to reposition the
crossing line. Saved region updates are stored in Supabase so they work on both local and deployed
environments.

### 3) Run vision service

```bash
cd services/vision
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8080
```

### 4) Apply database migration (Supabase CLI)

```bash
supabase db push
```

After migrations are applied, the web app supports:
- Email/password signup and login
- Daily token claim
- Admin-only region placement editor, disabled by default
- Placing predictions on upcoming rounds
- Leaderboard and prediction history
