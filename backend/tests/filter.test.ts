import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterItem } from '../supabase/functions/_shared/filter.ts';
import type { FilterRule } from '../supabase/functions/_shared/filter.ts';

test('family stays on the phone: kept, never sent to AI', () => {
  const r = filterItem({ source: 'voice', text: 'Send Mom the trip photos' });
  assert.equal(r.action, 'keep');
  assert.equal(r.area, 'family');
  assert.equal(r.aiAllowed, false);
});

test('health stays on the phone too', () => {
  const r = filterItem({ source: 'voice', text: 'Refill prescription before Friday' });
  assert.equal(r.area, 'health');
  assert.equal(r.aiAllowed, false);
});

test('work goes to AI', () => {
  const r = filterItem({ source: 'voice', text: 'Met Priya, she builds browser agents' });
  assert.deepEqual([r.action, r.area, r.aiAllowed], ['keep', 'work', true]);
});

test('"Bill" the person is not a bill', () => {
  assert.equal(filterItem({ source: 'voice', text: 'Coffee with Bill about the pilot' }).area, 'work');
  assert.equal(filterItem({ source: 'voice', text: 'Phone bill due Fri' }).area, 'admin');
});

test('when two areas match, the more private one wins', () => {
  const r = filterItem({ source: 'voice', text: 'Pay the dentist invoice' });
  assert.equal(r.area, 'health');
  assert.equal(r.aiAllowed, false);
});

test('newsletters and no-reply emails are skipped', () => {
  assert.equal(filterItem({ source: 'gmail', from: 'no-reply@shop.com', text: 'Your order shipped' }).action, 'skip');
  assert.equal(
    filterItem({ source: 'gmail', from: 'deals@shop.com', text: 'Black Friday: 40% off. Unsubscribe here.' }).action,
    'skip',
  );
});

test('things you say yourself are never skipped, even if they sound like an ad', () => {
  assert.equal(filterItem({ source: 'voice', text: 'Remember to unsubscribe from that gym list' }).action, 'keep');
});

test('your rules win over the built-in ones', () => {
  const rules: FilterRule[] = [
    { matchField: 'domain', pattern: 'investor.vc', action: 'keep', area: 'work', aiAllowed: true },
    { matchField: 'keyword', pattern: 'lensTalk', action: 'skip' },
  ];
  const fromInvestor = filterItem({ source: 'gmail', from: 'Ana <ana@mail.investor.vc>', text: 'Newsletter: our Q4 notes' }, rules);
  assert.deepEqual([fromInvestor.action, fromInvestor.area, fromInvestor.aiAllowed], ['keep', 'work', true]);
  assert.match(fromInvestor.reason, /your rule/);

  assert.equal(filterItem({ source: 'voice', text: 'LensTalk idea again' }, rules).action, 'skip');
});

test('a skip never lets the item reach AI', () => {
  const rules: FilterRule[] = [{ matchField: 'source', pattern: 'luma', action: 'skip', aiAllowed: true }];
  const r = filterItem({ source: 'luma', text: 'New event' }, rules);
  assert.deepEqual([r.action, r.aiAllowed], ['skip', false]);
});
