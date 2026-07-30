DO $linkray$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    GROUP BY table_name
    HAVING
      (
        bool_or(column_name IN ('code', 'code_hash', 'otp', 'otp_hash', 'token', 'token_hash'))
        AND bool_or(column_name IN ('expires_at', 'expires_at_ms', 'created_at'))
      )
      AND (
        table_name ILIKE '%website%'
        OR table_name ILIKE '%auth%'
        OR table_name ILIKE '%login%'
        OR table_name ILIKE '%code%'
        OR table_name ILIKE '%otp%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL',
      r.table_name
    );
    RAISE NOTICE 'LinkRay: added/checked used_at in %', r.table_name;
  END LOOP;
END
$linkray$;
