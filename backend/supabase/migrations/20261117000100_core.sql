-- Twinwire core schema v0 (2026-11-17)
--
-- Day-one rules (README "Built to Scale"):
--   1. Every row has a user_id and Row Level Security: nobody sees anyone else's rows.
--   2. Privacy by default: a memory is NOT sent to AI unless the filter allowed it (Z7).
--   3. AI spend is logged per call and read back as "spent today" (G8).
--   4. Permissions are an append-only log.
--   5. Deleting anything also deletes its links (X8 "gone everywhere").
--
-- Spaces: people, events, memories, to-dos. One links table joins them (a graph inside the database).

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;  -- fuzzy names: "Prya" finds Priya

-- ---------------------------------------------------------------- helpers

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name     text,
  home_area        text,                                   -- "SF", used for nearby events (U5)
  interests        text[] not null default '{}',
  daily_ai_cap_usd numeric(8, 2) not null default 2.00 check (daily_ai_cap_usd >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- people (C5)

create table public.people (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  full_name    text not null check (length(full_name) between 1 and 200),
  headline     text,
  company      text,
  area         text not null default 'work' check (area in ('work', 'family', 'health', 'admin', 'you')),
  groups       text[] not null default '{}',               -- Family, Friends, Work, or your own (N5)
  linkedin_url text,
  luma_url     text,
  source       text not null default 'you'
               check (source in ('you', 'luma', 'bright_data', 'contacts', 'calendar', 'gmail')),
  met_at       timestamptz,                                -- set when you tap Met
  keep_until   timestamptz,                                -- scouted guests expire unless you met them
  hidden       boolean not null default false,             -- X6: keep, but never nudge
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index people_user_idx on public.people (user_id);
create index people_name_trgm on public.people using gin (full_name extensions.gin_trgm_ops);
create unique index people_linkedin_unique on public.people (user_id, linkedin_url) where linkedin_url is not null;

-- ---------------------------------------------------------------- events (C4)

create table public.events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null,
  starts_at    timestamptz,
  ends_at      timestamptz,
  place        text,
  area         text not null default 'work' check (area in ('work', 'family', 'health', 'admin', 'you')),
  source       text not null default 'you' check (source in ('you', 'luma', 'calendar')),
  external_id  text,                                       -- Luma api_id or calendar event id
  url          text,
  status       text not null default 'found'
               check (status in ('found', 'maybe', 'going', 'skipped', 'attended')),
  decision_why text,                                       -- N2: the one-line reason for go / maybe / skip
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);
create index events_user_start_idx on public.events (user_id, starts_at);
create unique index events_external_unique on public.events (user_id, source, external_id) where external_id is not null;

-- ---------------------------------------------------------------- memories (C1)

create table public.memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind          text not null
                check (kind in ('voice', 'text', 'photo', 'share', 'recording_summary', 'summary', 'lesson', 'save_point')),
  body          text not null,                             -- your words; for a recording, only its summary (N8)
  area          text check (area in ('work', 'family', 'health', 'admin', 'you')),
  ai_allowed    boolean not null default false,            -- Z7: false until the filter says otherwise
  filter_reason text,
  happened_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  search        tsvector generated always as (to_tsvector('english', body)) stored
);
create index memories_user_time_idx on public.memories (user_id, happened_at desc);
create index memories_search_idx on public.memories using gin (search);

-- ---------------------------------------------------------------- to-dos and promises (C2)

create table public.todos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null,
  is_promise boolean not null default false,
  bucket     text not null default 'soon' check (bucket in ('now', 'soon', 'parked', 'done')),
  due_at     timestamptz,
  area       text check (area in ('work', 'family', 'health', 'admin', 'you')),
  done_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index todos_user_bucket_idx on public.todos (user_id, bucket, due_at);

-- ---------------------------------------------------------------- links: the graph

create table public.links (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  from_type  text not null check (from_type in ('person', 'event', 'memory', 'todo')),
  from_id    uuid not null,
  to_type    text not null check (to_type in ('person', 'event', 'memory', 'todo')),
  to_id      uuid not null,
  kind       text not null check (kind in ('mentions', 'met_at', 'attending', 'promised_to', 'about', 'from_event')),
  created_at timestamptz not null default now(),
  unique (user_id, from_type, from_id, to_type, to_id, kind)
);
create index links_from_idx on public.links (user_id, from_type, from_id);
create index links_to_idx on public.links (user_id, to_type, to_id);

-- Deleting a person, event, memory or to-do removes every link that touches it.
create or replace function public.drop_links() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.links
  where (from_type = tg_argv[0] and from_id = old.id)
     or (to_type = tg_argv[0] and to_id = old.id);
  return old;
end $$;

create trigger people_drop_links   after delete on public.people   for each row execute function public.drop_links('person');
create trigger events_drop_links   after delete on public.events   for each row execute function public.drop_links('event');
create trigger memories_drop_links after delete on public.memories for each row execute function public.drop_links('memory');
create trigger todos_drop_links    after delete on public.todos    for each row execute function public.drop_links('todo');

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger people_touch   before update on public.people   for each row execute function public.touch_updated_at();
create trigger events_touch   before update on public.events   for each row execute function public.touch_updated_at();
create trigger todos_touch    before update on public.todos    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- filter rules (Z7)

create table public.filter_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  match_field text not null check (match_field in ('sender', 'domain', 'keyword', 'source')),
  pattern     text not null,
  area        text check (area in ('work', 'family', 'health', 'admin', 'you')),
  action      text not null check (action in ('keep', 'skip')),
  ai_allowed  boolean,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- AI calls (G8): written by the server only

create table public.ai_calls (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  task          text not null,                             -- filter, summarize, triage, who_to_meet, invite_note
  model         text not null,
  source        text,                                      -- which connector or screen asked
  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd      numeric(12, 6) not null default 0 check (cost_usd >= 0),
  ok            boolean not null default true,
  created_at    timestamptz not null default now()
);
create index ai_calls_user_day_idx on public.ai_calls (user_id, created_at);

-- ---------------------------------------------------------------- permissions log: append-only

create table public.permissions_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  service    text not null check (service in ('luma', 'google_calendar', 'gmail', 'bright_data', 'linkedin', 'claude')),
  action     text not null check (action in ('granted', 'revoked', 'used')),
  scope      text,
  detail     text,
  created_at timestamptz not null default now()
);
create index permissions_log_user_idx on public.permissions_log (user_id, created_at desc);

-- ---------------------------------------------------------------- Row Level Security

alter table public.profiles        enable row level security;
alter table public.people          enable row level security;
alter table public.events          enable row level security;
alter table public.memories        enable row level security;
alter table public.todos           enable row level security;
alter table public.links           enable row level security;
alter table public.filter_rules    enable row level security;
alter table public.ai_calls        enable row level security;
alter table public.permissions_log enable row level security;

-- Your own rows: read, add, change, delete.
create policy own_rows on public.profiles     for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.people       for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.events       for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.memories     for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.todos        for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.links        for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.filter_rules for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- AI calls: you can read yours; only the server (service role, which skips RLS) writes them.
create policy read_own on public.ai_calls for select using (user_id = (select auth.uid()));

-- Permissions log: read and add only. No policy for update or delete, so nobody rewrites history.
create policy read_own on public.permissions_log for select using (user_id = (select auth.uid()));
create policy add_own  on public.permissions_log for insert with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- functions (run with the caller's rights, so RLS applies)

-- N7: the living person card, always built fresh from what is linked to the person.
create or replace function public.person_card(p_person uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  with linked as (
    select case when l.from_type = 'person' and l.from_id = p_person then l.to_type else l.from_type end as t,
           case when l.from_type = 'person' and l.from_id = p_person then l.to_id   else l.from_id   end as id
    from public.links l
    where (l.from_type = 'person' and l.from_id = p_person)
       or (l.to_type = 'person' and l.to_id = p_person)
  )
  select jsonb_build_object(
    'id', p.id,
    'name', p.full_name,
    'headline', p.headline,
    'company', p.company,
    'area', p.area,
    'groups', to_jsonb(p.groups),
    'linkedin_url', p.linkedin_url,
    'luma_url', p.luma_url,
    'met_at', p.met_at,
    'last_talk', (
      select jsonb_build_object('said', m.body, 'at', m.happened_at)
      from public.memories m join linked on linked.t = 'memory' and linked.id = m.id
      order by m.happened_at desc limit 1),
    'open_promises', coalesce((
      select jsonb_agg(jsonb_build_object('title', t.title, 'due_at', t.due_at) order by t.due_at nulls last)
      from public.todos t join linked on linked.t = 'todo' and linked.id = t.id
      where t.bucket <> 'done'), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('title', e.title, 'starts_at', e.starts_at) order by e.starts_at desc nulls last)
      from public.events e join linked on linked.t = 'event' and linked.id = e.id), '[]'::jsonb)
  )
  from public.people p
  where p.id = p_person;
$$;

-- N4: find people by name, company or headline, typos included.
create or replace function public.find_people(q text, max_rows integer default 5) returns setof public.people
language sql stable security invoker set search_path = public, extensions as $$
  select p.*
  from public.people p
  where p.full_name ilike '%' || q || '%'
     or p.company ilike '%' || q || '%'
     or p.headline ilike '%' || q || '%'
     or similarity(p.full_name, q) > 0.3
  order by similarity(p.full_name, q) desc, p.met_at desc nulls last
  limit least(greatest(max_rows, 1), 50);
$$;

-- G8: what you have spent on AI today (UTC day for v0).
create or replace function public.ai_spend_today() returns numeric
language sql stable security invoker set search_path = public as $$
  select coalesce(sum(cost_usd), 0)
  from public.ai_calls
  where user_id = (select auth.uid())
    and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
$$;

-- Privacy job: scouted guests you never met are deleted after their keep_until date.
-- Run daily by the server (service role). Links go with them through the drop_links trigger.
create or replace function public.purge_expired_people() returns integer
language plpgsql security invoker set search_path = public as $$
declare
  gone integer;
begin
  delete from public.people
  where keep_until is not null and keep_until < now() and met_at is null;
  get diagnostics gone = row_count;
  return gone;
end $$;

revoke execute on function public.purge_expired_people() from public, anon, authenticated;
grant execute on function public.purge_expired_people() to service_role;
