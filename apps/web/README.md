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

When enabled, admin users get draggable corner handles on the feed plus region save controls inside
the admin console. Saving writes the polygon to `apps/web/src/config/betting-region.json`. Turn
`REGION_EDITOR_ENABLED` back to `false` after saving.

This currently updates the web overlay region only. The vision backend ROI is still configured
separately.

## Included

- Supabase email/password auth
- Daily login reward claim action
- Prediction placement flow via SQL RPC
- Leaderboard and prediction history
- Admin-only session scheduling, editing, cancellation, and manual resolution console
- HLS live feed with active betting region overlay
- `GET /api/health` endpoint

## Required Supabase SQL

Run all migrations in `/supabase/migrations` before using the MVP UI.

## Admin access

Grant admin access by inserting the user into `public.admin_users` after they sign up:

```sql
insert into public.admin_users (user_id)
select id
from auth.users
where email = '<admin-email>';
```

## Next implementation steps

1. Hook vision worker output to automatic session resolution.
2. Add achievement awarding jobs and badge display.
3. Add admin audit logs for session and region changes.
