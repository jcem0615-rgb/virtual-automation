-- Virtual Office — schema.
-- Idempotent: safe to run against an existing database.
--   docker compose exec -T postgres psql -U office -d virtual_office < database/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenants

CREATE TABLE IF NOT EXISTS businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Manila',
  currency    char(3) NOT NULL DEFAULT 'PHP',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- agents
-- One agent per department per business. status is CHECK-constrained; add a
-- value here before using it anywhere else.

CREATE TABLE IF NOT EXISTS agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  department        text NOT NULL,
  name              text NOT NULL,
  role_title        text,
  status            text NOT NULL DEFAULT 'IDLE'
                    CHECK (status IN ('IDLE','WORKING','AWAITING_APPROVAL','PAUSED')),
  avatar_sprite_key text NOT NULL DEFAULT 'staff_default',
  desk_x            int NOT NULL DEFAULT 0,
  desk_y            int NOT NULL DEFAULT 0,
  last_message      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, department)
);

-- A business that does not need a department can take its desk away. The row
-- stays: approvals, action logs and conversations all name an agent, and
-- deleting it would take that history with it. `removed_at` is what the floor
-- and every roster read filters on, so the desk and its table simply are not
-- there — and putting it back is clearing one column, skills and all.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE INDEX IF NOT EXISTS agents_on_floor_idx
  ON agents (business_id, desk_y, desk_x) WHERE removed_at IS NULL;

-- -------------------------------------------------------------- approvals
-- The human gate. Nothing is dispatched until a row moves PENDING -> APPROVED.

CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  payload_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  feedback      text,
  resolved_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

-- ------------------------------------------------------------ action_logs
-- Every state transition writes one row here.

CREATE TABLE IF NOT EXISTS action_logs (
  id           bigserial PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  approval_id  uuid REFERENCES approvals(id) ON DELETE SET NULL,
  action       text NOT NULL,
  actor        text NOT NULL DEFAULT 'system',
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------- multi-tenant indexes
-- Every operational read is scoped by business_id, so every index leads with it.

CREATE INDEX IF NOT EXISTS agents_business_status_idx
  ON agents (business_id, status);
CREATE INDEX IF NOT EXISTS agents_business_department_idx
  ON agents (business_id, department);

CREATE INDEX IF NOT EXISTS approvals_business_status_created_idx
  ON approvals (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS approvals_business_agent_idx
  ON approvals (business_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approvals_pending_idx
  ON approvals (business_id, created_at DESC) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS action_logs_business_created_idx
  ON action_logs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS action_logs_business_agent_idx
  ON action_logs (business_id, agent_id, created_at DESC);

-- ----------------------------------------------------- NOTIFY plumbing
-- The database is the source of truth. A writer never emits a socket event;
-- it writes the row and these triggers announce it. The backend LISTENs,
-- re-reads the row and fans it out, so changes made by n8n, psql or a second
-- backend instance all reach the UI.
--
-- Payloads stay tiny (ids only) — NOTIFY is capped at 8000 bytes and the
-- backend needs the committed row anyway.

CREATE OR REPLACE FUNCTION notify_office_event() RETURNS trigger AS $fn$
DECLARE
  row_record record;
BEGIN
  row_record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  PERFORM pg_notify('office_events', json_build_object(
    'entity',      TG_ARGV[0],
    'op',          TG_OP,
    'id',          row_record.id,
    'business_id', row_record.business_id
  )::text);
  RETURN NULL;  -- AFTER trigger; return value is ignored
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_touch_updated_at ON agents;
CREATE TRIGGER agents_touch_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS agents_notify ON agents;
CREATE TRIGGER agents_notify
  AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('agent');

DROP TRIGGER IF EXISTS approvals_notify ON approvals;
CREATE TRIGGER approvals_notify
  AFTER INSERT OR UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('approval');

DROP TRIGGER IF EXISTS action_logs_notify ON action_logs;
CREATE TRIGGER action_logs_notify
  AFTER INSERT ON action_logs
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('action_log');

-- ------------------------------------------------------------- identity
-- Added so the dashboard can be exposed beyond 127.0.0.1. Accounts are
-- created by an operator (see backend/scripts/create-user.js); there is no
-- public sign-up, because this is a back office, not a product with members.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Logins are matched case-insensitively, so uniqueness has to be too.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Which tenants a user may see. This is what scopes every operational query
-- once a request is authenticated — the browser no longer picks its own scope.
CREATE TABLE IF NOT EXISTS user_businesses (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'reviewer' CHECK (role IN ('owner','reviewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, business_id)
);

CREATE INDEX IF NOT EXISTS user_businesses_business_idx
  ON user_businesses (business_id);

-- Server-side sessions, so signing out (or disabling an account) takes effect
-- immediately. Only the hash of the cookie value is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           text
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- The audit trail should name a person, not just the string 'dashboard'.
ALTER TABLE action_logs ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE approvals   ADD COLUMN IF NOT EXISTS resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- ------------------------------------------------------ platform operator
-- The person who runs this deployment and sells it on. Distinct from a
-- business `owner`: a platform operator can create and suspend businesses and
-- watch them working, but is NOT a member of any of them, so none of the
-- tenant-scoped reads below ever return their rows. Access to a floor comes
-- only from a user_businesses grant, like it does for anyone else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_owner boolean NOT NULL DEFAULT false;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_type text NOT NULL DEFAULT 'general';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------- provisioning a floor
-- The nine desks every business gets, and where they sit on the canvas.
-- seed.sql and the platform API both go through this, so a floor created from
-- the portal is laid out exactly like the seeded ones.
-- The ten desks a floor is laid out with: the five that face outward along
-- the front, the five that keep the place running behind them. The
-- coordinates are the floor the canvas draws, so this is the only place the
-- layout is decided — provisioning a whole floor and putting one removed
-- desk back both read it.
CREATE OR REPLACE FUNCTION agent_roster()
RETURNS TABLE (department text, role_title text, sprite text, desk_x int, desk_y int)
AS $fn$
  VALUES
    ('Sales',      'Sales Agent',        'staff_amber',  124, 330),
    ('Marketing',  'Marketing Agent',    'staff_rose',   336, 330),
    ('CRM',        'Customer Care Agent','staff_sky',    548, 330),
    ('Payments',   'Payment Collector',  'staff_emerald',760, 330),
    ('Inventory',  'Inventory Agent',    'staff_lime',   972, 330),
    ('Logistics',  'Dispatch Agent',     'staff_teal',   124, 560),
    ('Production', 'Operations Agent',   'staff_orange', 336, 560),
    ('Admin',      'Admin Agent',        'staff_slate',  548, 560),
    ('HR',         'People Agent',       'staff_violet', 760, 560),
    ('Security',   'Security Agent',     'staff_red',    972, 560)
$fn$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION provision_business_agents(p_business_id uuid)
RETURNS integer AS $fn$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO agents (business_id, department, name, role_title, avatar_sprite_key, desk_x, desk_y)
  SELECT p_business_id, r.department, r.department || ' Agent', r.role_title,
         r.sprite, r.desk_x, r.desk_y
  FROM agent_roster() r
  -- `removed_at` is deliberately not touched: re-running this must not drag a
  -- desk its owner took off the floor back onto it.
  ON CONFLICT (business_id, department) DO UPDATE
    SET role_title        = EXCLUDED.role_title,
        avatar_sprite_key = EXCLUDED.avatar_sprite_key,
        desk_x            = EXCLUDED.desk_x,
        desk_y            = EXCLUDED.desk_y;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  -- Every desk starts with its department's whole skill set switched on.
  INSERT INTO agent_skills (agent_id, skill_key)
  SELECT a.id, c.skill_key
    FROM agents a
    JOIN skill_catalogue c ON c.department = a.department
   WHERE a.business_id = p_business_id AND a.removed_at IS NULL
  ON CONFLICT (agent_id, skill_key) DO NOTHING;

  -- The Payments desk needs a rule per marketplace before it can decide
  -- anything, so a new floor gets the defaults with its desks. Defined
  -- further down the file; plpgsql resolves the call when it runs.
  PERFORM provision_payment_rules(p_business_id);

  RETURN inserted;
END;
$fn$ LANGUAGE plpgsql;

-- ------------------------------------------------- one platform operator
-- There is exactly one person who runs this deployment. Any extras from before
-- this rule existed are demoted to ordinary accounts (they keep their business
-- grants; they just stop being operators), oldest one kept.
DO $do$
DECLARE
  demoted text;
BEGIN
  SELECT string_agg(email, ', ' ORDER BY created_at) INTO demoted
    FROM users
   WHERE is_platform_owner
     AND id <> (SELECT id FROM users WHERE is_platform_owner
                 ORDER BY created_at, id LIMIT 1);
  IF demoted IS NOT NULL THEN
    UPDATE users SET is_platform_owner = false
     WHERE is_platform_owner
       AND id <> (SELECT id FROM users WHERE is_platform_owner
                   ORDER BY created_at, id LIMIT 1);
    RAISE NOTICE 'demoted extra platform operators: %', demoted;
  END IF;
END
$do$;

-- A partial unique index over a constant: at most one row may carry the flag.
-- Moving it means clearing the old one and setting the new one in the same
-- transaction, which scripts/transfer-owner.js does.
CREATE UNIQUE INDEX IF NOT EXISTS users_single_platform_owner
  ON users ((is_platform_owner)) WHERE is_platform_owner;

-- -------------------------------------------------------------- skills
-- What each department's agent is actually good at. The catalogue is reference
-- data shared by every business; agent_skills is which ones a given desk has
-- switched on. n8n reads the enabled list at checkout and shapes the prompt
-- from it, so turning a skill off changes what the model is asked to do.

CREATE TABLE IF NOT EXISTS skill_catalogue (
  department text NOT NULL,
  skill_key  text NOT NULL,
  name       text NOT NULL,
  summary    text NOT NULL,
  sort       int  NOT NULL DEFAULT 0,
  PRIMARY KEY (department, skill_key)
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_key  text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, skill_key)
);

CREATE INDEX IF NOT EXISTS agent_skills_enabled_idx
  ON agent_skills (agent_id) WHERE enabled;

INSERT INTO skill_catalogue (department, skill_key, name, summary, sort) VALUES
  -- Sales
  ('Sales','lead_qualification','Lead qualification','Reads an enquiry and works out budget, urgency and whether it is worth quoting.',1),
  ('Sales','quotation','Quotation drafting','Turns a scope into an itemised PHP quote with inclusions and validity.',2),
  ('Sales','follow_up','Follow-up sequences','Chases a quote that has gone quiet, politely, on a schedule.',3),
  ('Sales','appointment_booking','Appointment booking','Offers site-visit slots and confirms them against the calendar.',4),
  ('Sales','upsell','Upsell suggestions','Spots the add-on worth mentioning without padding the quote.',5),
  -- Marketing
  ('Marketing','ads_manager','Social media ads manager','Plans and adjusts paid campaigns: budget, audience, placement, and what to cut when cost per lead climbs.',1),
  ('Marketing','content_calendar','Content calendar','Plans a month of posts around seasons, promos and what sold last month.',2),
  ('Marketing','copywriting','Caption and copywriting','Writes posts and captions in the business voice, in the right length per platform.',3),
  ('Marketing','promo_planning','Promo planning','Designs an offer with real numbers: discount, margin, end date.',4),
  ('Marketing','performance_report','Performance reporting','Reads reach, clicks and cost per lead, and says plainly what to change.',5),
  -- CRM
  ('CRM','dm_replies','Messenger and DM replies','Answers Messenger, Instagram and marketplace chats in the business voice.',1),
  ('CRM','review_responses','Review responses','Replies to public reviews, including the bad ones, without arguing.',2),
  ('CRM','customer_history','Customer history recall','Pulls up what this customer bought and what went wrong last time.',3),
  ('CRM','escalation_triage','Escalation triage','Decides what a human must handle now rather than later.',4),
  ('CRM','csat_followup','Satisfaction follow-up','Checks in after a job and asks for a review when it went well.',5),
  -- Inventory
  ('Inventory','stock_monitoring','Stock monitoring','Watches levels against what is selling and flags what is about to run out.',1),
  ('Inventory','reorder_alerts','Reorder alerts','Calculates reorder points from lead time and demand, and raises them.',2),
  ('Inventory','supplier_rfq','Supplier RFQ drafting','Writes requests for quotes and compares what comes back.',3),
  ('Inventory','catalogue_hygiene','Catalogue hygiene','Keeps SKUs, prices and descriptions consistent across platforms.',4),
  -- HR
  ('HR','job_posts','Job post drafting','Writes a job ad that describes the actual work and the actual pay.',1),
  ('HR','applicant_screening','Applicant screening','Sorts applicants against the role and drafts the replies either way.',2),
  ('HR','onboarding','Onboarding checklists','Builds the first-week plan: requirements, accounts, training, buddy.',3),
  ('HR','shift_planning','Shift planning','Builds a roster that covers the work without burning overtime.',4),
  ('HR','policy_answers','Policy questions','Answers leave, benefits and conduct questions from the handbook.',5),
  -- Admin
  ('Admin','invoicing','Invoice drafting','Turns a completed job into an invoice with the right terms.',1),
  ('Admin','expense_coding','Expense categorisation','Codes receipts to accounts and flags the ones that look wrong.',2),
  ('Admin','document_filing','Document filing','Names and files permits, contracts and receipts where they can be found.',3),
  ('Admin','compliance_reminders','Compliance reminders','Tracks BIR filings, permits and renewals before they lapse.',4),
  -- Logistics
  ('Logistics','dispatch_scheduling','Dispatch scheduling','Assigns jobs to crews and vehicles against the day.',1),
  ('Logistics','route_planning','Route planning','Orders stops sensibly for traffic and delivery windows.',2),
  ('Logistics','delivery_updates','Delivery updates','Tells the customer where their order is, before they ask.',3),
  ('Logistics','courier_booking','Courier booking','Books third-party couriers and tracks what they promised.',4),
  -- Security
  ('Security','access_review','Access review','Checks who can reach what, and flags accounts that should be gone.',1),
  ('Security','incident_triage','Incident triage','Sorts an alert into noise, watch, or wake someone up.',2),
  ('Security','phishing_detection','Phishing detection','Reads suspicious messages and says whether to trust them.',3),
  ('Security','backup_verification','Backup verification','Confirms backups actually ran and can actually be restored.',4),
  -- Production
  ('Production','job_scheduling','Job order scheduling','Sequences work orders against crew, materials and deadlines.',1),
  ('Production','qa_checklists','Quality checklists','Builds and checks the sign-off list for each job type.',2),
  ('Production','materials_estimate','Materials estimate','Works out what a job needs and what it will cost in PHP.',3),
  ('Production','progress_reporting','Progress reporting','Reports where each job stands, with photos where it helps.',4),
  -- Payments. The money side of a marketplace sale, which is not the same
  -- thing as the order: the buyer pays the platform, the platform holds it,
  -- and only later does any of it reach the seller.
  ('Payments','payment_watch','Payment watching','Reads each order payment state from Shopee, Lazada and TikTok Shop and says which ones are really paid.',1),
  ('Payments','cod_rules','COD rules','Applies the business''s cash-on-delivery limits: what may go out unpaid, up to how much, and what must be prepaid.',2),
  ('Payments','unpaid_chasing','Unpaid order chasing','Drafts the polite nudge for an order that was placed and never paid, and the cancellation when the window closes.',3),
  ('Payments','escrow_tracking','Escrow tracking','Follows the money from paid, through the platform''s hold, to the day it is released.',4),
  ('Payments','payout_reconciliation','Payout reconciliation','Matches a platform payout against the orders in it and flags a shortfall with the figures.',5),
  ('Payments','fee_breakdown','Fee breakdown','Pulls apart commission, transaction and shipping fees so the margin is the real one.',6),
  ('Payments','refund_handling','Refund handling','Reads a refund or return and works out what it does to stock and to the payout.',7),
  ('Payments','live_checkout','Live checkout links','Issues the checkout link for a live-stream claim and watches whether it gets paid before the hold runs out.',8)
ON CONFLICT (department, skill_key) DO UPDATE
  SET name = EXCLUDED.name, summary = EXCLUDED.summary, sort = EXCLUDED.sort;

-- ------------------------------------------------- social posts and sync
-- A post the business puts out, and where it has been put. The app is the
-- place it is edited; the platforms are where copies live. An edit never goes
-- straight out — it files an approval like everything else, and only the
-- dispatch workflow updates the platforms once a human says yes.

CREATE TABLE IF NOT EXISTS social_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id    uuid REFERENCES agents(id) ON DELETE SET NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  media_url   text,
  status      text NOT NULL DEFAULT 'DRAFT'
              CHECK (status IN ('DRAFT','PENDING_UPDATE','PUBLISHED','ARCHIVED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_post_targets (
  post_id        uuid NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  platform       text NOT NULL
                 CHECK (platform IN ('facebook','instagram','tiktok','shopee','lazada','x')),
  external_id    text,
  state          text NOT NULL DEFAULT 'NOT_PUBLISHED'
                 CHECK (state IN ('NOT_PUBLISHED','PUBLISHED','UPDATE_PENDING','FAILED')),
  last_synced_at timestamptz,
  last_error     text,
  PRIMARY KEY (post_id, platform)
);

CREATE INDEX IF NOT EXISTS social_posts_business_idx
  ON social_posts (business_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS social_post_targets_platform_idx
  ON social_post_targets (platform, state);

-- One row per platform copy, so n8n can be told exactly which ones to update.
CREATE UNIQUE INDEX IF NOT EXISTS social_post_targets_external_idx
  ON social_post_targets (platform, external_id) WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS social_posts_touch ON social_posts;
CREATE TRIGGER social_posts_touch
  BEFORE UPDATE ON social_posts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS social_posts_notify ON social_posts;
CREATE TRIGGER social_posts_notify
  AFTER INSERT OR UPDATE OR DELETE ON social_posts
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('social_post');

-- A platform copy can also be on its way out for the first time, which is a
-- different thing from an edit chasing an already-live post.
ALTER TABLE social_post_targets DROP CONSTRAINT IF EXISTS social_post_targets_state_check;
ALTER TABLE social_post_targets ADD CONSTRAINT social_post_targets_state_check
  CHECK (state IN ('NOT_PUBLISHED','PUBLISH_PENDING','PUBLISHED','UPDATE_PENDING','FAILED'));

-- ------------------------------------------------- connected accounts
-- A business can have several accounts on the same platform: two Shopee
-- shops, a Lazada seller account, a TikTok Shop. Each one is connected
-- separately and can be synced or paused on its own.
--
-- Credentials are encrypted with AES-256-GCM under CREDENTIALS_KEY and are
-- never returned by the dashboard API — only n8n reads them back, through the
-- internal token, and every read is written to action_logs.

CREATE TABLE IF NOT EXISTS platform_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform       text NOT NULL
                 CHECK (platform IN ('facebook','instagram','tiktok','shopee','lazada','x')),
  label          text NOT NULL,                -- what the owner calls it
  external_id    text,                         -- shop id, seller id, page id
  region         text,                         -- PH, SG, MY … drives the API host
  credentials    text,                         -- AES-256-GCM, never served to a browser
  sync_enabled   boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_accounts_business_idx
  ON platform_accounts (business_id, platform);
-- One account per shop id per platform, per business.
CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_external_idx
  ON platform_accounts (business_id, platform, external_id) WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS platform_accounts_touch ON platform_accounts;
CREATE TRIGGER platform_accounts_touch
  BEFORE UPDATE ON platform_accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------ products
-- The business's own catalogue. A product lives here and is listed on
-- whichever connected accounts its owner picks.

CREATE TABLE IF NOT EXISTS products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sku          text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  price        numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency     char(3) NOT NULL DEFAULT 'PHP',
  stock        int NOT NULL DEFAULT 0 CHECK (stock >= 0),
  weight_kg    numeric(8,3) NOT NULL DEFAULT 0.5 CHECK (weight_kg > 0),
  images       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Per-platform bits a marketplace insists on: category ids, attributes,
  -- logistics. Shaped { shopee: {...}, lazada: {...}, tiktok: {...} }.
  platform_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT','LISTED','ARCHIVED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);

CREATE TABLE IF NOT EXISTS product_listings (
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  external_id    text,
  state          text NOT NULL DEFAULT 'NOT_LISTED'
                 CHECK (state IN ('NOT_LISTED','PUBLISH_PENDING','LISTED','UPDATE_PENDING','FAILED')),
  last_synced_at timestamptz,
  last_error     text,
  PRIMARY KEY (product_id, account_id)
);

CREATE INDEX IF NOT EXISTS products_business_idx ON products (business_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS product_listings_account_idx ON product_listings (account_id, state);

DROP TRIGGER IF EXISTS products_touch ON products;
CREATE TRIGGER products_touch
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS products_notify ON products;
CREATE TRIGGER products_notify
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('product');

-- Social posts can also name the account they went out on, now that a
-- business may hold more than one per platform.
ALTER TABLE social_post_targets ADD COLUMN IF NOT EXISTS account_id uuid
  REFERENCES platform_accounts(id) ON DELETE SET NULL;

-- ------------------------------------------------- marketplace messages
-- Shopee, Lazada and TikTok give a seller a chat thread with a buyer and an
-- order feed. Neither gives a seller a phone line: there is no voice-call
-- API on any of the three, so the CRM desk answers in writing and nowhere
-- in this app offers to place a call. Messenger and Instagram DMs land in
-- the same two tables so one inbox covers every channel.

CREATE TABLE IF NOT EXISTS conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id    uuid REFERENCES platform_accounts(id) ON DELETE SET NULL,
  -- Where the buyer is writing from. Each one is text chat; see the note above.
  channel       text NOT NULL
                CHECK (channel IN ('shopee_chat','lazada_chat','tiktok_dm',
                                   'meta_dm','instagram_dm','email')),
  -- The thread id the marketplace itself uses, so a reply goes back to the
  -- same conversation rather than opening a new one.
  external_id   text,
  buyer_name    text NOT NULL DEFAULT 'Buyer',
  buyer_handle  text,
  -- Set when the buyer is asking about something in the catalogue.
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  order_id      uuid,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','AWAITING_APPROVAL','ANSWERED','CLOSED')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  unread        int NOT NULL DEFAULT 0 CHECK (unread >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('IN','OUT')),
  body            text NOT NULL,
  -- An outbound line is only ever written here once a human approved it, so
  -- it carries the approval that let it out.
  approval_id     uuid REFERENCES approvals(id) ON DELETE SET NULL,
  external_id     text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_business_idx
  ON conversations (business_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_channel_idx ON conversations (business_id, channel);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_idx
  ON conversations (account_id, channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (conversation_id, created_at);

DROP TRIGGER IF EXISTS conversations_touch ON conversations;
CREATE TRIGGER conversations_touch
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS conversations_notify ON conversations;
CREATE TRIGGER conversations_notify
  AFTER INSERT OR UPDATE OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('conversation');

DROP TRIGGER IF EXISTS messages_notify ON messages;
CREATE TRIGGER messages_notify
  AFTER INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('message');

-- --------------------------------------------------------------- orders
-- Sales, pulled from each shop. The app does not take the money — the
-- marketplace does — so an order row is a record of something that already
-- happened and is never the gate's business. Fulfilment is: it moves stock
-- and it can be cancelled, so those writes are owner-only and logged.

CREATE TABLE IF NOT EXISTS orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   uuid REFERENCES platform_accounts(id) ON DELETE SET NULL,
  -- 'live' marks an order that came out of a live selling session rather
  -- than the ordinary shopfront.
  source       text NOT NULL DEFAULT 'shop'
               CHECK (source IN ('shop','live','chat')),
  external_id  text NOT NULL,
  order_no     text,
  buyer_name   text NOT NULL DEFAULT 'Buyer',
  status       text NOT NULL DEFAULT 'UNPAID'
               CHECK (status IN ('UNPAID','PAID','READY_TO_SHIP','SHIPPED',
                                 'DELIVERED','CANCELLED','RETURNED')),
  total        numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  currency     char(3) NOT NULL DEFAULT 'PHP',
  -- Where the buyer finishes paying. On Shopee, Lazada and TikTok Shop the
  -- checkout belongs to the marketplace; this is the link we hand over.
  checkout_url text,
  placed_at    timestamptz NOT NULL DEFAULT now(),
  -- When the stock for this order actually left the shelf. Which event does
  -- that is a payment rule, not a fixed law, so it is recorded rather than
  -- inferred — and it makes taking stock idempotent when a sync runs twice.
  stock_taken_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  uuid REFERENCES products(id) ON DELETE SET NULL,
  sku         text NOT NULL,
  name        text NOT NULL,
  qty         int NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price  numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_external_idx
  ON orders (account_id, external_id);
CREATE INDEX IF NOT EXISTS orders_business_idx ON orders (business_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (business_id, status);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- `conversations.order_id` points at a table declared below it, so the key
-- is added here rather than inline. Guarded, because this file re-runs.
DO $do$
BEGIN
  ALTER TABLE conversations
    ADD CONSTRAINT conversations_order_fk FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$do$;

DROP TRIGGER IF EXISTS orders_touch ON orders;
CREATE TRIGGER orders_touch
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS orders_notify ON orders;
CREATE TRIGGER orders_notify
  AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('order');

-- ---------------------------------------------------------- live selling
-- A live session and the basket of items pinned to it — the yellow basket
-- a TikTok Live viewer taps to buy without leaving the stream.
--
-- TikTok: real. TikTok Shop's API lets a seller attach catalogue products
-- to a LIVE room, so `live_basket_items.external_id` is the showcase id it
-- hands back and `slot` is the number the host calls out ("item 3").
--
-- Facebook: Meta retired Live Shopping — product tagging in a Facebook Live
-- ended 1 October 2022, and Instagram's went in March 2023. There is no
-- basket to pin to any more. What still works, and what sellers here
-- actually do, is read the comments: a viewer types "mine" or "3 mine", the
-- CRM desk reserves the stock and sends a checkout link in Messenger. So a
-- facebook session keeps the same basket rows for the host to read from,
-- and `basket_supported` is false to say on screen that the taps are gone.

CREATE TABLE IF NOT EXISTS live_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id     uuid REFERENCES platform_accounts(id) ON DELETE SET NULL,
  platform       text NOT NULL CHECK (platform IN ('tiktok','facebook')),
  title          text NOT NULL,
  -- The room id on the platform, once the stream is up.
  external_id    text,
  status         text NOT NULL DEFAULT 'SCHEDULED'
                 CHECK (status IN ('SCHEDULED','ARMED','LIVE','PAUSED','ENDED')),
  -- A live session is approved once, as a whole, and that approval is what
  -- lets the desk answer comments inside it without stopping for each one.
  armed_approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  -- What the desk is allowed to say back while the stream runs.
  reply_template text NOT NULL DEFAULT
    'Reserved for you, {buyer}. Checkout link: {checkout_url} — it holds for 15 minutes.',
  -- How long a reservation holds before the stock goes back.
  hold_minutes   int NOT NULL DEFAULT 15 CHECK (hold_minutes BETWEEN 1 AND 180),
  scheduled_for  timestamptz,
  started_at     timestamptz,
  ended_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live_basket_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- The number the host calls out. Unique within a session.
  slot        int NOT NULL CHECK (slot BETWEEN 1 AND 99),
  -- The live price, which is usually not the shelf price.
  live_price  numeric(12,2) CHECK (live_price IS NULL OR live_price >= 0),
  -- How many of them this session may sell before it stops taking "mine".
  allocation  int NOT NULL DEFAULT 0 CHECK (allocation >= 0),
  reserved    int NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  sold        int NOT NULL DEFAULT 0 CHECK (sold >= 0),
  state       text NOT NULL DEFAULT 'PIN_PENDING'
              CHECK (state IN ('PIN_PENDING','PINNED','UNPIN_PENDING','REMOVED','FAILED')),
  external_id text,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, slot),
  UNIQUE (session_id, product_id)
);

-- One row per sample the monitor takes, so the chart on the dashboard is
-- read out of the database like everything else rather than kept in a
-- browser tab that someone might close.
CREATE TABLE IF NOT EXISTS live_metrics (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sampled_at  timestamptz NOT NULL DEFAULT now(),
  viewers     int NOT NULL DEFAULT 0 CHECK (viewers >= 0),
  likes       int NOT NULL DEFAULT 0 CHECK (likes >= 0),
  comments    int NOT NULL DEFAULT 0 CHECK (comments >= 0),
  -- Taps on the basket, which only TikTok reports.
  basket_opens int NOT NULL DEFAULT 0 CHECK (basket_opens >= 0),
  orders      int NOT NULL DEFAULT 0 CHECK (orders >= 0),
  revenue     numeric(12,2) NOT NULL DEFAULT 0 CHECK (revenue >= 0)
);

-- A viewer saying "mine". Stock is held here, not in the marketplace, until
-- they either pay or the hold runs out.
CREATE TABLE IF NOT EXISTS live_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  basket_item_id uuid NOT NULL REFERENCES live_basket_items(id) ON DELETE CASCADE,
  buyer_name    text NOT NULL DEFAULT 'Viewer',
  buyer_handle  text,
  qty           int NOT NULL DEFAULT 1 CHECK (qty > 0),
  -- The comment that was read as buy intent, kept so a dispute can be read
  -- back rather than argued about.
  comment_text  text,
  status        text NOT NULL DEFAULT 'HELD'
                CHECK (status IN ('HELD','CHECKOUT_SENT','PAID','EXPIRED','CANCELLED')),
  checkout_url  text,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  holds_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_sessions_business_idx
  ON live_sessions (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_basket_session_idx ON live_basket_items (session_id, slot);
CREATE INDEX IF NOT EXISTS live_metrics_session_idx
  ON live_metrics (session_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS live_claims_session_idx
  ON live_claims (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_claims_open_idx
  ON live_claims (business_id, status) WHERE status IN ('HELD','CHECKOUT_SENT');

DROP TRIGGER IF EXISTS live_sessions_touch ON live_sessions;
CREATE TRIGGER live_sessions_touch
  BEFORE UPDATE ON live_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS live_claims_touch ON live_claims;
CREATE TRIGGER live_claims_touch
  BEFORE UPDATE ON live_claims
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS live_sessions_notify ON live_sessions;
CREATE TRIGGER live_sessions_notify
  AFTER INSERT OR UPDATE OR DELETE ON live_sessions
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('live_session');

DROP TRIGGER IF EXISTS live_basket_notify ON live_basket_items;
CREATE TRIGGER live_basket_notify
  AFTER INSERT OR UPDATE OR DELETE ON live_basket_items
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('live_session');

DROP TRIGGER IF EXISTS live_claims_notify ON live_claims;
CREATE TRIGGER live_claims_notify
  AFTER INSERT OR UPDATE OR DELETE ON live_claims
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('live_claim');

DROP TRIGGER IF EXISTS live_metrics_notify ON live_metrics;
CREATE TRIGGER live_metrics_notify
  AFTER INSERT ON live_metrics
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('live_metric');

-- ------------------------------------------------------------- the money
-- A marketplace sale and the money for it are two different events, days
-- apart, and this app does not take the money at any point. What happens on
-- Shopee, Lazada and TikTok Shop is the same shape on all three:
--
--   1. the buyer pays the platform, or says they will pay the courier (COD);
--   2. the platform holds it — escrow — while the parcel travels;
--   3. after delivery and the buyer-protection window, the platform releases
--      the seller's share into a payout, minus its commission and fees.
--
-- So `payments` is the per-order record of where the money has got to, and
-- `payouts` is the settlement batch the platform actually transfers. The
-- Payments desk reconciles one against the other and shouts when they do not
-- agree. Nothing here moves money; it reads what the platform did.

CREATE TABLE IF NOT EXISTS payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id  uuid REFERENCES platform_accounts(id) ON DELETE SET NULL,
  -- How the buyer is paying. 'cod' is the one that is not money yet.
  method      text NOT NULL DEFAULT 'unknown'
              CHECK (method IN ('unknown','online','cod','wallet',
                                'bank_transfer','installment','live_link')),
  -- AWAITING: placed, nothing paid.  IN_ESCROW: paid, platform holding it.
  -- RELEASED: in a payout.  SHORT: the payout came in under what the order
  -- says, which is a thing that happens and must not be rounded away.
  state       text NOT NULL DEFAULT 'AWAITING'
              CHECK (state IN ('AWAITING','IN_ESCROW','RELEASED','SHORT',
                               'REFUNDED','CANCELLED','EXPIRED','FAILED')),
  -- What the buyer paid, what the platform kept, what is left.
  gross       numeric(12,2) NOT NULL DEFAULT 0 CHECK (gross >= 0),
  commission_fee numeric(12,2) NOT NULL DEFAULT 0,
  transaction_fee numeric(12,2) NOT NULL DEFAULT 0,
  shipping_fee numeric(12,2) NOT NULL DEFAULT 0,
  other_fee   numeric(12,2) NOT NULL DEFAULT 0,
  -- What the platform says the seller gets. Kept as reported, not computed,
  -- so a disagreement with gross minus fees is visible instead of hidden.
  net         numeric(12,2) NOT NULL DEFAULT 0,
  currency    char(3) NOT NULL DEFAULT 'PHP',
  external_id text,
  paid_at     timestamptz,
  escrow_release_at timestamptz,
  released_at timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  period_start date,
  period_end   date,
  gross       numeric(12,2) NOT NULL DEFAULT 0,
  fees        numeric(12,2) NOT NULL DEFAULT 0,
  adjustments numeric(12,2) NOT NULL DEFAULT 0,
  net         numeric(12,2) NOT NULL DEFAULT 0,
  currency    char(3) NOT NULL DEFAULT 'PHP',
  -- EXPECTED: the platform has announced it.  SETTLED: it landed and matches.
  -- SHORT: it landed under what its orders add up to.  DISPUTED: raised.
  state       text NOT NULL DEFAULT 'EXPECTED'
              CHECK (state IN ('EXPECTED','SETTLED','SHORT','DISPUTED')),
  -- What reconciliation found, in words, for whoever reads it next.
  variance    numeric(12,2) NOT NULL DEFAULT 0,
  note        text,
  settled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

CREATE TABLE IF NOT EXISTS payout_orders (
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  order_id  uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount    numeric(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (payout_id, order_id)
);

-- The rules the Payments desk applies, per business and per platform,
-- because Shopee, Lazada and TikTok do not behave the same and a seller's
-- appetite for COD is their own business decision, not ours.
CREATE TABLE IF NOT EXISTS payment_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('shopee','lazada','tiktok','live')),
  -- Cash on delivery: allowed at all, and up to what order total.
  allow_cod   boolean NOT NULL DEFAULT true,
  cod_limit   numeric(12,2) NOT NULL DEFAULT 5000 CHECK (cod_limit >= 0),
  -- When the stock is really gone. 'order' is optimistic and oversells;
  -- 'payment' is the usual choice; 'release' is for the badly burned.
  release_stock_on text NOT NULL DEFAULT 'payment'
                   CHECK (release_stock_on IN ('order','payment','release')),
  -- An order placed and not paid: nudge after this long, cancel after that.
  chase_unpaid_after_minutes int NOT NULL DEFAULT 180
                   CHECK (chase_unpaid_after_minutes > 0),
  cancel_unpaid_after_minutes int NOT NULL DEFAULT 2880
                   CHECK (cancel_unpaid_after_minutes > 0),
  -- How far a payout may miss its orders before it is called SHORT. Rounding
  -- happens; a missing item does not.
  reconcile_tolerance numeric(12,2) NOT NULL DEFAULT 1.00
                   CHECK (reconcile_tolerance >= 0),
  -- Chasing a buyer is a message to a customer, so it goes through the gate
  -- like everything else. Turning this off stops the drafts being filed at
  -- all; it does not make them send themselves.
  chase_needs_approval boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, platform),
  CHECK (cancel_unpaid_after_minutes >= chase_unpaid_after_minutes)
);

-- Every business gets the default set, so the desk always has a rule to
-- apply rather than a null to guess at.
CREATE OR REPLACE FUNCTION provision_payment_rules(p_business_id uuid)
RETURNS integer AS $fn$
DECLARE
  inserted integer;
BEGIN
  INSERT INTO payment_rules (business_id, platform, cod_limit, release_stock_on)
  SELECT p_business_id, v.platform, v.cod_limit, v.release_stock_on
    FROM (VALUES
      -- Shopee PH: COD is the default for most buyers, so it is on, capped.
      ('shopee', 5000::numeric, 'payment'),
      -- Lazada PH: same, and its payout cycle is the slowest of the three.
      ('lazada', 5000::numeric, 'payment'),
      -- TikTok Shop: mostly prepaid, so a COD order is the exception.
      ('tiktok', 3000::numeric, 'payment'),
      -- A live claim is a checkout link with a timer. Nothing leaves the
      -- shelf until it is paid, or the next viewer loses the item.
      ('live',   0::numeric,    'payment')
    ) AS v (platform, cod_limit, release_stock_on)
  ON CONFLICT (business_id, platform) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$fn$ LANGUAGE plpgsql;

-- A live claim is never COD: a link that is not paid simply expires.
UPDATE payment_rules SET allow_cod = false WHERE platform = 'live' AND allow_cod;

CREATE INDEX IF NOT EXISTS payments_business_idx ON payments (business_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS payments_state_idx ON payments (business_id, state);
CREATE INDEX IF NOT EXISTS payouts_business_idx ON payouts (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payout_orders_order_idx ON payout_orders (order_id);

DROP TRIGGER IF EXISTS payments_touch ON payments;
CREATE TRIGGER payments_touch
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS payouts_touch ON payouts;
CREATE TRIGGER payouts_touch
  BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS payment_rules_touch ON payment_rules;
CREATE TRIGGER payment_rules_touch
  BEFORE UPDATE ON payment_rules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS payments_notify ON payments;
CREATE TRIGGER payments_notify
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('payment');

DROP TRIGGER IF EXISTS payouts_notify ON payouts;
CREATE TRIGGER payouts_notify
  AFTER INSERT OR UPDATE OR DELETE ON payouts
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('payout');

DROP TRIGGER IF EXISTS payment_rules_notify ON payment_rules;
CREATE TRIGGER payment_rules_notify
  AFTER INSERT OR UPDATE ON payment_rules
  FOR EACH ROW EXECUTE FUNCTION notify_office_event('payment_rule');

-- Floors that existed before the Payments desk did: give them its rules and
-- its skills. `provision_business_agents` is idempotent and never touches a
-- live `status`, so this is safe on a running deployment.
SELECT provision_business_agents(id) FROM businesses;

-- Orders that existed before stock-taking was recorded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_taken_at timestamptz;

-- ------------------------------------------------- connecting a shop
-- Connecting a marketplace account is an authorization the seller gives on
-- the marketplace's own site: we send them there, they pick the shop and
-- confirm, and it sends them back with a one-time code we exchange for
-- tokens. This table holds the handful of seconds in between.
--
-- The state value is what ties the code that comes back to the business and
-- the person who started it. It is single-use and short-lived, because a
-- leaked one would let somebody else's authorization land on this floor.

CREATE TABLE IF NOT EXISTS connect_states (
  state       text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL,
  label       text NOT NULL DEFAULT '',
  -- Set when an existing account is being re-authorised rather than a new
  -- one connected, so a refreshed token lands on the right row.
  account_id  uuid REFERENCES platform_accounts(id) ON DELETE CASCADE,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '15 minutes'
);

CREATE INDEX IF NOT EXISTS connect_states_expiry_idx ON connect_states (expires_at);
