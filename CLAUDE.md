# Virtual Office — project guide for Claude Code

Multi-tenant, self-hosted AI "virtual office". Autonomous agents (one per department per
business) draft work through n8n + a local Ollama model; nothing reaches a customer until a
human approves it in the dashboard. The original brief is in `docs/BLUEPRINT.md`.

## Layout

| Path | What it is |
| --- | --- |
| `database/schema.sql` | Tables, multi-tenant indexes, NOTIFY triggers. Idempotent. |
| `database/seed.sql` | Two businesses (`BIZ_ELEC`, `BIZ_ITSOL`), nine agents each. |
| `backend/server.js` | Express + Socket.io. REST for the UI and n8n, realtime fan-out. |
| `backend/db.js` | pg pool, `tx()` helper, reconnecting LISTEN client. |
| `backend/auth.js` | scrypt passwords, Postgres-backed sessions, tenant scope. |
| `backend/scripts/` | `create-user.js`, `reset-password.js`. There is no sign-up page. |
| `frontend/src/Login.jsx` | Email + password form. |
| `frontend/src/ControlRoom.jsx` | Platform operator's portal. Activity only, never content. |
| `frontend/src/components/PostsPanel.jsx` | Social posts, per-platform filter, editing. |
| `frontend/public/` | PWA manifest, service worker and icons. |
| `frontend/src/App.jsx` | Header filter, pending list, state, socket wiring. |
| `frontend/src/components/VirtualOfficeCanvas.jsx` | Phaser scene (office floor, avatars). |
| `frontend/src/components/ApprovalModal.jsx` | Approve / Reject / Emergency Pause. |
| `workflows/workflow_sales_lead.json` | Lead → checkout → Ollama → approval. |
| `workflows/workflow_messenger_inbound.json` | Meta webhook → CRM agent → approval. |
| `workflows/workflow_approval_dispatch.json` | Approved → the real channel sender. |
| `workflows/workflow_post_sync.json` | Approved post edit → updates each platform copy. |
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
  on `social_post_targets`. Add one there and to `PLATFORMS` in `server.js` together.
- Agent statuses: `IDLE | WORKING | AWAITING_APPROVAL | PAUSED`.
  Approval statuses: `PENDING | APPROVED | REJECTED`. Both are CHECK-constrained; add a
  value in `schema.sql` first.
- Approval `payload_json` shape: `{ type, title, draft, channel, recipient, source, … }`.
  `source` is the original request and is what gets replayed on reject. `channel`
  (`email`, `meta_dm`, `shopee`) drives routing in the dispatch workflow.
- Phaser owns the canvas; React never re-renders it. Push data in through
  `scene.syncAgents(agents)`. To add a visual state, extend `applyStatus()` — that is
  also where a status decides what the figure *does* (sit at the desk, stand beside it,
  wander the aisles, stop dead). Movement is in `step()`; `routeTo()` keeps people walking
  the aisles between desk blocks rather than over them.
- Tailwind utility classes only; no separate CSS files beyond `index.css`.
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
- Only the Sales workflow exists. Marketing, CRM, Inventory, HR, Admin, Logistics,
  Security and Production agents are seeded and rendered but have no n8n workflow.
- `workflow_approval_dispatch.json` routes by channel into placeholder nodes; the real
  Meta / Shopee / email senders are not wired.
- Reject always replays through `N8N_RETRY_WEBHOOK_URL` (the sales webhook). Once other
  departments have workflows, route retries per department.
- External LLM fallback (when Ollama is down) is not implemented.
- Uses plain PostgreSQL. `schema.sql` also runs on self-hosted Supabase, but the realtime
  layer here is LISTEN/NOTIFY, not Supabase Realtime.
- Avatars are drawn with primitives; `avatar_sprite_key` only selects a colour.
