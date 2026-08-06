BEGIN;

CREATE OR REPLACE FUNCTION public.lr_hard_delete_channels_v89(
  p_channel_ids integer[],
  p_max_chat_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
AS $lr_v89$
DECLARE
  target_ids integer[];
  target_ids_text text[];
  target_chats text[];
  item record;
  sql_text text;
  pass_no integer;
  affected integer;
  related_total bigint := 0;
  channel_total integer := 0;
  expected_total integer := 0;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT value), ARRAY[]::integer[])
  INTO target_ids
  FROM unnest(COALESCE(p_channel_ids, ARRAY[]::integer[])) AS value
  WHERE value IS NOT NULL;

  SELECT COALESCE(array_agg(DISTINCT btrim(value)), ARRAY[]::text[])
  INTO target_chats
  FROM unnest(COALESCE(p_max_chat_ids, ARRAY[]::text[])) AS value
  WHERE value IS NOT NULL
    AND btrim(value) <> '';

  SELECT COALESCE(array_agg(value::text), ARRAY[]::text[])
  INTO target_ids_text
  FROM unnest(target_ids) AS value;

  SELECT COUNT(*)
  INTO expected_total
  FROM public.channels
  WHERE id = ANY(target_ids)
     OR max_chat_id::text = ANY(target_chats);

  IF expected_total = 0 THEN
    RETURN jsonb_build_object(
      'channels', 0,
      'related', 0
    );
  END IF;

  FOR pass_no IN 1..12 LOOP
    FOR item IN
      SELECT
        columns.table_schema,
        columns.table_name,
        bool_or(columns.column_name='channel_id') AS has_channel_id,
        bool_or(columns.column_name='max_chat_id') AS has_max_chat_id,
        bool_or(columns.column_name='chat_id') AS has_chat_id
      FROM information_schema.columns columns
      JOIN information_schema.tables tables
        ON tables.table_schema=columns.table_schema
       AND tables.table_name=columns.table_name
      WHERE columns.table_schema='public'
        AND tables.table_type='BASE TABLE'
        AND columns.table_name<>'channels'
        AND columns.column_name IN (
          'channel_id',
          'max_chat_id',
          'chat_id'
        )
      GROUP BY
        columns.table_schema,
        columns.table_name
      ORDER BY
        columns.table_name
    LOOP
      sql_text := format(
        'DELETE FROM %I.%I WHERE false',
        item.table_schema,
        item.table_name
      );

      IF item.has_channel_id THEN
        sql_text := sql_text ||
          ' OR CAST(channel_id AS text)=ANY($1::text[])';
      END IF;

      IF item.has_max_chat_id THEN
        sql_text := sql_text ||
          ' OR CAST(max_chat_id AS text)=ANY($2::text[])';
      END IF;

      IF item.has_chat_id THEN
        sql_text := sql_text ||
          ' OR CAST(chat_id AS text)=ANY($2::text[])';
      END IF;

      BEGIN
        EXECUTE sql_text
        USING target_ids_text, target_chats;

        GET DIAGNOSTICS affected = ROW_COUNT;
        related_total := related_total + affected;
      EXCEPTION
        WHEN foreign_key_violation THEN
          NULL;
        WHEN invalid_text_representation THEN
          NULL;
        WHEN datatype_mismatch THEN
          NULL;
      END;
    END LOOP;
  END LOOP;

  IF to_regclass('public.lr_bot_state') IS NOT NULL
     AND cardinality(target_chats) > 0 THEN
    DELETE FROM public.lr_bot_state state
    WHERE EXISTS (
      SELECT 1
      FROM unnest(target_chats) AS chat_id
      WHERE state.key LIKE '%' || chat_id || '%'
         OR state.value::text LIKE '%' || chat_id || '%'
    );

    GET DIAGNOSTICS affected = ROW_COUNT;
    related_total := related_total + affected;
  END IF;

  DELETE FROM public.channels
  WHERE id = ANY(target_ids)
     OR max_chat_id::text = ANY(target_chats);

  GET DIAGNOSTICS channel_total = ROW_COUNT;

  IF channel_total <> expected_total THEN
    RAISE EXCEPTION
      'Удалено каналов %, ожидалось %. Осталась внешняя связь.',
      channel_total,
      expected_total;
  END IF;

  RETURN jsonb_build_object(
    'channels', channel_total,
    'related', related_total
  );
END;
$lr_v89$;

COMMENT ON FUNCTION public.lr_hard_delete_channels_v89(
  integer[],
  text[]
) IS
'Полное удаление канала LinkRay и всех связанных записей.';

DO $cleanup$
DECLARE
  old_ids integer[];
  old_chat_ids text[];
BEGIN
  SELECT
    COALESCE(array_agg(id), ARRAY[]::integer[]),
    COALESCE(array_agg(max_chat_id::text), ARRAY[]::text[])
  INTO old_ids, old_chat_ids
  FROM public.channels
  WHERE COALESCE(is_active, true)=false;

  IF cardinality(old_ids) > 0 THEN
    PERFORM public.lr_hard_delete_channels_v89(
      old_ids,
      old_chat_ids
    );
  END IF;
END;
$cleanup$;

COMMIT;
