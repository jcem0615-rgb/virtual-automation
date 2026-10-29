// The Secretary desk's book.
//
// `action_logs` already records every state change this application makes.
// That is a different thing from a record of the business: it says a draft
// was approved at 14:02, not that the supplier rang to say galvanised pipe
// goes up in March, or that Marites always asks for a discount and always
// pays. A small business keeps that in somebody's head, and loses it when
// that somebody is off.
//
// So these are notes, and the one rule that matters about them: **a note
// never leaves the building.** Every other kind of work in this app is on its
// way to a customer, which is why it goes through the approval gate. A note
// is for the people who run the floor, so it is written the moment somebody
// writes it — no gate, no draft, no dispatch. Nothing in here may grow a
// webhook or a `channel`.

const KINDS = ['note', 'minute', 'handover', 'daily'];

/** PHP, the way a seller writes it. */
const money = (n) => `PHP ${Number(n ?? 0).toLocaleString('en-PH',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function registerNotes(app, ctx) {
  const {
    q, tx, wrap, HttpError, assertUuid, businessClause, scopeFor, requireOwner,
    assertInScope, logAction, requireUser, internalGate,
  } = ctx;

  const NOTE_COLUMNS = `
    n.id, n.business_id, n.agent_id, n.kind, n.subject, n.body,
    n.order_id, n.product_id, n.conversation_id, n.account_id,
    n.author, n.pinned, n.note_date, n.created_at, n.updated_at,
    ag.department AS agent_department, ag.name AS agent_name,
    ag.role_title AS agent_role_title,
    o.order_no, p.name AS product_name, c.buyer_name, acc.label AS account_label`;

  const NOTE_JOINS = `
    FROM business_notes n
    LEFT JOIN agents ag ON ag.id = n.agent_id
    LEFT JOIN orders o ON o.id = n.order_id
    LEFT JOIN products p ON p.id = n.product_id
    LEFT JOIN conversations c ON c.id = n.conversation_id
    LEFT JOIN platform_accounts acc ON acc.id = n.account_id`;

  async function readNote(id) {
    assertUuid(id, 'note_id');
    const { rows } = await q(`SELECT ${NOTE_COLUMNS} ${NOTE_JOINS} WHERE n.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** The Secretary, or whichever desk is still on the floor to file under. */
  async function secretaryDesk(businessId) {
    const { rows } = await q(
      `SELECT id FROM agents
        WHERE business_id = $1 AND removed_at IS NULL
        ORDER BY (department = 'Secretary') DESC, desk_y, desk_x
        LIMIT 1`, [businessId]);
    return rows[0]?.id ?? null;
  }

  function readBody(body, { partial = false } = {}) {
    const out = {};
    if (body?.subject !== undefined || !partial) {
      const subject = String(body?.subject ?? '').trim();
      if (!subject) throw new HttpError(400, 'a note needs a subject');
      if (subject.length > 200) throw new HttpError(400, 'that subject is too long');
      out.subject = subject;
    }
    if (body?.body !== undefined || !partial) {
      const text = String(body?.body ?? '').trim();
      if (!text) throw new HttpError(400, 'a note needs something in it');
      if (text.length > 20000) throw new HttpError(400, 'that note is too long');
      out.body = text;
    }
    if (body?.kind !== undefined) {
      if (!KINDS.includes(body.kind)) {
        throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
      }
      out.kind = body.kind;
    }
    if (body?.pinned !== undefined) out.pinned = Boolean(body.pinned);
    for (const key of ['order_id', 'product_id', 'conversation_id', 'account_id']) {
      if (body?.[key] !== undefined) {
        out[key] = body[key] === null ? null : assertUuid(body[key], key);
      }
    }
    return out;
  }

  /**
   * What the note is attached to has to be on the same floor. Without this a
   * note on one business could point at another's order — which would leak
   * that order's number onto a screen it has no business being on.
   */
  async function assertLinksOnFloor(businessId, fields) {
    const checks = [
      ['order_id', 'orders'], ['product_id', 'products'],
      ['conversation_id', 'conversations'], ['account_id', 'platform_accounts'],
    ];
    for (const [key, table] of checks) {
      if (!fields[key]) continue;
      const { rows } = await q(
        `SELECT 1 FROM ${table} WHERE id = $1 AND business_id = $2`,
        [fields[key], businessId]);
      if (!rows[0]) throw new HttpError(404, `that ${key.replace('_id', '')} is not on this business`);
    }
  }

  app.use('/api/notes', requireUser);

  app.get('/api/notes', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    const where = businessClause(scope, { column: 'n.business_id' });
    const params = [...where.params];
    let kindSql = '';
    if (req.query.kind && req.query.kind !== 'all') {
      if (!KINDS.includes(req.query.kind)) throw new HttpError(400, 'unknown kind');
      params.push(req.query.kind);
      kindSql = ` AND n.kind = $${params.length}`;
    }
    let searchSql = '';
    if (req.query.q) {
      params.push(`%${String(req.query.q).slice(0, 120)}%`);
      // What a seller actually does with a book of notes: looks something up.
      searchSql = ` AND (n.subject ILIKE $${params.length} OR n.body ILIKE $${params.length})`;
    }
    params.push(Math.min(Number(req.query.limit) || 100, 300));
    const { rows } = await q(
      `SELECT ${NOTE_COLUMNS} ${NOTE_JOINS}
        WHERE ${where.sql}${kindSql}${searchSql}
        ORDER BY n.pinned DESC, n.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ kinds: KINDS, notes: rows });
  }));

  // Writing one. Owner and reviewer both may: a note reaches nobody, so
  // there is nothing here for the gate to protect.
  app.post('/api/notes', wrap(async (req, res) => {
    const businessId = assertUuid(req.body?.business_id, 'business_id');
    assertInScope(req.user, businessId);
    const fields = readBody(req.body ?? {});
    await assertLinksOnFloor(businessId, fields);
    const agentId = req.body?.agent_id
      ? assertUuid(req.body.agent_id, 'agent_id')
      : await secretaryDesk(businessId);

    const note = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO business_notes
           (business_id, agent_id, kind, subject, body, order_id, product_id,
            conversation_id, account_id, author, author_user_id, pinned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [businessId, agentId, fields.kind ?? 'note', fields.subject, fields.body,
         fields.order_id ?? null, fields.product_id ?? null,
         fields.conversation_id ?? null, fields.account_id ?? null,
         req.user.email, req.user.id, fields.pinned ?? false],
      );
      await logAction(client, {
        businessId,
        agentId,
        action: 'NOTE_WRITTEN',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { kind: fields.kind ?? 'note', subject: fields.subject },
      });
      return rows[0];
    });
    res.status(201).json({ ok: true, note: await readNote(note.id) });
  }));

  app.patch('/api/notes/:id', wrap(async (req, res) => {
    const existing = await readNote(req.params.id);
    if (!existing) throw new HttpError(404, 'note not found');
    assertInScope(req.user, existing.business_id);
    const fields = readBody(req.body ?? {}, { partial: true });
    if (!Object.keys(fields).length) throw new HttpError(400, 'nothing to change');
    await assertLinksOnFloor(existing.business_id, fields);

    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    await tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE business_notes SET ${sets}
          WHERE id = $1 AND business_id = ANY($2::uuid[]) RETURNING id`,
        [existing.id, req.user.businessIds, ...keys.map((k) => fields[k])],
      );
      if (!rows[0]) throw new HttpError(404, 'note not found');
      await logAction(client, {
        businessId: existing.business_id,
        agentId: existing.agent_id,
        action: 'NOTE_EDITED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { changed: keys },
      });
    });
    res.json({ ok: true, note: await readNote(existing.id) });
  }));

  // Throwing a record away is an owner's call, and the log keeps the fact
  // that it existed even once the text is gone.
  app.delete('/api/notes/:id', wrap(async (req, res) => {
    const existing = await readNote(req.params.id);
    if (!existing) throw new HttpError(404, 'note not found');
    assertInScope(req.user, existing.business_id);
    requireOwner(req.user, existing.business_id);
    await tx(async (client) => {
      await client.query(
        `DELETE FROM business_notes WHERE id = $1 AND business_id = ANY($2::uuid[])`,
        [existing.id, req.user.businessIds]);
      await logAction(client, {
        businessId: existing.business_id,
        action: 'NOTE_DELETED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { kind: existing.kind, subject: existing.subject },
      });
    });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------- internal (n8n)

  /** The Secretary desk files a note of its own. */
  app.post('/api/internal/notes', wrap(async (req, res) => {
    const body = req.body ?? {};
    const asked = body.business_id ? assertUuid(body.business_id, 'business_id') : null;
    const code = body.business_code ? String(body.business_code) : null;
    if (!asked && !code) throw new HttpError(400, 'business_id or business_code is required');
    const { rows: floors } = await q(
      `SELECT id FROM businesses
        WHERE ($1::uuid IS NULL OR id = $1::uuid)
          AND ($2::text IS NULL OR code = $2::text)`, [asked, code]);
    if (!floors[0]) throw new HttpError(404, 'business not found');
    const businessId = floors[0].id;
    const closed = await internalGate(businessId);
    if (closed) { res.status(423).json(closed); return; }

    const fields = readBody(body);
    await assertLinksOnFloor(businessId, fields);
    const agentId = await secretaryDesk(businessId);

    const note = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO business_notes
           (business_id, agent_id, kind, subject, body, order_id, product_id,
            conversation_id, account_id, author, pinned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'the Secretary desk', $10)
         RETURNING id`,
        [businessId, agentId, fields.kind ?? 'note', fields.subject, fields.body,
         fields.order_id ?? null, fields.product_id ?? null,
         fields.conversation_id ?? null, fields.account_id ?? null,
         fields.pinned ?? false],
      );
      await logAction(client, {
        businessId,
        agentId,
        action: 'NOTE_WRITTEN',
        actor: 'n8n',
        detail: { kind: fields.kind ?? 'note', subject: fields.subject },
      });
      return rows[0];
    });
    res.status(201).json({ ok: true, note: await readNote(note.id) });
  }));

  /**
   * The day's record, compiled from what the floor actually did.
   *
   * Deliberately counted rather than written by a model: a seller reading
   * "4 replies went out, 2 are still waiting, PHP 3,400 in three orders"
   * needs it to be true more than it needs it to be prose, and these are
   * numbers the database already holds. Nothing here can hallucinate.
   *
   * Upserted on (business_id, note_date), so a sweep that runs twice — or a
   * day re-compiled after more happened — rewrites the same note instead of
   * filling the book with duplicates.
   */
  app.post('/api/internal/notes/daily', wrap(async (req, res) => {
    const body = req.body ?? {};
    const asked = body.business_id ? assertUuid(body.business_id, 'business_id') : null;
    const code = body.business_code ? String(body.business_code) : null;
    if (!asked && !code) throw new HttpError(400, 'business_id or business_code is required');
    const { rows: floors } = await q(
      `SELECT id, code, name, timezone, currency FROM businesses
        WHERE ($1::uuid IS NULL OR id = $1::uuid)
          AND ($2::text IS NULL OR code = $2::text)`, [asked, code]);
    const floor = floors[0];
    if (!floor) throw new HttpError(404, 'business not found');
    const closed = await internalGate(floor.id);
    if (closed) { res.status(423).json(closed); return; }

    // The floor's own day, not the server's. A shop in Manila swept by a
    // machine in Virginia would otherwise get yesterday's date on it.
    const zone = floor.timezone || 'Asia/Manila';
    const { rows: dates } = await q(
      `SELECT ($1::text IS NOT NULL)::bool AS given,
              COALESCE($1::date, (now() AT TIME ZONE $2)::date) AS day`,
      [body.note_date ?? null, zone]);
    const day = dates[0].day;

    const { rows: counted } = await q(
      `WITH span AS (
         SELECT ($1::date)::timestamp AT TIME ZONE $2 AS from_ts,
                (($1::date + 1))::timestamp AT TIME ZONE $2 AS to_ts
       )
       SELECT
         (SELECT count(*)::int FROM action_logs l, span w
           WHERE l.business_id = $3 AND l.action = 'APPROVE_TASK'
             AND l.created_at >= w.from_ts AND l.created_at < w.to_ts) AS approved,
         (SELECT count(*)::int FROM action_logs l, span w
           WHERE l.business_id = $3 AND l.action = 'REJECT_TASK'
             AND l.created_at >= w.from_ts AND l.created_at < w.to_ts) AS rejected,
         (SELECT count(*)::int FROM action_logs l, span w
           WHERE l.business_id = $3 AND l.action = 'APPROVE_TASK' AND l.actor = 'auto'
             AND l.created_at >= w.from_ts AND l.created_at < w.to_ts) AS answered_itself,
         (SELECT count(*)::int FROM action_logs l, span w
           WHERE l.business_id = $3 AND l.action = 'MESSAGE_SENT'
             AND l.created_at >= w.from_ts AND l.created_at < w.to_ts) AS replies_sent,
         (SELECT count(*)::int FROM action_logs l, span w
           WHERE l.business_id = $3 AND l.action = 'MESSAGE_RECEIVED'
             AND l.created_at >= w.from_ts AND l.created_at < w.to_ts) AS buyers_wrote,
         (SELECT count(*)::int FROM orders o, span w
           WHERE o.business_id = $3
             AND o.created_at >= w.from_ts AND o.created_at < w.to_ts) AS orders,
         (SELECT COALESCE(sum(o.total), 0) FROM orders o, span w
           WHERE o.business_id = $3
             AND o.created_at >= w.from_ts AND o.created_at < w.to_ts) AS order_value,
         (SELECT count(*)::int FROM approvals a
           WHERE a.business_id = $3 AND a.status = 'PENDING') AS still_waiting,
         (SELECT count(*)::int FROM conversations c
           WHERE c.business_id = $3 AND c.status = 'OPEN') AS threads_open,
         (SELECT count(*)::int FROM agents ag
           WHERE ag.business_id = $3 AND ag.removed_at IS NULL
             AND ag.status = 'PAUSED') AS desks_paused`,
      [day, zone, floor.id],
    );
    const n = counted[0];

    // Only the lines that have something to say. A day with no orders should
    // not read "0 orders" in a list of zeroes; it should not mention orders.
    const lines = [];
    if (n.buyers_wrote) lines.push(`- ${n.buyers_wrote} buyer message${n.buyers_wrote === 1 ? '' : 's'} came in.`);
    if (n.replies_sent) {
      const byItself = n.answered_itself
        ? ` ${n.answered_itself} of them the desk answered on its own.` : '';
      lines.push(`- ${n.replies_sent} repl${n.replies_sent === 1 ? 'y' : 'ies'} went out.${byItself}`);
    }
    if (n.approved) lines.push(`- ${n.approved} draft${n.approved === 1 ? '' : 's'} approved.`);
    if (n.rejected) lines.push(`- ${n.rejected} turned down and sent back for a rewrite.`);
    if (n.orders) {
      lines.push(`- ${n.orders} order${n.orders === 1 ? '' : 's'}, ${money(n.order_value)} in total.`);
    }
    if (n.still_waiting) {
      lines.push(`- ${n.still_waiting} draft${n.still_waiting === 1 ? '' : 's'} still waiting for somebody.`);
    }
    if (n.threads_open) {
      lines.push(`- ${n.threads_open} thread${n.threads_open === 1 ? '' : 's'} with nobody's answer on it yet.`);
    }
    if (n.desks_paused) {
      lines.push(`- ${n.desks_paused} desk${n.desks_paused === 1 ? ' is' : 's are'} paused.`);
    }
    const text = lines.length
      ? lines.join('\n')
      : 'Nothing happened on the floor today — no buyer wrote, nothing was '
        + 'approved and no order came in.';

    const agentId = await secretaryDesk(floor.id);
    const note = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO business_notes
           (business_id, agent_id, kind, subject, body, author, note_date)
         VALUES ($1, $2, 'daily', $3, $4, 'the Secretary desk', $5)
         ON CONFLICT (business_id, note_date) WHERE kind = 'daily'
         DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body
         RETURNING id`,
        [floor.id, agentId, `What happened on ${day.toISOString().slice(0, 10)}`,
         text, day],
      );
      await logAction(client, {
        businessId: floor.id,
        agentId,
        action: 'DAILY_RECORD_WRITTEN',
        actor: 'n8n',
        detail: { note_date: day.toISOString().slice(0, 10), lines: lines.length },
      });
      return rows[0];
    });
    res.status(201).json({ ok: true, counted: n, note: await readNote(note.id) });
  }));
}
