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

  // Dispatch happens only after the row is committed as APPROVED. A post edit
  // goes to its own workflow, which updates each platform copy in place.
  const payload = outcome.payload_json ?? {};
  const isPostUpdate = payload.type === 'post_update' || payload.type === 'post_publish';
  const dispatch = await callWebhook(
    isPostUpdate ? N8N_POST_SYNC_WEBHOOK_URL : N8N_DISPATCH_WEBHOOK_URL,
    {
      approval_id: outcome.id,
      business_id: outcome.business_id,
      agent_id: outcome.agent_id,
      payload,
      ...(isPostUpdate ? { post: await readPost(payload.post_id) } : {}),
    },
    isPostUpdate ? 'post sync' : 'dispatch',
  );

  // If nothing took the job, the platforms are not going to change, so do not
  // leave the post looking like an update is on its way.
  if (isPostUpdate && !dispatch.ok) {
    await q(
      `UPDATE social_post_targets SET state = 'FAILED', last_error = $2
        WHERE post_id = $1 AND state IN ('UPDATE_PENDING', 'PUBLISH_PENDING')`,
      [payload.post_id, 'the job could not be queued'],
    ).catch(() => {});
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

  // A rejected post edit is simply dropped: the platforms were never touched,
  // so the live copies stay as they are.
  const postType = outcome.payload_json?.type;
  if (postType === 'post_update' || postType === 'post_publish') {
    const postId = outcome.payload_json.post_id;
    await tx(async (client) => {
      // An edit that was chasing a live post leaves it live; one that had not
      // gone out yet goes back to not published.
      await client.query(
        `UPDATE social_post_targets SET state = 'PUBLISHED'
          WHERE post_id = $1 AND state = 'UPDATE_PENDING'`, [postId]);
      await client.query(
        `UPDATE social_post_targets SET state = 'NOT_PUBLISHED'
          WHERE post_id = $1 AND state = 'PUBLISH_PENDING'`, [postId]);
      await client.query(
        `UPDATE social_posts SET status = CASE
             WHEN EXISTS (SELECT 1 FROM social_post_targets
                           WHERE post_id = $1 AND state = 'PUBLISHED')
             THEN 'PUBLISHED' ELSE 'DRAFT' END
          WHERE id = $1`, [postId]);
    }).catch((err) => console.error('[posts] could not roll back:', err.message));
    res.json({ ok: true, approval_id: outcome.id, post_update: 'discarded' });
    return;
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

// ---------------------------------------------------------- platform API
// For whoever runs this deployment and sells it on. The hard rule here is
// that a platform operator sees ACTIVITY, never CONTENT: no draft text, no
// payload, no feedback, no customer names. Those columns are not selected
// anywhere below. Reading a business's actual work needs a user_businesses
// grant from that business, like it does for anybody else.

app.use('/api/platform', requirePlatformOwner);

const BUSINESS_TYPES = [
  'electrical', 'it_services', 'retail', 'food', 'construction',
  'logistics', 'professional_services', 'general',
];

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

  const business = await tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO businesses (code, name, business_type, timezone, currency, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, name, business_type, timezone, currency, is_active, created_at`,
      [code, name, businessType, timezone, currency, req.user.id],
    );
    await client.query('SELECT provision_business_agents($1)', [rows[0].id]);
    return rows[0];
  }).catch((err) => {
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
