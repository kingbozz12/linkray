ALTER TABLE public.lr_web_login_codes
  ADD COLUMN IF NOT EXISTS challenge_hash TEXT,
  ADD COLUMN IF NOT EXISTS code_hash TEXT,
  ADD COLUMN IF NOT EXISTS requested_ip TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_lr_web_login_codes_challenge
  ON public.lr_web_login_codes (challenge_hash);

CREATE INDEX IF NOT EXISTS idx_lr_web_login_codes_user
  ON public.lr_web_login_codes (user_id);
