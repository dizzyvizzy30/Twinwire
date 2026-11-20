// Z7 · Filter before AI.
// Runs on every incoming item BEFORE anything can reach Claude. No AI, no network: plain rules.
// Order: your own rules first, then built-in skips (newsletters, no-reply), then life-area keywords.
// Family, health and "you" items are kept but never sent to AI (aiAllowed = false).
// Works in Deno (Supabase Edge Functions) and in Node.

export type LifeArea = 'work' | 'family' | 'health' | 'admin' | 'you';
export type Source = 'gmail' | 'calendar' | 'luma' | 'voice' | 'recording' | 'share' | 'text';

export interface Incoming {
  source: Source;
  text: string;
  from?: string; // email address or sender name
  subject?: string;
}

export interface FilterRule {
  matchField: 'sender' | 'domain' | 'keyword' | 'source';
  pattern: string;
  action: 'keep' | 'skip';
  area?: LifeArea;
  aiAllowed?: boolean;
}

export interface FilterResult {
  action: 'keep' | 'skip';
  area: LifeArea;
  aiAllowed: boolean;
  reason: string;
}

// Areas whose items stay on your phone and never go to an AI model.
export const PRIVATE_AREAS: ReadonlySet<LifeArea> = new Set<LifeArea>(['family', 'health', 'you']);

const AREA_WORDS: Record<Exclude<LifeArea, 'work' | 'you'>, string[]> = {
  health: [
    'doctor', 'dr', 'dentist', 'dental', 'clinic', 'hospital', 'prescription', 'pharmacy', 'meds', 'medication',
    'therapy', 'therapist', 'appointment', 'checkup', 'check-up', 'gym', 'workout', 'physio', 'vaccine', 'refill',
  ],
  family: [
    'mom', 'mum', 'dad', 'mother', 'father', 'sister', 'brother', 'wife', 'husband', 'partner', 'son', 'daughter',
    'kids', 'grandma', 'grandpa', 'aunt', 'uncle', 'cousin', 'family', 'thanksgiving', 'birthday', 'anniversary',
  ],
  // No plain "bill": it is also a name ("coffee with Bill"). Bills are caught by the phrases below.
  admin: [
    'bills', 'invoice', 'rent', 'insurance', 'renewal', 'renew', 'receipt', 'tax', 'taxes', 'payment', 'subscription',
    'bank', 'statement', 'lease', 'dmv', 'utility', 'utilities',
  ],
};

const AREA_PHRASES: Partial<Record<LifeArea, string[]>> = {
  admin: ['phone bill', 'electric bill', 'water bill', 'gas bill', 'credit card', 'bill due', 'pay the bill'],
};

// Check order when several areas match: the most private one wins.
const AREA_PRIORITY: Array<Exclude<LifeArea, 'work' | 'you'>> = ['health', 'family', 'admin'];

const SKIP_SENDERS = /(^|[^a-z])(no-?reply|do-?not-?reply|newsletter|notifications?|marketing|news|digest|mailer-daemon)([^a-z]|$)/i;
const SKIP_PHRASES = /\b(unsubscribe|view (this email )?in (your )?browser|% off|limited time offer|you are receiving this)\b/i;

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []);
}

function hasWord(bag: Set<string>, w: string): boolean {
  return bag.has(w) || bag.has(w + 's') || bag.has(w + "'s");
}

function domainOf(from?: string): string {
  const m = from?.toLowerCase().match(/@([a-z0-9.-]+)/);
  return m ? m[1] : '';
}

function ruleMatches(rule: FilterRule, item: Incoming, bag: Set<string>): boolean {
  const p = rule.pattern.toLowerCase().trim();
  if (!p) return false;
  switch (rule.matchField) {
    case 'sender':
      return (item.from ?? '').toLowerCase().includes(p);
    case 'domain': {
      const d = domainOf(item.from);
      return d === p || d.endsWith('.' + p);
    }
    case 'keyword':
      return p.includes(' ') ? `${item.subject ?? ''} ${item.text}`.toLowerCase().includes(p) : hasWord(bag, p);
    case 'source':
      return item.source === p;
  }
}

function areaFromWords(bag: Set<string>, text: string): { area: LifeArea; word?: string } {
  const lower = text.toLowerCase();
  for (const area of AREA_PRIORITY) {
    const word =
      AREA_WORDS[area].find((w) => hasWord(bag, w)) ?? AREA_PHRASES[area]?.find((p) => lower.includes(p));
    if (word) return { area, word };
  }
  return { area: 'work' };
}

export function filterItem(item: Incoming, rules: FilterRule[] = []): FilterResult {
  const all = `${item.subject ?? ''} ${item.text}`;
  const bag = words(all);

  // 1. Your rules win.
  for (const rule of rules) {
    if (!ruleMatches(rule, item, bag)) continue;
    const area = rule.area ?? areaFromWords(bag, all).area;
    return {
      action: rule.action,
      area,
      aiAllowed: rule.action === 'keep' && (rule.aiAllowed ?? !PRIVATE_AREAS.has(area)),
      reason: `your rule: ${rule.matchField} "${rule.pattern}"`,
    };
  }

  // 2. Built-in skips, for email only. Things you said or added yourself are never skipped.
  if (item.source === 'gmail') {
    if (SKIP_SENDERS.test(item.from ?? '')) {
      return { action: 'skip', area: 'admin', aiAllowed: false, reason: 'automated sender' };
    }
    if (SKIP_PHRASES.test(`${item.subject ?? ''} ${item.text}`)) {
      return { action: 'skip', area: 'admin', aiAllowed: false, reason: 'looks like a newsletter or ad' };
    }
  }

  // 3. Life area from words. Private areas stay on the phone.
  const { area, word } = areaFromWords(bag, all);
  return {
    action: 'keep',
    area,
    aiAllowed: !PRIVATE_AREAS.has(area),
    reason: word ? `mentions "${word}"` : 'no private words found',
  };
}
