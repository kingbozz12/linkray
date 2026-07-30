-- Generated from the current INSERT INTO public.lr_web_sessions statement.
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "user_id" BIGINT;
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "token_hash" TEXT;
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "created_ip" TEXT;
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "user_agent" TEXT;
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ;
ALTER TABLE public.lr_web_sessions ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_lr_web_sessions_token_hash ON public.lr_web_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_lr_web_sessions_user_id ON public.lr_web_sessions (user_id);
