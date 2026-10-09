// Virtual Office backend: REST for the dashboard and for n8n, plus a Socket.io
// fan-out driven entirely by Postgres NOTIFY. No route emits a socket event by
// hand — it writes the row, the trigger notifies, and the LISTEN handler below
// broadcasts whatever the database actually committed.
//
// Everything under /api (bar /api/health and /api/auth/*) needs a signed-in
// user, and the businesses that user belongs to are the only scope any query
// can run in. /api/internal/* is for n8n and carries a shared token instead.
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';
import {
  q, tx, listen, closePool,
  HttpError, assertUuid, businessClause,
} from './db.js';
import {
  encryptCredentials, decryptCredentials, describeCredentials,
  missingCredentials, REQUIRED_CREDENTIALS, credentialsKeyIsSet,
} from './secrets.js';
import {
  BUSINESS_LINES, BUSINESS_TYPES, businessLine, titlesFor, codeFromName,
} from './business-lines.js';
import { registerCommerce } from './commerce.js';
import { registerLive } from './live.js';
import {
  COOKIE_NAME, readCookie, resolveSession, requireUser, scopeFor,
  authenticate, createSession, destroySession, setSessionCookie,
  clearSessionCookie, secretsMatch, purgeExpiredSessions,
  roleFor, requireOwner, requirePlatformOwner, createUser, grantBusiness,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 4000);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const N8N_RETRY_WEBHOOK_URL = process.env.N8N_RETRY_WEBHOOK_URL ?? '';
const N8N_DISPATCH_WEBHOOK_URL = process.env.N8N_DISPATCH_WEBHOOK_URL ?? '';
const N8N_POST_SYNC_WEBHOOK_URL = process.env.N8N_POST_SYNC_WEBHOOK_URL ?? '';
const N8N_PRODUCT_SYNC_WEBHOOK_URL = process.env.N8N_PRODUCT_SYNC_WEBHOOK_URL ?? '';
const N8N_CHAT_WEBHOOK_URL = process.env.N8N_CHAT_WEBHOOK_URL ?? '';
const N8N_LIVE_WEBHOOK_URL = process.env.N8N_LIVE_WEBHOOK_URL ?? '';

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
    `SELECT ${AGENT_COLUMNS},
            COALESCE((
              SELECT json_agg(json_build_object(
                       'key', c.skill_key, 'name', c.name,
                       'summary', c.summary, 'enabled', s.enabled)
                     ORDER BY c.sort)
                FROM agent_skills s
                JOIN skill_catalogue c
                  ON c.skill_key = s.skill_key AND c.department = agents.department
               WHERE s.agent_id = agents.id
            ), '[]') AS skills
       FROM agents
      WHERE ${where.sql}
      ORDER BY business_id, desk_y, desk_x`,
    where.params,
  );
  return rows;
}

/** What this desk is currently asked to do. n8n builds its prompt from this. */
async function readEnabledSkills(agentId) {
  const { rows } = await q(
    `SELECT c.skill_key AS key, c.name, c.summary
       FROM agent_skills s
       JOIN agents a ON a.id = s.agent_id
       JOIN skill_catalogue c
         ON c.skill_key = s.skill_key AND c.department = a.department
      WHERE s.agent_id = $1 AND s.enabled
      ORDER BY c.sort`,
    [agentId],
  );
  return rows;
}

async function readAgent(id) {
  assertUuid(id, 'agent_id');
  const { rows } = await q(
    `SELECT ${AGENT_COLUMNS},
            COALESCE((
              SELECT json_agg(json_build_object(
                       'key', c.skill_key, 'name', c.name,
                       'summary', c.summary, 'enabled', s.enabled)
                     ORDER BY c.sort)
                FROM agent_skills s
                JOIN skill_catalogue c
                  ON c.skill_key = s.skill_key AND c.department = agents.department
               WHERE s.agent_id = agents.id
            ), '[]') AS skills
       FROM agents WHERE id = $1`, [id]);
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

/**
 * The check every /api/internal/* write makes before it writes: a suspended
 * business is closed to n8n the same way a paused agent is, so a run against
 * one aborts with 423 instead of quietly filing work nobody can act on.
 * Returns the body to send back, or null when the floor is open.
 */
async function internalGate(businessId) {
  const { rows } = await q(`SELECT is_active FROM businesses WHERE id = $1`, [businessId]);
  if (!rows[0]) throw new HttpError(404, 'business not found');
  if (rows[0].is_active) return null;
  return { ok: false, status: 'SUSPENDED',
    error: 'this business is suspended — abort this run' };
}

// ------------------------------------------------------- approval types
// Every kind of outbound work says in one place which workflow sends it,
// what that workflow needs handed to it, and how to put the rows back if it
// is turned down or nothing picks the job up. The gate itself — PENDING ->
// APPROVED, one guarded UPDATE — is the same for all of them, so it lives in
// the two routes below and nowhere else.
//
// A handler is { webhook, label, enrich, onDispatchFailed, onRejected }:
//   webhook()                 which n8n webhook to post to
//   enrich(payload)           extra fields that workflow needs
//   onDispatchFailed(payload) nothing took the job: stop showing 'sending'
//   onRejected(payload, fb)   a human said no; returns what to tell them
// A kind with an onRejected is not replayed through the model, because there
// is nothing to revise — the answer was no.
const approvalTypes = new Map();

function registerApprovalType(type, handler) {
  approvalTypes.set(type, handler);
}

const handlerFor = (payload) => approvalTypes.get(payload?.type) ?? null;

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
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isPlatformOwner: user.isPlatformOwner === true,
    roles: user.roles ?? {},
  };
}

/**
 * Open a floor: the row, its ten desks with their skills, its payment rules,
 * and the role titles that suit the trade. Both the owner's "add a business"
 * and the operator's portal come through here, so every office is laid out
 * and provisioned the same way whoever asked for it.
 */
async function openFloor(client, { code, name, businessType, timezone, currency, createdBy }) {
  const { rows } = await client.query(
    `INSERT INTO businesses (code, name, business_type, timezone, currency, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, code, name, business_type, timezone, currency, is_active, created_at`,
    [code, name, businessType, timezone, currency, createdBy],
  );
  const business = rows[0];
  await client.query('SELECT provision_business_agents($1)', [business.id]);

  // Same desks, named for the trade. The departments do not change, so every
  // rule, workflow and filter that keys off a department still works.
  const titles = titlesFor(businessType);
  for (const [department, title] of Object.entries(titles)) {
    await client.query(
      `UPDATE agents SET role_title = $3, name = $3
        WHERE business_id = $1 AND department = $2`,
      [business.id, department, title],
    );
  }
  return business;
}

async function readBusinesses(user) {
  // The tenant key on this table is `id`, not `business_id`.
  const where = businessClause(user.businessIds ?? [], { column: 'id' });
  const { rows } = await q(
    `SELECT id, code, name, business_type, timezone, currency FROM businesses
      WHERE ${where.sql} AND is_active ORDER BY name`,
    where.params,
  );
  return rows.map((b) => ({ ...b, role: roleFor(user, b.id) }));
}

// Everything below needs a session.
app.use('/api/businesses', requireUser);
app.use('/api/agents', requireUser);
app.use('/api/approvals', requireUser);
app.use('/api/action-logs', requireUser);
app.use('/api/state', requireUser);

// ------------------------------------------------------------ public REST

/**
 * Open another office. An owner of one floor may start another — a second
 * line of business is their decision, not the platform operator's — and they
 * own what they opened. The new floor is a tenant like any other: its own
 * desks, its own catalogue, its own accounts, and nothing of it visible from
 * the floor it was started from except that the same person can switch to it.
 *
 * The platform operator still sees it in the portal, because watching every
 * floor is that account's job; it still cannot read a word of its work.
 */
app.post('/api/businesses', wrap(async (req, res) => {
  // Being an owner somewhere is what earns this. A reviewer cannot open a
  // floor, and neither can the operator — holding no membership, it would be
  // opening an office it could not then read.
  const ownsSomething = (req.user.businessIds ?? [])
    .some((id) => roleFor(req.user, id) === 'owner');
  if (!ownsSomething) {
    throw new HttpError(403, 'only the owner of an office can open another one');
  }

  const name = String(req.body?.name ?? '').trim();
  if (name.length < 2) throw new HttpError(400, 'give the office a name');
  if (name.length > 120) throw new HttpError(400, 'that name is too long');
  const businessType = String(req.body?.business_type ?? 'general');
  if (!BUSINESS_TYPES.includes(businessType)) throw new HttpError(400, 'unknown business line');
  const timezone = String(req.body?.timezone ?? 'Asia/Manila');
  const currency = String(req.body?.currency ?? 'PHP').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a 3-letter code');

  // The code is derived rather than asked for; a clash just takes the next one.
  let business = null;
  let lastError = null;
  for (let attempt = 0; attempt < 12 && !business; attempt += 1) {
    const code = codeFromName(name, attempt);
    try {
      business = await tx(async (client) => {
        const opened = await openFloor(client, {
          code, name, businessType, timezone, currency, createdBy: req.user.id,
        });
        await client.query(
          `INSERT INTO user_businesses (user_id, business_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (user_id, business_id) DO UPDATE SET role = 'owner'`,
          [req.user.id, opened.id],
        );
        await logAction(client, {
          businessId: opened.id,
          action: 'BUSINESS_OPENED',
          actor: req.user.email,
          actorUserId: req.user.id,
          detail: { code: opened.code, business_type: businessType, name },
        });
        return opened;
      });
    } catch (err) {
      if (err.code !== '23505') throw err;
      lastError = err;
    }
  }
  if (!business) {
    throw new HttpError(409, 'could not find a free code for that name', { detail: lastError?.detail });
  }

  // REST picks the new floor up on the next request — scope is read from the
  // database each time — but the socket joined its rooms when it connected
  // and knows nothing of it, so the client is told to reconnect.
  res.status(201).json({
    ok: true,
    business: { ...business, role: 'owner' },
    line: businessLine(businessType),
    reconnect: true,
  });
}));

/** The lines of business a floor can be opened for, for the picker. */
app.get('/api/business-lines', requireUser, wrap(async (_req, res) => {
  res.json({ lines: BUSINESS_LINES.map(({ key, label, blurb }) => ({ key, label, blurb })) });
}));

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

  // Dispatch happens only after the row is committed as APPROVED, and which
  // workflow it goes to is the registered kind's business, not this route's.
  const payload = outcome.payload_json ?? {};
  const handler = handlerFor(payload);
  const target = handler?.webhook?.() ?? N8N_DISPATCH_WEBHOOK_URL;
  const extra = handler?.enrich ? await handler.enrich(payload) : {};
  const dispatch = await callWebhook(target, {
    approval_id: outcome.id,
    business_id: outcome.business_id,
    agent_id: outcome.agent_id,
    payload,
    ...extra,
  }, handler?.label ?? 'dispatch');

  // Nothing took the job, so the platforms are not going to change. Clear
  // whatever was showing as on its way, or it reads as sent forever.
  if (!dispatch.ok && handler?.onDispatchFailed) {
    await Promise.resolve(handler.onDispatchFailed(payload, 'the job could not be queued'))
      .catch((err) => console.error(`[${payload.type}] rollback failed:`, err.message));
  }

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

    // A kind that handles its own rejection has nothing to revise, so its
    // desk goes back to idle rather than sitting at WORKING waiting for a
    // revision that is never coming.
    const handled = Boolean(handlerFor(approval.payload_json)?.onRejected);
    const agent = await settleAgent(client, {
      agentId: approval.agent_id,
      businessId: approval.business_id,
      status: handled ? 'IDLE' : 'WORKING',
      message: handled ? 'Turned down' : 'Revising after feedback',
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

  // A kind that knows what its own no means puts its rows back and says so.
  // Nothing was ever sent, so there is nothing out there to undo.
  const payload = outcome.payload_json ?? {};
  const handler = handlerFor(payload);
  if (handler?.onRejected) {
    const said = await Promise.resolve(handler.onRejected(payload, feedback))
      .catch((err) => {
        console.error(`[${payload.type}] rollback failed:`, err.message);
        return { rollback: 'failed' };
      });
    res.json({ ok: true, approval_id: outcome.id, ...(said ?? {}) });
    return;
  }

  // A paused agent gets no retry — PAUSED wins over the replay too.
  let retry = { ok: false, skipped: true, reason: 'agent paused' };
  if (outcome.retried) {
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

  // Reviewers decide on drafts; only an owner switches a desk off. Checked
  // against the agent's own business, before anything is written.
  const existing = await readAgent(agentId);
  if (!existing) throw new HttpError(404, 'agent not found');
  requireOwner(user, existing.business_id);

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
    throw new HttpError(409, resume ? 'agent is not paused' : 'agent could not be paused',
      { status: existing.status });
  }
  res.json({ ok: true, agent });
}));


/** Switch one of a desk's skills on or off. Owners only. */
app.patch('/api/agents/:id/skills/:key', wrap(async (req, res) => {
  const agentId = assertUuid(req.params.id, 'agent_id');
  const skillKey = String(req.params.key);
  if (typeof req.body?.enabled !== 'boolean') {
    throw new HttpError(400, 'enabled must be true or false');
  }
  const agent = await readAgent(agentId);
  if (!agent) throw new HttpError(404, 'agent not found');
  requireOwner(req.user, agent.business_id);

  const updated = await tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE agent_skills SET enabled = $3, updated_at = now()
        WHERE agent_id = $1 AND skill_key = $2
        RETURNING skill_key, enabled`,
      [agentId, skillKey, req.body.enabled],
    );
    if (!rows[0]) return null;
    await logAction(client, {
      businessId: agent.business_id,
      agentId,
      action: req.body.enabled ? 'SKILL_ENABLED' : 'SKILL_DISABLED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { skill: skillKey },
    });
    return rows[0];
  });

  if (!updated) throw new HttpError(404, 'this agent does not have that skill');
  res.json({ ok: true, skill: updated, agent: await readAgent(agentId) });
}));


// --------------------------------------------------- connected accounts
// A business may hold several accounts on the same platform. Each is
// connected, labelled and synced on its own, and its credentials never leave
// the server.

const ACCOUNT_COLUMNS = `
  a.id, a.business_id, a.platform, a.label, a.external_id, a.region,
  a.sync_enabled, a.last_synced_at, a.last_error, a.created_at, a.credentials`;

function publicAccount(row) {
  const { credentials, ...rest } = row;
  return { ...rest, credentials: describeCredentials(credentials) };
}

async function readAccounts(scope, { platform } = {}) {
  const where = businessClause(scope, { column: 'a.business_id' });
  const params = [...where.params];
  let platformSql = '';
  if (platform && platform !== 'all') {
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'unknown platform');
    params.push(platform);
    platformSql = ` AND a.platform = $${params.length}`;
  }
  const { rows } = await q(
    `SELECT ${ACCOUNT_COLUMNS} FROM platform_accounts a
      WHERE ${where.sql}${platformSql}
      ORDER BY a.platform, a.label`,
    params,
  );
  return rows.map(publicAccount);
}

async function readAccountRow(id) {
  assertUuid(id, 'account_id');
  const { rows } = await q(
    `SELECT ${ACCOUNT_COLUMNS} FROM platform_accounts a WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

app.use('/api/accounts', requireUser);

app.get('/api/accounts', wrap(async (req, res) => {
  res.json({
    platforms: PLATFORMS,
    required: REQUIRED_CREDENTIALS,
    key_configured: credentialsKeyIsSet(),
    accounts: await readAccounts(scopeFor(req.user, req.query.business_id), {
      platform: req.query.platform,
    }),
  });
}));

/** Connect a seller account. Owners only — these are keys to a real shop. */
app.post('/api/accounts', wrap(async (req, res) => {
  const businessId = assertUuid(req.body?.business_id, 'business_id');
  requireOwner(req.user, businessId);

  const platform = req.body?.platform;
  if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'unknown platform');
  const label = String(req.body?.label ?? '').trim();
  if (label.length < 2) throw new HttpError(400, 'give the account a name you will recognise');

  const credentials = req.body?.credentials ?? {};
  if (typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new HttpError(400, 'credentials must be an object');
  }
  const missing = missingCredentials(platform, credentials);
  if (missing.length) {
    throw new HttpError(400, `${platform} also needs: ${missing.join(', ')}`);
  }

  const account = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO platform_accounts
         (business_id, platform, label, external_id, region, credentials)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ACCOUNT_COLUMNS.replaceAll('a.', '')}`,
      [businessId, platform, label,
       req.body?.external_id ?? credentials.shop_id ?? credentials.seller_id ?? null,
       req.body?.region ?? 'PH',
       encryptCredentials(credentials)],
    );
    await logAction(client, {
      businessId,
      action: 'ACCOUNT_CONNECTED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { platform, label },
    });
    return rows[0];
  }).catch((err) => {
    if (err.code === '23505') {
      throw new HttpError(409, 'that account is already connected to this business');
    }
    throw err;
  });

  res.status(201).json({ ok: true, account: publicAccount(account) });
}));

/** Rename it, pause its sync, or replace its credentials. */
app.patch('/api/accounts/:id', wrap(async (req, res) => {
  const accountId = assertUuid(req.params.id, 'account_id');
  const existing = await readAccountRow(accountId);
  if (!existing) throw new HttpError(404, 'account not found');
  requireOwner(req.user, existing.business_id);

  const sets = [];
  const params = [accountId];
  const push = (sql, value) => { params.push(value); sets.push(`${sql} = $${params.length}`); };

  if (req.body?.label !== undefined) {
    const label = String(req.body.label).trim();
    if (label.length < 2) throw new HttpError(400, 'give the account a name you will recognise');
    push('label', label);
  }
  if (req.body?.sync_enabled !== undefined) {
    if (typeof req.body.sync_enabled !== 'boolean') {
      throw new HttpError(400, 'sync_enabled must be true or false');
    }
    push('sync_enabled', req.body.sync_enabled);
  }
  if (req.body?.region !== undefined) push('region', String(req.body.region));
  if (req.body?.credentials !== undefined) {
    const merged = { ...(decryptCredentials(existing.credentials) ?? {}), ...req.body.credentials };
    const missing = missingCredentials(existing.platform, merged);
    if (missing.length) {
      throw new HttpError(400, `${existing.platform} also needs: ${missing.join(', ')}`);
    }
    push('credentials', encryptCredentials(merged));
    push('last_error', null);
  }
  if (!sets.length) throw new HttpError(400, 'nothing to change');

  const account = await tx(async (client) => {
    const { rows } = await client.query(
      `UPDATE platform_accounts SET ${sets.join(', ')} WHERE id = $1
       RETURNING ${ACCOUNT_COLUMNS.replaceAll('a.', '')}`,
      params,
    );
    await logAction(client, {
      businessId: existing.business_id,
      action: req.body?.sync_enabled === false ? 'ACCOUNT_SYNC_PAUSED' : 'ACCOUNT_UPDATED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: {
        platform: existing.platform,
        changed: Object.keys(req.body ?? {}).filter((k) => k !== 'credentials')
          .concat(req.body?.credentials ? ['credentials'] : []),
      },
    });
    return rows[0];
  });

  res.json({ ok: true, account: publicAccount(account) });
}));

app.delete('/api/accounts/:id', wrap(async (req, res) => {
  const accountId = assertUuid(req.params.id, 'account_id');
  const existing = await readAccountRow(accountId);
  if (!existing) throw new HttpError(404, 'account not found');
  requireOwner(req.user, existing.business_id);

  await tx(async (client) => {
    await client.query('DELETE FROM platform_accounts WHERE id = $1', [accountId]);
    await logAction(client, {
      businessId: existing.business_id,
      action: 'ACCOUNT_DISCONNECTED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { platform: existing.platform, label: existing.label },
    });
  });
  res.json({ ok: true });
}));

// ------------------------------------------------------------ social posts
// Posts live here and are copied out to the platforms. Editing one never goes
// straight out: it files an approval like any other outbound work, and only
// the dispatch workflow pushes the change once a human has said yes.

const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'shopee', 'lazada', 'x'];

const POST_COLUMNS = `
  p.id, p.business_id, p.agent_id, p.title, p.body, p.media_url,
  p.status, p.created_at, p.updated_at,
  COALESCE((
    SELECT json_agg(json_build_object(
             'platform', t.platform, 'external_id', t.external_id,
             'state', t.state, 'last_synced_at', t.last_synced_at,
             'last_error', t.last_error) ORDER BY t.platform)
      FROM social_post_targets t WHERE t.post_id = p.id
  ), '[]') AS targets`;

async function readPosts(scope, { platform, limit = 100 } = {}) {
  const where = businessClause(scope, { column: 'p.business_id' });
  const params = [...where.params];
  let platformSql = '';
  if (platform && platform !== 'all') {
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'unknown platform');
    params.push(platform);
    // Filtering by platform means "posts that go to this platform", so the
    // list never mixes channels together.
    platformSql = ` AND EXISTS (SELECT 1 FROM social_post_targets t2
                                 WHERE t2.post_id = p.id AND t2.platform = $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 100, 200));
  const { rows } = await q(
    `SELECT ${POST_COLUMNS} FROM social_posts p
      WHERE ${where.sql}${platformSql}
      ORDER BY p.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function readPost(id) {
  assertUuid(id, 'post_id');
  const { rows } = await q(
    `SELECT ${POST_COLUMNS} FROM social_posts p WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}

app.use('/api/posts', requireUser);

app.get('/api/posts', wrap(async (req, res) => {
  res.json({
    platforms: PLATFORMS,
    posts: await readPosts(scopeFor(req.user, req.query.business_id), {
      platform: req.query.platform,
      limit: req.query.limit,
    }),
  });
}));

app.get('/api/posts/:id', wrap(async (req, res) => {
  const post = await readPost(req.params.id);
  if (!post) throw new HttpError(404, 'post not found');
  assertInScope(req.user, post.business_id);
  res.json(post);
}));

/**
 * Edit a post. This does not touch any platform — it files an approval
 * carrying the new text and the platforms it would go to. Approving it is what
 * sends the update out.
 */
app.patch('/api/posts/:id', wrap(async (req, res) => {
  const postId = assertUuid(req.params.id, 'post_id');
  const user = req.user;
  const title = req.body?.title == null ? null : String(req.body.title).trim();
  const body = req.body?.body == null ? null : String(req.body.body).trim();
  const platforms = req.body?.platforms;
  if (body !== null && !body) throw new HttpError(400, 'body cannot be empty');
  if (platforms !== undefined) {
    if (!Array.isArray(platforms) || !platforms.length) {
      throw new HttpError(400, 'platforms must be a non-empty list');
    }
    for (const p of platforms) {
      if (!PLATFORMS.includes(p)) throw new HttpError(400, `unknown platform: ${p}`);
    }
  }

  const existing = await readPost(postId);
  if (!existing) throw new HttpError(404, 'post not found');
  assertInScope(user, existing.business_id);

  const nextTitle = title ?? existing.title;
  const nextBody = body ?? existing.body;
  const targets = platforms ?? existing.targets.map((t) => t.platform);
  const live = existing.targets.filter((t) => t.state === 'PUBLISHED');

  // A post that has never been published anywhere is just a draft: save it.
  if (!live.length) {
    const saved = await tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE social_posts SET title = $2, body = $3 WHERE id = $1 RETURNING id`,
        [postId, nextTitle, nextBody],
      );
      await syncTargets(client, postId, targets);
      await logAction(client, {
        businessId: existing.business_id,
        agentId: existing.agent_id,
        action: 'POST_EDITED',
        actor: user.email,
        actorUserId: user.id,
        detail: { platforms: targets },
      });
      return rows[0];
    });
    res.json({ ok: true, published: false, post: await readPost(saved.id) });
    return;
  }

  // It is live somewhere, so the change needs approving before it goes out.
  const approval = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO approvals (business_id, agent_id, payload_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, business_id, agent_id, status, payload_json, created_at`,
      [existing.business_id, existing.agent_id, JSON.stringify({
        type: 'post_update',
        title: `Update "${existing.title}" on ${targets.join(', ')}`,
        draft: nextBody,
        channel: targets[0],
        post_id: postId,
        platforms: targets,
        previous_body: existing.body,
        source: { post_id: postId, edited_by: user.email },
      })],
    );
    await client.query(
      `UPDATE social_posts SET status = 'PENDING_UPDATE' WHERE id = $1`, [postId]);
    await client.query(
      `UPDATE social_post_targets SET state = 'UPDATE_PENDING'
        WHERE post_id = $1 AND platform = ANY($2::text[]) AND state = 'PUBLISHED'`,
      [postId, targets],
    );
    if (existing.agent_id) {
      await settleAgent(client, {
        agentId: existing.agent_id,
        businessId: existing.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Post update waiting: ${existing.title}`.slice(0, 500),
      });
    }
    await logAction(client, {
      businessId: existing.business_id,
      agentId: existing.agent_id,
      approvalId: rows[0].id,
      action: 'POST_UPDATE_SUBMITTED',
      actor: user.email,
      actorUserId: user.id,
      detail: { post_id: postId, platforms: targets },
    });
    return rows[0];
  });

  res.json({ ok: true, published: false, needs_approval: true, approval_id: approval.id });
}));

/**
 * Put a post on the platforms it is not on yet. Like an edit, this does not
 * touch anything outside: it files an approval, and approving is what sends.
 */
app.post('/api/posts/:id/publish', wrap(async (req, res) => {
  const postId = assertUuid(req.params.id, 'post_id');
  const user = req.user;
  const post = await readPost(postId);
  if (!post) throw new HttpError(404, 'post not found');
  assertInScope(user, post.business_id);

  const asked = req.body?.platforms;
  if (asked !== undefined) {
    if (!Array.isArray(asked) || !asked.length) {
      throw new HttpError(400, 'platforms must be a non-empty list');
    }
    for (const p of asked) {
      if (!PLATFORMS.includes(p)) throw new HttpError(400, `unknown platform: ${p}`);
    }
  }

  const pending = post.targets
    .filter((t) => ['NOT_PUBLISHED', 'FAILED'].includes(t.state))
    .filter((t) => !asked || asked.includes(t.platform))
    .map((t) => t.platform);
  if (!pending.length) {
    throw new HttpError(409, 'every platform you asked for already has this post');
  }

  const approval = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO approvals (business_id, agent_id, payload_json)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [post.business_id, post.agent_id, JSON.stringify({
        type: 'post_publish',
        title: `Publish "${post.title}" to ${pending.join(', ')}`,
        draft: post.body,
        channel: pending[0],
        post_id: postId,
        platforms: pending,
        source: { post_id: postId, requested_by: user.email },
      })],
    );
    await client.query(
      `UPDATE social_post_targets SET state = 'PUBLISH_PENDING', last_error = NULL
        WHERE post_id = $1 AND platform = ANY($2::text[])`,
      [postId, pending],
    );
    if (post.agent_id) {
      await settleAgent(client, {
        agentId: post.agent_id,
        businessId: post.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Post waiting to go out: ${post.title}`.slice(0, 500),
      });
    }
    await logAction(client, {
      businessId: post.business_id,
      agentId: post.agent_id,
      approvalId: rows[0].id,
      action: 'POST_PUBLISH_SUBMITTED',
      actor: user.email,
      actorUserId: user.id,
      detail: { post_id: postId, platforms: pending },
    });
    return rows[0];
  });

  res.json({ ok: true, needs_approval: true, approval_id: approval.id, platforms: pending });
}));

/** Keep the target rows matching the platforms the post should go to. */
async function syncTargets(client, postId, platforms) {
  await client.query(
    `DELETE FROM social_post_targets
      WHERE post_id = $1 AND NOT (platform = ANY($2::text[])) AND state <> 'PUBLISHED'`,
    [postId, platforms],
  );
  for (const platform of platforms) {
    await client.query(
      `INSERT INTO social_post_targets (post_id, platform)
       VALUES ($1, $2) ON CONFLICT (post_id, platform) DO NOTHING`,
      [postId, platform],
    );
  }
}


// ------------------------------------------------------------- products
// The business's catalogue. A product is written here and listed on whichever
// connected accounts its owner picks — two Shopee shops and a Lazada account
// are three separate listings of the same product.

const PRODUCT_COLUMNS = `
  p.id, p.business_id, p.sku, p.name, p.description, p.price, p.currency,
  p.stock, p.weight_kg, p.images, p.platform_meta, p.status,
  p.created_at, p.updated_at,
  COALESCE((
    SELECT json_agg(json_build_object(
             'account_id', l.account_id, 'platform', acc.platform,
             'label', acc.label, 'external_id', l.external_id,
             'state', l.state, 'last_synced_at', l.last_synced_at,
             'last_error', l.last_error) ORDER BY acc.platform, acc.label)
      FROM product_listings l
      JOIN platform_accounts acc ON acc.id = l.account_id
     WHERE l.product_id = p.id
  ), '[]') AS listings`;

async function readProducts(scope, { platform, accountId, limit = 100 } = {}) {
  const where = businessClause(scope, { column: 'p.business_id' });
  const params = [...where.params];
  let filterSql = '';
  if (accountId) {
    assertUuid(accountId, 'account_id');
    params.push(accountId);
    filterSql = ` AND EXISTS (SELECT 1 FROM product_listings l2
                               WHERE l2.product_id = p.id AND l2.account_id = $${params.length})`;
  } else if (platform && platform !== 'all') {
    if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'unknown platform');
    params.push(platform);
    filterSql = ` AND EXISTS (SELECT 1 FROM product_listings l2
                               JOIN platform_accounts a2 ON a2.id = l2.account_id
                              WHERE l2.product_id = p.id AND a2.platform = $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 100, 200));
  const { rows } = await q(
    `SELECT ${PRODUCT_COLUMNS} FROM products p
      WHERE ${where.sql}${filterSql}
      ORDER BY p.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Which desk owns a piece of catalogue work. Inventory keeps the stock, so a
 * listing belongs to that desk; any desk will do if a floor is missing one,
 * because every approval has to sit somewhere a person can click it.
 */
async function deskFor(businessId, department = 'Inventory') {
  const { rows } = await q(
    `SELECT id FROM agents
      WHERE business_id = $1
      ORDER BY (department = $2) DESC, desk_y, desk_x
      LIMIT 1`,
    [businessId, department],
  );
  if (!rows[0]) throw new HttpError(409, 'this business has no desks to put the work on');
  return rows[0].id;
}

async function readProduct(id) {
  assertUuid(id, 'product_id');
  const { rows } = await q(
    `SELECT ${PRODUCT_COLUMNS} FROM products p WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}

function readProductBody(body, { partial = false } = {}) {
  const out = {};
  const need = (name, value) => {
    if (value === undefined) {
      if (partial) return;
      throw new HttpError(400, `${name} is required`);
    }
    out[name] = value;
  };
  if (body?.sku !== undefined || !partial) {
    const sku = String(body?.sku ?? '').trim();
    if (!/^[A-Za-z0-9._-]{2,48}$/.test(sku)) {
      throw new HttpError(400, 'sku must be 2-48 characters: letters, numbers, . _ -');
    }
    out.sku = sku;
  }
  if (body?.name !== undefined || !partial) {
    const name = String(body?.name ?? '').trim();
    if (name.length < 2) throw new HttpError(400, 'name is required');
    out.name = name;
  }
  if (body?.description !== undefined) out.description = String(body.description);
  if (body?.price !== undefined || !partial) {
    const price = Number(body?.price);
    if (!Number.isFinite(price) || price < 0) throw new HttpError(400, 'price must be a number');
    out.price = price;
  }
  if (body?.currency !== undefined) {
    const currency = String(body.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a 3-letter code');
    out.currency = currency;
  }
  if (body?.stock !== undefined) {
    const stock = Number(body.stock);
    if (!Number.isInteger(stock) || stock < 0) throw new HttpError(400, 'stock must be a whole number');
    out.stock = stock;
  }
  if (body?.weight_kg !== undefined) {
    const weight = Number(body.weight_kg);
    // Every marketplace prices shipping off this, so it cannot be zero.
    if (!Number.isFinite(weight) || weight <= 0) throw new HttpError(400, 'weight_kg must be above zero');
    out.weight_kg = weight;
  }
  if (body?.images !== undefined) {
    if (!Array.isArray(body.images)) throw new HttpError(400, 'images must be a list of urls');
    out.images = body.images.map((u) => String(u));
  }
  if (body?.platform_meta !== undefined) {
    if (typeof body.platform_meta !== 'object' || Array.isArray(body.platform_meta)) {
      throw new HttpError(400, 'platform_meta must be an object keyed by platform');
    }
    out.platform_meta = body.platform_meta;
  }
  void need;
  return out;
}

app.use('/api/products', requireUser);

app.get('/api/products', wrap(async (req, res) => {
  const scope = scopeFor(req.user, req.query.business_id);
  res.json({
    platforms: PLATFORMS,
    accounts: await readAccounts(scope),
    products: await readProducts(scope, {
      platform: req.query.platform,
      accountId: req.query.account_id,
      limit: req.query.limit,
    }),
  });
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const product = await readProduct(req.params.id);
  if (!product) throw new HttpError(404, 'product not found');
  assertInScope(req.user, product.business_id);
  res.json(product);
}));

app.post('/api/products', wrap(async (req, res) => {
  const businessId = assertUuid(req.body?.business_id, 'business_id');
  assertInScope(req.user, businessId);
  // The catalogue is what the business sells and what it sells it for, so
  // writing to it is an owner's job. A reviewer still sees all of it and
  // still approves what goes out; they just do not set the price.
  requireOwner(req.user, businessId);
  const fields = readProductBody(req.body);

  const product = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products
         (business_id, sku, name, description, price, currency, stock, weight_kg, images, platform_meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
       RETURNING id`,
      [businessId, fields.sku, fields.name, fields.description ?? '',
       fields.price, fields.currency ?? 'PHP', fields.stock ?? 0,
       fields.weight_kg ?? 0.5, JSON.stringify(fields.images ?? []),
       JSON.stringify(fields.platform_meta ?? {})],
    );
    await logAction(client, {
      businessId,
      action: 'PRODUCT_CREATED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { sku: fields.sku },
    });
    return rows[0];
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, `sku ${fields.sku} already exists here`);
    throw err;
  });

  res.status(201).json({ ok: true, product: await readProduct(product.id) });
}));

/**
 * Edit a product. Anything already listed somewhere needs approving before the
 * change reaches a marketplace; the copy here is updated either way, because
 * this app is where the catalogue lives.
 */
app.patch('/api/products/:id', wrap(async (req, res) => {
  const productId = assertUuid(req.params.id, 'product_id');
  const existing = await readProduct(productId);
  if (!existing) throw new HttpError(404, 'product not found');
  assertInScope(req.user, existing.business_id);
  requireOwner(req.user, existing.business_id);
  const fields = readProductBody(req.body, { partial: true });
  if (!Object.keys(fields).length) throw new HttpError(400, 'nothing to change');

  // What actually changed, in words, so the person approving a price cut sees
  // the old number next to the new one instead of just the new one.
  const changes = Object.entries(fields)
    .filter(([name]) => !['images', 'platform_meta'].includes(name))
    .map(([name, value]) => {
      const was = existing[name];
      return String(was) === String(value) ? null : `${name}: ${was} -> ${value}`;
    })
    .filter(Boolean);

  const sets = [];
  const params = [productId];
  for (const [name, value] of Object.entries(fields)) {
    params.push(['images', 'platform_meta'].includes(name) ? JSON.stringify(value) : value);
    sets.push(`${name} = $${params.length}${['images', 'platform_meta'].includes(name) ? '::jsonb' : ''}`);
  }

  const live = existing.listings.filter((l) => l.state === 'LISTED');
  const deskId = live.length ? await deskFor(existing.business_id) : null;

  const result = await tx(async (client) => {
    await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, params);
    if (!live.length) {
      await logAction(client, {
        businessId: existing.business_id,
        action: 'PRODUCT_EDITED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { sku: existing.sku, changes },
      });
      return { approvalId: null };
    }

    const { rows } = await client.query(
      `INSERT INTO approvals (business_id, agent_id, payload_json)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [existing.business_id, deskId, JSON.stringify({
        type: 'product_update',
        title: `Update "${existing.name}" on ${live.map((l) => l.label).join(', ')}`,
        draft: `${fields.name ?? existing.name} — ${fields.currency ?? existing.currency} ${fields.price ?? existing.price}, `
             + `${fields.stock ?? existing.stock} in stock\n\n`
             + (changes.length ? `Changing:\n${changes.join('\n')}\n\n` : '')
             + `${fields.description ?? existing.description}`,
        channel: live[0].platform,
        product_id: productId,
        account_ids: live.map((l) => l.account_id),
        fields: Object.keys(fields),
        source: { product_id: productId, edited_by: req.user.email },
      })],
    );
    await client.query(
      `UPDATE product_listings SET state = 'UPDATE_PENDING'
        WHERE product_id = $1 AND account_id = ANY($2::uuid[]) AND state = 'LISTED'`,
      [productId, live.map((l) => l.account_id)],
    );
    await settleAgent(client, {
      agentId: deskId,
      businessId: existing.business_id,
      status: 'AWAITING_APPROVAL',
      message: `Catalogue update waiting: ${existing.name}`.slice(0, 500),
    });
    await logAction(client, {
      businessId: existing.business_id,
      agentId: deskId,
      approvalId: rows[0].id,
      action: 'PRODUCT_UPDATE_SUBMITTED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { sku: existing.sku, accounts: live.length, changes },
    });
    return { approvalId: rows[0].id };
  });

  res.json({
    ok: true,
    needs_approval: result.approvalId !== null,
    approval_id: result.approvalId,
    product: await readProduct(productId),
  });
}));

/**
 * Delete a product. Taking a listing down is itself something a marketplace
 * sees, so a product that is live somewhere cannot simply vanish from here:
 * the delist is filed, the shops are told, and the row goes when they have
 * all answered. A product that is live nowhere is just a row, and goes now.
 *
 * Stock is not a reason to refuse — a shop stops selling things it still has
 * — but an unpaid order against it is, because deleting the product would
 * leave that order pointing at nothing.
 */
app.delete('/api/products/:id', wrap(async (req, res) => {
  const productId = assertUuid(req.params.id, 'product_id');
  const existing = await readProduct(productId);
  if (!existing) throw new HttpError(404, 'product not found');
  assertInScope(req.user, existing.business_id);
  requireOwner(req.user, existing.business_id);

  const { rows: owed } = await q(
    `SELECT count(*)::int AS open FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE i.product_id = $1 AND o.status IN ('UNPAID','PAID','READY_TO_SHIP','SHIPPED')`,
    [productId]);
  if (owed[0].open > 0) {
    throw new HttpError(409,
      `${owed[0].open} order(s) are still open against ${existing.sku} — finish or cancel them first`);
  }
  const { rows: held } = await q(
    `SELECT count(*)::int AS held FROM live_claims c
       JOIN live_basket_items b ON b.id = c.basket_item_id
      WHERE b.product_id = $1 AND c.status IN ('HELD','CHECKOUT_SENT')`,
    [productId]);
  if (held[0].held > 0) {
    throw new HttpError(409,
      `${held[0].held} live claim(s) are holding ${existing.sku} — let them run out first`);
  }

  const live = existing.listings.filter((l) => ['LISTED', 'UPDATE_PENDING'].includes(l.state));
  if (!live.length) {
    await tx(async (client) => {
      await client.query(`DELETE FROM products WHERE id = $1 AND business_id = ANY($2::uuid[])`,
        [productId, req.user.businessIds]);
      await logAction(client, {
        businessId: existing.business_id,
        action: 'PRODUCT_DELETED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { sku: existing.sku, name: existing.name },
      });
    });
    res.json({ ok: true, deleted: true });
    return;
  }

  const deskId = await deskFor(existing.business_id);
  const approval = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO approvals (business_id, agent_id, payload_json)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [existing.business_id, deskId, JSON.stringify({
        type: 'product_delist',
        title: `Take "${existing.name}" off ${live.map((l) => l.label).join(', ')}`,
        draft: `${existing.name} (${existing.sku}) comes down from `
             + `${live.map((l) => l.label).join(', ')} and is deleted from the catalogue here.\n\n`
             + `${existing.stock} are still on the shelf.`,
        channel: live[0].platform,
        product_id: productId,
        account_ids: live.map((l) => l.account_id),
        delete_after: true,
        source: { product_id: productId, requested_by: req.user.email },
      })],
    );
    await client.query(
      `UPDATE product_listings SET state = 'UPDATE_PENDING', last_error = NULL
        WHERE product_id = $1 AND account_id = ANY($2::uuid[])`,
      [productId, live.map((l) => l.account_id)]);
    await settleAgent(client, {
      agentId: deskId,
      businessId: existing.business_id,
      status: 'AWAITING_APPROVAL',
      message: `Delist waiting: ${existing.name}`.slice(0, 500),
    });
    await logAction(client, {
      businessId: existing.business_id,
      agentId: deskId,
      approvalId: rows[0].id,
      action: 'PRODUCT_DELIST_SUBMITTED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { sku: existing.sku, accounts: live.map((l) => l.label) },
    });
    return rows[0];
  });

  res.json({
    ok: true,
    deleted: false,
    needs_approval: true,
    approval_id: approval.id,
    note: `it is still live on ${live.length} shop(s); it goes when they confirm`,
  });
}));

/**
 * List a product on the accounts its owner picked. Like everything else that
 * leaves the building, it waits for a human.
 */
app.post('/api/products/:id/publish', wrap(async (req, res) => {
  const productId = assertUuid(req.params.id, 'product_id');
  const product = await readProduct(productId);
  if (!product) throw new HttpError(404, 'product not found');
  assertInScope(req.user, product.business_id);
  requireOwner(req.user, product.business_id);

  const accountIds = req.body?.account_ids;
  if (!Array.isArray(accountIds) || !accountIds.length) {
    throw new HttpError(400, 'choose at least one account to list it on');
  }
  for (const id of accountIds) assertUuid(id, 'account_id');

  // Only this business's accounts, and only ones that are syncing.
  const { rows: accounts } = await q(
    `SELECT id, platform, label, sync_enabled, credentials
       FROM platform_accounts
      WHERE id = ANY($1::uuid[]) AND business_id = $2`,
    [accountIds, product.business_id],
  );
  if (accounts.length !== accountIds.length) {
    throw new HttpError(404, 'one of those accounts does not belong to this business');
  }
  const paused = accounts.filter((a) => !a.sync_enabled);
  if (paused.length) {
    throw new HttpError(409,
      `sync is paused for ${paused.map((a) => a.label).join(', ')} — turn it back on first`);
  }
  const unconfigured = accounts.filter(
    (a) => missingCredentials(a.platform, decryptCredentials(a.credentials)).length);
  if (unconfigured.length) {
    throw new HttpError(409,
      `${unconfigured.map((a) => a.label).join(', ')} still needs credentials`);
  }

  // A marketplace will refuse a listing without its own required bits, so say
  // so here rather than letting it fail halfway out.
  const needs = [];
  for (const account of accounts) {
    const meta = product.platform_meta?.[account.platform] ?? {};
    if (['shopee', 'lazada', 'tiktok'].includes(account.platform) && !meta.category_id) {
      needs.push(`${account.label} needs a ${account.platform} category_id`);
    }
  }
  if (!product.images?.length) needs.push('the product needs at least one image');
  if (needs.length) throw new HttpError(400, needs.join('; '));

  const agentId = await deskFor(product.business_id);

  const approval = await tx(async (client) => {
    for (const account of accounts) {
      await client.query(
        `INSERT INTO product_listings (product_id, account_id, state)
         VALUES ($1, $2, 'PUBLISH_PENDING')
         ON CONFLICT (product_id, account_id) DO UPDATE
           SET state = CASE WHEN product_listings.state = 'LISTED'
                            THEN 'UPDATE_PENDING' ELSE 'PUBLISH_PENDING' END,
               last_error = NULL`,
        [productId, account.id],
      );
    }
    const { rows } = await client.query(
      `INSERT INTO approvals (business_id, agent_id, payload_json)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [product.business_id, agentId, JSON.stringify({
        type: 'product_publish',
        title: `List "${product.name}" on ${accounts.map((a) => a.label).join(', ')}`,
        draft: `${product.name} — ${product.currency} ${product.price}, ${product.stock} in stock\n\n${product.description}`,
        channel: accounts[0].platform,
        product_id: productId,
        account_ids: accounts.map((a) => a.id),
        source: { product_id: productId, requested_by: req.user.email },
      })],
    );
    await settleAgent(client, {
      agentId,
      businessId: product.business_id,
      status: 'AWAITING_APPROVAL',
      message: `Listing waiting: ${product.name}`.slice(0, 500),
    });
    await logAction(client, {
      businessId: product.business_id,
      agentId,
      approvalId: rows[0].id,
      action: 'PRODUCT_PUBLISH_SUBMITTED',
      actor: req.user.email,
      actorUserId: req.user.id,
      detail: { sku: product.sku, accounts: accounts.map((a) => a.label) },
    });
    return rows[0];
  });

  res.json({
    ok: true,
    needs_approval: true,
    approval_id: approval.id,
    accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, label: a.label })),
  });
}));

// ------------------------------------------- what the gate does with each kind
// Registered here, after the readers they use exist. A post edit and a
// product listing each go to their own workflow and each know how to put
// their rows back; everything else falls through to the dispatch workflow,
// which routes by `channel`.

const postRollback = (postId, failed) => tx(async (client) => {
  // An edit that was chasing a live post leaves it live; one that had not
  // gone out yet goes back to not published.
  await client.query(
    `UPDATE social_post_targets SET state = $2, last_error = $3
      WHERE post_id = $1 AND state = 'UPDATE_PENDING'`,
    [postId, failed ? 'FAILED' : 'PUBLISHED', failed ?? null]);
  await client.query(
    `UPDATE social_post_targets SET state = $2, last_error = $3
      WHERE post_id = $1 AND state = 'PUBLISH_PENDING'`,
    [postId, failed ? 'FAILED' : 'NOT_PUBLISHED', failed ?? null]);
  await client.query(
    `UPDATE social_posts SET status = CASE
         WHEN EXISTS (SELECT 1 FROM social_post_targets
                       WHERE post_id = $1 AND state = 'PUBLISHED')
         THEN 'PUBLISHED' ELSE 'DRAFT' END
      WHERE id = $1`, [postId]);
});

const productRollback = (productId, failed) => tx(async (client) => {
  await client.query(
    `UPDATE product_listings SET state = $2, last_error = $3
      WHERE product_id = $1 AND state = 'UPDATE_PENDING'`,
    [productId, failed ? 'FAILED' : 'LISTED', failed ?? null]);
  await client.query(
    `UPDATE product_listings SET state = $2, last_error = $3
      WHERE product_id = $1 AND state = 'PUBLISH_PENDING'`,
    [productId, failed ? 'FAILED' : 'NOT_LISTED', failed ?? null]);
});

for (const type of ['post_update', 'post_publish']) {
  registerApprovalType(type, {
    label: 'post sync',
    webhook: () => N8N_POST_SYNC_WEBHOOK_URL,
    enrich: async (payload) => ({ post: await readPost(payload.post_id) }),
    onDispatchFailed: (payload, why) => postRollback(payload.post_id, why),
    onRejected: async (payload) => {
      await postRollback(payload.post_id, null);
      return { post_update: 'discarded' };
    },
  });
}

registerApprovalType('product_delist', {
  label: 'product sync',
  webhook: () => N8N_PRODUCT_SYNC_WEBHOOK_URL,
  enrich: async (payload) => ({
    product: await readProduct(payload.product_id),
    // The sync workflow needs telling this is a removal, not an edit.
    action: 'delist',
  }),
  onDispatchFailed: (payload, why) => productRollback(payload.product_id, why),
  onRejected: async (payload) => {
    await productRollback(payload.product_id, null);
    return { delete: 'cancelled — the product stays' };
  },
});

for (const type of ['product_publish', 'product_update']) {
  registerApprovalType(type, {
    label: 'product sync',
    webhook: () => N8N_PRODUCT_SYNC_WEBHOOK_URL,
    enrich: async (payload) => ({ product: await readProduct(payload.product_id) }),
    onDispatchFailed: (payload, why) => productRollback(payload.product_id, why),
    onRejected: async (payload) => {
      await productRollback(payload.product_id, null);
      return { product_update: 'discarded' };
    },
  });
}

// ---------------------------------------------------------- platform API
// For whoever runs this deployment and sells it on. The hard rule here is
// that a platform operator sees ACTIVITY, never CONTENT: no draft text, no
// payload, no feedback, no customer names. Those columns are not selected
// anywhere below. Reading a business's actual work needs a user_businesses
// grant from that business, like it does for anybody else.

app.use('/api/platform', requirePlatformOwner);

app.get('/api/platform/overview', wrap(async (_req, res) => {
  const { rows: businesses } = await q(
    `SELECT b.id, b.code, b.name, b.business_type, b.timezone, b.currency,
            b.is_active, b.created_at,
            (SELECT count(*) FROM agents a WHERE a.business_id = b.id) AS agent_count,
            (SELECT count(*) FROM user_businesses ub WHERE ub.business_id = b.id) AS member_count
       FROM businesses b
      ORDER BY b.created_at`,
  );

  // The desk grid: department and status only, which is configuration rather
  // than anyone's customer data.
  const { rows: desks } = await q(
    `SELECT business_id, department, status, desk_x, desk_y FROM agents
      ORDER BY business_id, desk_y, desk_x`,
  );

  const { rows: counts } = await q(
    `SELECT business_id,
            count(*) FILTER (WHERE status = 'PENDING') AS pending,
            count(*) FILTER (WHERE status = 'APPROVED'
                             AND resolved_at > now() - interval '24 hours') AS approved_24h,
            count(*) FILTER (WHERE status = 'REJECTED'
                             AND resolved_at > now() - interval '24 hours') AS rejected_24h,
            max(created_at) AS last_draft_at
       FROM approvals GROUP BY business_id`,
  );

  const { rows: activity } = await q(
    `SELECT business_id, max(created_at) AS last_action_at,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS actions_24h
       FROM action_logs GROUP BY business_id`,
  );

  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.business_id, r]));
  const countsById = byId(counts);
  const activityById = byId(activity);

  res.json({
    businessTypes: BUSINESS_TYPES,
    businesses: businesses.map((b) => ({
      ...b,
      agent_count: Number(b.agent_count),
      member_count: Number(b.member_count),
      desks: desks.filter((d) => d.business_id === b.id)
        .map(({ department, status }) => ({ department, status })),
      pending: Number(countsById[b.id]?.pending ?? 0),
      approved_24h: Number(countsById[b.id]?.approved_24h ?? 0),
      rejected_24h: Number(countsById[b.id]?.rejected_24h ?? 0),
      last_draft_at: countsById[b.id]?.last_draft_at ?? null,
      last_action_at: activityById[b.id]?.last_action_at ?? null,
      actions_24h: Number(activityById[b.id]?.actions_24h ?? 0),
    })),
  });
}));

/** Open a new floor: the business plus its nine desks, laid out as usual. */
app.post('/api/platform/businesses', wrap(async (req, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  const name = String(req.body?.name ?? '').trim();
  const businessType = String(req.body?.business_type ?? 'general');
  const timezone = String(req.body?.timezone ?? 'Asia/Manila');
  const currency = String(req.body?.currency ?? 'PHP').toUpperCase();

  if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(code)) {
    throw new HttpError(400, 'code must be 3-32 characters: A-Z, 0-9 and underscore');
  }
  if (name.length < 2) throw new HttpError(400, 'name is required');
  if (!BUSINESS_TYPES.includes(businessType)) throw new HttpError(400, 'unknown business type');
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'currency must be a 3-letter code');

  const business = await tx((client) => openFloor(client, {
    code, name, businessType, timezone, currency, createdBy: req.user.id,
  })).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, `a business already uses the code ${code}`);
    throw err;
  });

  res.status(201).json({ ok: true, business });
}));

/** Suspend or restore a floor. Suspended businesses disappear from their own
 *  dashboards but nothing is deleted. */
app.patch('/api/platform/businesses/:id', wrap(async (req, res) => {
  const id = assertUuid(req.params.id, 'business_id');
  if (typeof req.body?.is_active !== 'boolean') {
    throw new HttpError(400, 'is_active must be true or false');
  }
  const { rows } = await q(
    `UPDATE businesses SET is_active = $2 WHERE id = $1
     RETURNING id, code, name, is_active`,
    [id, req.body.is_active],
  );
  if (!rows[0]) throw new HttpError(404, 'business not found');
  res.json({ ok: true, business: rows[0] });
}));

/** Accounts, so a new customer can be handed their own sign-in. */
app.get('/api/platform/users', wrap(async (_req, res) => {
  const { rows } = await q(
    `SELECT u.id, u.email, u.display_name, u.is_active, u.is_platform_owner,
            u.created_at, u.last_login_at,
            COALESCE(json_agg(json_build_object('code', b.code, 'role', ub.role)
                     ORDER BY b.code) FILTER (WHERE b.id IS NOT NULL), '[]') AS access
       FROM users u
  LEFT JOIN user_businesses ub ON ub.user_id = u.id
  LEFT JOIN businesses b ON b.id = ub.business_id
   GROUP BY u.id
   ORDER BY u.created_at`,
  );
  res.json(rows);
}));

app.post('/api/platform/users', wrap(async (req, res) => {
  const businessId = assertUuid(req.body?.business_id, 'business_id');
  const role = req.body?.role ?? 'owner';
  if (!['owner', 'reviewer'].includes(role)) throw new HttpError(400, 'role must be owner or reviewer');

  // Generated here rather than chosen, so a password is never typed into the
  // portal and never travels in a request body.
  const password = crypto.randomBytes(12).toString('base64url');
  const user = await createUser({
    email: req.body?.email,
    password,
    displayName: req.body?.display_name,
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, 'an account already uses that email');
    throw err;
  });
  await grantBusiness(user.id, businessId, role);

  // The only time this password is ever readable.
  res.status(201).json({ ok: true, user, password });
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
      `SELECT ag.id, ag.business_id, ag.status, b.is_active
         FROM agents ag JOIN businesses b ON b.id = ag.business_id
        WHERE ag.department = $1
          AND ($2::uuid IS NULL OR ag.business_id = $2::uuid)
          AND ($3::text IS NULL OR b.code = $3::text)
        FOR UPDATE OF ag`,
      [department, businessId ?? null, businessCode ?? null],
    );
    const target = rows[0];
    if (!target) return { notFound: true };
    if (!target.is_active) return { suspended: true };
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
  if (result.suspended) {
    res.status(423).json({ ok: false, status: 'SUSPENDED',
      error: 'this business is suspended — abort this run' });
    return;
  }
  if (result.paused) {
    res.status(423).json({ ok: false, status: 'PAUSED', agent_id: result.agentId,
      error: 'agent is paused — abort this run' });
    return;
  }
  // The enabled skills go back with the agent so n8n can shape the prompt
  // around what this desk is actually meant to do.
  res.json({ ok: true, agent: result.agent, skills: await readEnabledSkills(result.agent.id) });
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
      `SELECT ag.id, ag.business_id, ag.status, b.is_active
         FROM agents ag JOIN businesses b ON b.id = ag.business_id
        WHERE ag.id = $1 FOR UPDATE OF ag`, [agentId]);
    const agent = agents[0];
    if (!agent) return { notFound: true };
    if (!agent.is_active) return { suspended: true };
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
  if (result.suspended) {
    res.status(423).json({ ok: false, status: 'SUSPENDED',
      error: 'this business is suspended — draft not filed' });
    return;
  }
  if (result.paused) {
    res.status(423).json({ ok: false, status: 'PAUSED',
      error: 'agent is paused — draft not filed' });
    return;
  }
  res.status(201).json({ ok: true, approval: result.approval });
}));

/**
 * Pull a post in from a platform, or record one the bot has just published.
 * Keyed on (platform, external_id), so re-importing the same post updates the
 * copy here instead of making a second one.
 */
app.post('/api/internal/posts', wrap(async (req, res) => {
  const { business_code: businessCode, title, body } = req.body ?? {};
  const businessId = req.body?.business_id;
  const department = req.body?.department ?? 'Marketing';
  const targets = req.body?.targets;
  if (!title || !body) throw new HttpError(400, 'title and body are required');
  if (!Array.isArray(targets) || !targets.length) {
    throw new HttpError(400, 'targets must be a non-empty list');
  }
  for (const t of targets) {
    if (!PLATFORMS.includes(t?.platform)) throw new HttpError(400, `unknown platform: ${t?.platform}`);
  }
  if (!businessId && !businessCode) {
    throw new HttpError(400, 'business_id or business_code is required');
  }
  if (businessId) assertUuid(businessId, 'business_id');

  const result = await tx(async (client) => {
    const { rows: found } = await client.query(
      `SELECT b.id, b.is_active FROM businesses b
        WHERE ($1::uuid IS NULL OR b.id = $1::uuid)
          AND ($2::text IS NULL OR b.code = $2::text)`,
      [businessId ?? null, businessCode ?? null],
    );
    const business = found[0];
    if (!business) return { notFound: true };
    if (!business.is_active) return { suspended: true };

    // Does one of these platform copies already exist here?
    const withIds = targets.filter((t) => t.external_id);
    let postId = null;
    if (withIds.length) {
      const { rows } = await client.query(
        `SELECT p.id FROM social_posts p
           JOIN social_post_targets t ON t.post_id = p.id
          WHERE p.business_id = $1
            AND (t.platform, t.external_id) IN (
              SELECT * FROM unnest($2::text[], $3::text[]))
          LIMIT 1`,
        [business.id, withIds.map((t) => t.platform), withIds.map((t) => String(t.external_id))],
      );
      postId = rows[0]?.id ?? null;
    }

    const { rows: agents } = await client.query(
      `SELECT id FROM agents WHERE business_id = $1 AND department = $2`,
      [business.id, department],
    );
    const agentId = agents[0]?.id ?? null;

    if (postId) {
      await client.query(
        `UPDATE social_posts SET title = $2, body = $3, media_url = $4, status = 'PUBLISHED'
          WHERE id = $1`,
        [postId, title, body, req.body?.media_url ?? null],
      );
    } else {
      const { rows } = await client.query(
        `INSERT INTO social_posts (business_id, agent_id, title, body, media_url, status)
         VALUES ($1, $2, $3, $4, $5, 'PUBLISHED')
         RETURNING id`,
        [business.id, agentId, title, body, req.body?.media_url ?? null],
      );
      postId = rows[0].id;
    }

    for (const target of targets) {
      await client.query(
        `INSERT INTO social_post_targets (post_id, platform, external_id, state, last_synced_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (post_id, platform) DO UPDATE
           SET external_id = EXCLUDED.external_id,
               state = EXCLUDED.state,
               last_synced_at = now(),
               last_error = NULL`,
        [postId, target.platform, target.external_id ?? null,
         target.external_id ? 'PUBLISHED' : 'NOT_PUBLISHED'],
      );
    }

    await logAction(client, {
      businessId: business.id,
      agentId,
      action: 'POST_SYNCED_IN',
      actor: 'n8n',
      detail: { platforms: targets.map((t) => t.platform) },
    });
    return { postId };
  });

  if (result.notFound) throw new HttpError(404, 'business not found');
  if (result.suspended) {
    res.status(423).json({ ok: false, status: 'SUSPENDED',
      error: 'this business is suspended — post not synced' });
    return;
  }
  res.status(201).json({ ok: true, post: await readPost(result.postId) });
}));

/**
 * The only way credentials ever come back out. n8n calls this with the
 * internal token to get the keys for one account, and the read is logged, so
 * there is a record of every time a secret left the database.
 */
/**
 * Every connected account on every floor that is open, so a sweep can fan out
 * without being told what exists. A suspended business is simply not in the
 * list, which is how it stops being swept at all rather than being refused one
 * call at a time.
 *
 * Credentials are not here — they come one account at a time from the route
 * below, which logs each read.
 */
app.get('/api/internal/accounts', wrap(async (req, res) => {
  const KINDS = {
    chat: ['shopee', 'lazada', 'tiktok', 'facebook', 'instagram'],
    market: ['shopee', 'lazada', 'tiktok'],
    live: ['tiktok', 'facebook'],
  };
  const wanted = KINDS[String(req.query.kinds ?? '')] ?? PLATFORMS;
  const { rows } = await q(
    `SELECT a.id, a.business_id, a.platform, a.label, a.external_id, a.region,
            a.sync_enabled, a.last_synced_at, b.code AS business_code
       FROM platform_accounts a
       JOIN businesses b ON b.id = a.business_id AND b.is_active
      WHERE a.platform = ANY($1::text[])
      ORDER BY b.code, a.platform, a.label`,
    [wanted]);
  res.json({ accounts: rows });
}));

/** The floors that are open, for a sweep that runs per business. */
app.get('/api/internal/businesses', wrap(async (_req, res) => {
  const { rows } = await q(
    `SELECT id, code, name, business_type, timezone, currency
       FROM businesses WHERE is_active ORDER BY code`);
  res.json({ businesses: rows });
}));

app.get('/api/internal/accounts/:id/credentials', wrap(async (req, res) => {
  const accountId = assertUuid(req.params.id, 'account_id');
  const account = await readAccountRow(accountId);
  if (!account) throw new HttpError(404, 'account not found');

  const { rows: business } = await q(
    'SELECT is_active FROM businesses WHERE id = $1', [account.business_id]);
  if (!business[0]?.is_active) {
    res.status(423).json({ ok: false, status: 'SUSPENDED',
      error: 'this business is suspended' });
    return;
  }
  if (!account.sync_enabled) {
    res.status(423).json({ ok: false, status: 'SYNC_PAUSED',
      error: `sync is paused for ${account.label}` });
    return;
  }

  await tx((client) => logAction(client, {
    businessId: account.business_id,
    action: 'ACCOUNT_CREDENTIALS_READ',
    actor: 'n8n',
    detail: { platform: account.platform, label: account.label },
  }));

  res.json({
    ok: true,
    account: {
      id: account.id, platform: account.platform, label: account.label,
      external_id: account.external_id, region: account.region,
    },
    credentials: decryptCredentials(account.credentials),
  });
}));

/** n8n reports what happened to one product listing. */
app.post('/api/internal/products/:id/listings', wrap(async (req, res) => {
  const productId = assertUuid(req.params.id, 'product_id');
  const accountId = assertUuid(req.body?.account_id, 'account_id');
  const state = req.body?.state;
  if (!['LISTED', 'FAILED', 'NOT_LISTED'].includes(state)) {
    throw new HttpError(400, 'state must be LISTED, FAILED or NOT_LISTED');
  }
  const product = await readProduct(productId);
  if (!product) throw new HttpError(404, 'product not found');

  await tx(async (client) => {
    await client.query(
      `UPDATE product_listings
          SET state = $3,
              external_id = COALESCE($4, external_id),
              last_synced_at = now(),
              last_error = $5
        WHERE product_id = $1 AND account_id = $2`,
      [productId, accountId, state, req.body?.external_id ?? null, req.body?.error ?? null],
    );
    await client.query(
      `UPDATE platform_accounts
          SET last_synced_at = now(), last_error = $2
        WHERE id = $1`,
      [accountId, state === 'FAILED' ? (req.body?.error ?? 'listing failed') : null],
    );
    // Listed anywhere at all means the product is out there.
    await client.query(
      `UPDATE products SET status = CASE
           WHEN EXISTS (SELECT 1 FROM product_listings
                         WHERE product_id = $1 AND state = 'LISTED')
           THEN 'LISTED' ELSE 'DRAFT' END
        WHERE id = $1 AND NOT EXISTS (
          SELECT 1 FROM product_listings
           WHERE product_id = $1 AND state IN ('PUBLISH_PENDING','UPDATE_PENDING'))`,
      [productId],
    );
    await logAction(client, {
      businessId: product.business_id,
      action: state === 'LISTED' ? 'PRODUCT_LISTED' : 'PRODUCT_LISTING_FAILED',
      actor: 'n8n',
      detail: { sku: product.sku, state, error: req.body?.error ?? null },
    });

    // A delete that was waiting on the shops happens here, once none of them
    // still carries it and none is still mid-flight. A shop that refused to
    // take it down keeps the product alive on purpose: deleting it here would
    // leave a listing out there with nothing behind it.
    if (req.body?.delisting === true) {
      const { rows } = await client.query(
        `SELECT count(*) FILTER (WHERE state IN ('LISTED','PUBLISH_PENDING','UPDATE_PENDING'))::int AS blocking,
                count(*) FILTER (WHERE state = 'FAILED')::int AS failed
           FROM product_listings WHERE product_id = $1`, [productId]);
      if (rows[0].blocking === 0 && rows[0].failed === 0) {
        await client.query(`DELETE FROM products WHERE id = $1`, [productId]);
        await logAction(client, {
          businessId: product.business_id,
          action: 'PRODUCT_DELETED',
          actor: 'n8n',
          detail: { sku: product.sku, name: product.name, after: 'delist' },
        });
      }
    }
  });

  res.json({ ok: true, product: await readProduct(productId) });
}));

/** n8n reports back what happened to one platform copy. */
app.post('/api/internal/posts/:id/targets', wrap(async (req, res) => {
  const postId = assertUuid(req.params.id, 'post_id');
  const { platform, external_id: externalId, error } = req.body ?? {};
  const state = req.body?.state;
  if (!PLATFORMS.includes(platform)) throw new HttpError(400, 'unknown platform');
  if (!['PUBLISHED', 'FAILED', 'NOT_PUBLISHED'].includes(state)) {
    throw new HttpError(400, 'state must be PUBLISHED, FAILED or NOT_PUBLISHED');
  }

  const post = await readPost(postId);
  if (!post) throw new HttpError(404, 'post not found');

  await tx(async (client) => {
    await client.query(
      `UPDATE social_post_targets
          SET state = $3,
              external_id = COALESCE($4, external_id),
              last_synced_at = now(),
              last_error = $5
        WHERE post_id = $1 AND platform = $2`,
      [postId, platform, state, externalId ?? null, error ?? null],
    );
    // Once nothing is still pending, the post itself is settled again.
    await client.query(
      `UPDATE social_posts SET status = 'PUBLISHED'
        WHERE id = $1 AND NOT EXISTS (
          SELECT 1 FROM social_post_targets
           WHERE post_id = $1 AND state IN ('UPDATE_PENDING', 'PUBLISH_PENDING'))`,
      [postId],
    );
    await logAction(client, {
      businessId: post.business_id,
      agentId: post.agent_id,
      action: state === 'PUBLISHED' ? 'POST_SYNCED_OUT' : 'POST_SYNC_FAILED',
      actor: 'n8n',
      detail: { platform, state, error: error ?? null },
    });
  });

  res.json({ ok: true, post: await readPost(postId) });
}));

/**
 * Release a desk without filing anything (run finished or failed).
 *
 * Deliberately still allowed for a suspended business: this is the call a run
 * makes on its way out, it can only move an agent to IDLE, and blocking it
 * would strand a desk in WORKING until the business came back.
 */
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

// ------------------------------------------- the selling floor's own routes
// The inbox, the orders and the money live in commerce.js; the live streams
// in live.js. Both are handed the same helpers this file uses, so there is
// one tenant filter, one logger, one gate — not three copies of each.

const moduleContext = {
  q, tx, wrap, HttpError, assertUuid, businessClause, scopeFor, requireOwner,
  assertInScope, logAction, settleAgent, deskFor, requireUser,
  registerApprovalType, internalGate,
  chatWebhookUrl: () => N8N_CHAT_WEBHOOK_URL || N8N_DISPATCH_WEBHOOK_URL,
  orderSyncWebhookUrl: () => N8N_PRODUCT_SYNC_WEBHOOK_URL,
  liveWebhookUrl: () => N8N_LIVE_WEBHOOK_URL || N8N_DISPATCH_WEBHOOK_URL,
};

registerCommerce(app, moduleContext);
registerLive(app, moduleContext);

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
    } else {
      // Everything else — a post, a product, a conversation, an order, a
      // payment, a live session — is a collection the dashboard refetches. We
      // say which one changed and let it ask; the row it gets back is then the
      // committed one, which is the whole point of going through the database.
      broadcast(event.business_id, 'collection:changed',
        { entity: event.entity, id: event.id, op: event.op });
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
