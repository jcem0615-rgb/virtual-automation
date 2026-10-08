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
