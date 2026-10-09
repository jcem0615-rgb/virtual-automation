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
CREATE OR REPLACE FUNCTION provision_business_agents(p_business_id uuid)
RETURNS integer AS $fn$
DECLARE
  inserted integer;
BEGIN
  WITH roster (department, role_title, sprite, desk_x, desk_y) AS (
    VALUES
      ('Sales',      'Sales Agent',        'staff_amber',  160, 300),
      ('Marketing',  'Marketing Agent',    'staff_rose',   480, 300),
      ('CRM',        'Customer Care Agent','staff_sky',    800, 300),
      ('Inventory',  'Inventory Agent',    'staff_lime',   160, 450),
      ('HR',         'People Agent',       'staff_violet', 480, 450),
      ('Admin',      'Admin Agent',        'staff_slate',  800, 450),
      ('Logistics',  'Dispatch Agent',     'staff_teal',   160, 600),
      ('Security',   'Security Agent',     'staff_red',    480, 600),
      ('Production', 'Operations Agent',   'staff_orange', 800, 600)
  )
  INSERT INTO agents (business_id, department, name, role_title, avatar_sprite_key, desk_x, desk_y)
  SELECT p_business_id, r.department, r.department || ' Agent', r.role_title,
         r.sprite, r.desk_x, r.desk_y
  FROM roster r
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
   WHERE a.business_id = p_business_id
  ON CONFLICT (agent_id, skill_key) DO NOTHING;

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
  ('Production','progress_reporting','Progress reporting','Reports where each job stands, with photos where it helps.',4)
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
