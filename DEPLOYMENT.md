# Deployment

Production deployment for this repo is split across two platforms:

- `apps/web` -> Vercel
- `services/vision` -> Render private service from Docker

This keeps the Next.js frontend on the platform it is optimized for and keeps the long-running
FastAPI + ffmpeg + YOLO worker off serverless infrastructure.

## Frontend: Vercel

Create a Vercel project from this repository with these settings:

- Framework Preset: `Next.js`
- Root Directory: `apps/web`
- Node.js: `20.x` or newer
- Preview Deployments: enabled

Set these Vercel environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_HLS_URL`

Leave `NEXT_PUBLIC_VISION_API_URL` unset unless you intentionally re-enable browser-visible live
detection overlays. The current production UI does not need the vision service to be publicly
reachable.

Optional:

- `REGION_EDITOR_ENABLED=false`

## Backend: Render

Use the root [`render.yaml`](./render.yaml) Blueprint, or create the service manually with the same
settings:

- Service Type: `Private Service`
- Runtime: `Docker`
- Root Directory: `services/vision`
- Dockerfile Path: `services/vision/Dockerfile`
- Docker Context: `services/vision`
- Instances: `1`
- Auto-Deploy: `off`
- PR Previews: `off`

Choose the Render region that is closest to your Supabase project before creating the service.
Render does not let you change region after creation.

Required Render environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `CORS_ORIGINS`

The Blueprint also pins the current worker defaults:

- `ENABLE_AUTO_COUNT_WORKER=true`
- `ENABLE_LIVE_DETECTIONS=false`
- `AUTO_COUNT_POLL_INTERVAL_MS=1000`
- `AUTO_COUNT_SESSION_LOOKAHEAD_MS=20000`
- `COUNT_ENTRY_CONFIRM_FRAMES=2`
- `COUNT_EXIT_CONFIRM_FRAMES=2`
- `COUNT_REGION_PADDING_X=0.04`
- `COUNT_REGION_PADDING_Y=0.06`

### Why Render is single-instance only

The automatic counting worker currently deduplicates jobs only inside one process. Run exactly one
Render instance until distributed locking or leader election is added. Do not enable autoscaling or
manual horizontal scaling.

### Why auto-deploy is off

Deploying the backend during an active round can interrupt a live count. The Render Blueprint
defaults to manual deploys so you can roll out changes between rounds instead of restarting the
worker mid-session.

### Checking backend health

Because the service is private, it has no public URL. Use Render Shell to check it from inside the
service environment:

```bash
curl http://127.0.0.1:${PORT:-10000}/health
```

If you later re-enable live detector overlays in the frontend, switch the service to a public
Render Web Service or put an authenticated proxy in front of it before setting
`NEXT_PUBLIC_VISION_API_URL`.

## Production Smoke Test

After both services are deployed:

1. Open the Vercel app and confirm the homepage loads.
2. Sign up or sign in through Supabase.
3. Place a bet on an upcoming round.
4. Confirm an admin account can view and manage sessions.
5. On Render, confirm `/health` succeeds from Render Shell.
6. Schedule a short test session in the future.
7. Watch Render logs to confirm the worker picks up the session before it starts.
8. Confirm the final count is written and bets settle automatically in Supabase.
9. Confirm exactly one settlement occurs for that session.
