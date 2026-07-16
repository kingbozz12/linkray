BEGIN;

-- LINKRAY DELETE NON-OWNER USERS V1.2
-- Владелец определяется установщиком перед созданием файла.
-- MAX ID владельца: 198999490

DO $lr_cleanup$
DECLARE
  owner_max_id constant text := '198999490';
  owner_db_id bigint;
  owner_count integer;
  fk record;
  child_column text;
  parent_column text;
  deleted_rows bigint := 0;
  optional_oid oid;
  optional_kind "char";
  sequence_name text;
BEGIN
  SELECT COUNT(*), MIN(id)
  INTO owner_count, owner_db_id
  FROM public.lr_users
  WHERE max_user_id=owner_max_id;

  IF owner_count<>1 OR owner_db_id IS NULL THEN
    RAISE EXCEPTION
      'Владелец % не найден однозначно в lr_users',
      owner_max_id;
  END IF;

  /*
   * Сначала удаляем строки из всех таблиц, которые имеют
   * простой внешний ключ на lr_users. Это делает очистку
   * устойчивой даже для ограничений без ON DELETE CASCADE.
   */
  FOR fk IN
    SELECT
      child_ns.nspname AS child_schema,
      child.relname AS child_table,
      parent_ns.nspname AS parent_schema,
      parent.relname AS parent_table,
      constraint_row.conkey,
      constraint_row.confkey
    FROM pg_constraint constraint_row
    JOIN pg_class child
      ON child.oid=constraint_row.conrelid
    JOIN pg_namespace child_ns
      ON child_ns.oid=child.relnamespace
    JOIN pg_class parent
      ON parent.oid=constraint_row.confrelid
    JOIN pg_namespace parent_ns
      ON parent_ns.oid=parent.relnamespace
    WHERE constraint_row.contype='f'
      AND constraint_row.confrelid='public.lr_users'::regclass
  LOOP
    IF array_length(fk.conkey,1)<>1
       OR array_length(fk.confkey,1)<>1 THEN
      RAISE EXCEPTION
        'Найден составной FK %.%; безопасная очистка остановлена',
        fk.child_schema,
        fk.child_table;
    END IF;

    SELECT attname
    INTO child_column
    FROM pg_attribute
    WHERE attrelid=format(
      '%I.%I',
      fk.child_schema,
      fk.child_table
    )::regclass
      AND attnum=fk.conkey[1];

    SELECT attname
    INTO parent_column
    FROM pg_attribute
    WHERE attrelid='public.lr_users'::regclass
      AND attnum=fk.confkey[1];

    EXECUTE format(
      'DELETE FROM %I.%I child_row
       WHERE child_row.%I IN (
         SELECT parent_row.%I
         FROM public.lr_users parent_row
         WHERE parent_row.max_user_id<>%L
       )',
      fk.child_schema,
      fk.child_table,
      child_column,
      parent_column,
      owner_max_id
    );
  END LOOP;

  DELETE FROM public.lr_users
  WHERE max_user_id<>owner_max_id;

  GET DIAGNOSTICS deleted_rows=ROW_COUNT;

  IF deleted_rows<0 THEN
    RAISE EXCEPTION 'Некорректный результат удаления';
  END IF;

  /*
   * Очищаем только реально существующие физические таблицы.
   * Здесь намеренно нет выражений вида
   * 'public.table_name'::regclass: такое выражение падает
   * до проверки, когда таблица отсутствует.
   */
  FOREACH child_column IN ARRAY ARRAY[
    'public.lr_real_users',
    'public.lr_verified_users',
    'public.lr_user_quarantine',
    'public.lr_users_quarantine'
  ]
  LOOP
    optional_oid := to_regclass(child_column);

    IF optional_oid IS NULL THEN
      CONTINUE;
    END IF;

    SELECT relkind
    INTO optional_kind
    FROM pg_class
    WHERE oid=optional_oid;

    IF optional_kind IN ('r','p') THEN
      EXECUTE format(
        'DELETE FROM %s WHERE max_user_id<>$1',
        optional_oid::regclass
      )
      USING owner_max_id;
    END IF;
  END LOOP;

  -- Необязательная таблица админских сессий.
  optional_oid := to_regclass('public.lr_admin_sessions');

  IF optional_oid IS NOT NULL THEN
    SELECT relkind
    INTO optional_kind
    FROM pg_class
    WHERE oid=optional_oid;

    IF optional_kind IN ('r','p') THEN
      EXECUTE format(
        'DELETE FROM %s WHERE admin_user_id<>$1',
        optional_oid::regclass
      )
      USING owner_max_id;
    END IF;
  END IF;

  -- В таблице администраторов оставляем только владельца.
  DELETE FROM public.lr_admins
  WHERE max_user_id<>owner_max_id;

  UPDATE public.lr_admins
  SET
    role='owner',
    is_active=true,
    updated_at=now()
  WHERE max_user_id=owner_max_id;

  -- Если дополнительные поля изоляции существуют,
  -- у владельца снимаются все карантинные признаки.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='lr_users'
      AND column_name='is_verified_linkray_user'
  ) THEN
    EXECUTE format(
      'UPDATE public.lr_users
       SET is_verified_linkray_user=true
       WHERE max_user_id=%L',
      owner_max_id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='lr_users'
      AND column_name='quarantine_reason'
  ) THEN
    EXECUTE format(
      'UPDATE public.lr_users
       SET quarantine_reason=NULL
       WHERE max_user_id=%L',
      owner_max_id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='lr_users'
      AND column_name='quarantined_at'
  ) THEN
    EXECUTE format(
      'UPDATE public.lr_users
       SET quarantined_at=NULL
       WHERE max_user_id=%L',
      owner_max_id
    );
  END IF;

  UPDATE public.lr_users
  SET
    is_blocked=false,
    raw_profile=COALESCE(raw_profile,'{}'::jsonb)
      || jsonb_build_object(
        'user_id',
        owner_max_id,
        'is_bot',
        false,
        'verified',
        true
      ),
    updated_at=now()
  WHERE max_user_id=owner_max_id;

  -- Счётчик новых пользователей продолжается с текущего
  -- максимального ID. Для identity/serial без доступной
  -- последовательности эта операция безопасно пропускается.
  sequence_name :=
    pg_get_serial_sequence('public.lr_users','id');

  IF sequence_name IS NOT NULL THEN
    PERFORM setval(
      sequence_name,
      GREATEST(
        COALESCE(
          (SELECT MAX(id) FROM public.lr_users),
          1
        ),
        1
      ),
      true
    );
  END IF;
END;
$lr_cleanup$;

-- Представление админки снова явно опирается только
-- на реальных пользователей, если whitelist существует
-- как физическая таблица.
DO $lr_view$
DECLARE
  relation_oid oid;
  relation_kind "char";
BEGIN
  relation_oid := to_regclass('public.lr_real_users');

  IF relation_oid IS NOT NULL THEN
    SELECT relkind
    INTO relation_kind
    FROM pg_class
    WHERE oid=relation_oid;

    IF relation_kind IN ('r','p') THEN
      EXECUTE '
        CREATE OR REPLACE VIEW public.lr_admin_users AS
        SELECT user_row.*
        FROM public.lr_users user_row
        JOIN public.lr_real_users real_row
          ON real_row.max_user_id=user_row.max_user_id
      ';
    END IF;
  END IF;
END;
$lr_view$;

DO $lr_verify$
DECLARE
  owner_max_id constant text := '198999490';
  users_left integer;
  owners_left integer;
  admin_visible integer;
  wrong_user text;
  relation_oid oid;
BEGIN
  SELECT COUNT(*), MIN(max_user_id)
  INTO users_left, wrong_user
  FROM public.lr_users;

  IF users_left<>1 THEN
    RAISE EXCEPTION
      'После очистки в lr_users осталось строк: %',
      users_left;
  END IF;

  IF wrong_user<>owner_max_id THEN
    RAISE EXCEPTION
      'После очистки остался неверный пользователь: %',
      wrong_user;
  END IF;

  SELECT COUNT(*)
  INTO owners_left
  FROM public.lr_admins
  WHERE max_user_id=owner_max_id
    AND role='owner'
    AND COALESCE(is_active,true)=true;

  IF owners_left<>1 THEN
    RAISE EXCEPTION
      'Запись владельца в lr_admins повреждена';
  END IF;

  relation_oid := to_regclass('public.lr_admin_users');

  IF relation_oid IS NOT NULL THEN
    EXECUTE format(
      'SELECT COUNT(*) FROM %s',
      relation_oid::regclass
    )
    INTO admin_visible;

    IF admin_visible<>1 THEN
      RAISE EXCEPTION
        'В lr_admin_users отображается пользователей: %',
        admin_visible;
    END IF;
  END IF;
END;
$lr_verify$;

COMMIT;
