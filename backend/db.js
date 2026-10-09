// Postgres access: one pool for queries, a `tx()` helper for guarded writes,
// and a self-healing LISTEN client for the realtime path.
import pg from 'pg';

const { Pool, Client } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

// A pool error on an idle client must not take the process down.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export function q(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction. Rolls back on throw, always releases. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids never reach SQL as text without passing through here. */
export function assertUuid(value, label = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, `${label} must be a uuid`);
  }
  return value;
}

/**
 * Tenant isolation, in one place. Every query that returns operational rows
 * composes its WHERE from this, and it takes the list of businesses the caller
 * is allowed to see — produced by scopeFor() from the signed-in user, never
 * from the request. There is deliberately no "everything" branch: an empty
 * list matches no rows rather than all of them.
 */
export function businessClause(businessIds, { column = 'business_id', index = 1 } = {}) {
  const list = (Array.isArray(businessIds) ? businessIds : [businessIds]).filter(Boolean);
  for (const id of list) assertUuid(id, 'business_id');
  return { sql: `${column} = ANY($${index}::uuid[])`, params: [list] };
}

const CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * LISTEN on `channel` with its own dedicated connection, reconnecting with
 * backoff. Returns a stop function. `onReady` fires on every (re)connect so
 * callers can resync state they may have missed while disconnected.
 */
export function listen(channel, onNotification, { onReady, onLost } = {}) {
  if (!CHANNEL_RE.test(channel)) throw new Error(`unsafe channel name: ${channel}`);

  let client = null;
  let stopped = false;
  let backoff = 500;
  let timer = null;

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };

  const drop = (reason) => {
    if (client) {
      const dying = client;
      client = null;
      dying.removeAllListeners();
      dying.end().catch(() => {});
      onLost?.(reason);
    }
    schedule();
  };

  async function connect() {
    if (stopped) return;
    client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on('error', (err) => {
      console.error(`[db] LISTEN ${channel} error:`, err.message);
      drop(err.message);
    });
    client.on('end', () => drop('connection ended'));
    client.on('notification', (msg) => {
      if (msg.channel !== channel) return;
      try {
        onNotification(JSON.parse(msg.payload));
      } catch (err) {
        console.error(`[db] bad ${channel} payload:`, err.message);
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${channel}`);
      backoff = 500;
      console.log(`[db] LISTEN ${channel} ready`);
      onReady?.();
    } catch (err) {
      console.error(`[db] LISTEN ${channel} connect failed:`, err.message);
      drop(err.message);
    }
  }

  connect();

  return async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    const dying = client;
    client = null;
    if (dying) {
      dying.removeAllListeners();
      await dying.end().catch(() => {});
    }
  };
}

export async function closePool() {
  await pool.end().catch(() => {});
}
