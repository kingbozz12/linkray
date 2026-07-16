BEGIN;

CREATE TABLE IF NOT EXISTS public.lr_real_users (
  max_user_id text PRIMARY KEY,
  label text NOT NULL,
  source text NOT NULL DEFAULT 'manual_verified',
  verified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

TRUNCATE public.lr_real_users;

INSERT INTO public.lr_real_users (
  max_user_id,
  label,
  source,
  verified_at,
  updated_at
)
VALUES (
  '198999490',
  'Владелец LinkRay',
  'owner_admin_only_v3_1',
  now(),
  now()
);

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    is_verified_linkray_user boolean NOT NULL DEFAULT false;

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    quarantine_reason text;

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    quarantined_at timestamptz;

UPDATE public.lr_users user_row
SET
  is_verified_linkray_user=
    (user_row.max_user_id='198999490'),
  quarantine_reason=
    CASE
      WHEN user_row.max_user_id='198999490'
      THEN NULL
      ELSE 'not_current_linkray_user_v3_1'
    END,
  quarantined_at=
    CASE
      WHEN user_row.max_user_id='198999490'
      THEN NULL
      ELSE COALESCE(user_row.quarantined_at,now())
    END,
  updated_at=now();

CREATE OR REPLACE VIEW public.lr_admin_users AS
SELECT user_row.*
FROM public.lr_users user_row
JOIN public.lr_real_users real_row
  ON real_row.max_user_id=user_row.max_user_id;

DO $lr_check$
DECLARE
  visible_count integer;
  visible_owner text;
BEGIN
  SELECT COUNT(*), MIN(max_user_id)
  INTO visible_count, visible_owner
  FROM public.lr_admin_users;

  IF visible_count<>1 THEN
    RAISE EXCEPTION
      'Ожидался 1 пользователь, получено %',
      visible_count;
  END IF;

  IF visible_owner<>'198999490' THEN
    RAISE EXCEPTION
      'В списке остался неверный пользователь: %',
      visible_owner;
  END IF;
END;
$lr_check$;

COMMIT;
