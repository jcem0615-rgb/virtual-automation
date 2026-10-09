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
