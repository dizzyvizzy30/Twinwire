// What you're looking for, in a form Altie can match events against.
//
// You say it in your own words ("I want to meet voice AI founders, weeknights, free only").
// needsFromWords() turns that into fields and a list of plain changes. Nothing is saved until you tap Save.
// Privacy: words the filter marks as family, health or "you" never go to Claude (Z7).

import { askClaude } from './ai_gateway.ts';
import type { MessagesClient, SpendStore } from './ai_gateway.ts';
import { filterItem } from './filter.ts';
import { firstJsonObject } from './json.ts';

export interface Needs {
  focus: string | null; // the one thing right now (U8)
  wantTopics: string[];
  wantPeople: string[];
  avoidTopics: string[];
  lumaPages: string[];
  cities: string[]; // empty = any city on the watched pages
  onlineOk: boolean;
  maxPriceUsd: number; // 0 = free only
  okDays: number[]; // 0 Sunday ... 6 Saturday
  earliestHour: number; // earliest start time, 0-23, in your timezone
  latestHour: number; // latest start time
  perWeek: number; // how many "go" picks you want a week
  timezone: string;
}

export const DEFAULT_NEEDS: Needs = {
  focus: null,
  wantTopics: [],
  wantPeople: [],
  avoidTopics: [],
  lumaPages: ['sf', 'ai'],
  cities: [],
  onlineOk: false,
  maxPriceUsd: 30,
  okDays: [0, 1, 2, 3, 4, 5, 6],
  earliestHour: 8,
  latestHour: 21,
  perWeek: 3,
  timezone: 'America/Los_Angeles',
};

// ---------------------------------------------------------------- database row <-> Needs

type Row = Record<string, unknown>;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown, d: number): number => (v === null || v === undefined || v === '' ? d : Number(v));

export function needsFromRow(r: Row): Needs {
  return {
    focus: typeof r.focus === 'string' && r.focus.trim() ? r.focus : null,
    wantTopics: list(r.want_topics),
    wantPeople: list(r.want_people),
    avoidTopics: list(r.avoid_topics),
    lumaPages: list(r.luma_pages).length ? list(r.luma_pages) : DEFAULT_NEEDS.lumaPages,
    cities: list(r.cities),
    onlineOk: r.online_ok === true,
    maxPriceUsd: num(r.max_price_usd, DEFAULT_NEEDS.maxPriceUsd),
    okDays: Array.isArray(r.ok_days) ? r.ok_days.map(Number) : DEFAULT_NEEDS.okDays,
    earliestHour: num(r.earliest_hour, DEFAULT_NEEDS.earliestHour),
    latestHour: num(r.latest_hour, DEFAULT_NEEDS.latestHour),
    perWeek: num(r.per_week, DEFAULT_NEEDS.perWeek),
    timezone: typeof r.timezone === 'string' && r.timezone ? r.timezone : DEFAULT_NEEDS.timezone,
  };
}

// ---------------------------------------------------------------- what may go to AI

// Your needs as plain lines for Claude. Any item the privacy filter marks private is held back.
export function aiSafeNeeds(n: Needs): { text: string; heldBack: number } {
  let heldBack = 0;
  const safe = (items: string[]) =>
    items.filter((t) => {
      const ok = filterItem({ source: 'text', text: t }).aiAllowed;
      if (!ok) heldBack++;
      return ok;
    });
  const lines: string[] = [];
  const focus = n.focus ? safe([n.focus]) : [];
  if (focus.length) lines.push(`Focus right now: ${focus[0]}`);
  const topics = safe(n.wantTopics);
  if (topics.length) lines.push(`Topics they want: ${topics.join(', ')}`);
  const people = safe(n.wantPeople);
  if (people.length) lines.push(`People they want to meet: ${people.join(', ')}`);
  const avoid = safe(n.avoidTopics);
  if (avoid.length) lines.push(`Topics they avoid: ${avoid.join(', ')}`);
  return { text: lines.join('\n') || 'No topics given yet.', heldBack };
}

// ---------------------------------------------------------------- checking what the model proposes

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function cleanList(v: unknown, maxItems = 12, maxLen = 60): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = x.trim().replace(/\s+/g, ' ').slice(0, maxLen);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

function int(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;
}

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Keeps only well-formed fields. Anything odd is dropped, never guessed.
export function cleanNeedsPatch(raw: unknown): Partial<Needs> {
  const r = raw && typeof raw === 'object' ? (raw as Row) : {};
  const p: Partial<Needs> = {};
  if (typeof r.focus === 'string' && r.focus.trim()) p.focus = r.focus.trim().slice(0, 300);
  const wantTopics = cleanList(r.want_topics);
  if (wantTopics) p.wantTopics = wantTopics;
  const wantPeople = cleanList(r.want_people);
  if (wantPeople) p.wantPeople = wantPeople;
  const avoidTopics = cleanList(r.avoid_topics);
  if (avoidTopics) p.avoidTopics = avoidTopics;
  const cities = cleanList(r.cities, 6);
  if (cities) p.cities = cities;
  const pages = cleanList(r.luma_pages, 6, 40)?.map((s) => s.toLowerCase()).filter((s) => /^[a-z0-9-]+$/.test(s));
  if (pages?.length) p.lumaPages = pages;
  if (typeof r.online_ok === 'boolean') p.onlineOk = r.online_ok;
  if (typeof r.max_price_usd === 'number' && r.max_price_usd >= 0 && r.max_price_usd <= 1000) p.maxPriceUsd = r.max_price_usd;
  if (Array.isArray(r.ok_days)) {
    const days = [...new Set(r.ok_days.filter((d) => int(d, 0, 6) !== undefined) as number[])].sort((a, b) => a - b);
    if (days.length) p.okDays = days;
  }
  const early = int(r.earliest_hour, 0, 23);
  const late = int(r.latest_hour, 0, 23);
  if (early !== undefined && late !== undefined) {
    if (early <= late) Object.assign(p, { earliestHour: early, latestHour: late });
  } else if (early !== undefined) p.earliestHour = early;
  else if (late !== undefined) p.latestHour = late;
  const perWeek = int(r.per_week, 0, 14);
  if (perWeek !== undefined) p.perWeek = perWeek;
  if (validTimezone(r.timezone)) p.timezone = r.timezone;
  return p;
}

export function hourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// The changes in plain words, for the confirm screen.
export function describeChanges(current: Needs, next: Needs): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(current.focus, next.focus) && next.focus) out.push(`🎯 Focus: ${next.focus}`);
  if (!same(current.wantTopics, next.wantTopics)) out.push(`💡 Topics: ${next.wantTopics.join(', ') || 'none'}`);
  if (!same(current.wantPeople, next.wantPeople)) out.push(`🤝 People to meet: ${next.wantPeople.join(', ') || 'anyone'}`);
  if (!same(current.avoidTopics, next.avoidTopics)) out.push(`🚫 Skip: ${next.avoidTopics.join(', ') || 'nothing'}`);
  if (!same(current.cities, next.cities)) out.push(`📍 Cities: ${next.cities.join(', ') || 'any'}`);
  if (!same(current.lumaPages, next.lumaPages)) out.push(`🔭 Luma pages: ${next.lumaPages.join(', ')}`);
  if (current.onlineOk !== next.onlineOk) out.push(next.onlineOk ? '💻 Online events OK' : '🚶 In person only');
  if (current.maxPriceUsd !== next.maxPriceUsd) {
    out.push(next.maxPriceUsd === 0 ? '💸 Free events only' : `💸 Up to $${next.maxPriceUsd}`);
  }
  if (!same(current.okDays, next.okDays)) out.push(`📅 Days: ${next.okDays.map((d) => DAY_NAMES[d]).join(', ')}`);
  if (current.earliestHour !== next.earliestHour || current.latestHour !== next.latestHour) {
    out.push(`⏰ Starts between ${hourLabel(next.earliestHour)} and ${hourLabel(next.latestHour)}`);
  }
  if (current.perWeek !== next.perWeek) out.push(`🔋 Up to ${next.perWeek} "go" picks a week`);
  if (current.timezone !== next.timezone) out.push(`🌐 Time zone: ${next.timezone}`);
  return out;
}

// ---------------------------------------------------------------- your words -> needs

const READ_NEEDS_SYSTEM = `You turn what a person says about events they want into settings.
Return JSON only, with ONLY the fields their words change:
{"focus": string, "want_topics": [string], "want_people": [string], "avoid_topics": [string],
 "cities": [string], "online_ok": boolean, "max_price_usd": number (0 = free only),
 "ok_days": [0-6, 0 = Sunday], "earliest_hour": 0-23, "latest_hour": 0-23,
 "per_week": number of events a week, "timezone": IANA name}
Short topic words, like "voice AI", not sentences. "Weeknights" means ok_days [1,2,3,4,5] and earliest_hour 17.
If something is unclear, leave that field out.`;

export type NeedsProposal =
  | { ok: true; proposed: Needs; changes: string[] }
  | { ok: false; reason: string };

export async function needsFromWords(input: {
  words: string;
  current?: Needs;
  client: MessagesClient;
  store: SpendStore;
  userId: string;
}): Promise<NeedsProposal> {
  const current = input.current ?? DEFAULT_NEEDS;
  const words = input.words.trim().slice(0, 2000);
  if (!words) return { ok: false, reason: 'Say or type what you are looking for.' };

  const check = filterItem({ source: 'voice', text: words });
  if (!check.aiAllowed) {
    return {
      ok: false,
      reason: `That mentions ${check.area} things, so it stays on your phone and is not sent to AI. Set this one with the buttons instead.`,
    };
  }

  const { text } = await askClaude({
    client: input.client,
    store: input.store,
    userId: input.userId,
    task: 'read_needs',
    source: 'needs',
    system: READ_NEEDS_SYSTEM,
    maxTokens: 800,
    prompt: `Their settings now:\n${aiSafeNeeds(current).text}\n\nWhat they said:\n<said>${words}</said>`,
  });

  const patch = cleanNeedsPatch(firstJsonObject(text));
  const proposed: Needs = { ...current, ...patch };
  const changes = describeChanges(current, proposed);
  if (!changes.length) return { ok: false, reason: "I couldn't find a change in that. Try: \"free events, weeknights, voice AI founders\"." };
  return { ok: true, proposed, changes };
}
