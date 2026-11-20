// The whole loop on a real (in-memory) Postgres: Luma pages -> your needs -> picks -> your taps -> the next run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { runLumaWatch } from '../supabase/functions/_shared/watch.ts';
import { A, B, testDb } from './pg.ts';
import { NOW, fakeLuma } from './luma_pages.ts';
import { fakeClaude, voiceAndAgentsJudge } from './fake_claude.ts';

let db: PGlite;
let as: Awaited<ReturnType<typeof testDb>>['as'];
let rows: Awaited<ReturnType<typeof testDb>>['rows'];

before(async () => {
  ({ db, as, rows } = await testDb());

  // You (A): voice AI and agents, no crypto, up to $30, SF and AI pages.
  await as.user(A);
  await db.query(
    `insert into needs (focus, want_topics, want_people, avoid_topics, max_price_usd)
     values ('find a voice AI cofounder', '{voice AI,agents}', '{founders,investors}', '{crypto}', 30)`,
  );
  await db.query(`insert into memories (kind, body, area, ai_allowed) values
    ('voice', 'Met Teo at the last voice meetup, he is hiring', 'work', true),
    ('voice', 'Mom''s birthday dinner on Thursday', 'family', false),
    ('text',  'Unsorted work note that the filter has not cleared yet', 'work', false)`);

  // Someone else (B): only the AI page, free events only.
  await as.user(B);
  await db.query(`insert into needs (luma_pages, max_price_usd) values ('{ai}', 0)`);
});

after(async () => {
  await db.close();
});

const claude1 = fakeClaude(voiceAndAgentsJudge);

test('first run: finds events, picks with reasons, logs the AI cost', async () => {
  await as.server();
  const luma = fakeLuma();
  const r = await runLumaWatch({ db, fetchText: luma.fetchText, client: claude1.client, nowMs: NOW });

  assert.equal(r.people, 2);
  assert.deepEqual(r.pagesRead, ['sf', 'ai']);
  assert.equal(r.eventsSeen, 7, 'past events and ones beyond 14 days are left out');
  assert.equal(r.newEvents, 7 + 2);
  assert.equal(r.detailsRead, 3, 'descriptions only for events that pass someone’s rules');
  assert.deepEqual(r.picks, { go: 4, maybe: 0, skip: 5 });
  assert.equal(luma.asked.filter((u) => u.endsWith('/sf')).length, 1, 'each page read once for everyone');

  await as.owner();
  const mine = await rows<{ title: string; pick: string; pick_why: string; picked_by: string }>(
    `select title, pick, pick_why, picked_by from events where user_id = $1 order by starts_at`,
    [A],
  );
  const by = Object.fromEntries(mine.map((e) => [e.title, e]));
  assert.equal(by['Voice AI Builders Night'].pick, 'go');
  assert.equal(by['Voice AI Builders Night'].pick_why, 'Voice AI Builders Night fits your focus');
  assert.equal(by['Crypto x Agents Mixer'].pick_why, 'About crypto, which you skip');
  assert.equal(by['Founder Summit 2026'].picked_by, 'rules');

  const calls = await rows<{ task: string; model: string; cost_usd: string }>('select task, model, cost_usd from ai_calls where user_id = $1', [A]);
  assert.deepEqual(calls.map((c) => [c.task, c.model, Number(c.cost_usd)]), [['pick_events', 'claude-sonnet-5-5', 0.007]]);
});

test('Claude saw your cleared work note and the event descriptions, never private notes', () => {
  const forA = JSON.stringify(claude1.sent.find((s) => JSON.stringify(s).includes('Teo')));
  assert.ok(forA.includes('he is hiring'));
  assert.ok(forA.includes('Demos from voice AI founders'));
  assert.ok(!forA.includes('birthday'));
  assert.ok(!forA.includes('not cleared yet'));
});

test('you only ever see your own events; "for me" shows go first and hides skips', async () => {
  await as.user(A);
  const forMe = await rows<{ title: string }>('select title from events_for_me()');
  assert.deepEqual(forMe.map((e) => e.title), ['Voice AI Builders Night', 'Browser Agents Demo Day']);

  await as.user(B);
  const theirs = await rows<{ user_id: string }>('select user_id from events');
  assert.equal(theirs.length, 2);
  assert.ok(theirs.every((e) => e.user_id === B));
  assert.equal((await rows('select * from needs')).length, 1);
});

test('your tap is saved, with what Altie had said, so Altie can learn', async () => {
  await as.user(A);
  const [{ id }] = await rows<{ id: string }>("select id from events where external_id = 'evt-voice'");
  await db.query("select answer_event($1, 'going', '{great_fit}')", [id]);
  const [ev] = await rows<{ status: string; decision_why: string }>('select status, decision_why from events where id = $1', [id]);
  assert.deepEqual([ev.status, ev.decision_why], ['going', 'great_fit']);
  const [tap] = await rows<{ answer: string; altie_pick: string }>('select answer, altie_pick from event_taps');
  assert.deepEqual([tap.answer, tap.altie_pick], ['going', 'go']);

  await assert.rejects(db.query("select answer_event($1, 'skipped', '{made_up_reason}')", [id]), /check constraint/);

  await as.user(B);
  await assert.rejects(db.query("select answer_event($1, 'skipped')", [id]), /No such event/);
});

test('second run: no duplicates, your answer kept, nothing re-sent to Claude', async () => {
  await as.server();
  const luma = fakeLuma();
  const claude = fakeClaude(voiceAndAgentsJudge);
  const r = await runLumaWatch({ db, fetchText: luma.fetchText, client: claude.client, nowMs: NOW });
  assert.equal(r.newEvents, 0);
  assert.equal(r.detailsRead, 0, 'descriptions are not read twice');
  assert.equal(claude.sent.length, 0, 'nothing new to pick, so no AI cost');

  await as.owner();
  const [{ n }] = await rows<{ n: number }>('select count(*)::int as n from events where user_id = $1', [A]);
  assert.equal(n, 7);
  const [{ status }] = await rows<{ status: string }>("select status from events where user_id = $1 and external_id = 'evt-voice'", [A]);
  assert.equal(status, 'going');
});

test('change what you want, and Altie picks again with your new needs', async () => {
  await as.user(A);
  await db.query("update needs set avoid_topics = '{crypto,yoga}'");
  const [{ cleared }] = await rows<{ cleared: number }>('select count(*)::int as cleared from events where pick is null');
  assert.equal(cleared, 6, 'every unanswered event, but not the one you said yes to');

  await as.server();
  const claude = fakeClaude(voiceAndAgentsJudge);
  await runLumaWatch({ db, fetchText: fakeLuma().fetchText, client: claude.client, nowMs: NOW });
  assert.equal(claude.sent.length, 1);

  await as.user(A);
  const [yoga] = await rows<{ pick: string; pick_why: string }>("select pick, pick_why from events where external_id = 'evt-yoga'");
  assert.deepEqual([yoga.pick, yoga.pick_why], ['skip', 'About yoga, which you skip']);
  const [{ said }] = await rows<{ said: string }>("select pick as said from events where external_id = 'evt-voice'");
  assert.equal(said, 'go', 'your own answer and the pick behind it stay as they were');
});

test('only the server can save events and picks', async () => {
  await as.user(A);
  await assert.rejects(db.query("select save_luma_events($1, '[]'::jsonb)", [A]), /permission denied/);
  await assert.rejects(db.query("select save_picks($1, '[]'::jsonb)", [A]), /permission denied/);
});

test('with no AI key, it still works on keywords and says so', async () => {
  await as.user(A);
  await db.query("update needs set per_week = 3"); // clears picks again
  await as.server();
  const r = await runLumaWatch({ db, fetchText: fakeLuma().fetchText, nowMs: NOW });
  assert.ok(r.notes.some((n) => /No AI key/.test(n)));
  await as.user(A);
  const [agents] = await rows<{ pick: string; pick_why: string; picked_by: string }>(
    "select pick, pick_why, picked_by from events where external_id = 'evt-agents'",
  );
  assert.deepEqual([agents.pick, agents.pick_why, agents.picked_by], ['maybe', 'Matches what you want: agents', 'keywords']);
});
