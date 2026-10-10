# Virtual Office — project guide for Claude Code

Multi-tenant, self-hosted AI "virtual office". Autonomous agents (one per department per
business) draft work through n8n + a local Ollama model; nothing reaches a customer until a
human approves it in the dashboard. The original brief is in `docs/BLUEPRINT.md`.

## Layout

| Path | What it is |
| --- | --- |
| `database/schema.sql` | Tables, multi-tenant indexes, NOTIFY triggers. Idempotent. |
| `database/seed.sql` | Two businesses (`BIZ_ELEC`, `BIZ_ITSOL`), ten agents each. |
| `backend/server.js` | Express + Socket.io. REST for the UI and n8n, realtime fan-out. |
| `backend/db.js` | pg pool, `tx()` helper, reconnecting LISTEN client. |
| `backend/auth.js` | scrypt passwords, Postgres-backed sessions, tenant scope. |
| `backend/secrets.js` | AES-256-GCM for marketplace credentials. Never serves a value. |
| `backend/oauth.js` | Connecting a shop by authorising on the marketplace. |
| `backend/commerce.js` | The inbox, orders, payments and payouts. |
| `backend/uploads.js` | Product photos off the device, and the folder they are served from. |
| `backend/live.js` | Live selling: the basket, the monitor, the claims. |
| `backend/business-lines.js` | The trades a floor can be opened for. |
| `backend/scripts/` | `create-user.js`, `reset-password.js`. There is no sign-up page. |
| `frontend/src/Login.jsx` | Email + password form. |
| `frontend/src/ControlRoom.jsx` | Platform operator's portal. Activity only, never content. |
| `frontend/src/components/PostsPanel.jsx` | Social posts, per-platform filter, editing. |
| `frontend/src/components/ProductsPanel.jsx` | Catalogue, and which shops carry each item. |
| `frontend/src/components/AccountsPanel.jsx` | Connected seller accounts, one per shop. |
| `frontend/src/components/InboxPanel.jsx` | Buyer conversations. No calls: these platforms have none. |
| `frontend/src/components/SalesPanel.jsx` | Orders, the money behind them, and the floor's rules. |
| `frontend/src/components/LivePanel.jsx` | The yellow basket, the monitor, live claims. |
| `frontend/src/components/NewOfficeDialog.jsx` | Opening another floor for another trade. |
| `frontend/src/components/DesksPanel.jsx` | Which desks the floor has, and which it could have back. |
| `frontend/public/` | PWA manifest, service worker and icons. |
| `frontend/src/App.jsx` | Header filter, pending list, state, socket wiring. |
| `frontend/src/components/VirtualOfficeCanvas.jsx` | Phaser scene (office floor, avatars). |
| `frontend/src/components/ApprovalModal.jsx` | Approve / Reject / Emergency Pause. |
| `workflows/workflow_sales_lead.json` | Lead → checkout → Ollama → approval. |
| `workflows/workflow_messenger_inbound.json` | Meta webhook → CRM agent → approval. |
| `workflows/workflow_approval_dispatch.json` | Approved → the real channel sender. |
| `workflows/workflow_post_sync.json` | Approved post edit → updates each platform copy. |
| `workflows/workflow_product_sync.json` | Approved listing → Shopee, Lazada, TikTok Shop. |
| `workflows/workflow_marketplace_chat.json` | Buyer chat in → CRM draft → approval → reply out. |
| `workflows/workflow_order_sync.json` | Orders, payouts, and the collector's unpaid round. |
| `workflows/workflow_live_monitor.json` | Basket pinning, the room's numbers, comment claims. |
| `docker-compose.yml` | postgres, ollama, n8n, backend, frontend on one network. |
| `docker-compose.prod.yml` | Overlay for a deployment that is reachable online. |

## Commands

```bash
docker compose up -d --build                      # whole stack
docker compose exec ollama ollama pull llama3.1   # first run only
docker compose logs -f backend

# Accounts. Nobody can sign in until you make the first one.
docker compose exec backend node scripts/create-user.js \
  --email you@example.com --name "You" --business BIZ_ELEC --role owner

# You, as the person running the deployment. Watches every floor, is a
# member of none — so it can open businesses but cannot read their work.
docker compose exec backend node scripts/create-user.js \
  --email boss@example.com --name "You" --platform-owner

# Deployed, with only the dashboard published (put TLS in front of it):
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

cd backend  && npm install && npm run dev         # backend alone (needs DATABASE_URL)
cd frontend && npm install && npm run dev         # dashboard on :5173, proxies to :4000
cd frontend && npm run build                      # must pass before calling UI work done
```

Schema changes do not re-apply to an existing volume. Either run the SQL by hand
(`docker compose exec -T postgres psql -U office -d virtual_office < database/schema.sql`)
or reset with `docker compose down -v`.

There is no test suite yet. Verify backend changes against a real Postgres, not mocks —
the realtime path depends on triggers.

## How data flows

1. A lead hits the n8n webhook `POST /webhook/sales-lead`.
2. n8n calls `POST /api/internal/agents/checkout` → agent becomes `WORKING`
   (HTTP 423 if the agent is `PAUSED`, which aborts the run).
   A Facebook or Instagram message takes the same path through
   `workflow_messenger_inbound.json`, which claims the `CRM` desk instead.
3. n8n asks Ollama for a draft, then `POST /api/internal/approvals` → row is `PENDING`,
   agent becomes `AWAITING_APPROVAL`.
4. Postgres triggers `NOTIFY`; `server.js` re-reads the row and emits to Socket.io rooms.
5. A signed-in human clicks the avatar and approves or rejects:
   - `APPROVE_TASK` → row `APPROVED`, backend calls the n8n dispatch webhook.
   - `REJECT_TASK` → row `REJECTED` with feedback, backend re-calls the lead webhook with
     `feedback` + `previous_draft` so the model revises.
   - `KILL_SWITCH` → agent `PAUSED` (or resumed with `resume: true`).

## Rules that must keep holding

- **The database is the source of truth.** Never emit a socket event for a state change
  directly; write the row and let the trigger → LISTEN path broadcast it. That way changes
  made by n8n, psql, or a second backend instance all reach the UI.
- **Tenant isolation.** Every query that returns operational rows takes a `business_id`
  filter through `businessClause()`, and the ids it filters on come from `scopeFor(user, …)`
  — the signed-in account's memberships — never straight from the request. A socket joins
  one room per business its user belongs to (`biz:<uuid>`); there is no global room, and
  nothing is emitted except through `broadcast(businessId, …)`.
- **Roles are enforced server-side.** `owner` and `reviewer` both approve and reject;
  only an `owner` may pause or resume an agent, checked with `requireOwner(user, businessId)`
  before anything is written. The UI hides what a reviewer cannot do, but hiding is not
  the enforcement — the route is.
- **There is exactly one platform operator.** A partial unique index on
  `users (is_platform_owner) WHERE is_platform_owner` enforces it, `create-user.js`
  refuses a second with the current one's name, and `transfer-owner.js` moves it in one
  transaction. Do not add a way to make more.
- **A post reaching a platform is outbound work, so it goes through the gate.** Neither
  `PATCH /api/posts/:id` nor `POST /api/posts/:id/publish` touches a platform. An edit to
  a live post files a `post_update` approval and marks those targets `UPDATE_PENDING`; a
  first send files `post_publish` and marks them `PUBLISH_PENDING`. Approving either
  calls `N8N_POST_SYNC_WEBHOOK_URL`; each platform reports its own result back to
  `/api/internal/posts/:id/targets`. Rejecting returns `UPDATE_PENDING` to `PUBLISHED`
  and `PUBLISH_PENDING` to `NOT_PUBLISHED`, so a discarded send never looks sent. A post
  that is live nowhere and is only being edited is a draft and saves directly.
- **A sender that cannot do the job says so.** The sync workflow reports a target
  `FAILED` with a readable reason rather than skipping it: Instagram and TikTok cannot
  edit a published post, Shopee cannot create a listing from a caption, and an unset
  credential names the variable. Keep that; a silently skipped platform looks sent.
- **A shop is connected by authorising, not by pasting keys.** `POST /api/accounts/authorize`
  stores a single-use `connect_states` row and sends the seller to the marketplace's own
  page; the redirect lands on `/api/accounts/callback`, which checks the state belongs to
  the person finishing it, swaps the code for tokens server-side and encrypts them. That
  redirect must be on the **dashboard's own origin** — it is a top-level navigation and
  needs the session cookie, so pointing `OAUTH_REDIRECT_BASE` at the API on another host
  makes every callback arrive signed out. A platform whose app credentials are unset says
  which variable is missing and the UI falls back to the key form; it never opens a page
  that could only fail. `POST /api/accounts` is that fallback, not the main path.
- **Credentials are write-only from the browser.** A business connects several seller
  accounts; each one's keys are encrypted with AES-256-GCM under `CREDENTIALS_KEY` in
  `secrets.js`. `describeCredentials()` is all the dashboard ever sees — which fields are
  set, a tail for identifiers only, never a secret's value, not even its last characters.
  The one way back out is `GET /api/internal/accounts/:id/credentials`, token-gated, and
  it writes `ACCOUNT_CREDENTIALS_READ` to the log every time. Do not add a route that
  returns them to a session.
- **A product reaching a marketplace is outbound work.** `POST /api/products/:id/publish`
  and an edit to a listed product both file an approval and mark the listings
  `PUBLISH_PENDING` / `UPDATE_PENDING`; approving calls `N8N_PRODUCT_SYNC_WEBHOOK_URL`
  and each account reports back to `/api/internal/products/:id/listings`. Listings are
  per **account**, not per platform, because a business can hold two shops on one
  marketplace. The approval sits on the Inventory desk (`deskFor()`), so catalogue work
  shows up on the floor like everything else.
- **Suspension closes a business everywhere.** `resolveSession()` only counts memberships
  in businesses with `is_active`, so a suspended one leaves `businessIds` and every scope
  derived from it: REST reads, guarded writes, socket rooms. `/api/internal/*` checks it
  too — checkout and filing a draft return 423 with `status: 'SUSPENDED'`, so an n8n run
  aborts the same way it does for a paused agent. `release` stays open on purpose: it can
  only move an agent to IDLE, and blocking it would strand a desk in `WORKING`. The
  operator's portal still lists suspended businesses, because watching them is its job.
- **The platform operator sees activity, never content.** `is_platform_owner` unlocks
  `/api/platform/*` only. Those handlers never select `payload_json`, `feedback` or
  `resolved_by`, and an operator holds no `user_businesses` row, so every tenant-scoped
  read returns nothing for them. Reading a business's work means being granted an account
  on it. Keep it that way: adding a draft field to a platform response breaks the promise
  the portal makes on screen.
- **Authentication is not optional.** Everything under `/api` needs a session cookie
  except `/api/health` and `/api/auth/*`. Sockets verify the same cookie in `io.use()`.
  A write also re-checks the business in its own `WHERE … AND business_id = ANY($n)`, so
  a stale scope cannot reach another tenant's row. Accounts come from
  `scripts/create-user.js`; adding a sign-up route would be a product decision, not a
  refactor.
- **Nothing is dispatched without an approval row moving PENDING → APPROVED.** Resolution
  is a single guarded `UPDATE … WHERE status = 'PENDING'`, so double clicks and two
  reviewers cannot both win.
- **PAUSED always wins.** No side effect (approve, reject, retry) may move a paused agent;
  go through `settleAgent()`.
- **A desk taken off the floor is not deleted.** `approvals.agent_id` is NOT NULL ON DELETE
  CASCADE, and action logs and conversations name an agent too, so deleting the row would
  take that history with it. `DELETE /api/agents/:id` sets `removed_at`; every read filters
  `removed_at IS NULL`, so the agent and its table are simply not on the floor, and the
  realtime path sends a removal out as `deleted` rather than as a row to redraw. Checkout
  and filing both 404 on one, and `deskFor()` never picks one. `POST /api/agents` clears
  the column — same row, same skills, same place — and `agent_roster()` is the one list
  both that and `provision_business_agents()` read. A desk mid-job or holding a PENDING
  draft is refused, because that work would be stranded where nobody could reach it.
- **These marketplaces have no phone line.** Shopee, Lazada and TikTok Shop give a seller
  chat, a listing and an order feed, and no voice-call API. The inbox says so once at the
  top, the CRM prompt forbids offering a call, and nothing anywhere offers to ring a buyer.
- **An order and its money are two different events.** The buyer pays the marketplace,
  which holds it in escrow and releases the seller's share later minus its fees, so
  `orders` records what happened and `payments` tracks how far the money has got. A sync
  that does not mention a figure is not saying it is zero — only what the marketplace
  actually sent is written, or a cheap poll wipes the fees a fuller one got. Reconciling a
  payout reports the gap; it never rounds it away.
- **`payment_rules` decides, not the code.** Whether cash on delivery is allowed and up to
  what total, when stock really leaves the shelf (`release_stock_on`), and when an unpaid
  order is chased or given up on are per business and per marketplace. An unpaid order
  ships only on COD, inside the limit, and the refusal quotes the rule.
- **A photo has to become a URL before a listing can carry it.** Shopee, Lazada and
  TikTok Shop fetch the image over HTTP while they build the listing — none of them will
  look at a picture on the seller's phone. So `POST /api/uploads` takes the `File` as the
  whole request body (no multipart, no parser, no dependency), decides what it is from its
  own first bytes rather than the `Content-Type` header, and writes it under
  `uploads/<business_id>/<random>.<ext>`. Writing one needs an owner's session on that
  business; reading one needs nothing, because a marketplace holds no session here — the
  random name is the only thing guarding it. `UPLOAD_DIR` is a volume, or a rebuild drops
  the pictures the live listings point at.
- **A live session is armed once, and that is the gate.** A room moves faster than anyone
  can click, so `live_arm` is an approval over the exact sentence the desk will send a
  claimer; inside that session the desk fills in only the blanks. Pinning the basket is its
  own approval. Pausing withdraws both at once, and `/api/internal/live/*` returns 423 for
  a session that is not `LIVE` with an `APPROVED` arming — the same shape as a paused agent.
  TikTok's basket is real; Meta retired Live Shopping in October 2022, so a facebook
  session says so on its face and reads the comments instead.
- **An order out of a live room belongs to that room.** `POST /api/live/:id/go-live`
  connects a session to the stream the seller just started — it starts nothing on the
  platform, it says which room is theirs — and arming is still the gate it goes through.
  From then on the order sync files matching orders against the session
  (`orders.live_session_id`) and `attachOrderToLive()` moves the basket: the order's own
  lines are what `sold` counts, and a matching claim only has its hold released, or one
  sale would read as two. `live_counted_at` makes that happen once however often the order
  re-syncs, and a cancellation takes it back out. TikTok Shop does not hand back the room
  an order was bought in, so the workflow uses what is actually knowable — this shop is
  streaming and the order was placed after it started — and two rooms open on one shop is
  not guessed at.
- **Parameterised SQL only.** Validate ids with `assertUuid()`.
- **Every state transition writes `action_logs`,** naming the person (`actor` is the
  user's email, `actor_user_id` the row) or `n8n` for an automated one.
- `/api/internal/*` requires the `x-internal-token` header. It is for n8n, not the browser.

## Conventions

- ES modules, Node 22, no TypeScript. Small files, plain functions.
- Skills live in `skill_catalogue` (reference data, keyed by department) and
  `agent_skills` (which ones a desk has on). `provision_business_agents()` switches them
  all on for a new floor, checkout hands the enabled list to n8n so the prompt is built
  from it, and only an owner may toggle one. Adding a skill means a row in the catalogue,
  not a code change.
- Platforms are `facebook | instagram | tiktok | shopee | lazada | x`, CHECK-constrained
  on `social_post_targets` and `platform_accounts`. Add one there and to `PLATFORMS` in
  `server.js` together, plus a branch in the sync workflows.
- A marketplace will not take a listing without its own category id, logistics and
  weight. `products.platform_meta` holds those per platform, and
  `POST /api/products/:id/publish` refuses up front rather than letting the call fail
  halfway out. `REQUIRED_CREDENTIALS` in `secrets.js` does the same for account keys.
- Each kind of outbound work registers on the approval registry
  (`registerApprovalType`) with the workflow it dispatches to, what that workflow needs,
  and how to put its rows back when it is turned down or nothing takes the job. A kind that
  handles its own rejection also settles its desk, rather than leaving it `WORKING` for a
  revision that is never coming. Adding a kind means a registration, not another branch in
  the approve and reject routes.
- Ten desks: `Sales, Marketing, CRM, Payments, Inventory, Logistics, Production, Admin,
  HR, Security`. `provision_business_agents()` is the only place the layout is decided, and
  `business-lines.js` renames them for the trade — the departments never change, so every
  rule, workflow and filter that keys off one still works.
- The canvas draws **one** office. Every floor uses the same desk coordinates, so drawing
  two at once stands one business's staff inside another's; `App.jsx` scopes the agents and
  passes the business as `floor`, and `FLOOR_THEMES` picks the boards, walls, accent and
  the one piece of kit that says what the business does.
- **The floor fits the box it is given.** Above `NARROW_AT` it is the room as designed —
  `DESIGN_W` × `DESIGN_H`, five desks across at the coordinates `agent_roster()` gives,
  scaled to the box by Phaser's `FIT`. Below it the same room is rebuilt two desks across
  and taller: `resizeTo()` works out the shape, `deskAt()` places each desk by its roster
  index instead of its stored coordinates, the lounge and pantry stack because a 170px
  lounge cannot hold a sofa, and `drawNarrowProps()` puts the feature and the water point
  in the aisles. Scrolling down a page is what a phone is for; scrolling across it is not.
  Three things that cost an afternoon each: the box needs an explicit height or `FIT`
  scales the floor to a parent that is zero tall while the tab is closed and the canvas
  vanishes; `scale.setGameSize()` is what changes the floor under `FIT` (`resize()` only
  touches the canvas); and `refit()` has to run after a reflow, because a position and a
  route from the old floor point somewhere the new one does not have.
- Agent statuses: `IDLE | WORKING | AWAITING_APPROVAL | PAUSED`.
  Approval statuses: `PENDING | APPROVED | REJECTED`. Both are CHECK-constrained; add a
  value in `schema.sql` first.
- Approval `payload_json` shape: `{ type, title, draft, channel, recipient, source, … }`.
  `source` is the original request and is what gets replayed on reject. `channel`
  (`email`, `meta_dm`, `shopee`) drives routing in the dispatch workflow.
- Each figure carries a two-line plate: name, then `role_title`. `separate()` keeps a
  plate-shaped box clear between any two people, walking or not — sized from the plates
  Phaser actually laid out (`plateWidth()`), because "Customer Care Agent" needs a good
  deal more room than `PLATE_W` would guess. `PLATE_H` is deliberately tight: stepping
  around somebody costs twenty pixels of height where backing off costs a hundred of
  width, so the cheap way out is the vertical one. The nudge is capped at `NUDGE_SPEED`,
  **under** walking pace, and that cap is the point in both directions: an uncapped push
  moved people further in one frame than a step did, so two meeting at the same aisle
  corner shoved each other back and forth for ever; a push above walking pace instead
  stops a walker ever reaching a spot next to somebody. Under that cap a crossing will
  overlap for a second or so and cannot be prevented — so the plates are opaque and
  depth-sorted by `y`, and a crossing reads as one card in front of another rather than
  two sets of words mixed together. Each person also carries a fixed `laneX` / `laneY` so
  no two route through the identical waypoint in the first place, and `edgeFor()` keeps
  everyone half a plate off the wall so a name never hangs over the edge.
- Phaser owns the canvas; React never re-renders it. Push data in through
  `scene.syncAgents(agents)`. To add a visual state, extend `applyStatus()` — that is
  also where a status decides what the figure *does* (sit at the desk, stand beside it,
  wander the aisles, stop dead). Movement is in `step()`; `routeTo()` keeps people walking
  the aisles between desk blocks rather than over them.
- Tailwind utility classes only; no separate CSS files beyond `index.css`.
- **A phone gets its own layout out of the same DOM.** Below `lg` the dashboard is six
  tabs — Queue, Floor, Inbox, Sales, Live, Market — and `onTab(name)` in `App.jsx` returns
  `hidden lg:block` for everything that is not the open one, so there is one tree rather
  than two layouts to keep in step. It opens on Queue because approving is what the app is
  for. `main` carries `env(safe-area-inset-bottom) + 72px` of bottom padding so the tab bar
  never covers the last panel. The floor reflows to the width it is given (see the canvas
  note above), so nothing scrolls sideways — not the strip and not the page.
- The dashboard installs as a PWA. `public/sw.js` must never cache `/api` or `/socket.io`
  — a stale approval queue is worse than no app. Bump `VERSION` in it when the shell
  changes. Phaser runs with `expandParent: false`, or it widens its host div and pushes
  the page sideways on a phone.
- Currency is PHP; timezone defaults to `Asia/Manila`.

## Known gaps (good next tasks)

- Suspending a business leaves its agents in whatever status they held, so a desk that
  was `WORKING` still reads that way when it is restored. Settling them on suspend would
  lose the link to any `AWAITING_APPROVAL` draft, so it is left alone for now.
- The service worker caches the shell only. The dashboard needs the network, so opening
  the installed app offline gets the chrome and a failed session check, not a usable
  queue. Offline review would need the approvals cached, which is a product decision.
- The Messenger workflow answers one page, chosen by `META_BUSINESS_CODE`. Routing several
  pages to several businesses needs a page-id lookup rather than an env var.
- No password reset for the user: `scripts/reset-password.js` is the only route, and there
  is no email sending anywhere in the stack.
- The sign-in throttle lives in one backend process's memory. Run more than one instance
  and you want a shared limiter, or a rate limit at the proxy.
- Marketing, Inventory, HR, Admin, Logistics, Security and Production agents are seeded
  and rendered but have no n8n workflow of their own. Sales, CRM and Payments do.
- Lazada's statement endpoint does not carry its order lines, so a Lazada payout
  reconciles against nothing and is recorded saying so. Matching it needs
  `/finance/transaction/detail/get` per order.
- A live checkout link is whatever `LIVE_CHECKOUT_BASE` points at. TikTok's own cart is
  the right target there and is not wired; on Facebook, with Live Shopping gone, the seller
  has to have a checkout of their own.
- `connect_states` rows are swept only by their expiry index, not by a job.
- An uploaded photo is written before the product is saved, so abandoning the form leaves
  the file behind. Nothing sweeps `uploads/`, and deleting a product does not delete its
  pictures — a listing already on a marketplace may still be pointing at them.
- A live order is matched to its session by the room id when the platform gives one, and
  otherwise by "this shop has exactly one stream open". TikTok Shop's order API does not
  carry the room, so on TikTok it is always the second. Two streams on one shop at once
  and neither is attributed.
- `workflow_approval_dispatch.json` routes by channel into placeholder nodes; the real
  Meta / Shopee / email senders are not wired.
- Reject always replays through `N8N_RETRY_WEBHOOK_URL` (the sales webhook). Once other
  departments have workflows, route retries per department.
- External LLM fallback (when Ollama is down) is not implemented.
- Uses plain PostgreSQL. `schema.sql` also runs on self-hosted Supabase, but the realtime
  layer here is LISTEN/NOTIFY, not Supabase Realtime.
- Avatars are drawn with primitives; `avatar_sprite_key` only selects a colour.
