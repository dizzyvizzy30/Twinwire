import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, eventDetail, pageData, LumaLayoutChanged } from '../supabase/functions/_shared/luma.ts';
import { NOW, PAGES, fakeLuma, listPage, entry } from './luma_pages.ts';

test('reads events from every list on the page, soonest first, past ones left out', async () => {
  const { fetchText } = fakeLuma();
  const r = await discover(['sf'], fetchText, NOW);
  const names = r.events.map((e) => e.name);
  assert.equal(names[0], 'Voice AI Builders Night');
  assert.ok(names.includes('Sunset Yoga in the Park'), 'found in a nested list too');
  assert.ok(!names.includes('Yesterday Voice Meetup'), 'already over');
  assert.deepEqual(r.pagesRead, ['sf']);
});

test('an event on two pages is kept once', async () => {
  const { fetchText } = fakeLuma();
  const r = await discover(['sf', 'ai', 'sf'], fetchText, NOW);
  assert.equal(r.events.filter((e) => e.id === 'evt-voice').length, 1);
});

test('price, online, approval and hosts are read the way Luma lists them', async () => {
  const pages = {
    'https://luma.com/x': listPage([
      entry({ id: 'a', name: 'Free one', start: '2026-11-25T02:00:00Z', free: true, approval: true }),
      entry({ id: 'b', name: 'Paid one', start: '2026-11-25T03:00:00Z', cents: 2500, soldOut: true }),
      entry({ id: 'c', name: 'Unknown price', start: '2026-11-25T04:00:00Z', online: true, hosts: ['A A', 'B B', 'C C', 'D D', 'E E'] }),
    ]),
  };
  const { events } = await discover(['x'], fakeLuma(pages).fetchText, NOW);
  const [a, b, c] = events;
  assert.deepEqual([a.priceUsd, a.needsApproval, a.online], [0, true, false]);
  assert.deepEqual([b.priceUsd, b.soldOut], [25, true]);
  assert.deepEqual([c.priceUsd, c.online, c.city, c.hosts.length], [null, true, null, 4]);
  assert.equal(a.url, 'https://luma.com/slug-a');
});

test('one page failing does not hide the others; all failing is an error', async () => {
  const { fetchText } = fakeLuma();
  const r = await discover(['sf', 'nope'], fetchText, NOW);
  assert.ok(r.events.length > 0);
  assert.equal(r.pagesFailed[0].page, 'nope');
  await assert.rejects(discover(['nope', 'gone'], fetchText, NOW), /Couldn't read any Luma page/);
});

test('if Luma changes its page layout, we say so instead of returning nothing', () => {
  assert.throws(() => pageData('<html>new layout</html>', 'sf'), LumaLayoutChanged);
  assert.throws(() => pageData('<html>new layout</html>', 'sf'), /layout may have changed/);
});

test('an event page adds the description as plain text', async () => {
  const e = await eventDetail('slug-evt-voice', fakeLuma().fetchText);
  assert.equal(e.name, 'Voice AI Builders Night');
  assert.equal(e.about, 'Demos from voice AI founders.\nInvestors from two seed funds will be there.');
  assert.deepEqual(e.hosts, ['Mira Okafor', 'Teo Lindqvist']);
  assert.ok(PAGES['https://luma.com/slug-evt-voice']);
});
