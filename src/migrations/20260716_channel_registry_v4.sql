BEGIN;

ALTER TABLE public.lr_user_channels
  ADD COLUMN IF NOT EXISTS
    access_source text NOT NULL DEFAULT 'legacy';

ALTER TABLE public.lr_user_channels
  ADD COLUMN IF NOT EXISTS
    role text NOT NULL DEFAULT 'member';

ALTER TABLE public.lr_user_channels
  ADD COLUMN IF NOT EXISTS
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.lr_user_channels
  ADD COLUMN IF NOT EXISTS
    last_verified_at timestamptz;

CREATE OR REPLACE FUNCTION
  public.lr_sync_owner_channel_link_v4()
RETURNS trigger
LANGUAGE plpgsql
AS $lr_channel_link$
DECLARE
  owner_user_id bigint;
BEGIN
  SELECT user_row.id
  INTO owner_user_id
  FROM public.lr_users user_row
  JOIN public.lr_admins admin_row
    ON admin_row.max_user_id::text=
       user_row.max_user_id::text
  WHERE COALESCE(admin_row.is_active,true)=true
  ORDER BY
    CASE
      WHEN admin_row.role='owner' THEN 0
      ELSE 1
    END,
    admin_row.created_at,
    user_row.id
  LIMIT 1;

  IF owner_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_active,true)=true THEN
    INSERT INTO public.lr_user_channels (
      user_id,
      channel_id,
      linked_at,
      access_source,
      role,
      permissions,
      last_verified_at
    )
    VALUES (
      owner_user_id,
      NEW.id,
      now(),
      'channel_registry_v4',
      'owner',
      '[]'::jsonb,
      now()
    )
    ON CONFLICT (user_id,channel_id)
    DO UPDATE SET
      access_source=
        CASE
          WHEN public.lr_user_channels.access_source='workspace'
          THEN 'workspace'
          ELSE 'channel_registry_v4'
        END,
      role=
        CASE
          WHEN public.lr_user_channels.role='owner'
          THEN 'owner'
          ELSE EXCLUDED.role
        END,
      last_verified_at=now();
  ELSE
    DELETE FROM public.lr_user_channels
    WHERE user_id=owner_user_id
      AND channel_id=NEW.id
      AND COALESCE(access_source,'legacy')
          <> 'workspace';
  END IF;

  RETURN NEW;
END;
$lr_channel_link$;

DROP TRIGGER IF EXISTS
  lr_channels_owner_link_v4
ON public.channels;

CREATE TRIGGER
  lr_channels_owner_link_v4
AFTER INSERT OR UPDATE OF is_active
ON public.channels
FOR EACH ROW
EXECUTE FUNCTION
  public.lr_sync_owner_channel_link_v4();

-- Синхронизация уже существующих активных каналов.
WITH owner_user AS (
  SELECT user_row.id
  FROM public.lr_users user_row
  JOIN public.lr_admins admin_row
    ON admin_row.max_user_id::text=
       user_row.max_user_id::text
  WHERE COALESCE(admin_row.is_active,true)=true
  ORDER BY
    CASE
      WHEN admin_row.role='owner' THEN 0
      ELSE 1
    END,
    admin_row.created_at,
    user_row.id
  LIMIT 1
)
INSERT INTO public.lr_user_channels (
  user_id,
  channel_id,
  linked_at,
  access_source,
  role,
  permissions,
  last_verified_at
)
SELECT
  owner_user.id,
  channel_row.id,
  now(),
  'channel_registry_v4',
  'owner',
  '[]'::jsonb,
  now()
FROM owner_user
CROSS JOIN public.channels channel_row
WHERE COALESCE(channel_row.is_active,true)=true
ON CONFLICT (user_id,channel_id)
DO UPDATE SET
  access_source=
    CASE
      WHEN public.lr_user_channels.access_source='workspace'
      THEN 'workspace'
      ELSE 'channel_registry_v4'
    END,
  role=
    CASE
      WHEN public.lr_user_channels.role='owner'
      THEN 'owner'
      ELSE EXCLUDED.role
    END,
  last_verified_at=now();

-- Убираем рабочие связи владельца с отключёнными каналами.
WITH owner_user AS (
  SELECT user_row.id
  FROM public.lr_users user_row
  JOIN public.lr_admins admin_row
    ON admin_row.max_user_id::text=
       user_row.max_user_id::text
  WHERE COALESCE(admin_row.is_active,true)=true
  ORDER BY
    CASE
      WHEN admin_row.role='owner' THEN 0
      ELSE 1
    END,
    admin_row.created_at,
    user_row.id
  LIMIT 1
)
DELETE FROM public.lr_user_channels link_row
USING owner_user, public.channels channel_row
WHERE link_row.user_id=owner_user.id
  AND link_row.channel_id=channel_row.id
  AND COALESCE(channel_row.is_active,true)=false
  AND COALESCE(link_row.access_source,'legacy')
      <> 'workspace';

-- Старые глобальные режимы и блокировки уведомлений
-- больше не должны влиять на новые операции.
DELETE FROM public.lr_bot_state
WHERE key IN (
    'lr_v31_add_wait_global',
    'lr_v34_add_wait_global',
    'lr_v30_add_wait_global',
    'lr_v29_add_wait_global'
  )
   OR key LIKE 'lr_v31_channel_connected_notified:%'
   OR key LIKE 'lr_v34_add_confirm_sent:%';

COMMIT;
