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

# Nobody can sign in until this exists. There is no sign-up page.
docker compose exec backend node scripts/create-user.js \
  --email you@example.com --name "You" --business BIZ_ELEC --role owner
```

For yourself, as the person running the deployment rather than any one business:

```bash
docker compose exec backend node scripts/create-user.js \
  --email boss@example.com --name "You" --platform-owner
```

That account opens the **Control Room** instead of a floor. See *Running this as a
platform* below. **There is only ever one of these** — the database enforces it. To hand
it to someone else:

```bash
docker compose exec backend node scripts/transfer-owner.js --to them@example.com
```

That prints a generated password once. Pass `--password` to choose your own (10
characters minimum), omit `--business` to grant every business, and repeat
`--business` for several. `scripts/reset-password.js` changes a password later
and signs that account out everywhere.

| Service | URL |
| --- | --- |
| Dashboard | http://127.0.0.1:5173 |
| Backend API | http://127.0.0.1:4000/api/health |
| n8n | http://127.0.0.1:5678 |
| Postgres | `postgres://office:office@127.0.0.1:5432/virtual_office` |

Every port is bound to `127.0.0.1` in this file — it is the development setup.
See **Deploying it online** below for the version that faces the internet.

Import both files in `workflows/` through the n8n UI, then activate them. They
read `BACKEND_URL`, `OLLAMA_URL`, `OLLAMA_MODEL` and `INTERNAL_TOKEN` from the
environment that `docker-compose.yml` already sets.

## Deploying it online

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and INTERNAL_TOKEN to real secrets
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose exec backend node scripts/create-user.js --email you@example.com --role owner
```

The overlay publishes **only** the dashboard. Postgres, Ollama, the API and n8n stay
on the internal network; reach the n8n editor through an SSH tunnel
(`ssh -L 5678:localhost:5678 your-host`).

Before you point a domain at it:

- **Terminate TLS in front of it** (Caddy, nginx, a load balancer, Cloudflare). The
  session cookie is set `Secure`, so sign-in will not work over plain `http` unless you
  set `COOKIE_SECURE=false` — which sends the cookie unencrypted. Don't.
- **Change `POSTGRES_PASSWORD` and `INTERNAL_TOKEN`.** The defaults are development
  values and `INTERNAL_TOKEN` is the only thing standing between the internet and an
  endpoint that files approvals.
- **Set `TRUST_PROXY`** to the number of proxies in front of the backend, so sign-in
  throttling sees real client IPs rather than the proxy's.
- Accounts see only the businesses they are granted. Give each person the minimum.

## Who can do what

| | Reviewer | Owner | Platform operator |
| --- | --- | --- | --- |
| See the floor and the queue | ✅ | ✅ | only where granted |
| Approve / reject a draft | ✅ | ✅ | only where granted |
| Pause or resume an agent | ❌ | ✅ | only where granted |
| Open / suspend a business | ❌ | ❌ | ✅ |
| Create accounts | ❌ | ❌ | ✅ |
| Read any draft, anywhere | — | own business | **never** |

Roles are per business, so the same person can own one and review another. The checks
are in the routes, not just the buttons: a reviewer who posts the pause request by hand
gets a 403.

## Running this as a platform

A platform operator account lands in the **Control Room**. From there you can open a
business (which provisions its nine desks), hand its owner an account, suspend or
restore it, and watch every floor's activity: who is working, what is waiting, how many
approvals went through, when each office was last busy.

What you cannot do is read anyone's work. The platform endpoints never return draft
text, feedback, recipients or payloads, and an operator account holds no membership in
any business — so the ordinary tenant-scoped routes return 403 and 404 for it, exactly
as they would for a stranger. If you need to see inside a business, its owner grants you
an account like anyone else, and that grant is visible to them in the accounts list.

Suspending a business closes it completely without deleting anything: it leaves its
own people's scope, so its floor, drafts and sockets all go dark for them, and n8n is
refused as well — a checkout or a filed draft comes back 423 and the run aborts. A run
already in flight can still release its desk, so nothing is left stuck in `WORKING`.
Restoring brings it all straight back, pending drafts included.

## Installing it on a phone

The dashboard is a PWA, so it installs to the home screen and opens without browser
chrome. It needs HTTPS, which the deployment instructions above already assume.

- **Android / Chrome** — open the site and take the install prompt, or ⋮ → *Add to Home
  screen*.
- **iPhone / Safari** — Share → *Add to Home Screen*. iOS only offers this in Safari.

What you get is the real dashboard, full screen, with the floor scaled to the phone and
the desk list underneath as the thing you actually tap. Approve, reject and pause all
work the same.

It is not an offline app. The service worker caches the shell and the build assets so it
starts fast, but it deliberately never caches `/api` or the socket — a stale approval
queue would be worse than no app at all. Open it without a connection and you get the
dashboard chrome and a failed sign-in check.

## What each agent is good at

Every desk comes with its department's skills switched on — the Marketing agent has a
**social media ads manager**, a content calendar, copywriting, promo planning and
performance reporting; Sales has lead qualification, quoting, follow-ups, booking and
upsells; CRM has DM replies, review responses, history recall, escalation triage and
satisfaction follow-ups; and so on through Inventory, HR, Admin, Logistics, Security and
Production.

Click an agent to see the list. An **owner** can switch any of them off, and that
changes what the model is asked to do: `/api/internal/agents/checkout` hands n8n the
enabled skills, and the workflow builds its prompt from them. Reviewers see the list but
cannot change it.

Skills are reference data in `skill_catalogue`, keyed by department, so adding one is an
INSERT rather than a code change.

## Social posts, kept in sync

The app is where a post is written and edited; the platforms hold copies. Each post
shows the platforms it is on and the state of each copy.

- **Syncing in** — n8n posts to `/api/internal/posts` with the platform and that
  platform's own id. Re-syncing the same post updates the copy here instead of
  duplicating it.
- **Editing** — edit the text in the app and choose which platforms it should go to.
  If the post is already live anywhere, **saving does not publish**: it files an approval
  like any other outbound work, and those platform copies show as *updating*.
- **Sending it out** — a post that is not on a platform yet gets a **Send it out**
  button. That files an approval too; nothing goes out unapproved.
- **Approving** sends it. `workflow_post_sync.json` publishes or edits each copy
  depending on whether that platform already holds one, and reports back per platform, so
  the dashboard shows exactly which copies went out and which did not, with the reason.
- **Rejecting** discards the edit; the live copies are never touched.

The list has a **filter per platform**, so you can work on one channel at a time instead
of scrolling a mixed feed.

### What each platform can actually do

| | Publish a new post | Edit a live post |
| --- | --- | --- |
| **Facebook** | ✅ `POST /{page-id}/feed` | ✅ `POST /{post-id}` |
| **Shopee** | ❌ a listing needs a category, attributes and logistics — create it in Seller Centre | ✅ `product/update_item` |
| **TikTok** | ✅ Content Posting API, needs an image or video | ❌ no edit endpoint exists |
| **Instagram** | ❌ not wired | ❌ captions cannot be edited through the API |
| **Lazada / X** | ❌ not wired | ❌ not wired |

Where a platform cannot do something, the workflow marks that copy **failed with the
reason** instead of skipping it quietly — so the dashboard never shows a post as sent
when it was not.

**Shopee** needs `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_SHOP_ID` and
`SHOPEE_ACCESS_TOKEN` from the Open Platform console. Every call is signed
`HMAC-SHA256(partner_id + path + timestamp + access_token + shop_id)` under your partner
key. The access token is per shop and expires in hours, so refresh it on a schedule.
`SHOPEE_HOST` switches region or sandbox. The same credentials power the Shopee branch of
the dispatch workflow, which answers buyer chats through `sellerchat/send_message`.

**TikTok** needs `TIKTOK_ACCESS_TOKEN` with `video.publish` / `photo.publish`, an audited
app, and the media URL's domain verified with TikTok. A `.mp4`/`.mov`/`.webm` media URL
goes out as a video, anything else as a photo post.

**Facebook** needs `META_PAGE_ID` to publish something new; editing only needs the post
id it already has.

## Selling: shops, products and listings

A business can connect **several accounts on the same platform** — two Shopee shops and a
Lazada seller account are three separate places the same product can live.

**Connect a shop** in *Connected accounts* on the floor (owners only). Each needs its own
keys:

| Platform | Needs |
| --- | --- |
| Shopee | `partner_id`, `partner_key`, `shop_id`, `access_token` |
| Lazada | `app_key`, `app_secret`, `access_token` |
| TikTok Shop | `app_key`, `app_secret`, `access_token`, `shop_cipher` |
| Facebook / Instagram | `page_access_token` |

Credentials are encrypted with AES-256-GCM before they are stored, and **never come back
to a browser** — the panel shows which fields are set and nothing else. Only the
automation reads them, through a token-gated endpoint that logs every read. Set
`CREDENTIALS_KEY` (32 bytes, base64) before connecting anything:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Each account syncs on its own and can be paused without touching the others.

**Add a product** in *Products*, then **choose which shops carry it**. Listing it files an
approval like any other outbound work; approving it is what creates the listing. Each shop
reports its own result, so you can see that Shopee took it and TikTok refused, with the
reason.

Marketplaces insist on their own category id, a shipping channel and a weight before
they will accept a listing, so those are asked for up front — a product with no category
for Shopee is refused here rather than failing halfway out.

The list filters **per platform and per account**, so two shops on the same marketplace
never get mixed up.

### What each marketplace can do

| | Create a listing | Edit a live one |
| --- | --- | --- |
| **Shopee** | ✅ `product/add_item` | ✅ `product/update_item` |
| **Lazada** | ✅ `/product/create` (XML payload) | ✅ `/product/update` |
| **TikTok Shop** | ✅ `products/202309` | ✅ same endpoint, by id |

Each is signed the way that marketplace documents it: Shopee over
`partner_id + path + timestamp + access_token + shop_id`, Lazada over the path plus its
parameters sorted and concatenated, TikTok Shop over the app secret wrapping the sorted
parameters and the body. The Lazada host follows the account's region.

## Connecting a Facebook or Instagram page

The CRM agent can answer Messenger, and the reply still waits for a human. Nothing is
sent until somebody approves it on the floor.

**1. Make the webhook reachable.** Meta has to be able to call n8n. The production
overlay publishes only `/n8n-webhook/` for that, so your webhook URL is:

```
https://your-domain/n8n-webhook/messenger
```

The n8n editor stays private — reach it over an SSH tunnel.

**2. In the Meta app dashboard** (developers.facebook.com), add the **Messenger**
product, connect your page, and generate a **page access token** with `pages_messaging`.
Copy the **app secret** too.

**3. Put them in `.env`:**

```bash
META_VERIFY_TOKEN=any-string-you-invent
META_APP_SECRET=from-the-app-dashboard
META_PAGE_ACCESS_TOKEN=the-page-token
META_BUSINESS_CODE=BIZ_ELEC        # which business this page belongs to
```

Then `docker compose up -d` so n8n picks them up.

**4. Import `workflows/workflow_messenger_inbound.json`** in the n8n UI and activate it.
Back in the Meta dashboard, add the callback URL above with your verify token and
subscribe the page to the `messages` field. Meta calls the URL once to verify; the
workflow echoes the challenge back.

**5. Import `workflows/workflow_approval_dispatch.json`** (or re-import it if you had the
earlier version) and activate it. That is the half that actually sends: on approval it
posts the text to the Graph API as your page.

Then message your page. The CRM desk picks it up, drafts a reply, and it appears in your
queue. Approve it and it goes out; reject it with feedback and the model rewrites.

A few things worth knowing: Meta's standard messaging window is 24 hours after the
customer's last message, so a draft approved late may be refused by the API. Every
delivery is checked against `X-Hub-Signature-256` using your app secret — if it is wrong
the workflow drops the message rather than answering it. And if a human has paused the
CRM desk, the run aborts with 423 and the conversation is left alone.

Instagram DMs use the same Send API: add the Instagram product to the same app and
subscribe that account.

**Other channels.** `workflow_approval_dispatch.json` routes on
`payload_json.channel`, so adding WhatsApp, Shopee, Viber or email is a matter of adding
a branch to that switch and a sender node. The approval gate stays where it is.

## Adding another business

Two ways. From the Control Room, fill in **Open a new floor** — it creates the business
and its nine desks and lets you hand the owner an account straight away. Or from the
command line:

```bash
docker compose exec -T postgres psql -U office -d virtual_office \
  -c "INSERT INTO businesses (code, name, business_type) VALUES ('BIZ_CATER', 'Sampaguita Catering', 'food');" \
  -c "SELECT provision_business_agents(id) FROM businesses WHERE code = 'BIZ_CATER';"
```

Both go through the same `provision_business_agents()` function, so every floor is laid
out identically.

### How sign-in works

Passwords are hashed with scrypt (no native dependency). A sign-in creates a row in
`sessions` and sets an `HttpOnly`, `SameSite=Lax` cookie holding a random token; only
the token's SHA-256 is stored. Signing out deletes that row, so the cookie is dead on
the next request — including for an already-open socket. Ten failed attempts for the
same email and IP within 15 minutes are throttled.

Every query is scoped by the signed-in account's businesses, so a crafted
`business_id` returns 403, and another tenant's approval reads as 404.

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

The dashboard routes need a session, but `/api/internal/*` is for n8n and takes
the shared token instead, so you can still drive a whole run with curl.

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
| `backend/auth.js` | scrypt passwords, Postgres-backed sessions, tenant scope. |
| `backend/secrets.js` | Encrypts the marketplace credentials sellers connect. |
| `backend/scripts/` | `create-user.js`, `reset-password.js`, `transfer-owner.js`. |
| `frontend/src/App.jsx` | Header filter, pending list, state, socket wiring. |
| `frontend/src/Login.jsx` | Email + password form. |
| `frontend/src/ControlRoom.jsx` | The platform operator's portal. |
| `frontend/src/components/PostsPanel.jsx` | Social posts and the per-platform filter. |
| `frontend/src/components/ProductsPanel.jsx` | Catalogue and which shops carry each item. |
| `frontend/src/components/AccountsPanel.jsx` | Connected seller accounts. |
| `frontend/src/components/VirtualOfficeCanvas.jsx` | Phaser scene: the floor, and the staff who walk it. |
| `frontend/src/components/ApprovalModal.jsx` | Approve / Reject / Emergency Pause. |
| `workflows/*.json` | n8n exports (sales lead, Messenger inbound, dispatch). |
| `docker-compose.yml` | postgres, ollama, n8n, backend, frontend on one network. |
| `docker-compose.prod.yml` | Overlay that publishes only the dashboard. |
