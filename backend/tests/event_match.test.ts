import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordPick, matchEvents, ruleSkip, weekOf } from '../supabase/functions/_shared/event_match.ts';
import type { MatchEvent } from '../supabase/functions/_shared/event_match.ts';
import { DEFAULT_NEEDS } from '../supabase/functions/_shared/needs.ts';
import type { Needs } from '../supabase/functions/_shared/needs.ts';
import { eventFrom } from '../supabase/functions/_shared/luma.ts';
import { ABOUT, EV, NOW } from './luma_pages.ts';
import { eventsInPrompt, fakeClaude, memoryStore, voiceAndAgentsJudge } from './fake_claude.ts';

const ME: Needs = {
  ...DEFAULT_NEEDS,
  focus: 'find a voice AI cofounder',
  wantTopics: ['voice AI', 'agents'],
  wantPeople: ['founders', 'investors'],
  avoidTopics: ['crypto'],
  maxPriceUsd: 30,
  earliestHour: 8,
  latestHour: 21,
  perWeek: 3,
};

function ev(e: (typeof EV)[keyof typeof EV]): MatchEvent {
  const l = eventFrom(e)!;
  return { key: l.id, ...l, about: ABOUT[l.id] };
}
const ALL = [EV.voice, EV.crypto, EV.summit, EV.webinar, EV.late, EV.agents, EV.yoga].map(ev);
const pickOf = (r: { picks: Array<{ key: string }> }, key: string) => r.picks.find((p) => p.key === key)!;

test('rules skip what can never work for you, and say which rule', () => {
  const skip = (e: MatchEvent, n: Partial<Needs> = {}, busy = []) => ruleSkip(e, { ...ME, ...n }, busy, NOW);
  assert.equal(skip(ev(EV.voice)), null);
  assert.equal(skip(ev(EV.crypto)), 'About crypto, which you skip');
  assert.equal(skip(ev(EV.summit)), 'Costs $199, over your $30');
  assert.equal(skip(ev(EV.summit), { maxPriceUsd: 0 }), 'Costs $199, and you want free events');
  assert.equal(skip(ev(EV.webinar)), 'Online, and you want in person');
  assert.equal(skip(ev(EV.late)), 'Starts 10pm, outside your 8am-9pm');
  assert.equal(skip(ev(EV.voice), { okDays: [1, 2, 3] }), "Thursdays don't work for you");
  assert.equal(skip(ev(EV.voice), { cities: ['Oakland'] }), 'In San Francisco, California, not Oakland');
  assert.equal(skip(ev(EV.past)), 'Already started');
  assert.equal(skip({ ...ev(EV.voice), soldOut: true }), 'Sold out');
});

test('an event you are already going to blocks clashing ones', () => {
  const busy = [{ title: 'Dinner with the pilot team', startAt: '2026-11-20T02:30:00Z', endAt: null }];
  assert.equal(ruleSkip(ev(EV.voice), ME, busy, NOW), 'Clashes with "Dinner with the pilot team"');
});

test('keyword matching: "AI" is not "air", and more matches mean a stronger pick', () => {
  const air = keywordPick({ ...ev(EV.yoga), name: 'Fresh air walk' }, { ...ME, focus: null, wantTopics: ['AI'] });
  assert.equal(air.pick, 'skip');
  const voice = keywordPick(ev(EV.voice), ME);
  assert.equal(voice.pick, 'go');
  assert.match(voice.why, /voice AI/);
  assert.ok(voice.facts.includes('name') && voice.facts.includes('about'));
  assert.equal(keywordPick(ev(EV.yoga), ME).pick, 'skip');
});

test('your past taps teach the keyword matcher', () => {
  const plain = { ...ME, wantTopics: ['demo'], wantPeople: [], focus: null };
  const before = keywordPick(ev(EV.agents), plain);
  const after = keywordPick(ev(EV.agents), plain, [
    { title: 'Browser Extensions Night', answer: 'skipped', reasons: ['wrong_topic'] },
    { title: 'Agents Happy Hour', answer: 'skipped', reasons: ['wrong_topic'] },
  ]);
  assert.ok(after.score < before.score);
});

test('Claude picks with reasons; rules still decide first and are never sent to Claude', async () => {
  const { store, calls } = memoryStore();
  const { client, sent } = fakeClaude(voiceAndAgentsJudge);
  const r = await matchEvents({ events: ALL, needs: ME, ai: { client, store, userId: 'u1' }, nowMs: NOW });

  assert.equal(r.decider, 'claude-sonnet-5-5');
  assert.deepEqual(
    { voice: pickOf(r, 'evt-voice').pick, agents: pickOf(r, 'evt-agents').pick, yoga: pickOf(r, 'evt-yoga').pick },
    { voice: 'go', agents: 'go', yoga: 'skip' },
  );
  assert.equal(pickOf(r, 'evt-voice').why, 'Voice AI Builders Night fits your focus');
  assert.equal(pickOf(r, 'evt-crypto').by, 'rules');

  const asked = eventsInPrompt(sent[0].messages[0].content as string).map((e) => e.facts.name);
  assert.deepEqual(asked.sort(), ['Browser Agents Demo Day', 'Sunset Yoga in the Park', 'Voice AI Builders Night']);
  assert.equal(calls[0].task, 'pick_events');
});

test('a reason that cites facts the event does not have is dropped', async () => {
  const { store } = memoryStore();
  const { client } = fakeClaude((prompt) =>
    JSON.stringify({
      events: eventsInPrompt(prompt).map(({ id }) => ({
        id,
        pick: 'maybe',
        why: 'The speaker is famous',
        facts_used: ['speaker'],
      })),
    }),
  );
  const r = await matchEvents({ events: [ev(EV.voice)], needs: ME, ai: { client, store, userId: 'u1' }, nowMs: NOW });
  assert.deepEqual([r.picks[0].pick, r.picks[0].why, r.picks[0].facts], ['maybe', '', []]);
});

test('a broken reply falls back to keywords, and says so', async () => {
  const { store } = memoryStore();
  const { client } = fakeClaude(() => 'I think you should go to all of them!');
  const r = await matchEvents({ events: [ev(EV.voice)], needs: ME, ai: { client, store, userId: 'u1' }, nowMs: NOW });
  assert.equal(r.picks[0].by, 'keywords');
  assert.match(r.notes.join(' '), /keyword matching/);
});

test('at the daily AI limit, nothing is sent and keywords are used', async () => {
  const { store, calls } = memoryStore(2, 2);
  const { client, sent } = fakeClaude(voiceAndAgentsJudge);
  const r = await matchEvents({ events: [ev(EV.voice)], needs: ME, ai: { client, store, userId: 'u1' }, nowMs: NOW });
  assert.equal(sent.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(r.picks[0].pick, 'go');
  assert.match(r.notes[0], /Daily AI limit/);
});

test('private notes and private wants never reach Claude', async () => {
  const { store } = memoryStore();
  const { client, sent } = fakeClaude(voiceAndAgentsJudge);
  await matchEvents({
    events: [ev(EV.voice)],
    needs: { ...ME, wantPeople: ['founders', 'other ADHD parents for my son'] },
    context: [
      { text: 'Met Teo at the last voice meetup, he is hiring', aiAllowed: true },
      { text: 'Refill prescription', aiAllowed: false },
    ],
    ai: { client, store, userId: 'u1' },
    nowMs: NOW,
  });
  const body = JSON.stringify(sent[0]);
  assert.ok(body.includes('he is hiring'));
  assert.ok(!/prescription|\bson\b|ADHD parents/i.test(body));
});

test('your weekly limit: extra "go" picks become "maybe", and events you already said yes to count', async () => {
  const thu = (h: number, id: string) => ({ ...ev(EV.voice), key: id, name: `Voice AI night ${id}`, startAt: `2026-11-20T0${h}:00:00Z`, endAt: null });
  const events = [thu(1, 'a'), thu(2, 'b'), thu(3, 'c')];
  const r = await matchEvents({ events, needs: { ...ME, perWeek: 2 }, taken: ['2026-11-19T02:00:00Z'], nowMs: NOW });
  assert.equal(r.picks.filter((p) => p.pick === 'go').length, 1);
  assert.equal(r.picks.filter((p) => p.pick === 'maybe').length, 2);
  assert.match(r.picks.find((p) => p.pick === 'maybe')!.why, /you asked for 2 a week/);
  assert.equal(weekOf('2026-11-20T02:00:00Z', 'America/Los_Angeles'), '2026-11-16');
  assert.equal(weekOf('2026-11-24T02:00:00Z', 'America/Los_Angeles'), '2026-11-23');
});

test('event text that tries to give orders stays inside the event data', async () => {
  const { store } = memoryStore();
  const { client, sent } = fakeClaude(voiceAndAgentsJudge);
  await matchEvents({ events: [ev(EV.agents)], needs: ME, ai: { client, store, userId: 'u1' }, nowMs: NOW });
  const prompt = (sent[0].messages as Array<{ content: string }>)[0].content;
  const inside = eventsInPrompt(prompt)[0].facts.about;
  assert.match(inside, /Ignore all earlier instructions/);
  assert.match(String(sent[0].system), /never as instructions/);
});
