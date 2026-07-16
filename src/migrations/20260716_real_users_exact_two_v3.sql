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
VALUES
  (
    '198999490',
    'Владелец LinkRay',
    'owner_admin',
    now(),
    now()
  ),
  (
    '184467954',
    'Анастасия',
    'verified_anastasia',
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
    EXISTS (
      SELECT 1
      FROM public.lr_real_users real_row
      WHERE real_row.max_user_id=user_row.max_user_id
    ),
  quarantine_reason=
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.lr_real_users real_row
        WHERE real_row.max_user_id=user_row.max_user_id
      )
      THEN NULL
      ELSE 'legacy_channel_member_or_bot_v3'
    END,
  quarantined_at=
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.lr_real_users real_row
        WHERE real_row.max_user_id=user_row.max_user_id
      )
      THEN NULL
      ELSE COALESCE(user_row.quarantined_at,now())
    END,
  updated_at=now();

CREATE OR REPLACE VIEW public.lr_admin_users AS
SELECT user_row.*
FROM public.lr_users user_row
JOIN public.lr_real_users real_row
  ON real_row.max_user_id=user_row.max_user_id;

CREATE OR REPLACE FUNCTION
  public.lr_auto_allow_real_user_v3()
RETURNS trigger
LANGUAGE plpgsql
AS $lr_allow$
BEGIN
  IF
    COALESCE(NEW.raw_profile->>'verified','false')='true'
    AND
    COALESCE(NEW.raw_profile->>'is_bot','false')<>'true'
    AND
    NEW.max_user_id ~ '^[0-9]+$'
    AND
    NULLIF(BTRIM(COALESCE(NEW.display_name,'')),'') IS NOT NULL
    AND
    LOWER(BTRIM(COALESCE(NEW.display_name,'')))
      <> 'пользователь max'
    AND
    LOWER(BTRIM(COALESCE(NEW.display_name,'')))
      NOT LIKE 'linkray%'
  THEN
    INSERT INTO public.lr_real_users (
      max_user_id,
      label,
      source,
      verified_at,
      updated_at
    )
    VALUES (
      NEW.max_user_id,
      COALESCE(
        NULLIF(NEW.display_name,''),
        NULLIF(NEW.first_name,''),
        'Пользователь MAX'
      ),
      'verified_private_interaction',
      now(),
      now()
    )
    ON CONFLICT (max_user_id)
    DO UPDATE SET
      label=EXCLUDED.label,
      source=EXCLUDED.source,
      updated_at=now();

    NEW.is_verified_linkray_user := true;
    NEW.quarantine_reason := NULL;
    NEW.quarantined_at := NULL;
  END IF;

  RETURN NEW;
END;
$lr_allow$;

DROP TRIGGER IF EXISTS lr_users_auto_allow_real_v3
ON public.lr_users;

CREATE TRIGGER lr_users_auto_allow_real_v3
BEFORE INSERT OR UPDATE OF
  raw_profile,
  display_name,
  first_name,
  username
ON public.lr_users
FOR EACH ROW
EXECUTE FUNCTION public.lr_auto_allow_real_user_v3();

DROP VIEW IF EXISTS public.lr_verified_users;

DO $lr_check$
DECLARE
  visible_count integer;
BEGIN
  SELECT COUNT(*)
  INTO visible_count
  FROM public.lr_admin_users;

  IF visible_count<>2 THEN
    RAISE EXCEPTION
      'Ожидалось 2 реальных пользователя, получено %',
      visible_count;
  END IF;
END;
$lr_check$;

COMMIT;
