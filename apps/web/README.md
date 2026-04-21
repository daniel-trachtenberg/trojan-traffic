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

## Admin Region Editor

Admin users can enable region edit mode from the admin console whenever they need to place or
adjust the crossing line on the live feed.

When edit mode is enabled, draggable endpoint handles appear on the feed and save/reset controls stay
available outside the admin modal. Saving persists the line in Supabase so the same region is
served in local and deployed environments.

This updates the web overlay region that the product displays. The vision backend still uses each
session's own saved `region_polygon` when automatic counting runs.

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
