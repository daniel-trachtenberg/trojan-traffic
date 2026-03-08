# Web App

Next.js App Router MVP for Trojan Traffic.

## Local run

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

Set `NEXT_PUBLIC_VISION_API_URL` in `.env.local` to enable live person box overlays from the
vision service.

## One-off Admin Region Editor

The betting region editor is disabled by default. Only enable it when an admin needs to place or
adjust the polygon on the live feed.

```bash
REGION_EDITOR_ENABLED=true
```

When enabled, the web app shows draggable corner handles on the feed and a small save panel in the
top-right rail. Saving writes the polygon to `apps/web/src/config/betting-region.json`. Turn
`REGION_EDITOR_ENABLED` back to `false` after saving.

This currently updates the web overlay region only. The vision backend ROI is still configured
separately.

## Included

- Supabase email/password auth
- Daily login reward claim action
- Prediction placement flow via SQL RPC
- Leaderboard and prediction history
- HLS live feed with active betting region overlay
- `GET /api/health` endpoint

## Required Supabase SQL

Run all migrations in `/supabase/migrations` before using the MVP UI.

## Next implementation steps

1. Replace seeded session generation with admin scheduling tools.
2. Hook vision worker output to automatic session resolution.
3. Add achievement awarding jobs and badge display.
