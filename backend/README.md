# Twinwire backend v0

The data layer under Altie. Built to run on Supabase (Postgres + Edge Functions). Nothing here is deployed yet.

| Code | Piece | File |
|---|---|---|
| Z8 | Database schema with Row Level Security on every table | `supabase/migrations/20261117000100_core.sql` |
| N7 | Living person card: last talk, open promises, events | `person_card()` in the core migration |
| N4 | Find people, typos included | `find_people()` in the core migration |
| Z7 | Filter before AI: family, health and "you" never reach Claude | `supabase/functions/_shared/filter.ts` |
| G8 | One door to Claude: model by task, daily spend cap, cost log | `supabase/functions/_shared/ai_gateway.ts` |
| — | **Your needs**: say what you want in your own words, confirm the settings | `_shared/needs.ts`, `read-needs/` |
| G1 | **Luma watcher**: reads public Luma pages every 6 hours | `_shared/luma.ts`, `_shared/watch.ts`, `luma-watch/` |
| N2 | **Right events for you**: go / maybe / skip with a one-line reason | `_shared/event_match.ts`, `supabase/migrations/20261118000100_event_needs.sql` |

## How Altie picks your events

1. **You say what you want** ("voice AI founders, weeknights, free"). Altie shows the settings it heard. You tap Save.
2. **The watcher reads Luma** (`luma.com/sf`, `luma.com/ai`) every 6 hours, once for everyone.
3. **Rules first, no AI:** sold out, too pricey, wrong day or time, online, a topic you skip, clashes with an event you're going to. A rule skip always says which rule.
4. **Then fit:** Claude (Sonnet) reads your needs, your recent yes / no taps and your cleared work notes. With no key, or at your daily AI limit, keyword matching takes over and says so.
5. **Your weekly limit:** at most N "go" picks a week (default 3). Extra ones become "maybe".
6. **You tap** going / maybe / skip, with optional reasons. Altie learns from those taps. Change your needs and Altie picks again.

Altie only suggests. It never registers, pays or messages for you.

## Rules the tests prove

- Nobody can read or write anyone else's rows: people, events, needs, taps.
- A memory is not allowed into AI until the filter says so.
- Family and health words in your needs or notes never reach Claude.
- Only the server can log AI spend, save Luma events and save picks.
- At the daily cap, Claude is not called at all, and matching falls back to keywords.
- A reason that cites a fact the event doesn't have is dropped.
- Event text that tries to give orders stays inside the event data.
- Your own answer on an event is never overwritten by Altie or by the next watcher run.
- Each Luma page is read once per run, and each event description only once.
- The permissions log can't be edited or deleted.
- Deleting a person deletes their links too.
- Scouted guests you never met are deleted after their `keep_until` date.

## Run it

```bash
npm install
npm test        # 58 tests
npm run demo    # the event matcher on made-up Luma pages, no key needed
```

The tests run the real migrations on an in-memory Postgres (PGlite), so no Docker, no account and no key are needed.
`tests/supabase_stub.sql` and `tests/supabase_grants.sql` stand in for what Supabase already provides. Never deploy them.
Claude is replaced by a fake in the tests (`tests/fake_claude.ts`), and Luma by made-up pages with fictional names (`tests/luma_pages.ts`).

## Next, once there is a Supabase account

1. Make two projects: **test** and **live**. AI coding agents only ever get the test one's keys (Z8).
2. `supabase login`, then `supabase link` to the **test** project, then `supabase db push`.
3. Secrets go in **Supabase → Edge Functions → Secrets**, never in the app and never in chat:
   - `ANTHROPIC_API_KEY` (give it a spend limit on the Anthropic side too)
   - `WATCH_SECRET` (any long random string)
4. Deploy: `supabase functions deploy read-needs` and `supabase functions deploy luma-watch --no-verify-jwt`.
5. Schedule `luma-watch` every 6 hours (Supabase → Integrations → Cron), sending `Authorization: Bearer <WATCH_SECRET>`.
6. Still to add: `ask` (wraps `askClaude` for the app) and `purge-people` (daily).

## Good to know

- Luma pages are not an official API. If Luma changes its layout, the watcher reports "layout may have changed" instead of going quiet. If Luma blocks the watcher, we ask Luma for proper access rather than work around it.
- The watcher names itself honestly (`Twinwire/0.1`) and does not pretend to be a browser.
- Prices in `ai_gateway.ts` are from Anthropic's model list on 2026-11-17. Re-check them before launch.
