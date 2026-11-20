// G1 · Luma watcher. Runs on a schedule (every 6 hours), never from the app.
//
// Secrets (Supabase → Edge Functions → Secrets), never in the app and never in chat:
//   WATCH_SECRET        a long random string; the scheduler sends it as "Authorization: Bearer <it>"
//   ANTHROPIC_API_KEY   optional; without it, matching uses keywords
//   SUPABASE_DB_URL     provided by Supabase
//
// Deploy without the user-login check (the scheduler is not a user):
//   supabase functions deploy luma-watch --no-verify-jwt

import Anthropic from 'npm:@anthropic-ai/sdk';
import postgres from 'npm:postgres@3.4.5';
import { runLumaWatch } from '../_shared/watch.ts';
import type { Db } from '../_shared/watch.ts';
import { lumaFetch } from '../_shared/luma.ts';
import type { MessagesClient } from '../_shared/ai_gateway.ts';

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('WATCH_SECRET');
  if (!secret || req.headers.get('Authorization') !== `Bearer ${secret}`) {
    return new Response('Not allowed', { status: 401 });
  }

  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1 });
  const db: Db = { query: async (q, params = []) => ({ rows: (await sql.unsafe(q, params as never[])) as never[] }) };
  const client = Deno.env.get('ANTHROPIC_API_KEY') ? (new Anthropic() as unknown as MessagesClient) : undefined;

  try {
    const report = await runLumaWatch({ db, fetchText: lumaFetch, client });
    return Response.json(report);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    await sql.end();
  }
});
