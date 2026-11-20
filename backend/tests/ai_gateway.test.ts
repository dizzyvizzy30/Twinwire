import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askClaude, costUsd, SpendCapReached, MODEL_FOR_TASK } from '../supabase/functions/_shared/ai_gateway.ts';
import type { CallRecord, MessagesClient, SpendStore } from '../supabase/functions/_shared/ai_gateway.ts';

function memoryStore(cap: number, spent = 0) {
  const calls: CallRecord[] = [];
  const store: SpendStore = {
    spentToday: async () => spent + calls.reduce((s, c) => s + c.costUsd, 0),
    capUsd: async () => cap,
    record: async (c) => {
      calls.push(c);
    },
  };
  return { store, calls };
}

function fakeClient(reply = 'ok', usage = { input_tokens: 1000, output_tokens: 200 }) {
  const sent: Record<string, unknown>[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        sent.push(params);
        return { content: [{ type: 'text', text: reply }], usage, stop_reason: 'end_turn' };
      },
    },
  };
  return { client, sent };
}

test('cheap model sorts, stronger models summarize and decide', () => {
  assert.equal(MODEL_FOR_TASK.filter, 'claude-haiku-5-5');
  assert.equal(MODEL_FOR_TASK.summarize, 'claude-sonnet-5-5');
  assert.equal(MODEL_FOR_TASK.who_to_meet, 'claude-opus-5-5');
});

test('cost math per model, including the Haiku long-prompt price', () => {
  assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 }), 3);
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: 10_000, output_tokens: 1_000 }), 0.06);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0 }), 0.01);
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 0 }), 0.1);
  assert.throws(() => costUsd('some-other-model', { input_tokens: 1, output_tokens: 1 }), /No price/);
});

test('a call is logged with model, tokens and cost', async () => {
  const { store, calls } = memoryStore(2);
  const { client } = fakeClient('Priya: browser agents. Promised: deck by Fri.');
  const r = await askClaude({ client, store, userId: 'u1', task: 'summarize', prompt: 'Sum up', source: 'recording' });
  assert.equal(r.text, 'Priya: browser agents. Promised: deck by Fri.');
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { model: calls[0].model, task: calls[0].task, source: calls[0].source, in: calls[0].inputTokens, ok: calls[0].ok },
    { model: 'claude-sonnet-5-5', task: 'summarize', source: 'recording', in: 1000, ok: true },
  );
  assert.equal(calls[0].costUsd, 0.004);
});

test('at the daily cap, Claude is not called at all', async () => {
  const { store, calls } = memoryStore(2, 2);
  const { client, sent } = fakeClient();
  await assert.rejects(askClaude({ client, store, userId: 'u1', task: 'triage', prompt: 'x' }), SpendCapReached);
  assert.equal(sent.length, 0);
  assert.equal(calls.length, 0);
});

test('family and health notes are dropped before the request leaves', async () => {
  const { store } = memoryStore(2);
  const { client, sent } = fakeClient();
  const r = await askClaude({
    client,
    store,
    userId: 'u1',
    task: 'who_to_meet',
    prompt: 'Who should I meet tonight?',
    context: [
      { text: 'Priya builds browser agents', aiAllowed: true },
      { text: 'Send Mom the trip photos', aiAllowed: false },
      { text: 'Refill prescription', aiAllowed: false },
    ],
  });
  const body = JSON.stringify(sent[0]);
  assert.ok(body.includes('Priya builds browser agents'));
  assert.ok(!body.includes('Mom') && !body.includes('prescription'));
  assert.equal(r.droppedPrivate, 2);
});

test('the sorting task asks for low effort', async () => {
  const { store } = memoryStore(2);
  const { client, sent } = fakeClient();
  await askClaude({ client, store, userId: 'u1', task: 'filter', prompt: 'Which area?' });
  assert.deepEqual(sent[0].output_config, { effort: 'low' });
  assert.equal(sent[0].model, 'claude-haiku-5-5');
});

test('a failed call is logged as failed, at no cost, and the error is passed on', async () => {
  const { store, calls } = memoryStore(2);
  const client: MessagesClient = {
    messages: {
      create: async () => {
        throw new Error('network down');
      },
    },
  };
  await assert.rejects(askClaude({ client, store, userId: 'u1', task: 'summarize', prompt: 'x' }), /network down/);
  assert.deepEqual([calls.length, calls[0].ok, calls[0].costUsd], [1, false, 0]);
});
