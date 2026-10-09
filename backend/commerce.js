// The selling floor's paperwork: the buyer conversations, the orders that
// come out of them, and the money behind those orders.
//
// Three things about the marketplaces shape all of this.
//
// 1. Shopee, Lazada and TikTok Shop give a seller a chat thread and an order
//    feed. None of them gives a seller a phone line — there is no voice-call
//    API on any of the three — so every reply here is written, and nothing in
//    this app offers to ring a buyer. Messenger and Instagram DMs ride the
//    same two tables, so one inbox covers the lot.
// 2. The buyer never pays this app. They pay the marketplace, which holds the
//    money in escrow while the parcel travels and releases the seller's share
//    later, minus its fees. So an order is a record of something that already
//    happened elsewhere, and `payments` tracks how far along that money is.
// 3. What that means for stock is a decision, not a fact: some sellers take
//    stock the moment an order appears, most when it is paid, some not until
//    the money is actually released. `payment_rules.release_stock_on` holds
//    that choice per marketplace and this file obeys it.
//
// A reply to a buyer reaches a customer, so it goes through the approval gate
// like everything else. An order status move and a reconciliation do not
// reach anybody, so they are ordinary guarded writes — owner-only, logged.

export const CHANNELS = [
  'shopee_chat', 'lazada_chat', 'tiktok_dm', 'meta_dm', 'instagram_dm', 'email',
];

// Which connected platform a channel belongs to, for picking the account and
// the credentials a reply has to go out on.
export const CHANNEL_PLATFORM = {
  shopee_chat: 'shopee',
  lazada_chat: 'lazada',
  tiktok_dm: 'tiktok',
  meta_dm: 'facebook',
  instagram_dm: 'instagram',
  email: null,
};

export const ORDER_STATUSES = [
  'UNPAID', 'PAID', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED',
];

// A status that means the buyer's money is at least committed to the platform.
const PAID_ENOUGH = new Set(['PAID', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED']);

// Moving an order on by hand is fulfilment, not invention: these are the only
// moves a human may make here, and the rest come from the marketplace.
const ALLOWED_MOVES = {
  // An unpaid order can still be shipped — that is what cash on delivery is,
  // and on Shopee and Lazada it is most of the volume. Whether this floor
  // allows it, and up to what total, is the payment rule's call below.
  UNPAID: ['READY_TO_SHIP', 'CANCELLED'],
  PAID: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};

export function registerCommerce(app, ctx) {
  const {
    q, tx, wrap, HttpError, assertUuid, businessClause, scopeFor, requireOwner,
    assertInScope, logAction, settleAgent, deskFor, requireUser,
    registerApprovalType, chatWebhookUrl, orderSyncWebhookUrl, internalGate,
  } = ctx;

  // ------------------------------------------------------------- readers

  const CONVERSATION_COLUMNS = `
    c.id, c.business_id, c.account_id, c.channel, c.external_id,
    c.buyer_name, c.buyer_handle, c.product_id, c.order_id, c.status,
    c.last_message_at, c.unread, c.created_at,
    acc.label AS account_label, acc.platform AS account_platform,
    p.name AS product_name, p.sku AS product_sku,
    (SELECT m.body FROM messages m
      WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
    (SELECT m.direction FROM messages m
      WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction`;

  const CONVERSATION_JOINS = `
    FROM conversations c
    LEFT JOIN platform_accounts acc ON acc.id = c.account_id
    LEFT JOIN products p ON p.id = c.product_id`;

  async function readConversations(scope, { channel, status, limit = 100 } = {}) {
    const where = businessClause(scope, { column: 'c.business_id' });
    const params = [...where.params];
    let extra = '';
    if (channel && channel !== 'all') {
      if (!CHANNELS.includes(channel)) throw new HttpError(400, 'unknown channel');
      params.push(channel);
      extra += ` AND c.channel = $${params.length}`;
    }
    if (status && status !== 'all') {
      params.push(status);
      extra += ` AND c.status = $${params.length}`;
    }
    params.push(Math.min(Number(limit) || 100, 200));
    const { rows } = await q(
      `SELECT ${CONVERSATION_COLUMNS} ${CONVERSATION_JOINS}
        WHERE ${where.sql}${extra}
        ORDER BY c.last_message_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async function readConversation(id) {
    assertUuid(id, 'conversation_id');
    const { rows } = await q(
      `SELECT ${CONVERSATION_COLUMNS} ${CONVERSATION_JOINS} WHERE c.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async function readMessages(conversationId, limit = 200) {
    const { rows } = await q(
      `SELECT id, direction, body, approval_id, external_id, sent_at, created_at
         FROM messages WHERE conversation_id = $1
        ORDER BY created_at LIMIT $2`,
      [conversationId, Math.min(Number(limit) || 200, 500)],
    );
    return rows;
  }

  const ORDER_COLUMNS = `
    o.id, o.business_id, o.account_id, o.source, o.external_id, o.order_no,
    o.buyer_name, o.status, o.total, o.currency, o.checkout_url, o.placed_at,
    o.stock_taken_at, o.updated_at,
    acc.label AS account_label, acc.platform AS account_platform,
    COALESCE((
      SELECT json_agg(json_build_object(
               'id', i.id, 'product_id', i.product_id, 'sku', i.sku,
               'name', i.name, 'qty', i.qty, 'unit_price', i.unit_price)
             ORDER BY i.name)
        FROM order_items i WHERE i.order_id = o.id
    ), '[]') AS items,
    (SELECT json_build_object(
              'id', pm.id, 'method', pm.method, 'state', pm.state,
              'gross', pm.gross, 'net', pm.net,
              'commission_fee', pm.commission_fee,
              'transaction_fee', pm.transaction_fee,
              'shipping_fee', pm.shipping_fee, 'other_fee', pm.other_fee,
              'paid_at', pm.paid_at, 'escrow_release_at', pm.escrow_release_at,
              'released_at', pm.released_at, 'last_error', pm.last_error)
       FROM payments pm WHERE pm.order_id = o.id) AS payment`;

  async function readOrders(scope, { status, accountId, source, limit = 100 } = {}) {
    const where = businessClause(scope, { column: 'o.business_id' });
    const params = [...where.params];
    let extra = '';
    if (status && status !== 'all') {
      if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'unknown order status');
      params.push(status);
      extra += ` AND o.status = $${params.length}`;
    }
    if (accountId) {
      params.push(assertUuid(accountId, 'account_id'));
      extra += ` AND o.account_id = $${params.length}`;
    }
    if (source && source !== 'all') {
      params.push(source);
      extra += ` AND o.source = $${params.length}`;
    }
    params.push(Math.min(Number(limit) || 100, 200));
    const { rows } = await q(
      `SELECT ${ORDER_COLUMNS}
         FROM orders o
         LEFT JOIN platform_accounts acc ON acc.id = o.account_id
        WHERE ${where.sql}${extra}
        ORDER BY o.placed_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async function readOrder(id) {
    assertUuid(id, 'order_id');
    const { rows } = await q(
      `SELECT ${ORDER_COLUMNS}
         FROM orders o
         LEFT JOIN platform_accounts acc ON acc.id = o.account_id
        WHERE o.id = $1`, [id]);
    return rows[0] ?? null;
  }

  /**
   * The rule for one marketplace. Every business has a full set provisioned
   * with its desks, so this returns a row rather than a maybe; a platform
   * nobody wrote a rule for falls back to the cautious defaults.
   */
  async function ruleFor(businessId, platform) {
    const key = ['shopee', 'lazada', 'tiktok', 'live'].includes(platform) ? platform : 'shopee';
    const { rows } = await q(
      `SELECT * FROM payment_rules WHERE business_id = $1 AND platform = $2`,
      [businessId, key],
    );
    return rows[0] ?? {
      platform: key, allow_cod: false, cod_limit: 0, release_stock_on: 'payment',
      chase_unpaid_after_minutes: 180, cancel_unpaid_after_minutes: 2880,
      reconcile_tolerance: 1, chase_needs_approval: true,
    };
  }

  // -------------------------------------------------------- stock, by rule

  /**
   * Take the stock for an order, or put it back. Which event is allowed to do
   * this is the business's own rule — see `release_stock_on` — so the caller
   * says what just happened and this decides whether that is the moment.
   *
   * `stock_taken_at` makes it idempotent: a marketplace sync that replays the
   * same order does not take the stock twice.
   */
  async function applyStock(client, order, { event, rule }) {
    const wanted = rule.release_stock_on === 'order' ? 'order'
      : rule.release_stock_on === 'release' ? 'released' : 'paid';
    const giveBack = ['CANCELLED', 'RETURNED'].includes(order.status);

    if (giveBack) {
      if (!order.stock_taken_at) return { stock: 'was never taken' };
      await client.query(
        `UPDATE products p SET stock = p.stock + i.qty
           FROM order_items i
          WHERE i.order_id = $1 AND i.product_id = p.id`, [order.id]);
      await client.query(`UPDATE orders SET stock_taken_at = NULL WHERE id = $1`, [order.id]);
      return { stock: 'returned to the shelf' };
    }

    if (order.stock_taken_at) return { stock: 'already taken' };
    if (event !== wanted) return { stock: `waits for ${wanted}` };

    // Never below zero: a marketplace can sell what a late sync has not yet
    // deducted, and a negative shelf is a lie in the other direction.
    await client.query(
      `UPDATE products p SET stock = GREATEST(0, p.stock - i.qty)
         FROM order_items i
        WHERE i.order_id = $1 AND i.product_id = p.id`, [order.id]);
    await client.query(`UPDATE orders SET stock_taken_at = now() WHERE id = $1`, [order.id]);
    return { stock: 'taken' };
  }

  // ------------------------------------------------------------- the gate
  // A reply to a buyer and a nudge about an unpaid order are both messages to
  // a customer, so both are filed and neither is sent here.

  const closeConversation = (conversationId, status) => q(
    `UPDATE conversations SET status = $2 WHERE id = $1`, [conversationId, status]);

  for (const type of ['chat_reply', 'payment_chase']) {
    registerApprovalType(type, {
      label: type === 'chat_reply' ? 'chat reply' : 'payment chase',
      webhook: () => chatWebhookUrl(),
      enrich: async (payload) => ({
        conversation: payload.conversation_id
          ? await readConversation(payload.conversation_id) : null,
        order: payload.order_id ? await readOrder(payload.order_id) : null,
      }),
      onDispatchFailed: async (payload) => {
        if (payload.conversation_id) await closeConversation(payload.conversation_id, 'OPEN');
      },
      onRejected: async (payload) => {
        if (payload.conversation_id) await closeConversation(payload.conversation_id, 'OPEN');
        return { reply: 'discarded' };
      },
    });
  }

  // --------------------------------------------------------------- inbox

  app.use('/api/inbox', requireUser);
  app.use('/api/orders', requireUser);
  app.use('/api/payments', requireUser);
  app.use('/api/payouts', requireUser);
  app.use('/api/payment-rules', requireUser);

  app.get('/api/inbox', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    res.json({
      channels: CHANNELS,
      // Said once, here, because it is the question every seller asks: the
      // marketplaces have no call API, so there is nothing to ring.
      calls: {
        supported: false,
        note: 'Shopee, Lazada and TikTok Shop have no voice-call API — '
            + 'their seller tools are chat, the listing, and the order feed. '
            + 'Every reply here is written.',
      },
      conversations: await readConversations(scope, {
        channel: req.query.channel, status: req.query.status, limit: req.query.limit,
      }),
    });
  }));

  app.get('/api/inbox/:id', wrap(async (req, res) => {
    const conversation = await readConversation(req.params.id);
    if (!conversation) throw new HttpError(404, 'conversation not found');
    assertInScope(req.user, conversation.business_id);
    // Opening a thread is reading it.
    await q(`UPDATE conversations SET unread = 0 WHERE id = $1`, [conversation.id]);
    res.json({ conversation, messages: await readMessages(conversation.id) });
  }));

  // File a reply. Owner and reviewer both may: drafting is not sending.
  app.post('/api/inbox/:id/reply', wrap(async (req, res) => {
    const conversation = await readConversation(req.params.id);
    if (!conversation) throw new HttpError(404, 'conversation not found');
    assertInScope(req.user, conversation.business_id);

    const draft = String(req.body?.draft ?? '').trim();
    if (!draft) throw new HttpError(400, 'a reply needs something in it');
    if (draft.length > 4000) throw new HttpError(400, 'that reply is too long for a chat');

    const agentId = await deskFor(conversation.business_id, 'CRM');
    const approval = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO approvals (business_id, agent_id, payload_json)
         VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [conversation.business_id, agentId, JSON.stringify({
          type: 'chat_reply',
          title: `Reply to ${conversation.buyer_name} on ${conversation.channel}`,
          draft,
          channel: conversation.channel,
          recipient: conversation.buyer_handle ?? conversation.buyer_name,
          conversation_id: conversation.id,
          account_id: conversation.account_id,
          source: { conversation_id: conversation.id, drafted_by: req.user.email },
        })],
      );
      await client.query(
        `UPDATE conversations SET status = 'AWAITING_APPROVAL' WHERE id = $1`,
        [conversation.id]);
      await settleAgent(client, {
        agentId,
        businessId: conversation.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Reply waiting: ${conversation.buyer_name}`.slice(0, 500),
      });
      await logAction(client, {
        businessId: conversation.business_id,
        agentId,
        approvalId: rows[0].id,
        action: 'CHAT_REPLY_SUBMITTED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { channel: conversation.channel, conversation_id: conversation.id },
      });
      return rows[0];
    });

    res.json({ ok: true, needs_approval: true, approval_id: approval.id });
  }));

  app.post('/api/inbox/:id/close', wrap(async (req, res) => {
    const conversation = await readConversation(req.params.id);
    if (!conversation) throw new HttpError(404, 'conversation not found');
    assertInScope(req.user, conversation.business_id);
    await tx(async (client) => {
      await client.query(
        `UPDATE conversations SET status = 'CLOSED', unread = 0 WHERE id = $1`,
        [conversation.id]);
      await logAction(client, {
        businessId: conversation.business_id,
        action: 'CONVERSATION_CLOSED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { conversation_id: conversation.id, channel: conversation.channel },
      });
    });
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------- orders

  app.get('/api/orders', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    const orders = await readOrders(scope, {
      status: req.query.status, accountId: req.query.account_id,
      source: req.query.source, limit: req.query.limit,
    });
    const where = businessClause(scope, { column: 'business_id' });
    // The headline numbers, read out of the database rather than added up in
    // a browser that may be showing a filtered page.
    const { rows: totals } = await q(
      `SELECT status, count(*)::int AS orders, COALESCE(sum(total), 0) AS value
         FROM orders WHERE ${where.sql} GROUP BY status`, where.params);
    res.json({ statuses: ORDER_STATUSES, orders, totals });
  }));

  app.get('/api/orders/:id', wrap(async (req, res) => {
    const order = await readOrder(req.params.id);
    if (!order) throw new HttpError(404, 'order not found');
    assertInScope(req.user, order.business_id);
    res.json({ order });
  }));

  // Fulfilment. Owner-only, because it is what actually puts a parcel on a
  // van, and it refuses to run ahead of the money if the rule says so.
  app.patch('/api/orders/:id', wrap(async (req, res) => {
    const order = await readOrder(req.params.id);
    if (!order) throw new HttpError(404, 'order not found');
    assertInScope(req.user, order.business_id);
    requireOwner(req.user, order.business_id);

    const next = String(req.body?.status ?? '').trim().toUpperCase();
    if (!ORDER_STATUSES.includes(next)) throw new HttpError(400, 'unknown order status');
    if (next === order.status) {
      res.json({ ok: true, order, unchanged: true });
      return;
    }
    const moves = ALLOWED_MOVES[order.status] ?? [];
    if (!moves.includes(next)) {
      throw new HttpError(409,
        `an order that is ${order.status} can only go to ${moves.join(' or ') || 'nowhere'} from here`);
    }

    const rule = await ruleFor(order.business_id,
      order.source === 'live' ? 'live' : order.account_platform ?? 'shopee');
    const paid = PAID_ENOUGH.has(order.status) || order.payment?.state === 'IN_ESCROW'
      || order.payment?.state === 'RELEASED';
    const cod = order.payment?.method === 'cod';

    // Sending a parcel out against money that is not there is how a seller
    // ends up out of pocket. Unpaid only goes out on cash on delivery, only
    // if this floor allows it, and only up to the total it allows — and the
    // refusal quotes the rule rather than just saying no.
    if (next === 'READY_TO_SHIP' && !paid) {
      if (!cod) {
        throw new HttpError(409,
          'that order has not been paid, and it is not cash on delivery');
      }
      if (!rule.allow_cod) {
        throw new HttpError(409,
          `cash on delivery is switched off for ${rule.platform} on this floor`);
      }
      if (Number(order.total) > Number(rule.cod_limit)) {
        throw new HttpError(409,
          `${order.currency} ${order.total} is over the ${rule.cod_limit} COD limit for ${rule.platform} on this floor`);
      }
    }

    const result = await tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE orders SET status = $2 WHERE id = $1 AND business_id = ANY($3::uuid[])
          RETURNING id, status, stock_taken_at`,
        [order.id, next, req.user.businessIds]);
      if (!rows[0]) throw new HttpError(404, 'order not found');

      const stock = await applyStock(client,
        { ...order, status: next }, { event: 'manual', rule });

      // A cancelled or returned order is not money any more.
      if (['CANCELLED', 'RETURNED'].includes(next)) {
        await client.query(
          `UPDATE payments SET state = $2 WHERE order_id = $1 AND state <> 'RELEASED'`,
          [order.id, next === 'RETURNED' ? 'REFUNDED' : 'CANCELLED']);
      }
      await logAction(client, {
        businessId: order.business_id,
        action: 'ORDER_STATUS_CHANGED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { order_no: order.order_no ?? order.external_id, from: order.status, to: next, ...stock },
      });
      return { status: next, ...stock };
    });

    res.json({ ok: true, ...result, order: await readOrder(order.id) });
  }));

  // Chase an unpaid order. The nudge is a message to a buyer, so it is filed,
  // not sent — and if the rule says this floor does not chase, it is not even
  // drafted.
  app.post('/api/orders/:id/chase', wrap(async (req, res) => {
    const order = await readOrder(req.params.id);
    if (!order) throw new HttpError(404, 'order not found');
    assertInScope(req.user, order.business_id);
    if (order.status !== 'UNPAID') throw new HttpError(409, 'that order is not waiting on payment');

    const rule = await ruleFor(order.business_id, order.account_platform ?? 'shopee');
    const minutes = Math.round(
      (Date.now() - new Date(order.placed_at).getTime()) / 60000);
    if (minutes < rule.chase_unpaid_after_minutes) {
      throw new HttpError(409,
        `this floor waits ${rule.chase_unpaid_after_minutes} minutes before chasing; that order is ${minutes} old`);
    }

    const agentId = await deskFor(order.business_id, 'Payments');
    const items = (order.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(', ');
    const draft = `Hi ${order.buyer_name}, your order ${order.order_no ?? order.external_id} `
      + `(${items}) is still waiting for payment. `
      + (order.checkout_url ? `You can pay here: ${order.checkout_url}. ` : '')
      + `We will hold it until ${new Date(
        new Date(order.placed_at).getTime() + rule.cancel_unpaid_after_minutes * 60000,
      ).toISOString().slice(0, 16).replace('T', ' ')} and then release the stock.`;

    const approval = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO approvals (business_id, agent_id, payload_json)
         VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [order.business_id, agentId, JSON.stringify({
          type: 'payment_chase',
          title: `Chase unpaid order ${order.order_no ?? order.external_id}`,
          draft,
          channel: order.account_platform ? `${order.account_platform}_chat` : 'email',
          recipient: order.buyer_name,
          order_id: order.id,
          account_id: order.account_id,
          source: { order_id: order.id, requested_by: req.user.email },
        })],
      );
      await settleAgent(client, {
        agentId,
        businessId: order.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Chase waiting: ${order.order_no ?? order.external_id}`.slice(0, 500),
      });
      await logAction(client, {
        businessId: order.business_id,
        agentId,
        approvalId: rows[0].id,
        action: 'PAYMENT_CHASE_SUBMITTED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { order_no: order.order_no ?? order.external_id, unpaid_minutes: minutes },
      });
      return rows[0];
    });

    res.json({ ok: true, needs_approval: true, approval_id: approval.id });
  }));

  // ------------------------------------------------------- money and rules

  app.get('/api/payments', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    const where = businessClause(scope, { column: 'pm.business_id' });
    const { rows } = await q(
      `SELECT pm.*, o.order_no, o.external_id AS order_external_id, o.buyer_name,
              o.source, acc.label AS account_label, acc.platform AS account_platform
         FROM payments pm
         JOIN orders o ON o.id = pm.order_id
         LEFT JOIN platform_accounts acc ON acc.id = pm.account_id
        WHERE ${where.sql}
        ORDER BY pm.updated_at DESC LIMIT 200`, where.params);
    const { rows: summary } = await q(
      `SELECT state, count(*)::int AS payments,
              COALESCE(sum(gross), 0) AS gross, COALESCE(sum(net), 0) AS net
         FROM payments pm WHERE ${where.sql} GROUP BY state`, where.params);
    res.json({ payments: rows, summary });
  }));

  app.get('/api/payouts', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    const where = businessClause(scope, { column: 'po.business_id' });
    const { rows } = await q(
      `SELECT po.*, acc.label AS account_label, acc.platform AS account_platform,
              (SELECT count(*)::int FROM payout_orders x WHERE x.payout_id = po.id) AS order_count
         FROM payouts po
         JOIN platform_accounts acc ON acc.id = po.account_id
        WHERE ${where.sql}
        ORDER BY po.created_at DESC LIMIT 100`, where.params);
    res.json({ payouts: rows });
  }));

  app.get('/api/payment-rules', wrap(async (req, res) => {
    const scope = scopeFor(req.user, req.query.business_id);
    const where = businessClause(scope);
    const { rows } = await q(
      `SELECT * FROM payment_rules WHERE ${where.sql} ORDER BY business_id, platform`,
      where.params);
    res.json({ rules: rows });
  }));

  // Changing a payment rule changes what goes out unpaid and when stock
  // leaves, so it is an owner's decision.
  app.patch('/api/payment-rules/:id', wrap(async (req, res) => {
    const id = assertUuid(req.params.id, 'rule_id');
    const { rows: found } = await q(`SELECT * FROM payment_rules WHERE id = $1`, [id]);
    const rule = found[0];
    if (!rule) throw new HttpError(404, 'rule not found');
    assertInScope(req.user, rule.business_id);
    requireOwner(req.user, rule.business_id);

    const patch = {};
    const body = req.body ?? {};
    if ('allow_cod' in body) patch.allow_cod = Boolean(body.allow_cod);
    if ('cod_limit' in body) {
      const n = Number(body.cod_limit);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'cod_limit must be 0 or more');
      patch.cod_limit = n;
    }
    if ('release_stock_on' in body) {
      if (!['order', 'payment', 'release'].includes(body.release_stock_on)) {
        throw new HttpError(400, 'release_stock_on is order, payment or release');
      }
      patch.release_stock_on = body.release_stock_on;
    }
    for (const key of ['chase_unpaid_after_minutes', 'cancel_unpaid_after_minutes']) {
      if (key in body) {
        const n = Math.round(Number(body[key]));
        if (!Number.isFinite(n) || n < 1) throw new HttpError(400, `${key} must be at least 1`);
        patch[key] = n;
      }
    }
    if ('reconcile_tolerance' in body) {
      const n = Number(body.reconcile_tolerance);
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'reconcile_tolerance must be 0 or more');
      patch.reconcile_tolerance = n;
    }
    if ('chase_needs_approval' in body) {
      patch.chase_needs_approval = Boolean(body.chase_needs_approval);
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to change');

    const merged = { ...rule, ...patch };
    if (Number(merged.cancel_unpaid_after_minutes) < Number(merged.chase_unpaid_after_minutes)) {
      throw new HttpError(400, 'you cannot cancel an order before you have chased it');
    }

    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const updated = await tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE payment_rules SET ${sets}
          WHERE id = $1 AND business_id = ANY($2::uuid[]) RETURNING *`,
        [id, req.user.businessIds, ...keys.map((k) => patch[k])],
      );
      if (!rows[0]) throw new HttpError(404, 'rule not found');
      await logAction(client, {
        businessId: rule.business_id,
        action: 'PAYMENT_RULE_CHANGED',
        actor: req.user.email,
        actorUserId: req.user.id,
        detail: { platform: rule.platform, ...patch },
      });
      return rows[0];
    });
    res.json({ ok: true, rule: updated });
  }));

  // ------------------------------------------------------- internal (n8n)

  // What the chat workflow needs to answer on the right thread.
  app.get('/api/internal/conversations/:id', wrap(async (req, res) => {
    const conversation = await readConversation(req.params.id);
    if (!conversation) throw new HttpError(404, 'conversation not found');
    res.json({ conversation, messages: await readMessages(conversation.id, 40) });
  }));

  // An inbound buyer message. Upserted on the marketplace's own thread id, so
  // a replay does not open a second conversation for the same chat.
  app.post('/api/internal/conversations', wrap(async (req, res) => {
    const body = req.body ?? {};
    const businessId = assertUuid(body.business_id, 'business_id');
    const channel = String(body.channel ?? '');
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'unknown channel');
    const text = String(body.body ?? '').trim();
    if (!text) throw new HttpError(400, 'an inbound message needs a body');

    const live = await internalGate(businessId);
    if (live) { res.status(423).json(live); return; }

    const accountId = body.account_id ? assertUuid(body.account_id, 'account_id') : null;
    if (accountId) {
      const { rows } = await q(
        `SELECT 1 FROM platform_accounts WHERE id = $1 AND business_id = $2`,
        [accountId, businessId]);
      if (!rows[0]) throw new HttpError(404, 'that account is not on this business');
    }

    const out = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO conversations
           (business_id, account_id, channel, external_id, buyer_name, buyer_handle,
            product_id, status, last_message_at, unread)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', now(), 1)
         ON CONFLICT (account_id, channel, external_id)
           WHERE external_id IS NOT NULL
         DO UPDATE SET last_message_at = now(),
                       unread = conversations.unread + 1,
                       buyer_name = COALESCE(EXCLUDED.buyer_name, conversations.buyer_name),
                       status = CASE WHEN conversations.status = 'CLOSED'
                                     THEN 'OPEN' ELSE conversations.status END
         RETURNING id, business_id`,
        [businessId, accountId, channel, body.external_id ?? null,
         String(body.buyer_name ?? 'Buyer').slice(0, 200),
         body.buyer_handle ?? null,
         body.product_id ? assertUuid(body.product_id, 'product_id') : null],
      );
      const conversation = rows[0];
      await client.query(
        `INSERT INTO messages (conversation_id, business_id, direction, body, external_id)
         VALUES ($1, $2, 'IN', $3, $4)`,
        [conversation.id, businessId, text.slice(0, 8000), body.message_external_id ?? null]);
      await logAction(client, {
        businessId,
        action: 'MESSAGE_RECEIVED',
        actor: 'n8n',
        detail: { channel, conversation_id: conversation.id },
      });
      return conversation;
    });

    res.status(201).json({ ok: true, conversation_id: out.id });
  }));

  // The reply actually went out. Written here and only here, carrying the
  // approval that let it: an OUT message with no approval_id would mean
  // something reached a customer without a human, so it cannot be written.
  app.post('/api/internal/conversations/:id/messages', wrap(async (req, res) => {
    const conversationId = assertUuid(req.params.id, 'conversation_id');
    const body = req.body ?? {};
    const approvalId = assertUuid(body.approval_id, 'approval_id');
    const text = String(body.body ?? '').trim();
    if (!text) throw new HttpError(400, 'a sent message needs a body');

    const { rows: checked } = await q(
      `SELECT c.id, c.business_id, a.status AS approval_status
         FROM conversations c
         JOIN approvals a ON a.id = $2 AND a.business_id = c.business_id
        WHERE c.id = $1`,
      [conversationId, approvalId]);
    const row = checked[0];
    if (!row) throw new HttpError(404, 'conversation or approval not found');
    if (row.approval_status !== 'APPROVED') {
      throw new HttpError(409, 'that reply was not approved', { status: row.approval_status });
    }

    const sent = body.failed
      ? null
      : (body.sent_at ? new Date(body.sent_at) : new Date());

    await tx(async (client) => {
      await client.query(
        `INSERT INTO messages
           (conversation_id, business_id, direction, body, approval_id, external_id, sent_at)
         VALUES ($1, $2, 'OUT', $3, $4, $5, $6)`,
        [conversationId, row.business_id, text.slice(0, 8000), approvalId,
         body.external_id ?? null, sent]);
      await client.query(
        `UPDATE conversations SET status = $2, last_message_at = now() WHERE id = $1`,
        [conversationId, body.failed ? 'OPEN' : 'ANSWERED']);
      // PAUSED always wins, so the desk is only let go if it is not paused.
      await client.query(
        `UPDATE agents SET status = 'IDLE', last_message = $2
          WHERE business_id = $1 AND department = 'CRM' AND status <> 'PAUSED'`,
        [row.business_id, body.failed ? 'Reply could not be sent' : 'Reply sent']);
      await logAction(client, {
        businessId: row.business_id,
        approvalId,
        action: body.failed ? 'MESSAGE_SEND_FAILED' : 'MESSAGE_SENT',
        actor: 'n8n',
        detail: { conversation_id: conversationId, error: body.error ?? null },
      });
    });

    res.json({ ok: true });
  }));

  // An order from a marketplace sync, with its money. Upserted on the
  // marketplace's own id, so a poll that overlaps the last one is harmless.
  app.post('/api/internal/orders', wrap(async (req, res) => {
    const body = req.body ?? {};
    const businessId = assertUuid(body.business_id, 'business_id');
    const accountId = assertUuid(body.account_id, 'account_id');
    const externalId = String(body.external_id ?? '').trim();
    if (!externalId) throw new HttpError(400, 'an order needs the marketplace id');
    const status = String(body.status ?? 'UNPAID').toUpperCase();
    if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'unknown order status');

    const live = await internalGate(businessId);
    if (live) { res.status(423).json(live); return; }

    const { rows: accounts } = await q(
      `SELECT id, platform, label FROM platform_accounts
        WHERE id = $1 AND business_id = $2`, [accountId, businessId]);
    const account = accounts[0];
    if (!account) throw new HttpError(404, 'that account is not on this business');

    const source = ['shop', 'live', 'chat'].includes(body.source) ? body.source : 'shop';
    const rule = await ruleFor(businessId, source === 'live' ? 'live' : account.platform);
    const method = ['online', 'cod', 'wallet', 'bank_transfer', 'installment', 'live_link']
      .includes(body.payment?.method) ? body.payment.method : 'unknown';
    const total = Number(body.total ?? 0);

    // The COD rule is the business's, so an order that breaks it is still
    // recorded — it happened — but it is flagged rather than quietly shipped.
    const codRefused = method === 'cod'
      && (!rule.allow_cod || total > Number(rule.cod_limit));

    const result = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO orders (business_id, account_id, source, external_id, order_no,
                             buyer_name, status, total, currency, checkout_url, placed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()))
         ON CONFLICT (account_id, external_id) DO UPDATE
           SET status = EXCLUDED.status, total = EXCLUDED.total,
               buyer_name = EXCLUDED.buyer_name,
               checkout_url = COALESCE(EXCLUDED.checkout_url, orders.checkout_url)
         RETURNING id, status, stock_taken_at, business_id`,
        [businessId, accountId, source, externalId, body.order_no ?? null,
         String(body.buyer_name ?? 'Buyer').slice(0, 200), status, total,
         body.currency ?? 'PHP', body.checkout_url ?? null, body.placed_at ?? null],
      );
      const order = rows[0];

      // Items are replaced wholesale: the marketplace's copy is the truth.
      if (Array.isArray(body.items)) {
        await client.query(`DELETE FROM order_items WHERE order_id = $1`, [order.id]);
        for (const item of body.items) {
          await client.query(
            `INSERT INTO order_items (order_id, product_id, sku, name, qty, unit_price)
             VALUES ($1,
                     (SELECT id FROM products
                       WHERE business_id = $2 AND sku = $3),
                     $3, $4, $5, $6)`,
            [order.id, businessId, String(item.sku ?? '').slice(0, 120),
             String(item.name ?? item.sku ?? 'item').slice(0, 300),
             Math.max(1, Math.round(Number(item.qty ?? 1))), Number(item.unit_price ?? 0)],
          );
        }
      }

      const pay = body.payment ?? {};
      const state = String(pay.state ?? (PAID_ENOUGH.has(status) ? 'IN_ESCROW' : 'AWAITING'))
        .toUpperCase();
      // A sync that does not mention a figure is not saying it is zero. Only
      // what the marketplace actually sent is written, so a cheap poll that
      // carries the status but no fees cannot wipe the fees a fuller one got.
      const money = (key, fallback = null) =>
        pay[key] === undefined || pay[key] === null ? fallback : Number(pay[key]);
      await client.query(
        `INSERT INTO payments (business_id, order_id, account_id, method, state,
                               gross, commission_fee, transaction_fee, shipping_fee,
                               other_fee, net, currency, external_id, paid_at,
                               escrow_release_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::numeric,0),COALESCE($7::numeric,0),
                 COALESCE($8::numeric,0),COALESCE($9::numeric,0),
                 COALESCE($10::numeric,0),COALESCE($11::numeric,0),$12,$13,$14,$15)
         ON CONFLICT (order_id) DO UPDATE
           SET method = CASE WHEN EXCLUDED.method = 'unknown'
                             THEN payments.method ELSE EXCLUDED.method END,
               state = EXCLUDED.state,
               gross = COALESCE($6::numeric, payments.gross),
               commission_fee = COALESCE($7::numeric, payments.commission_fee),
               transaction_fee = COALESCE($8::numeric, payments.transaction_fee),
               shipping_fee = COALESCE($9::numeric, payments.shipping_fee),
               other_fee = COALESCE($10::numeric, payments.other_fee),
               net = COALESCE($11::numeric, payments.net),
               external_id = COALESCE($13, payments.external_id),
               paid_at = COALESCE($14::timestamptz, payments.paid_at),
               escrow_release_at = COALESCE($15::timestamptz, payments.escrow_release_at),
               last_error = NULL`,
        [businessId, order.id, accountId, method, state,
         money('gross', total), money('commission_fee'), money('transaction_fee'),
         money('shipping_fee'), money('other_fee'), money('net'),
         body.currency ?? 'PHP', pay.external_id ?? null,
         pay.paid_at ?? null, pay.escrow_release_at ?? null],
      );

      // Which event takes the stock is the rule's call, not this route's.
      const event = ['CANCELLED', 'RETURNED'].includes(status) ? 'cancel'
        : state === 'RELEASED' ? 'released'
        : PAID_ENOUGH.has(status) || state === 'IN_ESCROW' ? 'paid'
        : 'order';
      const stock = await applyStock(client, { ...order, status }, { event, rule });

      await logAction(client, {
        businessId,
        action: codRefused ? 'ORDER_COD_OVER_LIMIT' : 'ORDER_SYNCED',
        actor: 'n8n',
        detail: {
          order_no: body.order_no ?? externalId, account: account.label,
          status, method, source, ...stock,
          ...(codRefused ? { cod_limit: rule.cod_limit, total } : {}),
        },
      });
      return { order_id: order.id, ...stock };
    });

    res.status(201).json({
      ok: true,
      ...result,
      cod_over_limit: codRefused,
      rule: {
        platform: rule.platform, allow_cod: rule.allow_cod,
        cod_limit: rule.cod_limit, release_stock_on: rule.release_stock_on,
      },
    });
  }));

  // A platform payout, and the reconciliation it gets. Nothing here moves
  // money — it reads what the marketplace says it paid and compares that with
  // what the orders in it add up to. A gap is reported, never rounded away.
  app.post('/api/internal/payouts', wrap(async (req, res) => {
    const body = req.body ?? {};
    const businessId = assertUuid(body.business_id, 'business_id');
    const accountId = assertUuid(body.account_id, 'account_id');
    const externalId = String(body.external_id ?? '').trim();
    if (!externalId) throw new HttpError(400, 'a payout needs the platform id');

    const { rows: accounts } = await q(
      `SELECT id, platform, label FROM platform_accounts
        WHERE id = $1 AND business_id = $2`, [accountId, businessId]);
    const account = accounts[0];
    if (!account) throw new HttpError(404, 'that account is not on this business');

    const rule = await ruleFor(businessId, account.platform);
    const lines = Array.isArray(body.orders) ? body.orders : [];

    const out = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO payouts (business_id, account_id, external_id, period_start,
                              period_end, gross, fees, adjustments, net, currency,
                              state, settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (account_id, external_id) DO UPDATE
           SET gross = EXCLUDED.gross, fees = EXCLUDED.fees,
               adjustments = EXCLUDED.adjustments, net = EXCLUDED.net,
               state = EXCLUDED.state, settled_at = EXCLUDED.settled_at,
               period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end
         RETURNING id`,
        [businessId, accountId, externalId, body.period_start ?? null,
         body.period_end ?? null, Number(body.gross ?? 0), Number(body.fees ?? 0),
         Number(body.adjustments ?? 0), Number(body.net ?? 0), body.currency ?? 'PHP',
         body.settled_at ? 'SETTLED' : 'EXPECTED', body.settled_at ?? null],
      );
      const payout = rows[0];

      // Match each line to an order of this account's, by the marketplace id.
      let matched = 0;
      let expected = 0;
      const unmatched = [];
      await client.query(`DELETE FROM payout_orders WHERE payout_id = $1`, [payout.id]);
      for (const line of lines) {
        const amount = Number(line.amount ?? 0);
        const { rows: found } = await client.query(
          `SELECT o.id, COALESCE(pm.net, 0) AS net FROM orders o
             LEFT JOIN payments pm ON pm.order_id = o.id
            WHERE o.account_id = $1 AND o.external_id = $2`,
          [accountId, String(line.external_id ?? '')]);
        if (!found[0]) { unmatched.push(line.external_id); continue; }
        matched += 1;
        expected += Number(found[0].net);
        await client.query(
          `INSERT INTO payout_orders (payout_id, order_id, amount) VALUES ($1,$2,$3)
           ON CONFLICT (payout_id, order_id) DO UPDATE SET amount = EXCLUDED.amount`,
          [payout.id, found[0].id, amount]);
        await client.query(
          `UPDATE payments SET state = 'RELEASED', released_at = COALESCE($2::timestamptz, now())
            WHERE order_id = $1 AND state IN ('AWAITING', 'IN_ESCROW')`,
          [found[0].id, body.settled_at ?? null]);
      }

      // The gap between what the platform paid and what its own per-order
      // figures add up to. Within tolerance it is rounding; beyond it, the
      // payout is SHORT and the desk has something to take up.
      const variance = Number((Number(body.net ?? 0) - expected).toFixed(2));
      const short = Math.abs(variance) > Number(rule.reconcile_tolerance);
      const note = unmatched.length
        ? `${unmatched.length} line(s) matched no order here: ${unmatched.slice(0, 5).join(', ')}`
        : short
          ? `payout is ${variance < 0 ? 'under' : 'over'} its orders by ${Math.abs(variance)}`
          : null;

      await client.query(
        `UPDATE payouts SET variance = $2, note = $3,
                            state = CASE WHEN $4 THEN 'SHORT' ELSE state END
          WHERE id = $1`,
        [payout.id, variance, note, short || unmatched.length > 0]);
      if (short) {
        await client.query(
          `UPDATE payments pm SET state = 'SHORT'
             FROM payout_orders x
            WHERE x.payout_id = $1 AND pm.order_id = x.order_id
              AND abs(pm.net - x.amount) > $2`,
          [payout.id, Number(rule.reconcile_tolerance)]);
      }

      await logAction(client, {
        businessId,
        action: short || unmatched.length ? 'PAYOUT_SHORT' : 'PAYOUT_RECONCILED',
        actor: 'n8n',
        detail: {
          account: account.label, payout: externalId, net: body.net ?? 0,
          expected: Number(expected.toFixed(2)), variance, matched,
          unmatched: unmatched.length,
        },
      });
      return { payout_id: payout.id, variance, matched, unmatched, short, note };
    });

    res.status(201).json({ ok: true, ...out });
  }));

  /**
   * The desk chasing an order by itself. Same gate as the human route — the
   * nudge is filed, never sent — and the floor's own rule decides whether it
   * is drafted at all and whether it is early.
   */
  app.post('/api/internal/orders/:id/chase', wrap(async (req, res) => {
    const order = await readOrder(req.params.id);
    if (!order) throw new HttpError(404, 'order not found');

    const live = await internalGate(order.business_id);
    if (live) { res.status(423).json(live); return; }
    if (order.status !== 'UNPAID') {
      res.json({ ok: true, filed: false, reason: 'that order is not waiting on payment' });
      return;
    }

    const rule = await ruleFor(order.business_id,
      order.source === 'live' ? 'live' : order.account_platform ?? 'shopee');
    if (!rule.chase_needs_approval) {
      // Switched off means the drafts are not made at all. It has never meant
      // that they send themselves.
      res.json({ ok: true, filed: false, reason: 'this floor does not chase unpaid orders' });
      return;
    }
    const minutes = Math.round((Date.now() - new Date(order.placed_at).getTime()) / 60000);
    if (minutes < rule.chase_unpaid_after_minutes) {
      res.json({ ok: true, filed: false, reason: 'too early by this floor\u2019s rule' });
      return;
    }
    // One nudge per order: a desk that files the same chase every poll is
    // worse than one that files none.
    const { rows: already } = await q(
      `SELECT 1 FROM approvals
        WHERE business_id = $1 AND payload_json->>'type' = 'payment_chase'
          AND payload_json->>'order_id' = $2 AND status <> 'REJECTED'`,
      [order.business_id, order.id]);
    if (already[0]) { res.json({ ok: true, filed: false, reason: 'already chased' }); return; }

    const agentId = await deskFor(order.business_id, 'Payments');
    const items = (order.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(', ');
    const draft = String(req.body?.draft ?? '').trim()
      || `Hi ${order.buyer_name}, your order ${order.order_no ?? order.external_id} `
         + `(${items}) is still waiting for payment. `
         + (order.checkout_url ? `You can pay here: ${order.checkout_url}. ` : '')
         + `We will hold it a little longer and then release the stock.`;

    const approval = await tx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO approvals (business_id, agent_id, payload_json)
         VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [order.business_id, agentId, JSON.stringify({
          type: 'payment_chase',
          title: `Chase unpaid order ${order.order_no ?? order.external_id}`,
          draft,
          channel: order.account_platform ? `${order.account_platform}_chat` : 'email',
          recipient: order.buyer_name,
          order_id: order.id,
          account_id: order.account_id,
          source: { order_id: order.id, requested_by: 'n8n' },
        })],
      );
      await settleAgent(client, {
        agentId,
        businessId: order.business_id,
        status: 'AWAITING_APPROVAL',
        message: `Chase waiting: ${order.order_no ?? order.external_id}`.slice(0, 500),
      });
      await logAction(client, {
        businessId: order.business_id,
        agentId,
        approvalId: rows[0].id,
        action: 'PAYMENT_CHASE_SUBMITTED',
        actor: 'n8n',
        detail: { order_no: order.order_no ?? order.external_id, unpaid_minutes: minutes },
      });
      return rows[0];
    });
    res.status(201).json({ ok: true, filed: true, approval_id: approval.id });
  }));

  // What the payments desk should be acting on right now: unpaid past the
  // chase mark, past the cancel mark, and escrow that should have landed.
  app.get('/api/internal/payments/due', wrap(async (req, res) => {
    const businessId = assertUuid(req.query.business_id, 'business_id');
    const { rows } = await q(
      `SELECT o.id, o.external_id, o.order_no, o.buyer_name, o.total, o.currency,
              o.placed_at, o.checkout_url, acc.platform, acc.label AS account_label,
              pm.method, pm.state,
              EXTRACT(EPOCH FROM (now() - o.placed_at)) / 60 AS minutes_old,
              r.chase_unpaid_after_minutes, r.cancel_unpaid_after_minutes
         FROM orders o
         LEFT JOIN platform_accounts acc ON acc.id = o.account_id
         LEFT JOIN payments pm ON pm.order_id = o.id
         LEFT JOIN payment_rules r
                ON r.business_id = o.business_id
               AND r.platform = CASE WHEN o.source = 'live' THEN 'live'
                                     ELSE COALESCE(acc.platform, 'shopee') END
        WHERE o.business_id = $1
          AND o.status = 'UNPAID'
          AND EXTRACT(EPOCH FROM (now() - o.placed_at)) / 60
              >= COALESCE(r.chase_unpaid_after_minutes, 180)
        ORDER BY o.placed_at
        LIMIT 100`,
      [businessId]);
    res.json({
      chase: rows.filter((r) => Number(r.minutes_old) < Number(r.cancel_unpaid_after_minutes ?? 2880)),
      cancel: rows.filter((r) => Number(r.minutes_old) >= Number(r.cancel_unpaid_after_minutes ?? 2880)),
    });
  }));

  return { readConversation, readConversations, readOrder, readOrders, ruleFor, applyStock };
}
