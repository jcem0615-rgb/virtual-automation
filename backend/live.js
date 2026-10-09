// Live selling: a stream, the items pinned to it, what the room is doing, and
// the viewers who shout "mine".
//
// What is actually possible, platform by platform, because the difference
// decides the whole design:
//
// * TikTok. Real. TikTok Shop lets a seller attach catalogue products to a
//   LIVE room, and a viewer taps the basket — the yellow one in the corner of
//   the stream — and checks out without leaving it. So a TikTok session's
//   basket rows are pinned through the API: `live_basket_items.external_id`
//   is the showcase id it hands back, and `slot` is the number the host calls
//   out ("item three, 290 pesos").
//
// * Facebook. Gone. Meta retired Live Shopping: product tagging in a Facebook
//   Live ended on 1 October 2022, and Instagram's followed in March 2023.
//   There is no basket to pin to and no API that would put one back. What
//   still works — and what sellers here do every night — is reading the
//   comments: a viewer types "mine" or "3 mine", the desk holds the stock and
//   sends them a checkout link. So a facebook session keeps the same basket
//   rows, as the host's own numbered list, and says on screen that the taps
//   are gone and the comments are the till.
//
// The gate still holds, but it is armed once rather than per message: pinning
// the basket is an approval, arming the session is an approval, and that
// arming approval is what authorises the desk to answer claims inside this
// session with the one template a human read and approved. Nothing improvises
// a sentence at a customer. Pausing the session withdraws it immediately.

export const LIVE_PLATFORMS = ['tiktok', 'facebook'];

// Only TikTok has a tappable basket; see the note above.
export const BASKET_SUPPORTED = { tiktok: true, facebook: false };

const BASKET_NOTE = {
  tiktok: 'Viewers tap the basket in the stream and check out there.',
  facebook: 'Meta retired Live Shopping in October 2022, so there is no basket to tap. '
          + 'This list is the one the host reads out, and the comments are the till.',
};

// What a comment has to look like to count as buying something. Kept narrow on
// purpose: a false positive holds stock away from someone who meant it.
//   "mine", "mine 2", "2 mine", "item 3 mine", "sold 3", "#3 mine", "x2 mine"
const CLAIM_PATTERNS = [
  /\b(?:item|no\.?|#)\s*(\d{1,2})\b[^0-9]{0,12}\b(?:mine|sold|akin|get)\b/i,
  /\b(?:mine|sold|akin|get)\b[^0-9]{0,12}\b(?:item|no\.?|#)?\s*(\d{1,2})\b/i,
];
const QTY_PATTERN = /\b(?:x\s*(\d{1,2})|(\d{1,2})\s*(?:pcs?|pieces?|units?))\b/i;

/**
 * Read a live comment for buy intent. Returns { slot, qty } or null.
 * A bare "mine" with one item in the basket is taken as that item; with
 * several it is ambiguous and is left alone rather than guessed.
 */
export function readClaim(text, slots = []) {
  const line = String(text ?? '');
  for (const pattern of CLAIM_PATTERNS) {
    const hit = pattern.exec(line);
    if (hit) {
      const slot = Number(hit[1]);
      if (slots.includes(slot)) return { slot, qty: readQty(line) };
    }
  }
  if (/\b(?:mine|sold|akin|get)\b/i.test(line) && slots.length === 1) {
    return { slot: slots[0], qty: readQty(line) };
  }
  return null;
}

function readQty(line) {
  const hit = QTY_PATTERN.exec(line);
  const n = Number(hit?.[1] ?? hit?.[2] ?? 1);
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : 1;
}

export function registerLive(app, ctx) {
  const {
    q, tx, wrap, HttpError, assertUuid, businessClause, scopeFor, requireOwner,
    assertInScope, logAction, settleAgent, deskFor, requireUser,
    registerApprovalType, liveWebhookUrl, internalGate,
  } = ctx;

  // ------------------------------------------------------------- readers

  const SESSION_COLUMNS = `
    s.id, s.business_id, s.account_id, s.platform, s.title, s.external_id,
    s.status, s.armed_approval_id, s.reply_template, s.hold_minutes,
    s.scheduled_for, s.started_at, s.ended_at, s.created_at,
    acc.label AS account_label,
    COALESCE((
      SELECT json_agg(json_build_object(
               'id', b.id, 'product_id', b.product_id, 'slot', b.slot,
               'name', p.name, 'sku', p.sku, 'shelf_price', p.price,
               'live_price', b.live_price, 'allocation', b.allocation,
               'reserved', b.reserved, 'sold', b.sold, 'stock', p.stock,
               'state', b.state, 'external_id', b.external_id,
               'last_error', b.last_error) ORDER BY b.slot)
        FROM live_basket_items b
        JOIN products p ON p.id = b.product_id
       WHERE b.session_id = s.id
    ), '[]') AS basket,
    (SELECT json_build_object(
              'sampled_at', m.sampled_at, 'viewers', m.viewers, 'likes', m.likes,
              'comments', m.comments, 'basket_opens', m.basket_opens,
              'orders', m.orders, 'revenue', m.revenue)
       FROM live_metrics m WHERE m.session_id = s.id
      ORDER BY m.sampled_at DESC LIMIT 1) AS latest,
    (SELECT json_build_object(
              'peak_viewers', COALESCE(max(m.viewers), 0),
              'samples', count(*)::int,
              'comments', COALESCE(max(m.comments), 0),
              'basket_opens', COALESCE(max(m.basket_opens), 0),
              'orders', COALESCE(max(m.orders), 0),
              'revenue', COALESCE(max(m.revenue), 0))
       FROM live_metrics m WHERE m.session_id = s.id) AS totals,
    (SELECT count(*)::int FROM live_claims c
      WHERE c.session_id = s.id AND c.status IN ('HELD', 'CHECKOUT_SENT')) AS open_claims`;

  async function readSessions(scope, { status, limit = 50 } = {}) {
    const where = businessClause(scope, { column: 's.business_id' });
    const params = [...where.params];
    let extra = '';
    if (status && status !== 'all') {
      params.push(status);
      extra = ` AND s.status = $${params.length}`;
    }
    params.push(Math.min(Number(limit) || 50, 100));
    const { rows } = await q(
      `SELECT ${SESSION_COLUMNS}
         FROM live_sessions s
         LEFT JOIN platform_accounts acc ON acc.id = s.account_id
        WHERE ${where.sql}${extra}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(decorate);
  }

  async function readSession(id) {
    assertUuid(id, 'session_id');
    const { rows } = await q(
      `SELECT ${SESSION_COLUMNS}
         FROM live_sessions s
         LEFT JOIN platform_accounts acc ON acc.id = s.account_id
        WHERE s.id = $1`, [id]);
    return rows[0] ? decorate(rows[0]) : null;
  }

  // Say on the row itself what this platform can and cannot do, so the UI
  // never has to decide it and never gets it wrong.
  const decorate = (row) => ({
    ...row,
    basket_supported: BASKET_SUPPORTED[row.platform] ?? false,
    basket_note: BASKET_NOTE[row.platform] ?? '',
  });

  async function readClaims(sessionId, limit = 100) {
    const { rows } = await q(
      `SELECT c.id, c.buyer_name, c.buyer_handle, c.qty, c.comment_text, c.status,
              c.checkout_url, c.holds_until, c.created_at, c.order_id,
              b.slot, p.name AS product_name, p.sku
         FROM live_claims c
         JOIN live_basket_items b ON b.id = c.basket_item_id
         JOIN products p ON p.id = b.product_id
        WHERE c.session_id = $1
        ORDER BY c.created_at DESC LIMIT $2`,
      [sessionId, Math.min(Number(limit) || 100, 200)]);
    return rows;
  }

  // ------------------------------------------------------------- the gate

  const basketRollback = (sessionId, failed) => tx(async (client) => {
    await client.query(
      `UPDATE live_basket_items SET state = $2, last_error = $3
        WHERE session_id = $1 AND state = 'PIN_PENDING'`,
      [sessionId, failed ? 'FAILED' : 'REMOVED', failed ?? null]);
    await client.query(
      `UPDATE live_basket_items SET state = 'PINNED', last_error = $2
        WHERE session_id = $1 AND state = 'UNPIN_PENDING'`,
      [sessionId, failed ?? null]);
  });

  registerApprovalType('live_pin', {
    label: 'live basket',
    webhook: () => liveWebhookUrl(),
    enrich: async (payload) => ({ session: await readSession(payload.session_id) }),
    onDispatchFailed: (payload, why) => basketRollback(payload.session_id, why),
    onRejected: async (payload) => {
      await basketRollback(payload.session_id, null);
      return { basket: 'discarded' };
    },
  });

  registerApprovalType('live_arm', {
    label: 'live session',
    webhook: () => liveWebhookUrl(),
    enrich: async (payload) => ({ session: await readSession(payload.session_id) }),
    onDispatchFailed: (payload) => q(
      `UPDATE live_sessions SET status = 'SCHEDULED', armed_approval_id = NULL
        WHERE id = $1 AND status = 'ARMED'`, [payload.session_id]),
    onRejected: async (payload) => {
      await q(
        `UPDATE live_sessions SET status = 'SCHEDULED', armed_approval_id = NULL
          WHERE id = $1 AND status IN ('ARMED', 'SCHEDULED')`, [payload.session_id]);
      return { session: 'not armed' };
    },
  });

  // ------------------------------------------------------------- the API

  app.use('/api/live', requireUser);

  app.get('/api/live', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    res.json({
      platforms: LIVE_PLATFORMS.map((platform) => ({
        platform,
        basket_supported: BASKET_SUPPORTED[platform],
        note: BASKET_NOTE[platform],
      })),
      sessions: await readSessions(scope, { status: req.query.status, limit: req.query.limit }),
    });
  }));

  app.get('/api/live/:id', wrap(async (req, res) => {
    const session = await readSession(req.params.id);
    if (!session) throw new HttpError(404, 'session not found');
    assertInScope(req.user, session.business_id);
    const { rows: series } = await q(
      `SELECT sampled_at, viewers, likes, comments, basket_opens, orders, revenue
         FROM live_metrics WHERE session_id = $1
        ORDER BY sampled_at DESC LIMIT 120`, [session.id]);
    res.json({ session, claims: await readClaims(session.id), series: series.reverse() });
  }));

  // Booking a stream is an owner's call: it commits stock and a reply script.
  app.post('/api/live', wrap(async (req, res) => {
    const body = req.body ?? {};
    const businessId = assertUuid(body.business_id, 'business_id');
    assertInScope(req.user, businessId);
    requireOwner(req.user, businessId);

    const platform = String(body.platform ?? '');
    if (!LIVE_PLATFORMS.includes(platform)) {
      throw new HttpError(400, 'a live session runs on tiktok or facebook');
    }
    const title = String(body.title ?? '').trim();
    if (!title) throw new HttpError(400, 'give the stream a title');

    const accountId = body.account_id ? assertUuid(body.account_id, 'account_id') : null;
    if (accountId) {
      const { rows } = await q(
        `SELECT 1 FROM platform_accounts
          WHERE id = $1 AND business_id = $2 AND platform = $3`,
        [accountId, businessId, platform]);
      if (!rows[0]) throw new HttpError(404, `that is not a ${platform} account on this business`);
    }
    const hold = Math.round(Number(body.hold_minutes ?? 15));
    if (!Number.isFinite(hold) || hold < 1 || hold > 180) {
      throw new HttpError(400, 'a hold is between 1 and 180 minutes');
    }

    const session = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO live_sessions (business_id, account_id, platform, title,
                                    reply_template, hold_minutes, scheduled_for)
         VALUES ($1,$2,$3,$4,
                 COALESCE(NULLIF($5, ''), DEFAULT_TEMPLATE()), $6, $7)
         RETURNING id`.replace('DEFAULT_TEMPLATE()',
            `'Reserved for you, {buyer}. Checkout link: {checkout_url} — it holds for {minutes} minutes.'`),
        [businessId, accountId, platform, title.slice(0, 300),
         String(body.reply_template ?? '').trim().slice(0, 500), hold,
         body.scheduled_for ?? null],
      );
      await logAction(client, {
        businessId,
        action: 'LIVE_SESSION_CREATED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { platform, title, hold_minutes: hold },
      });
      return rows[0];
    });

    res.status(201).json({ ok: true, session: await readSession(session.id) });
  }));

  /**
   * Put items in the basket. This reaches a platform — on TikTok it literally
   * pins them to the room — so it is filed for approval, with the slot numbers
   * and the live prices a human can read before any of it is public.
   */
  app.post('/api/live/:id/basket', wrap(async (req, res) => {
    const session = await readSession(req.params.id);
    if (!session) throw new HttpError(404, 'session not found');
    assertInScope(req.user, session.business_id);
    requireOwner(req.user, session.business_id);
    if (['ENDED'].includes(session.status)) throw new HttpError(409, 'that stream is over');

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) throw new HttpError(400, 'choose at least one product');
    if (items.length > 50) throw new HttpError(400, 'that is more than a basket holds');

    // Resolve every product first, so a bad id fails before anything is written.
    const resolved = [];
    const seenSlots = new Set();
    for (const [index, item] of items.entries()) {
      const productId = assertUuid(item.product_id, 'product_id');
      const { rows } = await q(
        `SELECT id, name, sku, price, stock FROM products
          WHERE id = $1 AND business_id = $2`, [productId, session.business_id]);
      const product = rows[0];
      if (!product) throw new HttpError(404, 'one of those products is not on this business');

      const slot = Math.round(Number(item.slot ?? index + 1));
      if (!Number.isFinite(slot) || slot < 1 || slot > 99) {
        throw new HttpError(400, `slot ${item.slot} is not a number the host can call out`);
      }
      if (seenSlots.has(slot)) throw new HttpError(400, `two items cannot both be item ${slot}`);
      seenSlots.add(slot);

      const allocation = Math.round(Number(item.allocation ?? product.stock));
      if (!Number.isFinite(allocation) || allocation < 0) {
        throw new HttpError(400, 'an allocation is 0 or more');
      }
      if (allocation > product.stock) {
        throw new HttpError(409,
          `you cannot put ${allocation} of ${product.name} in the basket; there are ${product.stock} on the shelf`);
      }
      const livePrice = item.live_price === null || item.live_price === undefined
        ? null : Number(item.live_price);
      if (livePrice !== null && (!Number.isFinite(livePrice) || livePrice < 0)) {
        throw new HttpError(400, 'a live price is 0 or more');
      }
      resolved.push({ product, slot, allocation, livePrice });
    }

    const agentId = await deskFor(session.business_id, 'Marketing');
    const approval = await tx(async (client) => {
      for (const r of resolved) {
        await client.query(
          `INSERT INTO live_basket_items
             (session_id, business_id, product_id, slot, live_price, allocation, state)
           VALUES ($1,$2,$3,$4,$5,$6,'PIN_PENDING')
           ON CONFLICT (session_id, product_id) DO UPDATE
             SET slot = EXCLUDED.slot, live_price = EXCLUDED.live_price,
                 allocation = EXCLUDED.allocation, state = 'PIN_PENDING',
                 last_error = NULL`,
          [session.id, session.business_id, r.product.id, r.slot, r.livePrice, r.allocation],
        );
      }
      const lines = resolved
        .map((r) => `${r.slot}. ${r.product.name} — ${r.livePrice ?? r.product.price} (${r.allocation} up)`)
        .join('\n');
      const { rows } = await client.query(
        `INSERT INTO approvals (business_id, agent_id, payload_json)
         VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [session.business_id, agentId, JSON.stringify({
          type: 'live_pin',
          title: `Basket for "${session.title}" (${resolved.length} item${resolved.length === 1 ? '' : 's'})`,
          draft: session.basket_supported
            ? `These go in the basket on ${session.platform}:\n\n${lines}`
            : `${BASKET_NOTE[session.platform]}\n\nThe host reads out:\n\n${lines}`,
          channel: session.platform,
          session_id: session.id,
          product_ids: resolved.map((r) => r.product.id),
          source: { session_id: session.id, requested_by: req.user.email },
        })],
      );
      await settleAgent(client, {
        agentId,
        businessId: session.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Basket waiting: ${session.title}`.slice(0, 500),
      });
      await logAction(client, {
        businessId: session.business_id,
        agentId,
        approvalId: rows[0].id,
        action: 'LIVE_BASKET_SUBMITTED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { session: session.title, items: resolved.length },
      });
      return rows[0];
    });

    res.json({ ok: true, needs_approval: true, approval_id: approval.id });
  }));

  /**
   * Arm the session. This is the one approval that stands in for all the ones
   * a live stream has no time for: a human reads the exact sentence the desk
   * will send a claimer, and approving it is what lets that sentence go out
   * — unchanged, with only the buyer's name and their link filled in.
   */
  app.post('/api/live/:id/arm', wrap(async (req, res) => {
    const session = await readSession(req.params.id);
    if (!session) throw new HttpError(404, 'session not found');
    assertInScope(req.user, session.business_id);
    requireOwner(req.user, session.business_id);
    if (session.status === 'ENDED') throw new HttpError(409, 'that stream is over');
    if (session.armed_approval_id && ['ARMED', 'LIVE'].includes(session.status)) {
      throw new HttpError(409, 'that session is already armed');
    }
    const pinned = (session.basket ?? []).filter((b) => b.state === 'PINNED');
    if (!pinned.length) {
      throw new HttpError(409, 'put something in the basket and get it approved first');
    }

    const template = String(req.body?.reply_template ?? session.reply_template).trim();
    if (!template) throw new HttpError(400, 'the desk needs a line to send');
    if (!template.includes('{checkout_url}')) {
      throw new HttpError(400,
        'the reply has to include {checkout_url}, or a claimer has no way to pay');
    }

    const agentId = await deskFor(session.business_id, 'Payments');
    const example = template
      .replace('{buyer}', 'Maria')
      .replace('{checkout_url}', 'https://…/checkout/abc123')
      .replace('{minutes}', String(session.hold_minutes))
      .replace('{item}', pinned[0].name)
      .replace('{price}', String(pinned[0].live_price ?? pinned[0].shelf_price));

    const approval = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO approvals (business_id, agent_id, payload_json)
         VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [session.business_id, agentId, JSON.stringify({
          type: 'live_arm',
          title: `Arm "${session.title}" — ${pinned.length} item${pinned.length === 1 ? '' : 's'}, ${session.hold_minutes}-minute holds`,
          draft: `Approving this lets the Payments desk answer claims in this one `
               + `stream, with exactly this line and nothing else:\n\n${example}\n\n`
               + `Each claim holds its item for ${session.hold_minutes} minutes and then `
               + `puts it back. Pausing the session withdraws this straight away.`,
          channel: session.platform,
          session_id: session.id,
          reply_template: template,
          source: { session_id: session.id, requested_by: req.user.email },
        })],
      );
      await client.query(
        `UPDATE live_sessions SET status = 'ARMED', reply_template = $2,
                                  armed_approval_id = $3
          WHERE id = $1`,
        [session.id, template.slice(0, 500), rows[0].id]);
      await settleAgent(client, {
        agentId,
        businessId: session.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Arming waiting: ${session.title}`.slice(0, 500),
      });
      await logAction(client, {
        businessId: session.business_id,
        agentId,
        approvalId: rows[0].id,
        action: 'LIVE_ARM_SUBMITTED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { session: session.title, hold_minutes: session.hold_minutes },
      });
      return rows[0];
    });

    res.json({ ok: true, needs_approval: true, approval_id: approval.id });
  }));

  /**
   * Stop the session answering anybody, now. The live equivalent of the kill
   * switch: holds stay held so nobody loses their place, but no further claim
   * is taken and no further line goes out until it is armed again.
   */
  app.post('/api/live/:id/pause', wrap(async (req, res) => {
    const session = await readSession(req.params.id);
    if (!session) throw new HttpError(404, 'session not found');
    assertInScope(req.user, session.business_id);
    requireOwner(req.user, session.business_id);
    if (session.status === 'ENDED') throw new HttpError(409, 'that stream is already over');

    const resume = req.body?.resume === true;
    if (resume && !session.armed_approval_id) {
      throw new HttpError(409, 'that session was never armed, so there is nothing to resume');
    }

    await tx(async (client) => {
      await client.query(
        `UPDATE live_sessions SET status = $2, armed_approval_id = $3 WHERE id = $1`,
        [session.id,
         resume ? 'LIVE' : 'PAUSED',
         resume ? session.armed_approval_id : null]);
      await logAction(client, {
        businessId: session.business_id,
        action: resume ? 'LIVE_RESUMED' : 'LIVE_PAUSED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { session: session.title, open_claims: session.open_claims },
      });
    });
    res.json({ ok: true, session: await readSession(session.id) });
  }));

  /** End it. Anything still held goes back on the shelf. */
  app.post('/api/live/:id/end', wrap(async (req, res) => {
    const session = await readSession(req.params.id);
    if (!session) throw new HttpError(404, 'session not found');
    assertInScope(req.user, session.business_id);
    requireOwner(req.user, session.business_id);
    if (session.status === 'ENDED') { res.json({ ok: true, session }); return; }

    const out = await tx(async (client) => {
      const { rows: expired } = await client.query(
        `UPDATE live_claims SET status = 'EXPIRED'
          WHERE session_id = $1 AND status IN ('HELD', 'CHECKOUT_SENT')
          RETURNING basket_item_id, qty`, [session.id]);
      for (const claim of expired) {
        await client.query(
          `UPDATE live_basket_items SET reserved = GREATEST(0, reserved - $2)
            WHERE id = $1`, [claim.basket_item_id, claim.qty]);
      }
      await client.query(
        `UPDATE live_basket_items SET state = 'REMOVED'
          WHERE session_id = $1 AND state IN ('PINNED', 'PIN_PENDING', 'UNPIN_PENDING')`,
        [session.id]);
      await client.query(
        `UPDATE live_sessions SET status = 'ENDED', ended_at = now(),
                                  armed_approval_id = NULL
          WHERE id = $1`, [session.id]);
      await logAction(client, {
        businessId: session.business_id,
        action: 'LIVE_ENDED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { session: session.title, holds_released: expired.length },
      });
      return { holds_released: expired.length };
    });
    res.json({ ok: true, ...out, session: await readSession(session.id) });
  }));

  // ------------------------------------------------------- internal (n8n)

  /**
   * The rooms a sweep should be watching. `armed` is the one word the
   * workflow needs: a session is only answerable when a human approved it and
   * nobody has paused it since.
   */
  app.get('/api/internal/live/sessions', wrap(async (req, res) => {
    const status = String(req.query.status ?? 'LIVE').toUpperCase();
    if (!['SCHEDULED', 'ARMED', 'LIVE', 'PAUSED', 'ENDED', 'ALL'].includes(status)) {
      throw new HttpError(400, 'unknown status');
    }
    const { rows } = await q(
      `SELECT s.id FROM live_sessions s
         JOIN businesses b ON b.id = s.business_id AND b.is_active
        WHERE ($1 = 'ALL' OR s.status = $1)
        ORDER BY s.started_at DESC NULLS LAST LIMIT 50`, [status]);
    const sessions = [];
    for (const row of rows) {
      const session = await readSession(row.id);
      if (!session) continue;
      const { rows: approval } = await q(
        `SELECT status FROM approvals WHERE id = $1`, [session.armed_approval_id ?? null]);
      sessions.push({
        ...session,
        armed: session.status === 'LIVE' && approval[0]?.status === 'APPROVED',
      });
    }
    res.json({ sessions });
  }));

  /** Everything the live workflow needs to run one session. */
  app.get('/api/internal/live/:id', wrap(async (req, res) => {
    const session = await readSession(req.params.id);
    if (!session) throw new HttpError(404, 'session not found');
    const { rows: approval } = await q(
      `SELECT status FROM approvals WHERE id = $1`, [session.armed_approval_id ?? null]);
    res.json({
      session,
      // The workflow is told in one word whether it may answer anybody.
      armed: session.status === 'LIVE' && approval[0]?.status === 'APPROVED',
      claims: await readClaims(session.id, 50),
    });
  }));

  /** The stream is up, or it has finished. */
  app.post('/api/internal/live/:id/state', wrap(async (req, res) => {
    const sessionId = assertUuid(req.params.id, 'session_id');
    const wanted = String(req.body?.status ?? '').toUpperCase();
    if (!['LIVE', 'ENDED'].includes(wanted)) {
      throw new HttpError(400, 'a workflow may only report LIVE or ENDED');
    }
    const { rows } = await q(
      `SELECT s.id, s.business_id, s.status, s.armed_approval_id, b.is_active,
              a.status AS approval_status
         FROM live_sessions s
         JOIN businesses b ON b.id = s.business_id
         LEFT JOIN approvals a ON a.id = s.armed_approval_id
        WHERE s.id = $1`, [sessionId]);
    const session = rows[0];
    if (!session) throw new HttpError(404, 'session not found');
    if (!session.is_active) {
      res.status(423).json({ ok: false, status: 'SUSPENDED',
        error: 'this business is suspended — abort this run' });
      return;
    }
    // A stream only goes LIVE if a human armed it, and a paused one stays
    // paused: the workflow does not get to lift either.
    if (wanted === 'LIVE') {
      if (session.status === 'PAUSED') {
        res.status(423).json({ ok: false, status: 'PAUSED',
          error: 'this session is paused — abort this run' });
        return;
      }
      if (session.approval_status !== 'APPROVED') {
        res.status(423).json({ ok: false, status: 'NOT_ARMED',
          error: 'nobody has approved this session yet — abort this run' });
        return;
      }
    }

    await tx(async (client) => {
      await client.query(
        `UPDATE live_sessions
            SET status = $2, external_id = COALESCE($3, external_id),
                started_at = CASE WHEN $2 = 'LIVE'
                                  THEN COALESCE(started_at, now()) ELSE started_at END,
                ended_at = CASE WHEN $2 = 'ENDED' THEN now() ELSE ended_at END
          WHERE id = $1 AND status <> 'PAUSED'`,
        [sessionId, wanted, req.body?.external_id ?? null]);
      await logAction(client, {
        businessId: session.business_id,
        action: wanted === 'LIVE' ? 'LIVE_STARTED' : 'LIVE_ENDED',
        actor: 'n8n',
        detail: { external_id: req.body?.external_id ?? null },
      });
    });
    res.json({ ok: true });
  }));

  /** The result of pinning each basket item on the platform. */
  app.post('/api/internal/live/:id/basket', wrap(async (req, res) => {
    const sessionId = assertUuid(req.params.id, 'session_id');
    const results = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!results.length) throw new HttpError(400, 'report at least one item');

    const applied = await tx(async (client) => {
      const out = [];
      for (const item of results) {
        const productId = assertUuid(item.product_id, 'product_id');
        const ok = item.state === 'PINNED' || item.ok === true;
        const { rows } = await client.query(
          `UPDATE live_basket_items
              SET state = $3, external_id = COALESCE($4, external_id), last_error = $5
            WHERE session_id = $1 AND product_id = $2
            RETURNING slot, state`,
          [sessionId, productId, ok ? 'PINNED' : 'FAILED',
           item.external_id ?? null, ok ? null : String(item.error ?? 'the platform refused it')],
        );
        if (rows[0]) out.push({ slot: rows[0].slot, state: rows[0].state });
      }
      return out;
    });
    res.json({ ok: true, items: applied });
  }));

  /** One sample of what the room is doing. This is the monitor. */
  app.post('/api/internal/live/:id/metrics', wrap(async (req, res) => {
    const sessionId = assertUuid(req.params.id, 'session_id');
    const body = req.body ?? {};
    const { rows } = await q(
      `SELECT business_id, status FROM live_sessions WHERE id = $1`, [sessionId]);
    const session = rows[0];
    if (!session) throw new HttpError(404, 'session not found');

    const n = (value) => Math.max(0, Math.round(Number(value ?? 0)) || 0);
    await q(
      `INSERT INTO live_metrics (session_id, business_id, viewers, likes, comments,
                                 basket_opens, orders, revenue)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [sessionId, session.business_id, n(body.viewers), n(body.likes), n(body.comments),
       n(body.basket_opens), n(body.orders), Math.max(0, Number(body.revenue ?? 0))],
    );
    res.status(201).json({ ok: true });
  }));

  /**
   * A comment from the room. The desk reads it for buy intent, holds the item
   * if there is one left, and says so — but only inside a session a human
   * armed, and only in the sentence they approved.
   */
  app.post('/api/internal/live/:id/comments', wrap(async (req, res) => {
    const sessionId = assertUuid(req.params.id, 'session_id');
    const body = req.body ?? {};
    const text = String(body.text ?? '').trim();
    if (!text) throw new HttpError(400, 'a comment needs some text');

    const { rows } = await q(
      `SELECT s.id, s.business_id, s.status, s.reply_template, s.hold_minutes,
              s.platform, s.armed_approval_id, b.is_active, a.status AS approval_status
         FROM live_sessions s
         JOIN businesses b ON b.id = s.business_id
         LEFT JOIN approvals a ON a.id = s.armed_approval_id
        WHERE s.id = $1`, [sessionId]);
    const session = rows[0];
    if (!session) throw new HttpError(404, 'session not found');
    if (!session.is_active) {
      res.status(423).json({ ok: false, status: 'SUSPENDED',
        error: 'this business is suspended — abort this run' });
      return;
    }
    if (session.status === 'PAUSED') {
      res.status(423).json({ ok: false, status: 'PAUSED',
        error: 'this session is paused — nothing goes out' });
      return;
    }
    if (session.status !== 'LIVE' || session.approval_status !== 'APPROVED') {
      res.status(423).json({ ok: false, status: 'NOT_ARMED',
        error: 'this session is not armed, so no reply may be sent' });
      return;
    }

    const { rows: basket } = await q(
      `SELECT b.id, b.slot, b.allocation, b.reserved, b.sold, b.live_price,
              p.id AS product_id, p.name, p.price
         FROM live_basket_items b JOIN products p ON p.id = b.product_id
        WHERE b.session_id = $1 AND b.state = 'PINNED'
        ORDER BY b.slot`, [sessionId]);

    const claim = readClaim(text, basket.map((b) => b.slot));
    if (!claim) { res.json({ ok: true, claimed: false, reason: 'no buy intent read' }); return; }

    const item = basket.find((b) => b.slot === claim.slot);
    const left = item.allocation - item.reserved - item.sold;
    if (left < claim.qty) {
      // Saying "that one is gone" is still a line to a stranger, so it is the
      // approved template's job to carry it — never an improvised apology.
      res.json({
        ok: true, claimed: false, reason: 'sold out',
        slot: item.slot, left: Math.max(0, left),
      });
      return;
    }

    const out = await tx(async (client) => {
      await client.query(
        `UPDATE live_basket_items SET reserved = reserved + $2 WHERE id = $1`,
        [item.id, claim.qty]);
      const { rows: created } = await client.query(
        `INSERT INTO live_claims (session_id, business_id, basket_item_id, buyer_name,
                                  buyer_handle, qty, comment_text, status, holds_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'HELD', now() + ($8 || ' minutes')::interval)
         RETURNING id, holds_until`,
        [sessionId, session.business_id, item.id,
         String(body.buyer_name ?? 'Viewer').slice(0, 200), body.buyer_handle ?? null,
         claim.qty, text.slice(0, 1000), String(session.hold_minutes)],
      );
      await logAction(client, {
        businessId: session.business_id,
        action: 'LIVE_CLAIM_HELD',
        actor: 'n8n',
        detail: {
          slot: item.slot, product: item.name, qty: claim.qty,
          buyer: String(body.buyer_name ?? 'Viewer'),
        },
      });
      return created[0];
    });

    // The exact line a human approved, with only the blanks filled in.
    const reply = session.reply_template
      .replaceAll('{buyer}', String(body.buyer_name ?? 'there'))
      .replaceAll('{minutes}', String(session.hold_minutes))
      .replaceAll('{item}', item.name)
      .replaceAll('{price}', String(item.live_price ?? item.price));

    res.status(201).json({
      ok: true,
      claimed: true,
      claim_id: out.id,
      holds_until: out.holds_until,
      slot: item.slot,
      qty: claim.qty,
      product_id: item.product_id,
      unit_price: item.live_price ?? item.price,
      // {checkout_url} is deliberately still a blank: the workflow has the
      // link and fills it in when it sends, so no half-made link is stored.
      reply_template: reply,
      approved_by_approval_id: session.armed_approval_id,
    });
  }));

  /** What happened to a claim: link sent, paid, expired, cancelled. */
  app.post('/api/internal/live/claims/:id', wrap(async (req, res) => {
    const claimId = assertUuid(req.params.id, 'claim_id');
    const wanted = String(req.body?.status ?? '').toUpperCase();
    if (!['CHECKOUT_SENT', 'PAID', 'EXPIRED', 'CANCELLED'].includes(wanted)) {
      throw new HttpError(400, 'a claim goes to CHECKOUT_SENT, PAID, EXPIRED or CANCELLED');
    }

    const out = await tx(async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.business_id, c.status, c.qty, c.basket_item_id,
                b.slot, p.name
           FROM live_claims c
           JOIN live_basket_items b ON b.id = c.basket_item_id
           JOIN products p ON p.id = b.product_id
          WHERE c.id = $1 FOR UPDATE OF c`, [claimId]);
      const claim = rows[0];
      if (!claim) throw new HttpError(404, 'claim not found');
      if (['PAID', 'EXPIRED', 'CANCELLED'].includes(claim.status)) {
        return { unchanged: true, status: claim.status };
      }

      await client.query(
        `UPDATE live_claims
            SET status = $2, checkout_url = COALESCE($3, checkout_url),
                order_id = COALESCE($4, order_id)
          WHERE id = $1`,
        [claimId, wanted, req.body?.checkout_url ?? null,
         req.body?.order_id ? assertUuid(req.body.order_id, 'order_id') : null]);

      // A hold becomes a sale, or it goes back. Either way the basket's own
      // counters move, so the next claimer is told the truth.
      if (wanted === 'PAID') {
        await client.query(
          `UPDATE live_basket_items
              SET reserved = GREATEST(0, reserved - $2), sold = sold + $2
            WHERE id = $1`, [claim.basket_item_id, claim.qty]);
      } else if (['EXPIRED', 'CANCELLED'].includes(wanted)) {
        await client.query(
          `UPDATE live_basket_items SET reserved = GREATEST(0, reserved - $2)
            WHERE id = $1`, [claim.basket_item_id, claim.qty]);
      }

      await logAction(client, {
        businessId: claim.business_id,
        action: `LIVE_CLAIM_${wanted}`,
        actor: 'n8n',
        detail: { slot: claim.slot, product: claim.name, qty: claim.qty },
      });
      return { status: wanted };
    });
    res.json({ ok: true, ...out });
  }));

  /**
   * Holds that ran out. Called on a timer: a claim nobody paid for puts its
   * item back, because the next viewer asking for it should be able to have
   * it rather than be told it is gone by a ghost.
   */
  app.post('/api/internal/live/expire-holds', wrap(async (req, res) => {
    const businessId = req.body?.business_id
      ? assertUuid(req.body.business_id, 'business_id') : null;
    const out = await tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE live_claims SET status = 'EXPIRED'
          WHERE status IN ('HELD', 'CHECKOUT_SENT')
            AND holds_until IS NOT NULL AND holds_until < now()
            AND ($1::uuid IS NULL OR business_id = $1)
          RETURNING id, business_id, basket_item_id, qty`, [businessId]);
      for (const claim of rows) {
        await client.query(
          `UPDATE live_basket_items SET reserved = GREATEST(0, reserved - $2)
            WHERE id = $1`, [claim.basket_item_id, claim.qty]);
      }
      const byBusiness = new Set(rows.map((r) => r.business_id));
      for (const id of byBusiness) {
        await logAction(client, {
          businessId: id,
          action: 'LIVE_HOLDS_EXPIRED',
          actor: 'n8n',
          detail: { released: rows.filter((r) => r.business_id === id).length },
        });
      }
      return rows.length;
    });
    res.json({ ok: true, expired: out });
  }));

  return { readSession, readSessions, readClaims };
}
