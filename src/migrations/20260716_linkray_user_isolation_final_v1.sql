BEGIN;

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    is_verified_linkray_user boolean NOT NULL DEFAULT false;

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    verified_at timestamptz;

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    registration_source text NOT NULL DEFAULT 'unknown';

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    quarantined_at timestamptz;

ALTER TABLE public.lr_users
  ADD COLUMN IF NOT EXISTS
    quarantine_reason text;

CREATE INDEX IF NOT EXISTS
  lr_users_verified_last_seen_idx
ON public.lr_users(
  is_verified_linkray_user,
  last_seen_at DESC
);

UPDATE public.lr_users
SET
  is_verified_linkray_user=true,
  verified_at=COALESCE(
    verified_at,
    registered_at,
    created_at,
    now()
  ),
  registration_source=
    CASE
      WHEN registration_source IN ('', 'unknown')
      THEN 'legacy'
      ELSE registration_source
    END,
  updated_at=now()
WHERE quarantine_reason IS NULL;

DROP TABLE IF EXISTS tmp_lr_final_candidates;

CREATE TEMP TABLE tmp_lr_final_candidates (
  user_id bigint PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO tmp_lr_final_candidates(user_id)
SELECT
  user_row.id
FROM public.lr_users user_row
JOIN LATERAL (
  SELECT MIN(event_row.event_at) AS first_event
  FROM public.lr_antifraud_events event_row
  WHERE event_row.user_id::text=
        user_row.max_user_id::text
    AND event_row.event_type='join'
) antifraud ON antifraud.first_event IS NOT NULL
WHERE
  ABS(
    EXTRACT(
      EPOCH FROM (
        user_row.registered_at -
        antifraud.first_event
      )
    )
  ) <= 120

  AND NOT EXISTS (
    SELECT 1
    FROM public.lr_admins admin_row
    WHERE admin_row.max_user_id::text=
          user_row.max_user_id::text
      AND COALESCE(admin_row.is_active,true)=true
  )

  AND NOT EXISTS (
    SELECT 1
    FROM public.lr_user_channels linked_row
    WHERE linked_row.user_id=user_row.id
  )

  AND NOT EXISTS (
    SELECT 1
    FROM public.channels channel_row
    WHERE channel_row.owner_max_user_id::text=
          user_row.max_user_id::text
  )

  AND NOT EXISTS (
    SELECT 1
    FROM public.scheduled_posts post_row
    WHERE post_row.created_by_max_user_id::text=
          user_row.max_user_id::text
  )

  AND NOT EXISTS (
    SELECT 1
    FROM public.bot_sessions session_row
    WHERE REGEXP_REPLACE(
      session_row.user_id::text,
      '^user:',
      ''
    )=user_row.max_user_id::text
  );

UPDATE public.lr_users user_row
SET
  is_verified_linkray_user=false,
  verified_at=NULL,
  registration_source=
    'antifraud_quarantine_final_v1',
  quarantined_at=now(),
  quarantine_reason=
    'antifraud_only_high_confidence_final_v1',
  raw_profile=
    COALESCE(user_row.raw_profile,'{}'::jsonb)
    || jsonb_build_object(
      'linkray_quarantined',
      true,
      'linkray_quarantine_reason',
      'antifraud_only_high_confidence_final_v1'
    ),
  updated_at=now()
FROM tmp_lr_final_candidates candidate
WHERE user_row.id=candidate.user_id;

CREATE OR REPLACE VIEW public.lr_admin_users AS
SELECT *
FROM public.lr_users
WHERE is_verified_linkray_user=true;

-- Старое представление могло остаться после Stage 1.2.
-- Сначала все файлы уже переведены на lr_admin_users,
-- поэтому его можно безопасно убрать.
DROP VIEW IF EXISTS public.lr_verified_users;

CREATE OR REPLACE FUNCTION
  public.lr_verify_private_profile_final_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $lr_verify$
BEGIN
  IF
    COALESCE(NEW.raw_profile->>'verified','false')='true'
    AND
    COALESCE(NEW.raw_profile->>'is_bot','false')<>'true'
    AND
    NEW.max_user_id ~ '^[0-9]+$'
    AND
    NULLIF(BTRIM(COALESCE(NEW.display_name,'')),'')
      IS NOT NULL
    AND
    LOWER(BTRIM(COALESCE(NEW.display_name,'')))
      <> 'пользователь max'
    AND
    LOWER(BTRIM(COALESCE(NEW.display_name,'')))
      NOT LIKE 'linkray%'
  THEN
    NEW.is_verified_linkray_user := true;
    NEW.verified_at := COALESCE(
      NEW.verified_at,
      now()
    );
    NEW.registration_source :=
      'verified_private_profile';
    NEW.quarantined_at := NULL;
    NEW.quarantine_reason := NULL;
    NEW.raw_profile :=
      COALESCE(NEW.raw_profile,'{}'::jsonb)
        - 'linkray_quarantined'
        - 'linkray_quarantine_reason';
  END IF;

  RETURN NEW;
END;
$lr_verify$;

DROP TRIGGER IF EXISTS
  lr_users_verify_private_profile_final_v1
ON public.lr_users;

CREATE TRIGGER
  lr_users_verify_private_profile_final_v1
BEFORE INSERT OR UPDATE OF
  raw_profile,
  display_name,
  username
ON public.lr_users
FOR EACH ROW
EXECUTE FUNCTION
  public.lr_verify_private_profile_final_v1();

COMMIT;
