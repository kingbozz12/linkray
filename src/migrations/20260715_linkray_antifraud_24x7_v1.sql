-- LinkRay AntiFraud 24/7 v1
-- Safe, isolated tables. No changes to autoposting tables.

CREATE TABLE IF NOT EXISTS lr_antifraud_channels (
  channel_id bigint PRIMARY KEY,
  max_chat_id text NOT NULL UNIQUE,
  title text,
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  disabled_at timestamptz,
  learning_started_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lr_antifraud_waves (
  id bigserial PRIMARY KEY,
  channel_id bigint NOT NULL,
  max_chat_id text NOT NULL,
  started_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'detected',
  participants_before integer,
  participants_after integer,
  joined_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  high_count integer NOT NULL DEFAULT 0,
  medium_count integer NOT NULL DEFAULT 0,
  normal_count integer NOT NULL DEFAULT 0,
  max_bot_count integer NOT NULL DEFAULT 0,
  eligible_count integer NOT NULL DEFAULT 0,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_sent boolean NOT NULL DEFAULT false,
  ignored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lr_antifraud_waves_channel_time_idx
  ON lr_antifraud_waves(channel_id, started_at DESC);

CREATE TABLE IF NOT EXISTS lr_antifraud_events (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  channel_id bigint NOT NULL,
  max_chat_id text NOT NULL,
  wave_id bigint REFERENCES lr_antifraud_waves(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_at timestamptz NOT NULL,
  user_id text NOT NULL,
  first_name text,
  last_name text,
  display_name text,
  normalized_name text,
  username text,
  avatar_url text,
  is_bot boolean NOT NULL DEFAULT false,
  is_admin boolean NOT NULL DEFAULT false,
  is_owner boolean NOT NULL DEFAULT false,
  last_activity_time timestamptz,
  risk_score integer NOT NULL DEFAULT 0,
  risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  strong_signals integer NOT NULL DEFAULT 0,
  removal_eligible boolean NOT NULL DEFAULT false,
  left_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lr_antifraud_events_channel_time_idx
  ON lr_antifraud_events(channel_id, event_at DESC);
CREATE INDEX IF NOT EXISTS lr_antifraud_events_wave_risk_idx
  ON lr_antifraud_events(wave_id, removal_eligible DESC, risk_score DESC);

CREATE TABLE IF NOT EXISTS lr_antifraud_whitelist (
  channel_id bigint NOT NULL,
  user_id text NOT NULL,
  display_name text,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS lr_antifraud_actions (
  id bigserial PRIMARY KEY,
  action_token text NOT NULL UNIQUE,
  wave_id bigint NOT NULL,
  channel_id bigint NOT NULL,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by text,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lr_antifraud_removals (
  id bigserial PRIMARY KEY,
  action_id bigint REFERENCES lr_antifraud_actions(id) ON DELETE SET NULL,
  wave_id bigint NOT NULL,
  channel_id bigint NOT NULL,
  max_chat_id text NOT NULL,
  user_id text NOT NULL,
  display_name text,
  risk_score integer NOT NULL,
  status text NOT NULL,
  error text,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
