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
| `frontend/src/App.jsx` | Header filter, pending list, state, socket wiring. |
| `frontend/src/components/VirtualOfficeCanvas.jsx` | Phaser scene (office floor, avatars). |
| `frontend/src/components/ApprovalModal.jsx` | Approve / Reject / Emergency Pause. |
| `workflows/*.json` | n8n exports. Import through the n8n UI. |
| `docker-compose.yml` | postgres, ollama, n8n, backend, frontend on one network. |

## Commands

```bash
docker compose up -d --build                      # whole stack
docker compose exec ollama ollama pull llama3.1   # first run only
docker compose logs -f backend

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
3. n8n asks Ollama for a draft, then `POST /api/internal/approvals` → row is `PENDING`,
   agent becomes `AWAITING_APPROVAL`.
4. Postgres triggers `NOTIFY`; `server.js` re-reads the row and emits to Socket.io rooms.
5. A human clicks the avatar and approves or rejects:
   - `APPROVE_TASK` → row `APPROVED`, backend calls the n8n dispatch webhook.
   - `REJECT_TASK` → row `REJECTED` with feedback, backend re-calls the lead webhook with
     `feedback` + `previous_draft` so the model revises.
   - `KILL_SWITCH` → agent `PAUSED` (or resumed with `resume: true`).

## Rules that must keep holding

- **The database is the source of truth.** Never emit a socket event for a state change
  directly; write the row and let the trigger → LISTEN path broadcast it. That way changes
  made by n8n, psql, or a second backend instance all reach the UI.
- **Tenant isolation.** Every query that returns operational rows takes a `business_id`
  filter through `businessClause()`. Sockets sit in exactly one room: `biz:<uuid>` or
  `biz:all`. Broadcast only with `broadcast(businessId, …)`.
- **Nothing is dispatched without an approval row moving PENDING → APPROVED.** Resolution
  is a single guarded `UPDATE … WHERE status = 'PENDING'`, so double clicks and two
  reviewers cannot both win.
- **PAUSED always wins.** No side effect (approve, reject, retry) may move a paused agent;
  go through `settleAgent()`.
- **Parameterised SQL only.** Validate ids with `assertUuid()`.
- **Every state transition writes `action_logs`.**
- `/api/internal/*` requires the `x-internal-token` header. It is for n8n, not the browser.

## Conventions

- ES modules, Node 22, no TypeScript. Small files, plain functions.
- Agent statuses: `IDLE | WORKING | AWAITING_APPROVAL | PAUSED`.
  Approval statuses: `PENDING | APPROVED | REJECTED`. Both are CHECK-constrained; add a
  value in `schema.sql` first.
- Approval `payload_json` shape: `{ type, title, draft, channel, recipient, source, … }`.
  `source` is the original request and is what gets replayed on reject. `channel`
  (`email`, `meta_dm`, `shopee`) drives routing in the dispatch workflow.
- Phaser owns the canvas; React never re-renders it. Push data in through
  `scene.syncAgents(agents)`. To add a visual state, extend `applyStatus()`.
- Tailwind utility classes only; no separate CSS files beyond `index.css`.
- Currency is PHP; timezone defaults to `Asia/Manila`.

## Known gaps (good next tasks)

- The dashboard and its REST/socket endpoints have **no login**. Ports are bound to
  127.0.0.1 for that reason. Add auth before exposing this on a network.
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
