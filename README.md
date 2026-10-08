# Virtual Office

Multi-tenant, self-hosted AI "virtual office". Each business gets nine
autonomous agents — one per department — that draft work through n8n and a
local Ollama model. Nothing reaches a customer until a human approves it on the
dashboard floor plan.

The brief is in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md); the working notes for
Claude Code are in [`CLAUDE.md`](CLAUDE.md).

## Run the stack

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec ollama ollama pull llama3.1   # first run only
```

| Service | URL |
| --- | --- |
| Dashboard | http://127.0.0.1:5173 |
| Backend API | http://127.0.0.1:4000/api/health |
| n8n | http://127.0.0.1:5678 |
| Postgres | `postgres://office:office@127.0.0.1:5432/virtual_office` |

Every port is bound to `127.0.0.1` because **the dashboard has no login yet**.
Add auth before exposing this on a network.

Import both files in `workflows/` through the n8n UI, then activate them. They
read `BACKEND_URL`, `OLLAMA_URL`, `OLLAMA_MODEL` and `INTERNAL_TOKEN` from the
environment that `docker-compose.yml` already sets.

## Run the parts on their own

```bash
cd backend  && npm install && npm run dev   # needs DATABASE_URL
cd frontend && npm install && npm run dev   # :5173, proxies to :4000
cd frontend && npm run build                # must pass before calling UI work done
```

## Schema changes

The init scripts only run on an **empty** volume. For an existing database,
apply the SQL by hand (it is idempotent):

```bash
docker compose exec -T postgres psql -U office -d virtual_office < database/schema.sql
docker compose exec -T postgres psql -U office -d virtual_office < database/seed.sql
```

Or start over with `docker compose down -v`.

## Try the flow without n8n

`/api/internal/*` is what n8n calls, so you can drive a whole run with curl.

```bash
TOKEN=dev-internal-token

# 1. Claim the Sales desk (HTTP 423 if a human has paused that agent).
AGENT=$(curl -s -X POST localhost:4000/api/internal/agents/checkout \
  -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"business_code":"BIZ_ELEC","department":"Sales","task":"Panel upgrade enquiry"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["agent"]["id"])')

# 2. File a draft for review — the desk turns amber on the dashboard.
curl -s -X POST localhost:4000/api/internal/approvals \
  -H "x-internal-token: $TOKEN" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AGENT\",\"payload\":{\"type\":\"sales_reply\",
       \"title\":\"Reply to Mrs. Santos\",
       \"draft\":\"Good day! A 100A panel upgrade is PHP 18,500 all-in.\",
       \"channel\":\"email\",\"recipient\":\"santos@example.com\",
       \"source\":{\"lead_id\":\"LEAD-1\",\"message\":\"How much for a panel upgrade?\"}}}"
```

Then approve or reject it in the dashboard and watch the desk change without a
refresh. Approving calls the n8n dispatch webhook; rejecting replays the lead
webhook with your feedback plus the draft that was turned down.

There is no test suite yet. Verify backend changes against a real Postgres —
the realtime path runs on triggers, so mocks prove nothing.

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
