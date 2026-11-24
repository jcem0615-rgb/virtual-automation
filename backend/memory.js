// The server in the office: what each desk remembers between runs.
//
// Checkout used to hand n8n two things — the skills the department has
// switched on, and the request in front of it. That is everything the desk
// knew, so it knew nothing it had not been told in the last thirty seconds.
// A reviewer could turn the same draft down every week with the same
// sentence and the desk would write it again, because the sentence went into
// one prompt and then nowhere.
//
// So a desk gets memory, and checkout hands it over beside the skills. Two
// rules hold this up, and both are load-bearing.
//
//   **A memory is not outbound.** It is read into a prompt and never sent
//   anywhere. Like a note, it has no channel and no dispatch, and must never
//   grow one. Unlike a note, it *does* reach a customer eventually — through
//   whatever the desk writes next, which still goes through the approval
//   gate like everything else. That is the whole reason this is safe.
//
//   **It is bounded.** Everything handed over goes into a prompt. An
//   unbounded table is a prompt that grows until the model stops reading the
//   end of it, and a deployment that pays for every token of it. So a run
//   gets `MEMORY_LIMIT` rows, pinned first. Nothing is deleted to make room
//   — a row past the cap is still on the server and still on screen, it is
//   just not read into the next job — and the panel says which desks are
//   over it, so a desk quietly working from half of what it knows is
//   visible rather than something you deduce from a bad draft.

const KINDS = ['fact', 'preference', 'correction'];

// How many memories a desk may take into one prompt. Low on purpose: this is
// a local model with a modest context, and forty lines of "remember that…"
// in front of the actual request is already a lot to ask of it.
export const MEMORY_LIMIT = 40;

const SUBJECT_MAX = 120;
const BODY_MAX = 600;

/**
 * What a desk takes into a run, in the order it matters: pinned first, then
 * what has been useful most recently, then the newest. Capped.
 *
 * Reading is a write too — `used_count` and `last_used_at` move — because a
 * memory nobody's prompt ever reaches is one worth forgetting, and there is
 * no way to see that without counting.
 */
export async function readMemory(q, agentId, limit = MEMORY_LIMIT) {
  const { rows } = await q(
    `WITH taken AS (
       SELECT id FROM agent_memory
        WHERE agent_id = $1
        ORDER BY pinned DESC, last_used_at DESC NULLS LAST, created_at DESC
        LIMIT $2
     )
     UPDATE agent_memory m
        SET used_count = m.used_count + 1, last_used_at = now()
       FROM taken
      WHERE m.id = taken.id
      RETURNING m.kind, m.subject, m.body, m.learned_from, m.pinned`,
    [agentId, limit],
  );
  // The UPDATE … RETURNING gives no order of its own, so it is imposed here
  // rather than left to whatever the executor happened to do.
  const rank = { correction: 0, preference: 1, fact: 2 };
  return rows.sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) || rank[a.kind] - rank[b.kind]);
}

/**
 * Learn something, or correct what was already learnt under that subject.
 *
 * The upsert is the point: a desk told the same thing on three runs holds
 * one row, not three, so the cap is spent on distinct things. It also means
 * the newest telling wins, which is what you want when a price changes.
 */
export async function rememberFor(client, {
  businessId, agentId, kind = 'fact', subject, body,
  learnedFrom = 'a person', approvalId = null, conversationId = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO agent_memory
       (business_id, agent_id, kind, subject, body, learned_from,
        approval_id, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (agent_id, lower(subject)) DO UPDATE
       SET kind = EXCLUDED.kind,
           body = EXCLUDED.body,
           learned_from = EXCLUDED.learned_from,
           approval_id = EXCLUDED.approval_id,
           conversation_id = EXCLUDED.conversation_id
     RETURNING id, (xmax = 0) AS is_new`,
    [businessId, agentId, kind, subject, body, learnedFrom,
      approvalId, conversationId],
  );
  return rows[0];
}

/**
 * A rejection, turned into something the desk keeps.
 *
 * This is where the loop actually closes. The reviewer has already typed the
 * reason; without this it goes into one revision and is lost. The subject is
 * what the draft was about, so turning the same kind of work down twice
 * replaces the lesson rather than stacking two of them.
 */
export async function rememberRejection(client, { approval, feedback, actor }) {
  const title = String(approval.payload_json?.title ?? 'this kind of work')
    .slice(0, SUBJECT_MAX);
  return rememberFor(client, {
    businessId: approval.business_id,
    agentId: approval.agent_id,
    kind: 'correction',
    subject: title,
    body: String(feedback).slice(0, BODY_MAX),
    learnedFrom: actor,
    approvalId: approval.id,
  });
}

export function registerMemory(app, ctx) {
  const {
    q, tx, wrap, HttpError, assertUuid, businessClause, scopeFor, requireOwner,
    assertInScope, logAction, requireUser, internalGate,
  } = ctx;

  const COLUMNS = `
    m.id, m.business_id, m.agent_id, m.kind, m.subject, m.body,
    m.learned_from, m.approval_id, m.conversation_id, m.pinned,
    m.used_count, m.last_used_at, m.created_at, m.updated_at,
    ag.department AS agent_department, ag.name AS agent_name,
    ag.role_title AS agent_role_title, ag.status AS agent_status`;

  const JOINS = `
    FROM agent_memory m
    JOIN agents ag ON ag.id = m.agent_id`;

  async function readOne(id) {
    assertUuid(id, 'memory_id');
    const { rows } = await q(`SELECT ${COLUMNS} ${JOINS} WHERE m.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Both halves of a memory, trimmed and checked. */
  function readBody(body, { partial = false } = {}) {
    const out = {};
    if (body.kind !== undefined || !partial) {
      const kind = body.kind ?? 'fact';
      if (!KINDS.includes(kind)) {
        throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
      }
      out.kind = kind;
    }
    for (const [field, max] of [['subject', SUBJECT_MAX], ['body', BODY_MAX]]) {
      if (body[field] === undefined && partial) continue;
      const value = String(body[field] ?? '').trim();
      if (!value) throw new HttpError(400, 'a memory needs a subject and a body');
      if (value.length > max) {
        throw new HttpError(400, `${field} is longer than ${max} characters`);
      }
      out[field] = value;
    }
    if (body.pinned !== undefined) out.pinned = Boolean(body.pinned);
    return out;
  }

  /** The desk this memory is for, on a floor the caller can reach. */
  async function deskOnFloor(agentId, businessIds) {
    assertUuid(agentId, 'agent_id');
    const { rows } = await q(
      `SELECT id, business_id FROM agents
        WHERE id = $1 AND removed_at IS NULL AND business_id = ANY($2::uuid[])`,
      [agentId, businessIds],
    );
    if (!rows[0]) throw new HttpError(404, 'no desk on this floor with that id');
    return rows[0];
  }

  // Everything under /api/memory needs a session, the same as every other
  // operational read in this app.
  app.use('/api/memory', requireUser);

  // ------------------------------------------------------------- reading

  app.get('/api/memory', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    const where = businessClause(scope, { column: 'm.business_id' });
    const params = [...where.params];
    let more = '';
    if (req.query.agent_id) {
      params.push(assertUuid(req.query.agent_id, 'agent_id'));
      more += ` AND m.agent_id = $${params.length}`;
    }
    if (req.query.kind && req.query.kind !== 'all') {
      if (!KINDS.includes(req.query.kind)) throw new HttpError(400, 'unknown kind');
      params.push(req.query.kind);
      more += ` AND m.kind = $${params.length}`;
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).slice(0, 120)}%`);
      more += ` AND (m.subject ILIKE $${params.length} OR m.body ILIKE $${params.length})`;
    }
    const { rows } = await q(
      `SELECT ${COLUMNS} ${JOINS}
        WHERE ${where.sql}${more}
        ORDER BY m.pinned DESC, m.created_at DESC
        LIMIT 400`,
      params,
    );
    // What each desk holds, against what a prompt can carry. On screen this
    // is the difference between watching a desk fill up and finding out from
    // a draft that forgot something.
    const held = businessClause(scope, { column: 'm.business_id' });
    const { rows: desks } = await q(
      `SELECT m.agent_id, ag.department, ag.name, ag.role_title,
              count(*)::int AS held,
              count(*) FILTER (WHERE m.pinned)::int AS pinned
         FROM agent_memory m JOIN agents ag ON ag.id = m.agent_id
        WHERE ${held.sql} AND ag.removed_at IS NULL
        GROUP BY m.agent_id, ag.department, ag.name, ag.role_title, ag.desk_y, ag.desk_x
        ORDER BY ag.desk_y, ag.desk_x`,
      held.params,
    );
    res.json({ ok: true, memories: rows, desks, kinds: KINDS, limit: MEMORY_LIMIT });
  }));

  // ------------------------------------------------------------- writing

  app.post('/api/memory', wrap(async (req, res) => {
    const businessId = assertUuid(req.body?.business_id, 'business_id');
    assertInScope(req.user, businessId);
    const desk = await deskOnFloor(req.body?.agent_id, req.user.businessIds);
    if (desk.business_id !== businessId) {
      throw new HttpError(404, 'that desk is not on this floor');
    }
    const fields = readBody(req.body ?? {});

    const written = await tx(async (client) => {
      const row = await rememberFor(client, {
        businessId, agentId: desk.id, ...fields,
        learnedFrom: req.user.email,
      });
      await logAction(client, {
        businessId, agentId: desk.id,
        action: row.is_new ? 'MEMORY_LEARNED' : 'MEMORY_REPLACED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { kind: fields.kind, subject: fields.subject },
      });
      return row;
    });
    res.status(201).json({ ok: true, memory: await readOne(written.id) });
  }));

  app.patch('/api/memory/:id', wrap(async (req, res) => {
    const existing = await readOne(req.params.id);
    if (!existing) throw new HttpError(404, 'memory not found');
    assertInScope(req.user, existing.business_id);
    const fields = readBody(req.body ?? {}, { partial: true });
    if (!Object.keys(fields).length) throw new HttpError(400, 'nothing to change');

    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    await tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE agent_memory SET ${sets}
          WHERE id = $1 AND business_id = ANY($2::uuid[]) RETURNING id`,
        [existing.id, req.user.businessIds, ...keys.map((k) => fields[k])],
      );
      if (!rows[0]) throw new HttpError(404, 'memory not found');
      await logAction(client, {
        businessId: existing.business_id,
        agentId: existing.agent_id,
        action: 'MEMORY_EDITED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { changed: keys, subject: existing.subject },
      });
    });
    res.json({ ok: true, memory: await readOne(existing.id) });
  }));

  /**
   * Forgetting. An owner's call, like throwing a note away — this changes
   * what every future draft from that desk is built on, so it is not a
   * reviewer's to do.
   */
  app.delete('/api/memory/:id', wrap(async (req, res) => {
    const existing = await readOne(req.params.id);
    if (!existing) throw new HttpError(404, 'memory not found');
    assertInScope(req.user, existing.business_id);
    await requireOwner(req.user, existing.business_id);

    await tx(async (client) => {
      await client.query(
        `DELETE FROM agent_memory WHERE id = $1 AND business_id = ANY($2::uuid[])`,
        [existing.id, req.user.businessIds],
      );
      // The log keeps that the desk once knew this, and who decided it
      // should not.
      await logAction(client, {
        businessId: existing.business_id,
        agentId: existing.agent_id,
        action: 'MEMORY_FORGOTTEN',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { kind: existing.kind, subject: existing.subject },
      });
    });
    res.json({ ok: true, forgotten: true });
  }));

  // ------------------------------------------------------- what n8n writes

  /**
   * A desk writing down what it worked out during a run.
   *
   * Gated the same way a paused desk and a suspended floor gate everything
   * else: if the desk is not allowed to work, it is not allowed to learn.
   */
  app.post('/api/internal/agents/:id/memory', wrap(async (req, res) => {
    const agentId = assertUuid(req.params.id, 'agent_id');
    const { rows } = await q(
      `SELECT ag.id, ag.business_id, ag.status
         FROM agents ag
        WHERE ag.id = $1 AND ag.removed_at IS NULL`,
      [agentId],
    );
    const desk = rows[0];
    if (!desk) throw new HttpError(404, 'no desk with that id');
    // A suspended floor is closed to n8n the same way it is everywhere else.
    const closed = await internalGate(desk.business_id);
    if (closed) {
      res.status(423).json(closed);
      return;
    }
    if (desk.status === 'PAUSED') {
      res.status(423).json({ ok: false, status: 'PAUSED',
        error: 'agent is paused — nothing was written' });
      return;
    }
    const fields = readBody(req.body ?? {});
    const conversationId = req.body?.conversation_id ?? null;
    if (conversationId) assertUuid(conversationId, 'conversation_id');

    const written = await tx(async (client) => {
      const row = await rememberFor(client, {
        businessId: desk.business_id, agentId: desk.id, ...fields,
        learnedFrom: 'the desk',
        conversationId,
      });
      await logAction(client, {
        businessId: desk.business_id, agentId: desk.id,
        action: row.is_new ? 'MEMORY_LEARNED' : 'MEMORY_REPLACED',
        actor: 'n8n',
        detail: { kind: fields.kind, subject: fields.subject },
      });
      return row;
    });
    res.status(201).json({ ok: true, memory: await readOne(written.id) });
  }));
}
