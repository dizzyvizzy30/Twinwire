import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiSafeNeeds, cleanNeedsPatch, DEFAULT_NEEDS, needsFromRow, needsFromWords } from '../supabase/functions/_shared/needs.ts';
import { fakeClaude, memoryStore } from './fake_claude.ts';

test('your own words become settings you can check before saving', async () => {
  const { store } = memoryStore();
  const { client, sent } = fakeClaude(() =>
    JSON.stringify({
      focus: 'find a voice AI cofounder',
      want_topics: ['voice AI', 'agents'],
      want_people: ['founders'],
      ok_days: [1, 2, 3, 4, 5],
      earliest_hour: 17,
      latest_hour: 21,
      max_price_usd: 0,
    }),
  );
  const r = await needsFromWords({
    words: 'I want to meet voice AI founders, weeknights only, free stuff. Looking for a cofounder.',
    client,
    store,
    userId: 'u1',
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.proposed.focus, 'find a voice AI cofounder');
  assert.deepEqual(r.proposed.okDays, [1, 2, 3, 4, 5]);
  assert.ok(r.changes.includes('💸 Free events only'));
  assert.ok(r.changes.includes('⏰ Starts between 5pm and 9pm'));
  assert.equal(sent[0].model, 'claude-haiku-5-5', 'a cheap model reads settings');
});

test('words about health or family are not sent to AI at all', async () => {
  const { store } = memoryStore();
  const { client, sent } = fakeClaude(() => '{}');
  const r = await needsFromWords({ words: 'Nothing on Tuesdays, that is my therapy day', client, store, userId: 'u1' });
  assert.equal(r.ok, false);
  assert.equal(sent.length, 0);
  if (!r.ok) assert.match(r.reason, /stays on your phone/);
});

test('odd values from the model are dropped, never guessed', () => {
  const p = cleanNeedsPatch({
    earliest_hour: 22,
    latest_hour: 9, // earlier than the start: both dropped
    ok_days: [9, 2, 2, 'mon', 0],
    max_price_usd: -5,
    per_week: 40,
    timezone: 'Mars/Olympus',
    luma_pages: ['sf', 'https://evil.example/x'],
    want_topics: ['voice AI', 'Voice AI', '', 42],
  });
  assert.deepEqual(p, { okDays: [0, 2], lumaPages: ['sf'], wantTopics: ['voice AI'] });
});

test('a reply with no settings in it changes nothing', async () => {
  const { store } = memoryStore();
  const { client } = fakeClaude(() => 'Sorry, I am not sure.');
  const r = await needsFromWords({ words: 'hmm', client, store, userId: 'u1' });
  assert.equal(r.ok, false);
});

test('private items in your needs are held back from AI', () => {
  const { text, heldBack } = aiSafeNeeds({
    ...DEFAULT_NEEDS,
    focus: 'Get my mom settled after the move',
    wantTopics: ['voice AI', 'dentist meetups'],
  });
  assert.equal(heldBack, 2);
  assert.ok(text.includes('voice AI'));
  assert.ok(!/mom|dentist/i.test(text));
});

test('a database row reads back as needs, with defaults for anything missing', () => {
  const n = needsFromRow({ want_topics: ['agents'], max_price_usd: '0.00', ok_days: [1, 2], luma_pages: [] });
  assert.deepEqual([n.wantTopics, n.maxPriceUsd, n.okDays, n.lumaPages, n.perWeek], [['agents'], 0, [1, 2], ['sf', 'ai'], 3]);
});
