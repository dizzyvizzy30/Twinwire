// G8 · One door to Claude, with a daily spend cap and a cost log.
// - Picks the model by task: a cheap model sorts, stronger models summarize and decide.
// - Refuses to call when today's spend has reached your cap.
// - Drops any context item the filter did not allow (Z7), so family and health never reach Claude.
// - Logs model, tokens and cost for every call.
//
// The Claude client is passed in, so this file has no SDK import and tests run offline.
// In an Edge Function: `import Anthropic from "npm:@anthropic-ai/sdk"` and pass `new Anthropic()`
// (it reads ANTHROPIC_API_KEY from the function's secrets).

export type Task =
  | 'filter'
  | 'read_needs'
  | 'summarize'
  | 'triage'
  | 'pick_events'
  | 'who_to_meet'
  | 'invite_note';

export const MODEL_FOR_TASK: Record<Task, string> = {
  filter: 'claude-haiku-5-5',
  read_needs: 'claude-haiku-5-5', // turns your own words into needs fields
  summarize: 'claude-sonnet-5-5',
  triage: 'claude-sonnet-5-5',
  pick_events: 'claude-sonnet-5-5', // go / maybe / skip for Luma events
  invite_note: 'claude-sonnet-5-5',
  who_to_meet: 'claude-opus-5-5',
};

const EFFORT_FOR_TASK: Partial<Record<Task, 'low' | 'medium' | 'high'>> = {
  filter: 'low',
  read_needs: 'low',
  invite_note: 'low',
  triage: 'low',
  pick_events: 'low',
};

// US dollars per million tokens, from Anthropic's model list as of 2026-11-17. Re-check before launch.
interface Price { input: number; output: number }
const PRICES: Record<string, Price | ((promptTokens: number) => Price)> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  // Haiku 5.5 costs more when the prompt is over 100K tokens.
  'claude-haiku-5-5': (prompt) => (prompt <= 100_000 ? { input: 0.1, output: 0.5 } : { input: 0.5, output: 2.5 }),
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

// Cache tokens are counted at the full input price, so the estimate errs high, never low.
export function costUsd(model: string, usage: Usage): number {
  const promptTokens =
    usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const entry = PRICES[model];
  if (!entry) throw new Error(`No price for model ${model}. Add it to PRICES before using it.`);
  const price = typeof entry === 'function' ? entry(promptTokens) : entry;
  return (promptTokens * price.input + usage.output_tokens * price.output) / 1_000_000;
}

export interface CallRecord {
  userId: string;
  task: Task;
  model: string;
  source?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
}

// Where spend lives. The real one reads ai_spend_today() and profiles.daily_ai_cap_usd, and inserts into ai_calls.
export interface SpendStore {
  spentToday(userId: string): Promise<number>;
  capUsd(userId: string): Promise<number>;
  record(call: CallRecord): Promise<void>;
}

// The slice of the Anthropic SDK client this gateway uses.
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage: Usage;
      stop_reason?: string | null;
    }>;
  };
}

export interface ContextItem {
  text: string;
  aiAllowed: boolean;
}

export interface AskInput {
  client: MessagesClient;
  store: SpendStore;
  userId: string;
  task: Task;
  prompt: string;
  system?: string;
  context?: ContextItem[];
  source?: string;
  maxTokens?: number;
}

export interface AskResult {
  text: string;
  model: string;
  costUsd: number;
  spentTodayUsd: number;
  droppedPrivate: number;
  stopReason: string | null;
}

export class SpendCapReached extends Error {
  spentUsd: number;
  capUsd: number;
  constructor(spentUsd: number, capUsd: number) {
    super(`Daily AI cap reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}. It resets at midnight UTC.`);
    this.name = 'SpendCapReached';
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

export async function askClaude(input: AskInput): Promise<AskResult> {
  const { client, store, userId, task } = input;
  const model = MODEL_FOR_TASK[task];

  const [spent, cap] = await Promise.all([store.spentToday(userId), store.capUsd(userId)]);
  if (spent >= cap) throw new SpendCapReached(spent, cap);

  const allowed = (input.context ?? []).filter((c) => c.aiAllowed);
  const droppedPrivate = (input.context ?? []).length - allowed.length;
  const contextBlock = allowed.length
    ? `<notes>\n${allowed.map((c) => `- ${c.text}`).join('\n')}\n</notes>\n\n`
    : '';

  const effort = EFFORT_FOR_TASK[task];
  const params: Record<string, unknown> = {
    model,
    max_tokens: input.maxTokens ?? 1024,
    messages: [{ role: 'user', content: contextBlock + input.prompt }],
  };
  if (input.system) params.system = input.system;
  if (effort) params.output_config = { effort };

  let response;
  try {
    response = await client.messages.create(params);
  } catch (err) {
    await store.record({ userId, task, model, source: input.source, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false });
    throw err;
  }

  const cost = costUsd(model, response.usage);
  await store.record({
    userId,
    task,
    model,
    source: input.source,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    costUsd: cost,
    ok: true,
  });

  const text = response.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');

  return {
    text,
    model,
    costUsd: cost,
    spentTodayUsd: spent + cost,
    droppedPrivate,
    stopReason: response.stop_reason ?? null,
  };
}
