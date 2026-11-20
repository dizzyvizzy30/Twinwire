// A stand-in for Claude in tests. It records every request and answers from a function you give it.
import type { MessagesClient, SpendStore, CallRecord } from '../supabase/functions/_shared/ai_gateway.ts';

export function fakeClaude(answer: (prompt: string, params: Record<string, unknown>) => string) {
  const sent: Array<Record<string, unknown>> = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        sent.push(params);
        const msgs = params.messages as Array<{ content: string }>;
        return {
          content: [{ type: 'text', text: answer(msgs[0].content, params) }],
          usage: { input_tokens: 2000, output_tokens: 300 },
          stop_reason: 'end_turn',
        };
      },
    },
  };
  return { client, sent };
}

// Pulls the events out of a pick_events prompt: [{ id: 'e1', name: '...' }, ...]
export function eventsInPrompt(prompt: string): Array<{ id: string; facts: Record<string, string> }> {
  return [...prompt.matchAll(/<event id="(e\d+)">(.*?)<\/event>/g)].map((m) => ({ id: m[1], facts: JSON.parse(m[2]) }));
}

// A simple judge: anything about voice or agents is a "go", the rest a "skip".
export function voiceAndAgentsJudge(prompt: string): string {
  const events = eventsInPrompt(prompt).map(({ id, facts }) => {
    const hit = /voice|agent/i.test(facts.name);
    return {
      id,
      pick: hit ? 'go' : 'skip',
      why: hit ? `${facts.name} fits your focus` : 'Not about your topics',
      facts_used: ['name'],
    };
  });
  return `Here you go:\n${JSON.stringify({ events })}`;
}

export function memoryStore(cap = 2, spent = 0) {
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
