# Supabase Setup

This folder contains SQL migrations for Trojan Traffic.

## Prerequisites

- Supabase CLI installed and logged in
- Linked project (`supabase link --project-ref <project-ref>`)

## Apply migrations

```bash
supabase db push
```

## Local database (optional)

```bash
supabase start
supabase migration up
```
