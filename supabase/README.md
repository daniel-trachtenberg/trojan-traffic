# Supabase Setup

This folder contains SQL migrations for Trojan Traffic.

## Prerequisites

- Supabase CLI installed and logged in
- Linked project (`supabase link --project-ref <project-ref>`)

## Apply migrations

```bash
supabase db push
```

Current migration set includes:
- core schema and RLS
- MVP RPC functions (`claim_daily_login`, `place_prediction`, `get_leaderboard`)
- achievement definitions plus automatic user achievement awards
- computed credit tiers for leaderboard and public profiles
- early local demo session seed data for quick MVP testing

## Local database (optional)

```bash
supabase start
supabase migration up
```
