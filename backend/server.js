// Virtual Office backend: REST for the dashboard and for n8n, plus a Socket.io
// fan-out driven entirely by Postgres NOTIFY. No route emits a socket event by
// hand — it writes the row, the trigger notifies, and the LISTEN handler below
// broadcasts whatever the database actually committed.
//
// Everything under /api (bar /api/health and /api/auth/*) needs a signed-in
// user, and the businesses that user belongs to are the only scope any query
// can run in. /api/internal/* is for n8n and carries a shared token instead.
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';
import {
  q, tx, listen, closePool,
  HttpError, assertUuid, businessClause,
} from './db.js';
import {
  COOKIE_NAME, readCookie, resolveSession, requireUser, scopeFor,
  authenticate, createSession, destroySession, setSessionCookie,
  clearSessionCookie, secretsMatch, purgeExpiredSessions,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 4000);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const N8N_RETRY_WEBHOOK_URL = process.env.N8N_RETRY_WEBHOOK_URL ?? '';
const N8N_DISPATCH_WEBHOOK_URL = process.env.N8N_DISPATCH_WEBHOOK_URL ?? '';

const app = express();

// Behind nginx or any TLS terminator, so secure cookies and client IPs work.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// Same-origin by default: in the container nginx serves the dashboard and
// proxies /api, so no cross-origin access is needed. Set CORS_ORIGIN only if
// you really do serve the UI from another host.
const corsOptions = process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }
  : { origin: false };
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new SocketServer(server, { cors: corsOptions });

// ------------------------------------------------------------------ rooms
// A socket joins one room per business its user belongs to — never a global
// room, so an event can only reach sockets entitled to that tenant.

const roomFor = (businessId) => `biz:${businessId}`;

function broadcast(businessId, event, payload) {
  if (!businessId) return;
  io.to(roomFor(businessId)).emit(event, payload);
}

// Socket.io carries the same session cookie as the REST calls.
io.use((socket, next) => {
  resolveSession(readCookie(socket.handshake.headers.cookie, COOKIE_NAME))
    .then((user) => {
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    })
    .catch(() => next(new Error('unauthorized')));
});

function joinScope(socket, requested) {
  let scope;
  try {
    scope = scopeFor(socket.data.user, requested);
  } catch (err) {
    socket.emit('subscribed', { error: err.message });
    return;
  }
  for (const room of socket.rooms) {
    if (room !== socket.id) socket.leave(room);
  }
  for (const businessId of scope) socket.join(roomFor(businessId));
  socket.emit('subscribed', { businesses: scope });
}

io.on('connection', (socket) => {
  // Start subscribed to everything this user can see, so events arrive even
  // before the dashboard sends its first `subscribe`.
  joinScope(socket, 'all');
  socket.emit('hello', { user: { email: socket.data.user.email } });

  socket.on('subscribe', (raw) => {
    const requested = typeof raw === 'string' ? raw : raw?.businessId;
    joinScope(socket, requested ?? 'all');
  });
});

// ------------------------------------------------------------- SQL shapes

const AGENT_COLUMNS = `
  id, business_id, department, name, role_title, status,
  avatar_sprite_key, desk_x, desk_y, last_message, updated_at`;

const APPROVAL_COLUMNS = `
  a.id, a.business_id, a.agent_id, a.status, a.payload_json, a.feedback,
  a.resolved_by, a.created_at, a.resolved_at,
  ag.name AS agent_name, ag.department AS agent_department`;

async function readAgents(scope) {
  const where = businessClause(scope);
  const { rows } = await q(
    `SELECT ${AGENT_COLUMNS} FROM agents
      WHERE ${where.sql}
      ORDER BY business_id, desk_y, desk_x`,
    where.params,
  );
  return rows;
}

async function readAgent(id) {
  assertUuid(id, 'agent_id');
  const { rows } = await q(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function readApprovals(scope, { status, limit = 100 } = {}) {
  const where = businessClause(scope, { column: 'a.business_id' });
  const params = [...where.params];
  let statusSql = '';
  if (status && status !== 'ALL') {
    params.push(status);
    statusSql = ` AND a.status = $${params.length}`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await q(
    `SELECT ${APPROVAL_COLUMNS}
       FROM approvals a JOIN agents ag ON ag.id = a.agent_id
      WHERE ${where.sql}${statusSql}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function readApproval(id) {
  assertUuid(id, 'approval_id');
  const { rows } = await q(
    `SELECT ${APPROVAL_COLUMNS}
       FROM approvals a JOIN agents ag ON ag.id = a.agent_id
      WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

const LOG_COLUMNS = `
  l.id, l.business_id, l.agent_id, l.approval_id, l.action,
  l.actor, l.detail, l.created_at, ag.name AS agent_name`;

async function readLogs(scope, limit = 50) {
  const where = businessClause(scope, { column: 'l.business_id' });
  const params = [...where.params, Math.min(Number(limit) || 50, 200)];
  const { rows } = await q(
    `SELECT ${LOG_COLUMNS}
       FROM action_logs l LEFT JOIN agents ag ON ag.id = l.agent_id
      WHERE ${where.sql}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function readLog(id) {
  const { rows } = await q(
    `SELECT ${LOG_COLUMNS}
       FROM action_logs l LEFT JOIN agents ag ON ag.id = l.agent_id
      WHERE l.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Confirm a row belongs to a business the signed-in user may touch. */
function assertInScope(user, businessId) {
  if (!(user.businessIds ?? []).includes(businessId)) {
    throw new HttpError(404, 'not found');
  }
}

// ------------------------------------------------------------- write paths

function logAction(client, { businessId, agentId, approvalId, action, actor, actorUserId, detail }) {
  return client.query(
    `INSERT INTO action_logs
       (business_id, agent_id, approval_id, action, actor, actor_user_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [businessId, agentId ?? null, approvalId ?? null, action,
     actor ?? 'system', actorUserId ?? null, JSON.stringify(detail ?? {})],
  );
}

/**
 * The only way an agent's status moves as a side effect of something else.
 * PAUSED always wins: a paused agent is never dragged out of PAUSED here, so
 * approve / reject / retry cannot restart a desk a human switched off.
 */
async function settleAgent(client, { agentId, businessId, status, message = null }) {
  const { rows } = await client.query(
    `UPDATE agents SET status = $3, last_message = $4
      WHERE id = $1 AND business_id = $2 AND status <> 'PAUSED'
      RETURNING ${AGENT_COLUMNS}`,
    [agentId, businessId, status, message],
  );
  return rows[0] ?? null;  // null means the agent is paused — caller must cope
}

async function callWebhook(url, body, label) {
  if (!url) {
    console.warn(`[n8n] ${label} skipped: no webhook url configured`);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`[n8n] ${label} -> HTTP ${res.status}`);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error(`[n8n] ${label} failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// ----------------------------------------------------------------- auth

app.get('/api/health', wrap(async (_req, res) => {
  const { rows } = await q('SELECT now() AS now');
  res.json({ ok: true, now: rows[0].now, listening: listenerReady });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  const user = await authenticate(email, password, { ip: req.ip });
  const token = await createSession(user.id, {
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });
  setSessionCookie(res, token);
  const session = await resolveSession(token);
  res.json({ ok: true, user: publicUser(session) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  await destroySession(readCookie(req.headers.cookie, COOKIE_NAME));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  const user = await resolveSession(readCookie(req.headers.cookie, COOKIE_NAME));
  if (!user) throw new HttpError(401, 'sign in to continue');
  res.json({ user: publicUser(user), businesses: await readBusinesses(user) });
}));

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

async function readBusinesses(user) {
  // The tenant key on this table is `id`, not `business_id`.
  const where = businessClause(user.businessIds ?? [], { column: 'id' });
  const { rows } = await q(
    `SELECT id, code, name, timezone, currency FROM businesses
      WHERE ${where.sql} ORDER BY name`,
    where.params,
  );
  return rows;
}

// Everything below needs a session.
app.use('/api/businesses', requireUser);
app.use('/api/agents', requireUser);
app.use('/api/approvals', requireUser);
app.use('/api/action-logs', requireUser);
app.use('/api/state', requireUser);

// ------------------------------------------------------------ public REST

app.get('/api/businesses', wrap(async (req, res) => {
  res.json(await readBusinesses(req.user));
}));

app.get('/api/agents', wrap(async (req, res) => {
  res.json(await readAgents(scopeFor(req.user, req.query.business_id)));
}));

app.get('/api/approvals', wrap(async (req, res) => {
  res.json(await readApprovals(scopeFor(req.user, req.query.business_id), {
    status: req.query.status ?? 'PENDING',
    limit: req.query.limit,
  }));
}));

app.get('/api/approvals/:id', wrap(async (req, res) => {
  const row = await readApproval(req.params.id);
  if (!row) throw new HttpError(404, 'approval not found');
  assertInScope(req.user, row.business_id);
  res.json(row);
}));

app.get('/api/action-logs', wrap(async (req, res) => {
  res.json(await readLogs(scopeFor(req.user, req.query.business_id), req.query.limit));
}));

/** One round trip for the dashboard's initial paint. */
app.get('/api/state', wrap(async (req, res) => {
  const scope = scopeFor(req.user, req.query.business_id);
  const [businesses, agents, approvals, logs] = await Promise.all([
    readBusinesses(req.user),
    readAgents(scope),
    readApprovals(scope, { status: 'PENDING' }),
    readLogs(scope, 30),
  ]);
  res.json({ businesses, agents, approvals, logs });
}));

// APPROVE_TASK — a single guarded UPDATE is the whole race protection: two
// reviewers (or one double click) both run it, only one sees a row back.
app.post('/api/approvals/:id/approve', wrap(async (req, res) => {
  const approvalId = assertUuid(req.params.id, 'approval_id');
  const user = req.user;

  const outcome = await tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE approvals
          SET status = 'APPROVED', resolved_at = now(),
              resolved_by = $2, resolved_by_user_id = $3
        WHERE id = $1 AND status = 'PENDING'
          AND business_id = ANY($4::uuid[])
        RETURNING id, business_id, agent_id, payload_json`,
      [approvalId, user.email, user.id, user.businessIds],
    );
    const approval = rows[0];
    if (!approval) return null;

    const agent = await settleAgent(client, {
      agentId: approval.agent_id,
      businessId: approval.business_id,
      status: 'IDLE',
      message: 'Approved — dispatching',
    });

    await logAction(client, {
      businessId: approval.business_id,
      agentId: approval.agent_id,
      approvalId: approval.id,
      action: 'APPROVE_TASK',
      actor: user.email,
      actorUserId: user.id,
      detail: { agent_paused: agent === null, channel: approval.payload_json?.channel ?? null },
    });
    return approval;
  });

  if (!outcome) {
    const current = await readApproval(approvalId);
    if (!current) throw new HttpError(404, 'approval not found');
    assertInScope(user, current.business_id);
    throw new HttpError(409, `approval already ${current.status.toLowerCase()}`,
      { status: current.status });
  }

  // Dispatch happens only after the row is committed as APPROVED.
  const dispatch = await callWebhook(N8N_DISPATCH_WEBHOOK_URL, {
    approval_id: outcome.id,
    business_id: outcome.business_id,
    agent_id: outcome.agent_id,
    payload: outcome.payload_json,
  }, 'dispatch');

  res.json({ ok: true, approval_id: outcome.id, dispatch });
}));

// REJECT_TASK — replays the original request through n8n with the feedback and
// the draft that was turned down, so the model revises instead of starting over.
app.post('/api/approvals/:id/reject', wrap(async (req, res) => {
  const approvalId = assertUuid(req.params.id, 'approval_id');
  const user = req.user;
  const feedback = String(req.body?.feedback ?? '').trim();
  if (!feedback) throw new HttpError(400, 'feedback is required when rejecting');

  const outcome = await tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE approvals
          SET status = 'REJECTED', resolved_at = now(),
              resolved_by = $2, resolved_by_user_id = $3, feedback = $4
        WHERE id = $1 AND status = 'PENDING'
          AND business_id = ANY($5::uuid[])
        RETURNING id, business_id, agent_id, payload_json`,
      [approvalId, user.email, user.id, feedback, user.businessIds],
    );
    const approval = rows[0];
    if (!approval) return null;

    const agent = await settleAgent(client, {
      agentId: approval.agent_id,
      businessId: approval.business_id,
      status: 'WORKING',
      message: 'Revising after feedback',
    });

    await logAction(client, {
      businessId: approval.business_id,
      agentId: approval.agent_id,
      approvalId: approval.id,
      action: 'REJECT_TASK',
      actor: user.email,
      actorUserId: user.id,
      detail: { feedback, agent_paused: agent === null },
    });
    return { ...approval, retried: agent !== null };
  });

  if (!outcome) {
    const current = await readApproval(approvalId);
    if (!current) throw new HttpError(404, 'approval not found');
    assertInScope(user, current.business_id);
    throw new HttpError(409, `approval already ${current.status.toLowerCase()}`,
      { status: current.status });
  }

  // A paused agent gets no retry — PAUSED wins over the replay too.
  let retry = { ok: false, skipped: true, reason: 'agent paused' };
  if (outcome.retried) {
    const payload = outcome.payload_json ?? {};
    retry = await callWebhook(N8N_RETRY_WEBHOOK_URL, {
      ...(payload.source ?? {}),
      business_id: outcome.business_id,
      agent_id: outcome.agent_id,
      feedback,
      previous_draft: payload.draft ?? null,
      retry_of: outcome.id,
    }, 'retry');

    // If n8n never took the work, don't leave the desk spinning forever.
    if (!retry.ok) {
      await tx((client) => settleAgent(client, {
        agentId: outcome.agent_id,
        businessId: outcome.business_id,
        status: 'IDLE',
        message: 'Retry could not be queued',
      }));
    }
  }

  res.json({ ok: true, approval_id: outcome.id, retry });
}));

// KILL_SWITCH — pause wins unconditionally; resume only lifts a pause.
app.post('/api/agents/:id/kill', wrap(async (req, res) => {
  const agentId = assertUuid(req.params.id, 'agent_id');
  const resume = req.body?.resume === true;
  const user = req.user;

  const agent = await tx(async (client) => {
    const { rows } = resume
      ? await client.query(
          `UPDATE agents SET status = 'IDLE', last_message = 'Resumed by operator'
            WHERE id = $1 AND status = 'PAUSED' AND business_id = ANY($2::uuid[])
            RETURNING ${AGENT_COLUMNS}`, [agentId, user.businessIds])
      : await client.query(
          `UPDATE agents SET status = 'PAUSED', last_message = 'Paused by operator'
            WHERE id = $1 AND business_id = ANY($2::uuid[])
            RETURNING ${AGENT_COLUMNS}`, [agentId, user.businessIds]);
    const row = rows[0];
    if (!row) return null;

    await logAction(client, {
      businessId: row.business_id,
      agentId: row.id,
      action: 'KILL_SWITCH',
      actor: user.email,
      actorUserId: user.id,
      detail: { resume },
    });
    return row;
  });

  if (!agent) {
    const existing = await readAgent(agentId);
    if (!existing) throw new HttpError(404, 'agent not found');
    assertInScope(user, existing.business_id);
    throw new HttpError(409, resume ? 'agent is not paused' : 'agent could not be paused',
      { status: existing.status });
  }
  res.json({ ok: true, agent });
}));

// ---------------------------------------------------------- internal REST
// For n8n only. The browser never sends this header.

app.use('/api/internal', (req, _res, next) => {
  if (!secretsMatch(req.get('x-internal-token'), INTERNAL_TOKEN)) {
    return next(new HttpError(401, 'bad or missing x-internal-token'));
  }
  next();
});

/** Claim a desk for a run. 423 if the agent is paused, which aborts the run. */
app.post('/api/internal/agents/checkout', wrap(async (req, res) => {
  const { business_code: businessCode, department } = req.body ?? {};
  const businessId = req.body?.business_id;
  const message = req.body?.task ? String(req.body.task).slice(0, 500) : 'Working';
  if (!department) throw new HttpError(400, 'department is required');
  if (!businessId && !businessCode) {
    throw new HttpError(400, 'business_id or business_code is required');
  }
  if (businessId) assertUuid(businessId, 'business_id');

  const result = await tx(async (client) => {
    const { rows } = await client.query(
      `SELECT ag.id, ag.business_id, ag.status
         FROM agents ag JOIN businesses b ON b.id = ag.business_id
        WHERE ag.department = $1
          AND ($2::uuid IS NULL OR ag.business_id = $2::uuid)
          AND ($3::text IS NULL OR b.code = $3::text)
        FOR UPDATE OF ag`,
      [department, businessId ?? null, businessCode ?? null],
    );
    const target = rows[0];
    if (!target) return { notFound: true };
    if (target.status === 'PAUSED') return { paused: true, agentId: target.id };

    const { rows: updated } = await client.query(
      `UPDATE agents SET status = 'WORKING', last_message = $2
        WHERE id = $1 AND status <> 'PAUSED'
        RETURNING ${AGENT_COLUMNS}`,
      [target.id, message],
    );
    await logAction(client, {
      businessId: target.business_id,
      agentId: target.id,
      action: 'AGENT_CHECKOUT',
      actor: 'n8n',
      detail: { department, task: message },
    });
    return { agent: updated[0] };
  });

  if (result.notFound) throw new HttpError(404, 'no agent for that business and department');
  if (result.paused) {
    res.status(423).json({ ok: false, status: 'PAUSED', agent_id: result.agentId,
      error: 'agent is paused — abort this run' });
    return;
  }
  res.json({ ok: true, agent: result.agent });
}));

/** File a draft for human review. */
app.post('/api/internal/approvals', wrap(async (req, res) => {
  const agentId = assertUuid(req.body?.agent_id, 'agent_id');
  const payload = req.body?.payload ?? req.body?.payload_json;
  if (!payload || typeof payload !== 'object') {
    throw new HttpError(400, 'payload object is required');
  }
  if (!payload.draft) throw new HttpError(400, 'payload.draft is required');

  const result = await tx(async (client) => {
    const { rows: agents } = await client.query(
      `SELECT id, business_id, status FROM agents WHERE id = $1 FOR UPDATE`, [agentId]);
    const agent = agents[0];
    if (!agent) return { notFound: true };
    if (agent.status === 'PAUSED') return { paused: true };

    const { rows } = await client.query(
      `INSERT INTO approvals (business_id, agent_id, payload_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, business_id, agent_id, status, payload_json, created_at`,
      [agent.business_id, agent.id, JSON.stringify(payload)],
    );
    const approval = rows[0];

    await settleAgent(client, {
      agentId: agent.id,
      businessId: agent.business_id,
      status: 'AWAITING_APPROVAL',
      message: payload.title ? String(payload.title).slice(0, 500) : 'Awaiting approval',
    });
    await logAction(client, {
      businessId: agent.business_id,
      agentId: agent.id,
      approvalId: approval.id,
      action: 'DRAFT_SUBMITTED',
      actor: 'n8n',
      detail: { type: payload.type ?? null, channel: payload.channel ?? null },
    });
    return { approval };
  });

  if (result.notFound) throw new HttpError(404, 'agent not found');
  if (result.paused) {
    res.status(423).json({ ok: false, status: 'PAUSED',
      error: 'agent is paused — draft not filed' });
    return;
  }
  res.status(201).json({ ok: true, approval: result.approval });
}));

/** Release a desk without filing anything (run finished or failed). */
app.post('/api/internal/agents/:id/release', wrap(async (req, res) => {
  const agentId = assertUuid(req.params.id, 'agent_id');
  const status = req.body?.status ?? 'IDLE';
  if (!['IDLE', 'WORKING'].includes(status)) {
    throw new HttpError(400, 'status must be IDLE or WORKING');
  }
  const message = req.body?.message ? String(req.body.message).slice(0, 500) : null;

  const agent = await tx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, business_id FROM agents WHERE id = $1`, [agentId]);
    if (!rows[0]) return undefined;
    const settled = await settleAgent(client, {
      agentId, businessId: rows[0].business_id, status, message,
    });
    await logAction(client, {
      businessId: rows[0].business_id,
      agentId,
      action: 'AGENT_RELEASE',
      actor: 'n8n',
      detail: { status, agent_paused: settled === null, message },
    });
    return settled;
  });

  if (agent === undefined) throw new HttpError(404, 'agent not found');
  res.json({ ok: true, agent, paused: agent === null });
}));

// -------------------------------------------------------------- errors

app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ ok: false, error: err.message, detail: err.detail });
});

// ------------------------------------------------- realtime: NOTIFY -> UI

let listenerReady = false;

const stopListening = listen('office_events', async (event) => {
  try {
    if (event.entity === 'agent') {
      const agent = event.op === 'DELETE' ? null : await readAgent(event.id);
      broadcast(event.business_id, 'agent:update',
        agent ?? { id: event.id, business_id: event.business_id, deleted: true });
    } else if (event.entity === 'approval') {
      const approval = event.op === 'DELETE' ? null : await readApproval(event.id);
      broadcast(event.business_id, 'approval:update',
        approval ?? { id: event.id, business_id: event.business_id, deleted: true });
    } else if (event.entity === 'action_log') {
      const log = await readLog(event.id);
      if (log) broadcast(event.business_id, 'log:append', log);
    }
  } catch (err) {
    console.error('[realtime] could not fan out', event, err.message);
  }
}, {
  onReady: () => {
    listenerReady = true;
    // Anything that changed while we were disconnected is invisible to us, so
    // tell every client to refetch rather than guess.
    io.emit('resync', { reason: 'listener reconnected' });
  },
  onLost: (reason) => {
    listenerReady = false;
    io.emit('realtime:degraded', { reason });
  },
});

// Lapsed sessions are rejected on sight; this just stops the table growing.
const sessionSweep = setInterval(() => {
  purgeExpiredSessions().catch((err) => console.error('[auth] sweep failed:', err.message));
}, 60 * 60 * 1000);
sessionSweep.unref();

server.listen(PORT, process.env.BIND_HOST ?? '0.0.0.0', () => {
  console.log(`[api] virtual office backend on :${PORT}`);
});

async function shutdown(signal) {
  console.log(`[api] ${signal} — shutting down`);
  clearInterval(sessionSweep);
  io.close();
  server.close();
  await stopListening();
  await closePool();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
