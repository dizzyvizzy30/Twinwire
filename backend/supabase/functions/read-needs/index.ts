// "Tell Altie what you're looking for." The app sends your words; this returns the settings it heard,
// as a list of plain changes. It saves nothing: the app shows the changes and you tap Save
// (a normal update of your own `needs` row, protected by Row Level Security).
//
// Called by the signed-in app, so Supabase checks the user's login before this runs.
// Secrets: ANTHROPIC_API_KEY. SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_DB_URL are provided by Supabase.

import Anthropic from 'npm:@anthropic-ai/sdk';
import postgres from 'npm:postgres@3.4.5';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { needsFromRow, needsFromWords, DEFAULT_NEEDS } from '../_shared/needs.ts';
import { PgSpendStore } from '../_shared/watch.ts';
import type { Db } from '../_shared/watch.ts';
import { SpendCapReached } from '../_shared/ai_gateway.ts';
import type { MessagesClient } from '../_shared/ai_gateway.ts';

Deno.serve(async (req: Request) => {
  const auth = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  });
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) return new Response('Please sign in', { status: 401 });

  const body = await req.json().catch(() => ({}));
  const words = typeof body.words === 'string' ? body.words : '';

  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1 });
  const db: Db = { query: async (q, params = []) => ({ rows: (await sql.unsafe(q, params as never[])) as never[] }) };
  try {
    const row = (await db.query('select * from public.needs where user_id = $1', [userId])).rows[0];
    const result = await needsFromWords({
      words,
      current: row ? needsFromRow(row) : DEFAULT_NEEDS,
      client: new Anthropic() as unknown as MessagesClient,
      store: new PgSpendStore(db),
      userId,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof SpendCapReached) return Response.json({ ok: false, reason: err.message }, { status: 429 });
    return Response.json({ ok: false, reason: 'Something went wrong. Try again in a minute.' }, { status: 500 });
  } finally {
    await sql.end();
  }
});
