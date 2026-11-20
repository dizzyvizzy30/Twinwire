// Runs the real migration on an in-memory Postgres (PGlite) and checks the privacy rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const here = new URL('.', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, here), 'utf8');
// Every migration, in order, the same way `supabase db push` applies them.
const migrations = () => readdirSync(new URL('../supabase/migrations/', here)).filter((f) => f.endsWith('.sql')).sort();

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

let db: PGlite;

async function asUser(id: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec('set role authenticated');
}
async function asServer() {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.exec('set role service_role');
}
async function asOwner() {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
}
async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  assert.equal(r.length, 1, `expected one row from: ${sql}`);
  return r[0];
}

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(read('./supabase_stub.sql'));
  for (const file of migrations()) await db.exec(read(`../supabase/migrations/${file}`));
  await db.exec(read('./supabase_grants.sql'));
  await db.query('insert into auth.users (id) values ($1), ($2)', [A, B]);
});

after(async () => {
  await db.close();
});

test('user_id fills itself in from the signed-in user', async () => {
  await asUser(A);
  const p = await one<{ user_id: string }>("insert into people (full_name) values ('Priya Shah') returning user_id");
  assert.equal(p.user_id, A);
});

test('another user sees none of your rows', async () => {
  await asUser(B);
  const seen = await rows('select * from people');
  assert.equal(seen.length, 0);
});

test('you cannot write a row into someone else’s account', async () => {
  await asUser(B);
  await assert.rejects(
    db.query('insert into people (user_id, full_name) values ($1, $2)', [A, 'Sneaky']),
    /row-level security/,
  );
});

test('person card pulls last talk, open promises and events from links', async () => {
  await asUser(A);
  const priya = await one<{ id: string }>("select id from people where full_name = 'Priya Shah'");
  const ev = await one<{ id: string }>(
    "insert into events (title, starts_at, source) values ('Agentic Web #02', '2026-11-16T18:00:00Z', 'luma') returning id",
  );
  const older = await one<{ id: string }>(
    "insert into memories (kind, body, happened_at) values ('voice', 'Met Priya, she works on browser agents', '2026-11-16T19:00:00Z') returning id",
  );
  const newer = await one<{ id: string }>(
    "insert into memories (kind, body, happened_at) values ('voice', 'Promised Priya the deck by Friday', '2026-11-16T20:00:00Z') returning id",
  );
  const promise = await one<{ id: string }>(
    "insert into todos (title, is_promise, bucket, due_at) values ('Send Priya the deck', true, 'now', '2026-11-20T17:00:00Z') returning id",
  );
  const done = await one<{ id: string }>("insert into todos (title, bucket) values ('Old thing', 'done') returning id");

  await db.query(
    `insert into links (from_type, from_id, to_type, to_id, kind) values
       ('person', $1, 'event',  $2, 'met_at'),
       ('memory', $3, 'person', $1, 'mentions'),
       ('memory', $4, 'person', $1, 'mentions'),
       ('todo',   $5, 'person', $1, 'promised_to'),
       ('todo',   $6, 'person', $1, 'promised_to')`,
    [priya.id, ev.id, older.id, newer.id, promise.id, done.id],
  );

  const { card } = await one<{ card: any }>('select person_card($1) as card', [priya.id]);
  assert.equal(card.name, 'Priya Shah');
  assert.equal(card.last_talk.said, 'Promised Priya the deck by Friday');
  assert.deepEqual(card.open_promises.map((t: any) => t.title), ['Send Priya the deck']);
  assert.deepEqual(card.events.map((e: any) => e.title), ['Agentic Web #02']);

  await asUser(B);
  const other = await one<{ card: unknown }>('select person_card($1) as card', [priya.id]);
  assert.equal(other.card, null, 'B gets nothing back for A’s person');
});

test('find_people forgives typos', async () => {
  await asUser(A);
  const hits = await rows<{ full_name: string }>("select full_name from find_people('Prya Sha')");
  assert.equal(hits[0]?.full_name, 'Priya Shah');
});

test('memories are searchable by word', async () => {
  await asUser(A);
  const hits = await rows<{ body: string }>(
    "select body from memories where search @@ plainto_tsquery('english', 'agent')",
  );
  assert.deepEqual(hits.map((h) => h.body), ['Met Priya, she works on browser agents']);
});

test('memories are not allowed into AI until the filter says so', async () => {
  await asUser(A);
  const m = await one<{ ai_allowed: boolean }>("insert into memories (kind, body) values ('text', 'Call Mom') returning ai_allowed");
  assert.equal(m.ai_allowed, false);
});

test('only the server can log AI spend; you can read your total', async () => {
  await asUser(A);
  await assert.rejects(
    db.query("insert into ai_calls (user_id, task, model, cost_usd) values ($1, 'filter', 'x', 0)", [A]),
    /row-level security/,
  );

  await asServer();
  await db.query(
    `insert into ai_calls (user_id, task, model, cost_usd, created_at) values
       ($1, 'summarize', 'claude-sonnet-5-5', 0.012, now()),
       ($1, 'filter',    'claude-haiku-5-5',  0.0004, now()),
       ($1, 'summarize', 'claude-sonnet-5-5', 5.0, now() - interval '2 days')`,
    [A],
  );

  await asUser(A);
  const a = await one<{ spent: string }>('select ai_spend_today() as spent');
  assert.equal(Number(a.spent), 0.0124, 'yesterday is not counted');

  await asUser(B);
  const b = await one<{ spent: string }>('select ai_spend_today() as spent');
  assert.equal(Number(b.spent), 0);
});

test('the permissions log cannot be rewritten', async () => {
  await asUser(A);
  await db.query("insert into permissions_log (service, action, scope) values ('luma', 'granted', 'events:read')");
  await db.query("update permissions_log set action = 'revoked'");
  await db.query('delete from permissions_log');
  const log = await rows<{ action: string }>('select action from permissions_log');
  assert.deepEqual(log.map((r) => r.action), ['granted']);
});

test('deleting a person deletes their links too', async () => {
  await asUser(A);
  const p = await one<{ id: string }>("insert into people (full_name) values ('Temp Person') returning id");
  const m = await one<{ id: string }>("insert into memories (kind, body) values ('text', 'Saw Temp') returning id");
  await db.query("insert into links (from_type, from_id, to_type, to_id, kind) values ('memory', $1, 'person', $2, 'mentions')", [m.id, p.id]);
  await db.query('delete from people where id = $1', [p.id]);
  const left = await rows('select * from links where to_id = $1', [p.id]);
  assert.equal(left.length, 0);
});

test('scouted guests you never met are purged after keep_until; people you met stay', async () => {
  await asUser(A);
  await db.query(
    `insert into people (full_name, source, keep_until, met_at) values
       ('Guest Never Met', 'luma', now() - interval '1 day', null),
       ('Guest You Met',   'luma', now() - interval '1 day', now()),
       ('Guest Still Fresh', 'luma', now() + interval '29 days', null)`,
  );

  await asUser(A);
  await assert.rejects(db.query('select purge_expired_people()'), /permission denied/);

  await asServer();
  const { gone } = await one<{ gone: number }>('select purge_expired_people() as gone');
  assert.equal(gone, 1);

  await asOwner();
  const names = (await rows<{ full_name: string }>("select full_name from people where source = 'luma' order by full_name")).map(
    (r) => r.full_name,
  );
  assert.deepEqual(names, ['Guest Still Fresh', 'Guest You Met']);
});
