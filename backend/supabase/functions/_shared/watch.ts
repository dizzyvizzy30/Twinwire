// G1 + N2 · The Luma watcher run (scheduled, server side).
//
//   1. Read each watched Luma page once, for everyone (polite: one request per page per run).
//   2. Read descriptions only for events that pass at least one person's rules (capped per run).
//   3. For each person: save new events, then pick go / maybe / skip for the ones not picked yet.
//      Context used: your needs, events you're going to, your recent taps, and your work notes
//      that the filter allowed (family, health and "you" never go to AI).
//
// The database and Claude are passed in, so tests run on an in-memory Postgres with a fake Claude.

import { discover, eventDetail } from './luma.ts';
import type { FetchText, LumaEvent } from './luma.ts';
import { matchEvents, ruleSkip } from './event_match.ts';
import type { Busy, MatchEvent, PastTap, Pick } from './event_match.ts';
import { needsFromRow } from './needs.ts';
import type { Needs } from './needs.ts';
import type { CallRecord, ContextItem, MessagesClient, SpendStore } from './ai_gateway.ts';

// The slice of a Postgres client this file uses. PGlite fits it as is; the Edge Function wraps postgres.js.
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// G8's spend store on the real tables: ai_calls and profiles.daily_ai_cap_usd.
export class PgSpendStore implements SpendStore {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async spentToday(userId: string): Promise<number> {
    const r = await this.db.query<{ spent: string | number }>(
      `select coalesce(sum(cost_usd), 0) as spent from public.ai_calls
        where user_id = $1 and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
      [userId],
    );
    return Number(r.rows[0]?.spent ?? 0);
  }
  async capUsd(userId: string): Promise<number> {
    const r = await this.db.query<{ cap: string | number }>(
      'select daily_ai_cap_usd as cap from public.profiles where user_id = $1',
      [userId],
    );
    return r.rows.length ? Number(r.rows[0].cap) : 2;
  }
  async record(c: CallRecord): Promise<void> {
    await this.db.query(
      `insert into public.ai_calls (user_id, task, model, source, input_tokens, output_tokens, cost_usd, ok)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.userId, c.task, c.model, c.source ?? null, c.inputTokens, c.outputTokens, c.costUsd, c.ok],
    );
  }
}

export interface WatchInput {
  db: Db;
  fetchText: FetchText;
  client?: MessagesClient; // leave out to use keyword matching only
  nowMs?: number;
  horizonDays?: number; // how far ahead to look (default 14)
  maxDetails?: number; // event pages to read per run (default 20)
}

export interface WatchReport {
  people: number;
  pagesRead: string[];
  pagesFailed: string[];
  eventsSeen: number;
  detailsRead: number;
  newEvents: number;
  picks: Record<'go' | 'maybe' | 'skip', number>;
  notes: string[];
}

type EventRow = {
  id: string;
  title: string;
  starts_at: string | Date | null;
  ends_at: string | Date | null;
  city: string | null;
  online: boolean;
  price_usd: string | number | null;
  needs_approval: boolean;
  sold_out: boolean;
  going_count: number | null;
  hosts: string[] | null;
  about: string | null;
};

const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : v);

function fromRow(r: EventRow): MatchEvent {
  return {
    key: r.id,
    name: r.title,
    startAt: iso(r.starts_at),
    endAt: iso(r.ends_at),
    city: r.city,
    online: r.online,
    priceUsd: r.price_usd === null ? null : Number(r.price_usd),
    needsApproval: r.needs_approval,
    soldOut: r.sold_out,
    goingCount: r.going_count,
    hosts: r.hosts ?? [],
    about: r.about,
  };
}

function fromLuma(e: LumaEvent): MatchEvent {
  return { key: e.id, ...e };
}

export async function runLumaWatch(input: WatchInput): Promise<WatchReport> {
  const { db } = input;
  const nowMs = input.nowMs ?? Date.now();
  const until = nowMs + (input.horizonDays ?? 14) * 86_400_000;
  const report: WatchReport = {
    people: 0,
    pagesRead: [],
    pagesFailed: [],
    eventsSeen: 0,
    detailsRead: 0,
    newEvents: 0,
    picks: { go: 0, maybe: 0, skip: 0 },
    notes: [],
  };

  const people = (await db.query<Record<string, unknown> & { user_id: string }>('select * from public.needs')).rows.map(
    (r) => ({ userId: r.user_id, needs: needsFromRow(r) }),
  );
  report.people = people.length;
  if (!people.length) return report;

  // 1. Each watched page once. Remember which page each event came from.
  const onPage = new Map<string, Set<string>>();
  const events = new Map<string, LumaEvent>();
  for (const page of [...new Set(people.flatMap((p) => p.needs.lumaPages))]) {
    try {
      const r = await discover([page], input.fetchText, nowMs);
      report.pagesRead.push(page);
      onPage.set(page, new Set(r.events.map((e) => e.id)));
      for (const e of r.events) {
        const start = Date.parse(e.startAt ?? '');
        if (Number.isFinite(start) && start <= until) events.set(e.id, e);
      }
    } catch (err) {
      report.pagesFailed.push(page);
      report.notes.push(`Luma page "${page}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report.eventsSeen = events.size;
  if (!events.size) return report;

  // 2. Descriptions, only for events that pass someone's rules and that we don't have yet.
  const known = new Set(
    (
      await db.query<{ external_id: string }>(
        `select distinct external_id from public.events
          where source = 'luma' and about is not null
            and external_id in (select jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify([...events.keys()])],
      )
    ).rows.map((r) => r.external_id),
  );
  const watches = (p: (typeof people)[number], e: LumaEvent) => p.needs.lumaPages.some((pg) => onPage.get(pg)?.has(e.id));
  const wanted = [...events.values()].filter(
    (e) => !known.has(e.id) && people.some((p) => watches(p, e) && !ruleSkip(fromLuma(e), p.needs, [], nowMs)),
  );
  for (const e of wanted.slice(0, input.maxDetails ?? 20)) {
    try {
      const d = await eventDetail(e.slug, input.fetchText);
      if (d.about) e.about = d.about;
      report.detailsRead++;
    } catch {
      // A missing description only makes the match less sure. Keep going.
    }
  }

  // 3. Per person.
  for (const { userId, needs } of people) {
    try {
      const mine = [...events.values()].filter((e) => watches({ userId, needs }, e));
      const saved = await db.query<{ n: number }>('select public.save_luma_events($1, $2::jsonb) as n', [
        userId,
        JSON.stringify(mine),
      ]);
      report.newEvents += Number(saved.rows[0]?.n ?? 0);

      const picks = await pickFor(db, userId, needs, input.client, nowMs, report.notes);
      if (picks.length) {
        await db.query('select public.save_picks($1, $2::jsonb)', [
          userId,
          JSON.stringify(picks.map((p) => ({ eventId: p.key, pick: p.pick, why: p.why, facts: p.facts, by: p.by }))),
        ]);
      }
      for (const p of picks) report.picks[p.pick]++;
    } catch (err) {
      report.notes.push(`One person's run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

// Picks for one person: everything on Luma they haven't answered and Altie hasn't picked yet.
async function pickFor(
  db: Db,
  userId: string,
  needs: Needs,
  client: MessagesClient | undefined,
  nowMs: number,
  notes: string[],
): Promise<Pick[]> {
  const todo = (
    await db.query<EventRow>(
      `select id, title, starts_at, ends_at, city, online, price_usd, needs_approval, sold_out, going_count, hosts, about
         from public.events
        where user_id = $1 and source = 'luma' and status = 'found' and pick is null and starts_at > $2
        order by starts_at`,
      [userId, new Date(nowMs).toISOString()],
    )
  ).rows.map(fromRow);
  if (!todo.length) return [];

  const going = (
    await db.query<{ title: string; starts_at: string | Date; ends_at: string | Date | null }>(
      `select title, starts_at, ends_at from public.events
        where user_id = $1 and status = 'going' and starts_at is not null and starts_at > $2`,
      [userId, new Date(nowMs - 86_400_000).toISOString()],
    )
  ).rows;
  const busy: Busy[] = going.map((g) => ({ title: g.title, startAt: iso(g.starts_at)!, endAt: iso(g.ends_at) }));

  const alreadyGo = (
    await db.query<{ starts_at: string | Date }>(
      `select starts_at from public.events
        where user_id = $1 and status = 'found' and pick = 'go' and starts_at > $2`,
      [userId, new Date(nowMs).toISOString()],
    )
  ).rows.map((r) => iso(r.starts_at)!);

  // Only work and admin taps teach the matcher, so a family event title never reaches AI.
  const taps: PastTap[] = (
    await db.query<{ title: string; answer: PastTap['answer']; reasons: string[] }>(
      `select e.title, t.answer, t.reasons
         from public.event_taps t join public.events e on e.id = t.event_id
        where t.user_id = $1 and e.area in ('work', 'admin')
        order by t.created_at desc limit 20`,
      [userId],
    )
  ).rows;

  const context: ContextItem[] = (
    await db.query<{ body: string; ai_allowed: boolean }>(
      `select body, ai_allowed from public.memories
        where user_id = $1 and area = 'work'
        order by happened_at desc limit 8`,
      [userId],
    )
  ).rows.map((m) => ({ text: m.body.slice(0, 300), aiAllowed: m.ai_allowed }));

  const result = await matchEvents({
    events: todo,
    needs,
    busy,
    taken: [...busy.map((b) => b.startAt), ...alreadyGo],
    taps,
    context,
    ai: client ? { client, store: new PgSpendStore(db), userId } : undefined,
    nowMs,
  });
  for (const n of result.notes) if (!notes.includes(n)) notes.push(n);
  return result.picks;
}
