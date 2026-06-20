-- ============================================================
-- Hourglass — Supabase schema + security setup
-- Run this in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================

-- 1. PROFILES ------------------------------------------------
-- One row per user, holds a friendly display name for the leaderboard.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at  timestamptz not null default now()
);

-- 2. SESSIONS ------------------------------------------------
-- Every focus (earn) and scroll (spend) session. Balance is derived from this.
create table if not exists public.sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  type             text not null check (type in ('focus', 'scroll')),
  app_target       text check (app_target in ('instagram', 'youtube', 'netflix')),
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_minutes numeric,
  created_at       timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on public.sessions (user_id);

-- 3. ROW LEVEL SECURITY --------------------------------------
alter table public.profiles  enable row level security;
alter table public.sessions  enable row level security;

-- Profiles: anyone signed in can READ all profiles (for the leaderboard),
-- but you may only insert/update YOUR OWN profile row.
drop policy if exists "profiles read all"      on public.profiles;
drop policy if exists "profiles insert own"    on public.profiles;
drop policy if exists "profiles update own"    on public.profiles;
create policy "profiles read all"   on public.profiles for select using (auth.role() = 'authenticated');
create policy "profiles insert own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles update own" on public.profiles for update using (auth.uid() = id);

-- Sessions: anyone signed in can READ all sessions (friends view),
-- but you may only write/update/delete YOUR OWN sessions.
drop policy if exists "sessions read all"   on public.sessions;
drop policy if exists "sessions insert own" on public.sessions;
drop policy if exists "sessions update own" on public.sessions;
drop policy if exists "sessions delete own" on public.sessions;
create policy "sessions read all"   on public.sessions for select using (auth.role() = 'authenticated');
create policy "sessions insert own" on public.sessions for insert with check (auth.uid() = user_id);
create policy "sessions update own" on public.sessions for update using (auth.uid() = user_id);
create policy "sessions delete own" on public.sessions for delete using (auth.uid() = user_id);

-- 4. REALTIME ------------------------------------------------
-- Broadcast sessions changes so the friends leaderboard updates live.
alter publication supabase_realtime add table public.sessions;

-- Done. Now flip ONE setting in the dashboard:
--   Authentication -> Sign In / Providers -> Email -> turn OFF "Confirm email"
--   (so accounts work instantly for tonight's testing).
