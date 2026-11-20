// G1 · Luma, public pages only. Ported from the altie-whos-going prototype (luma.py).
//
// Every Luma city or topic page (luma.com/sf, luma.com/ai) and every event page is public.
// The page ships its data as JSON in a __NEXT_DATA__ script tag. That is not an official API,
// so it may change: when it does, discover() says so instead of returning nothing.
//
// fetch is passed in, so tests run on saved pages with no network.
// Polite by design: each page is read once per watcher run, for all users together.

export const LUMA_BASE = 'https://luma.com';

export interface LumaEvent {
  id: string;
  slug: string;
  url: string;
  name: string;
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  city: string | null;
  address: string | null;
  online: boolean;
  priceUsd: number | null; // 0 = free, null = unknown
  needsApproval: boolean;
  soldOut: boolean;
  goingCount: number;
  hosts: string[];
  about?: string;
}

export type FetchText = (url: string) => Promise<string>;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export class LumaLayoutChanged extends Error {
  constructor(path: string) {
    super(`Luma page "${path}" has no event data. Its layout may have changed.`);
    this.name = 'LumaLayoutChanged';
  }
}

// The JSON inside the page's __NEXT_DATA__ tag: props.pageProps.
export function pageData(html: string, path = 'page'): Json {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new LumaLayoutChanged(path);
  try {
    return obj(obj(JSON.parse(m[1]).props).pageProps);
  } catch {
    throw new LumaLayoutChanged(path);
  }
}

function personName(p: Json): string {
  return (str(p.name) ?? [str(p.first_name), str(p.last_name)].filter(Boolean).join(' ')).trim();
}

// One event, from a list entry or an event page (both have the same shape).
export function eventFrom(entry: Json): LumaEvent | null {
  const ev = obj(entry.event);
  const id = str(ev.api_id);
  const slug = str(ev.url);
  const name = str(ev.name);
  if (!id || !slug || !name) return null;
  const geo = obj(ev.geo_address_info);
  const ticket = obj(entry.ticket_info);
  const cents = obj(ticket.price).cents;
  const priceUsd = ticket.is_free === true ? 0 : typeof cents === 'number' && cents > 0 ? cents / 100 : null;
  const hosts = (Array.isArray(entry.hosts) ? entry.hosts : [])
    .map((h) => personName(obj(h)))
    .filter(Boolean)
    .slice(0, 4);
  return {
    id,
    slug,
    url: `${LUMA_BASE}/${slug}`,
    name: name.trim(),
    startAt: str(ev.start_at),
    endAt: str(ev.end_at),
    timezone: str(ev.timezone) ?? 'America/Los_Angeles',
    city: str(geo.city_state) ?? str(geo.city),
    address: str(geo.short_address) ?? str(geo.address),
    online: ev.location_type === 'online',
    priceUsd,
    needsApproval: ticket.require_approval === true,
    soldOut: ticket.is_sold_out === true || entry.sold_out === true,
    goingCount: typeof entry.guest_count === 'number' ? entry.guest_count : 0,
    hosts,
  };
}

// Finds every list of events anywhere in the page data (Luma nests them in different places per page).
function* eventLists(o: unknown): Generator<unknown[]> {
  if (Array.isArray(o)) {
    for (const v of o) yield* eventLists(v);
  } else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Json)) {
      if (k === 'events' && Array.isArray(v) && v.length && obj(v[0]).event) yield v;
      else yield* eventLists(v);
    }
  }
}

export function eventsOnPage(data: Json): LumaEvent[] {
  const out: LumaEvent[] = [];
  for (const list of eventLists(data)) {
    for (const entry of list) {
      const e = eventFrom(obj(entry));
      if (e) out.push(e);
    }
  }
  return out;
}

// Luma's rich-text description, flattened to plain text.
export function plainText(doc: unknown): string {
  if (Array.isArray(doc)) return doc.map(plainText).join('');
  const d = obj(doc);
  if (d.type === 'text') return typeof d.text === 'string' ? d.text : '';
  const inner = (Array.isArray(d.content) ? d.content : []).map(plainText).join('');
  return inner + (['paragraph', 'heading', 'listItem'].includes(String(d.type)) ? '\n' : '');
}

export interface DiscoverResult {
  events: LumaEvent[];
  pagesRead: string[];
  pagesFailed: Array<{ page: string; error: string }>;
}

// Upcoming events from Luma's public city and topic pages, soonest first, no duplicates.
// One page failing doesn't hide the others. All pages failing is an error.
export async function discover(pages: string[], fetchText: FetchText, nowMs = Date.now()): Promise<DiscoverResult> {
  const seen = new Set<string>();
  const events: LumaEvent[] = [];
  const pagesRead: string[] = [];
  const pagesFailed: DiscoverResult['pagesFailed'] = [];
  for (const page of [...new Set(pages.map((p) => p.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))]) {
    let data: Json;
    try {
      data = pageData(await fetchText(`${LUMA_BASE}/${page}`), page);
    } catch (err) {
      pagesFailed.push({ page, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    pagesRead.push(page);
    for (const e of eventsOnPage(data)) {
      const end = Date.parse(e.endAt ?? e.startAt ?? '');
      if (seen.has(e.id) || (Number.isFinite(end) && end < nowMs)) continue;
      seen.add(e.id);
      events.push(e);
    }
  }
  if (!pagesRead.length && pagesFailed.length) {
    throw new Error(`Couldn't read any Luma page: ${pagesFailed.map((f) => f.page).join(', ')}`);
  }
  events.sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
  return { events, pagesRead, pagesFailed };
}

// One event page: adds the description. (Guests are read elsewhere, only for events you go to.)
export async function eventDetail(slug: string, fetchText: FetchText): Promise<LumaEvent> {
  const data = pageData(await fetchText(`${LUMA_BASE}/${slug}`), slug);
  const d = obj(obj(data.initialData).data);
  const e = eventFrom(d);
  if (!e) throw new Error(`Couldn't read the Luma event "${slug}"`);
  e.about = plainText(d.description_mirror).trim().slice(0, 1500) || undefined;
  return e;
}

// The real fetch, for the Edge Function. It says honestly what it is (no pretending to be a browser).
// If Luma blocks it, we respect that and ask Luma for proper access instead of working around it.
export const lumaFetch: FetchText = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Twinwire/0.1 (personal event finder)', 'Accept-Language': 'en-US' },
  });
  if (!res.ok) throw new Error(`Luma answered ${res.status} for ${url}`);
  return await res.text();
};
