// See the event matcher work, with no account, no key and no network.
// Uses made-up Luma pages from the tests and keyword matching.
//   npm run demo
import { discover } from '../supabase/functions/_shared/luma.ts';
import { matchEvents } from '../supabase/functions/_shared/event_match.ts';
import { DEFAULT_NEEDS } from '../supabase/functions/_shared/needs.ts';
import type { Needs } from '../supabase/functions/_shared/needs.ts';
import { ABOUT, NOW, fakeLuma } from '../tests/luma_pages.ts';

const needs: Needs = {
  ...DEFAULT_NEEDS,
  focus: 'find a voice AI cofounder',
  wantTopics: ['voice AI', 'agents'],
  wantPeople: ['founders', 'investors'],
  avoidTopics: ['crypto'],
  maxPriceUsd: 30,
  latestHour: 21,
  perWeek: 3,
};

const { events } = await discover(['sf', 'ai'], fakeLuma().fetchText, NOW);
const result = await matchEvents({
  events: events.map((e) => ({ key: e.id, ...e, about: ABOUT[e.id] })),
  needs,
  nowMs: NOW,
});

const icon = { go: '🟢 go   ', maybe: '🟡 maybe', skip: '⚪ skip ' };
const names = new Map(events.map((e) => [e.id, e.name]));
console.log(`\nYour focus: ${needs.focus}\n`);
for (const p of result.picks) console.log(`${icon[p.pick]}  ${names.get(p.key)!.padEnd(28)}  ${p.why}  [${p.by}]`);
console.log(`\n${result.notes.join('\n')}\n`);
