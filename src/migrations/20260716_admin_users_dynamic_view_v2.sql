BEGIN;

CREATE OR REPLACE VIEW public.lr_admin_users AS
SELECT user_row.*
FROM public.lr_users user_row
WHERE NOT (
  EXISTS (
    SELECT 1
    FROM public.lr_antifraud_events event_row
    WHERE event_row.user_id::text=
          user_row.max_user_id::text
      AND event_row.event_type='join'
      AND ABS(
        EXTRACT(
          EPOCH FROM (
            user_row.registered_at -
            event_row.event_at
          )
        )
      ) <= 120
  )

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
  )
);

DROP VIEW IF EXISTS public.lr_verified_users;

COMMIT;
