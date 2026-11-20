// An in-memory Postgres with the real migrations, plus helpers to act as a signed-in user or as the server.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const here = new URL('.', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, here), 'utf8');

export const A = '00000000-0000-0000-0000-00000000000a';
export const B = '00000000-0000-0000-0000-00000000000b';

export async function testDb() {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(read('./supabase_stub.sql'));
  const files = readdirSync(new URL('../supabase/migrations/', here)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.exec(read(`../supabase/migrations/${f}`));
  await db.exec(read('./supabase_grants.sql'));
  await db.query('insert into auth.users (id) values ($1), ($2)', [A, B]);

  const as = {
    user: async (id: string) => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
      await db.exec('set role authenticated');
    },
    server: async () => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
      await db.exec('set role service_role');
    },
    owner: async () => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    },
  };
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  return { db, as, rows };
}
