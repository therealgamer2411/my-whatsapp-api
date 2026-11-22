CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS workspaces (id UUID PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS workspace_members (workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'owner', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS assistant_settings (workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, enabled BOOLEAN NOT NULL DEFAULT FALSE, provider TEXT NOT NULL DEFAULT 'openai-compatible', model TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL DEFAULT '', api_key_ciphertext TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT 'أنت مساعد خدمة عملاء محترف. أجب بوضوح ولا تخترع أسعارًا أو معلومات.', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

-- Specialized AI secretaries. Each profile has an isolated instruction set and routing metadata.
CREATE TABLE IF NOT EXISTS ai_secretaries (
 id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'general',
 description TEXT NOT NULL DEFAULT '',
 system_prompt TEXT NOT NULL DEFAULT '',
 keywords TEXT[] NOT NULL DEFAULT '{}',
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 is_default BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(workspace_id,name)
);
CREATE INDEX IF NOT EXISTS ai_secretaries_workspace_idx ON ai_secretaries(workspace_id,enabled,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ai_secretaries_one_default_idx ON ai_secretaries(workspace_id) WHERE is_default=TRUE;
CREATE TABLE IF NOT EXISTS wa_sessions (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, waha_name TEXT NOT NULL UNIQUE, label TEXT NOT NULL, phone_number TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL DEFAULT 'NOWEB', status TEXT NOT NULL DEFAULT 'STARTING', last_error TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS wa_sessions_workspace_idx ON wa_sessions(workspace_id,created_at DESC);
CREATE TABLE IF NOT EXISTS contacts (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE, chat_id TEXT NOT NULL, phone_number TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT 'عميل', is_paused BOOLEAN NOT NULL DEFAULT FALSE, paused_reason TEXT NOT NULL DEFAULT '', last_message_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(session_id,chat_id));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secretary_id UUID REFERENCES ai_secretaries(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secretary_assignment TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secretary_category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secretary_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS secretary_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS contacts_secretary_idx ON contacts(workspace_id,secretary_id,secretary_assignment);
CREATE INDEX IF NOT EXISTS contacts_workspace_last_idx ON contacts(workspace_id,last_message_at DESC);
CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE, contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, wamid TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')), message_type TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'received', sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(session_id,wamid));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mimetype TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT NOT NULL DEFAULT 'none';
CREATE INDEX IF NOT EXISTS messages_contact_time_idx ON messages(contact_id,sent_at DESC);
CREATE TABLE IF NOT EXISTS webhook_events (id UUID PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, session_name TEXT NOT NULL DEFAULT '', received_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS subscription_plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly_price_egp INTEGER NOT NULL DEFAULT 0, limits JSONB NOT NULL DEFAULT '{}'::jsonb, is_active BOOLEAN NOT NULL DEFAULT TRUE);
INSERT INTO subscription_plans(id,name,monthly_price_egp,limits) VALUES ('starter','Starter',0,'{"sessions":1,"members":2}'),('business','Business',0,'{"sessions":5,"members":10}'),('enterprise','Enterprise',0,'{"sessions":-1,"members":-1}') ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS workspace_subscriptions (workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, plan_id TEXT NOT NULL DEFAULT 'starter' REFERENCES subscription_plans(id), status TEXT NOT NULL DEFAULT 'trial', started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), renews_at TIMESTAMPTZ);

-- Consent-aware broadcast campaigns. Only explicitly opted-in contacts are eligible.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_opt_in_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_opt_in_source TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS campaigns (
 id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','completed','cancelled','failed')),
 delay_ms INTEGER NOT NULL DEFAULT 10000 CHECK(delay_ms BETWEEN 5000 AND 60000),
 total_count INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS campaign_recipients (
 id UUID PRIMARY KEY, campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 session_id UUID NOT NULL REFERENCES wa_sessions(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','skipped')),
 error TEXT NOT NULL DEFAULT '', sent_at TIMESTAMPTZ, UNIQUE(campaign_id,contact_id)
);
CREATE INDEX IF NOT EXISTS campaign_recipients_queue_idx ON campaign_recipients(campaign_id,status);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS secretary_id UUID REFERENCES ai_secretaries(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS campaigns_workspace_idx ON campaigns(workspace_id,created_at DESC);


-- Auditable per-recipient reference and exact outbound payload for campaigns.
CREATE SEQUENCE IF NOT EXISTS message_reference_seq START 1;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS reference_code TEXT;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS sent_body TEXT NOT NULL DEFAULT '';
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS provider_message_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_reference_code_uq ON campaign_recipients(reference_code) WHERE reference_code IS NOT NULL;
