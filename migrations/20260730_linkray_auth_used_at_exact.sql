DO $fix$
DECLARE r record;
BEGIN
  -- Точная таблица определяется по набору колонок авторизации.
  FOR r IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    GROUP BY table_name
    HAVING
      bool_or(column_name IN (
        'expires_at','expires_at_ms','code_expires_at','created_at'
      ))
      AND bool_or(column_name IN (
        'code','code_hash','code_digest',
        'otp','otp_hash','otp_digest',
        'token','token_hash',
        'attempts','identifier'
      ))
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL',
      r.table_name
    );
    RAISE NOTICE 'checked used_at in %', r.table_name;
  END LOOP;
END
$fix$;
ALTER TABLE IF EXISTS public."public" ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NULL;
