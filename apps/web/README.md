# Web App

Next.js App Router MVP for Trojan Traffic.

## Local run

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

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
