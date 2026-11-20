-- Event matching v0 (2026-11-18): Altie learns what you're looking for, watches Luma, and suggests the right events.
--
--   needs       What you want right now. You say it in your own words; Altie fills these fields; you confirm.
--   events      + the Luma facts, + Altie's pick (go / maybe / skip) with a one-line reason.
--               Altie's pick never changes your answer: `pick` is Altie's, `status` is yours.
--   event_taps  Every yes / no you tap, with optional reasons. Altie learns from these.
--
-- Rule: Altie thinks -> you tap. Altie never registers, pays or messages for you.

-- ---------------------------------------------------------------- needs: what you're looking for

create table public.needs (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  focus          text check (length(focus) <= 300),            -- the one thing right now (U8), e.g. "find a voice AI cofounder"
  focus_until    date,
  want_topics    text[] not null default '{}',                 -- "voice AI", "agents"
  want_people    text[] not null default '{}',                 -- "founders", "investors"
  avoid_topics   text[] not null default '{}',                 -- "crypto"
  luma_pages     text[] not null default '{sf,ai}',            -- which public Luma pages to watch (luma.com/sf, luma.com/ai)
  cities         text[] not null default '{}',                 -- empty = any city on those pages
  online_ok      boolean not null default false,
  max_price_usd  numeric(8, 2) not null default 30 check (max_price_usd >= 0),  -- 0 = free events only
  ok_days        smallint[] not null default '{0,1,2,3,4,5,6}', -- 0 Sunday ... 6 Saturday
  earliest_hour  smallint not null default 8 check (earliest_hour between 0 and 23),   -- earliest start time you'd go to
  latest_hour    smallint not null default 21 check (latest_hour between 0 and 23),    -- latest start time you'd go to
  per_week       smallint not null default 3 check (per_week between 0 and 14),        -- how many "go" picks you want a week
  timezone       text not null default 'America/Los_Angeles',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (earliest_hour <= latest_hour)
);
create trigger needs_touch before update on public.needs for each row execute function public.touch_updated_at();

-- When you change what you want, Altie's picks on events you haven't answered are cleared,
-- so the next watcher run picks them again with your new needs. Your own answers are never touched.
create or replace function public.needs_changed() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  update public.events
     set pick = null, pick_why = null, pick_facts = '{}', picked_by = null, picked_at = null
   where user_id = new.user_id and status = 'found' and pick is not null;
  return new;
end $$;
create trigger needs_repick after insert or update on public.needs for each row execute function public.needs_changed();

-- ---------------------------------------------------------------- events: Luma facts and Altie's pick

alter table public.events
  add column city           text,
  add column online         boolean not null default false,
  add column price_usd      numeric(8, 2),                     -- null = unknown, 0 = free
  add column needs_approval boolean not null default false,
  add column sold_out       boolean not null default false,
  add column going_count    integer,
  add column hosts          text[] not null default '{}',
  add column about          text,                              -- the event description, trimmed
  add column pick           text check (pick in ('go', 'maybe', 'skip')),  -- Altie's suggestion
  add column pick_why       text,                              -- Altie's one-line reason
  add column pick_facts     text[] not null default '{}',      -- which event facts the reason used
  add column picked_by      text,                              -- 'rules', 'keywords' or the model name
  add column picked_at      timestamptz;

comment on column public.events.decision_why is 'Your reason, from your tap. Altie''s reason is pick_why.';

-- ---------------------------------------------------------------- event_taps: your answers, so Altie learns

create table public.event_taps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event_id    uuid not null references public.events (id) on delete cascade,
  answer      text not null check (answer in ('going', 'maybe', 'skipped', 'attended')),
  reasons     text[] not null default '{}'
              check (reasons <@ array['great_fit', 'wrong_topic', 'wrong_people', 'too_far', 'bad_time',
                                      'too_pricey', 'too_big', 'not_now', 'already_busy']::text[]),
  altie_pick  text check (altie_pick in ('go', 'maybe', 'skip')),  -- what Altie had said, to see how often Altie is right
  created_at  timestamptz not null default now()
);
create index event_taps_user_idx on public.event_taps (user_id, created_at desc);

alter table public.needs      enable row level security;
alter table public.event_taps enable row level security;
create policy own_rows on public.needs      for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy own_rows on public.event_taps for all using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- for the app (run with your rights, so RLS applies)

-- Your tap: sets your answer on the event and logs it for learning.
create or replace function public.answer_event(p_event uuid, p_answer text, p_reasons text[] default '{}')
returns void
language plpgsql security invoker set search_path = public as $$
declare
  was_pick text;
begin
  update public.events
     set status = p_answer,
         decision_why = nullif(array_to_string(p_reasons, ', '), '')
   where id = p_event
  returning pick into was_pick;
  if not found then
    raise exception 'No such event';
  end if;
  insert into public.event_taps (event_id, answer, reasons, altie_pick)
  values (p_event, p_answer, coalesce(p_reasons, '{}'), was_pick);
end $$;

-- What Altie suggests for the next N days: "go" first, then "maybe", soonest first. Skips are left out.
create or replace function public.events_for_me(p_days integer default 14)
returns setof public.events
language sql stable security invoker set search_path = public as $$
  select e.*
  from public.events e
  where e.status = 'found'
    and e.pick in ('go', 'maybe')
    and e.starts_at > now()
    and e.starts_at < now() + make_interval(days => least(greatest(p_days, 1), 60))
  order by (e.pick = 'go') desc, e.starts_at;
$$;

-- ---------------------------------------------------------------- for the Luma watcher (server only)

-- Saves events found on Luma for one user. New ones come in as 'found'.
-- Existing ones get fresh facts, but your answer (status) and Altie's pick are kept.
-- Returns how many were new.
create or replace function public.save_luma_events(p_user uuid, p_events jsonb)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  before_count integer;
  after_count  integer;
begin
  select count(*) into before_count from public.events where user_id = p_user and source = 'luma';

  insert into public.events as e
    (user_id, source, external_id, title, url, starts_at, ends_at, place, city, online, price_usd,
     needs_approval, sold_out, going_count, hosts, about)
  select p_user, 'luma', x->>'id', x->>'name', x->>'url',
         (x->>'startAt')::timestamptz, (x->>'endAt')::timestamptz,
         x->>'address', x->>'city', coalesce((x->>'online')::boolean, false),
         (x->>'priceUsd')::numeric, coalesce((x->>'needsApproval')::boolean, false),
         coalesce((x->>'soldOut')::boolean, false), (x->>'goingCount')::integer,
         coalesce(array(select jsonb_array_elements_text(coalesce(x->'hosts', '[]'::jsonb))), '{}'),
         left(x->>'about', 1500)
  from jsonb_array_elements(p_events) as x
  where x->>'id' is not null and x->>'name' is not null
  on conflict (user_id, source, external_id) where external_id is not null do update
    set title          = excluded.title,
        url            = excluded.url,
        starts_at      = excluded.starts_at,
        ends_at        = excluded.ends_at,
        place          = excluded.place,
        city           = excluded.city,
        online         = excluded.online,
        price_usd      = excluded.price_usd,
        needs_approval = excluded.needs_approval,
        sold_out       = excluded.sold_out,
        going_count    = excluded.going_count,
        hosts          = excluded.hosts,
        about          = coalesce(excluded.about, e.about);

  select count(*) into after_count from public.events where user_id = p_user and source = 'luma';
  return after_count - before_count;
end $$;

-- Saves Altie's picks. Only touches events you haven't answered yet.
create or replace function public.save_picks(p_user uuid, p_picks jsonb)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  changed integer;
begin
  update public.events e
     set pick       = x->>'pick',
         pick_why   = nullif(x->>'why', ''),
         pick_facts = coalesce(array(select jsonb_array_elements_text(coalesce(x->'facts', '[]'::jsonb))), '{}'),
         picked_by  = x->>'by',
         picked_at  = now()
    from jsonb_array_elements(p_picks) as x
   where e.id = (x->>'eventId')::uuid
     and e.user_id = p_user
     and e.status = 'found';
  get diagnostics changed = row_count;
  return changed;
end $$;

revoke execute on function public.save_luma_events(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.save_picks(uuid, jsonb)       from public, anon, authenticated;
grant  execute on function public.save_luma_events(uuid, jsonb) to service_role;
grant  execute on function public.save_picks(uuid, jsonb)       to service_role;
