# Web App

Next.js App Router scaffold for Trojan Traffic.

## Local run

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
npm run dev:web
```

## Included

- Typed env parsing (`src/lib/env.ts`)
- Supabase browser client bootstrap (`src/lib/supabase/client.ts`)
- HLS live feed component (`src/components/live-feed.tsx`)
- `GET /api/health` endpoint

## Next implementation steps

1. Add Supabase auth flows and protected routes.
2. Build the betting flow for scheduled sessions.
3. Subscribe to resolved session updates and settle user state in UI.
