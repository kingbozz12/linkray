ALTER TABLE channel_signatures DISABLE ROW LEVEL SECURITY;

ALTER TABLE channel_signatures ALTER COLUMN signature SET DEFAULT '';
ALTER TABLE channel_signatures ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE channel_signatures ALTER COLUMN owner_key SET DEFAULT 'shared';
ALTER TABLE channel_signatures ALTER COLUMN title SET DEFAULT 'Автоподпись';
ALTER TABLE channel_signatures ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE channel_signatures ALTER COLUMN text SET DEFAULT '';

CREATE OR REPLACE FUNCTION channel_signatures_sync_text_signature_v22()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(btrim(NEW.text), '') <> '' THEN
      NEW.signature := NEW.text;
    ELSIF COALESCE(btrim(NEW.signature), '') <> '' THEN
      NEW.text := NEW.signature;
    END IF;
  ELSE
    IF NEW.text IS DISTINCT FROM OLD.text AND COALESCE(btrim(NEW.text), '') <> '' THEN
      NEW.signature := NEW.text;
    ELSIF NEW.signature IS DISTINCT FROM OLD.signature AND COALESCE(btrim(NEW.signature), '') <> '' THEN
      NEW.text := NEW.signature;
    ELSIF COALESCE(btrim(NEW.text), '') <> '' AND COALESCE(btrim(NEW.signature), '') = '' THEN
      NEW.signature := NEW.text;
    ELSIF COALESCE(btrim(NEW.signature), '') <> '' AND COALESCE(btrim(NEW.text), '') = '' THEN
      NEW.text := NEW.signature;
    END IF;
  END IF;

  NEW.enabled := COALESCE(NEW.enabled, true);
  NEW.is_active := COALESCE(NEW.is_active, true);
  NEW.owner_key := COALESCE(NULLIF(NEW.owner_key, ''), 'shared');
  NEW.title := COALESCE(NULLIF(NEW.title, ''), 'Автоподпись');
  NEW.updated_at := now();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS channel_signatures_sync_text_signature_v22_trg ON channel_signatures;

CREATE TRIGGER channel_signatures_sync_text_signature_v22_trg
BEFORE INSERT OR UPDATE ON channel_signatures
FOR EACH ROW
EXECUTE FUNCTION channel_signatures_sync_text_signature_v22();

UPDATE channel_signatures
SET
  signature = CASE
    WHEN COALESCE(btrim(text), '') <> '' THEN text
    ELSE signature
  END,
  text = CASE
    WHEN COALESCE(btrim(text), '') <> '' THEN text
    WHEN COALESCE(btrim(signature), '') <> '' THEN signature
    ELSE text
  END,
  enabled = true,
  is_active = true,
  updated_at = now();
