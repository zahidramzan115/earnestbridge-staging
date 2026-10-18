-- ============================================================
-- PHASE 7G-4B0-M — CONTACT MERGE SECURITY + NORMALIZED EMAIL FOUNDATION
-- ============================================================
-- Verified inputs (read from repo migrations):
--   public.merge_crm_contacts(p_target_id UUID, p_source_id UUID, p_admin_actor TEXT DEFAULT 'Admin')
--     RETURNS JSONB, plpgsql, SECURITY DEFINER, no search_path, no GRANT/REVOKE.
--     Defined once in 20260911000300_crm_phase2_schema.sql; never redefined.
--   public.crm_contacts.id               UUID PRIMARY KEY
--   public.crm_contacts.is_merged        BOOLEAN NOT NULL DEFAULT false
--   public.crm_contacts.merged_into_id   UUID NULL REFERENCES crm_contacts(id)
--   public.crm_contact_emails.contact_id UUID NOT NULL
--   Existing unique indexes (UNCHANGED):
--     idx_crm_contacts_email_unique       ON crm_contacts(lower(trim(primary_email))) WHERE is_merged = false
--     idx_crm_contact_emails_unique       ON crm_contact_emails(lower(trim(email)))
--   public.is_service_role_caller() from 20261007000100 (7G-2)
--
-- WHAT THIS MIGRATION DOES
--   1. Hardens merge_crm_contacts: fixed search_path, EXECUTE for service_role only.
--      The function body is NOT changed (ALTER FUNCTION only).
--   2. Adds guard_crm_contact_merge_state() + trigger protecting
--      crm_contacts.is_merged and crm_contacts.merged_into_id.
--      Only service_role may change them. SuperAdmin is NOT exempt.
--   3. Enforces valid merged state: is_merged = true <=> merged_into_id IS NOT NULL.
--   4. Adds find_crm_contact_id_by_normalized_email(p_email TEXT)
--      (SECURITY INVOKER, service_role only).
--
-- NOT CHANGED
--   merge_crm_contacts body, guard_purge_metadata(), purged_* columns,
--   borrower_access, borrower_applications policies, existing indexes,
--   existing rows (no backfill, no data mutation).
-- ============================================================


-- ─── 1. HARDEN merge_crm_contacts EXECUTION ──────────────────────────────────
-- Exact verified signature: (uuid, uuid, text)

ALTER FUNCTION public.merge_crm_contacts(UUID, UUID, TEXT)
  SET search_path = public, pg_catalog;

REVOKE ALL ON FUNCTION public.merge_crm_contacts(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_crm_contacts(UUID, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.merge_crm_contacts(UUID, UUID, TEXT) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.merge_crm_contacts(UUID, UUID, TEXT) TO service_role;


-- ─── 2 + 3. MERGE-STATE GUARD ────────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE on crm_contacts.
--
-- INSERT:
--   Normal creation (is_merged = false AND merged_into_id IS NULL) passes.
--   Anything else requires service_role, and must still be a valid merged state.
--
-- UPDATE:
--   If is_merged and merged_into_id are both unchanged -> return immediately
--   (normal Contact edits, including purge metadata edits, are unaffected).
--   If either changed -> service_role required (SuperAdmin JWT is NOT enough).
--
-- VALID STATE (enforced for every caller whenever merge state is being set/changed):
--   is_merged = true   REQUIRES merged_into_id IS NOT NULL
--   merged_into_id set REQUIRES is_merged = true
--
-- merge_crm_contacts writes is_merged = true and merged_into_id = target in the
-- same UPDATE, executed via the service-role client, so it passes both rules.
-- The existing orphan hide (is_merged = true, merged_into_id NULL) is rejected.

CREATE OR REPLACE FUNCTION public.guard_crm_contact_merge_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $func$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_merged, false) = false
       AND NEW.merged_into_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.is_merged      IS NOT DISTINCT FROM OLD.is_merged
       AND NEW.merged_into_id IS NOT DISTINCT FROM OLD.merged_into_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Merge state is being set or changed: only service_role (server merge route /
  -- merge_crm_contacts RPC). SuperAdmin browser sessions are intentionally NOT
  -- exempt; SuperAdmin purge uses purged_at / purged_by / purge_reason instead.
  IF NOT public.is_service_role_caller() THEN
    RAISE EXCEPTION
      'Permission denied: crm_contacts.is_merged and merged_into_id may only be changed by the server merge workflow (service_role).'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Valid merged state, even for service_role.
  IF COALESCE(NEW.is_merged, false) = true AND NEW.merged_into_id IS NULL THEN
    RAISE EXCEPTION
      'Invalid merge state: is_merged = true requires merged_into_id to be set.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.merged_into_id IS NOT NULL AND COALESCE(NEW.is_merged, false) = false THEN
    RAISE EXCEPTION
      'Invalid merge state: merged_into_id requires is_merged = true.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$func$;

REVOKE ALL ON FUNCTION public.guard_crm_contact_merge_state() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_crm_contact_merge_state_trigger ON public.crm_contacts;
CREATE TRIGGER guard_crm_contact_merge_state_trigger
  BEFORE INSERT OR UPDATE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_crm_contact_merge_state();


-- ─── 5 + 6. EXACT NORMALIZED EMAIL LOOKUP HELPER ─────────────────────────────
-- Matches the existing unique-index semantics: lower(trim(email)).
--   * primary_email checked first, then crm_contact_emails.email
--   * only Contacts with is_merged = false
--   * purged_at is deliberately NOT filtered (inbound activity must be able to
--     find and auto-restore a purged Contact)
--   * blank / NULL input returns NULL
--   * returns the Contact id only
--
-- Ambiguity: idx_crm_contacts_email_unique (non-merged) and
-- idx_crm_contact_emails_unique make a duplicate impossible within each table.
-- A cross-table collision (same normalized email as one Contact's primary and a
-- different Contact's alternate) is not prevented by the schema. Behavior:
-- the primary_email match wins; otherwise the oldest alternate-email row wins
-- (created_at, then id) so the result is deterministic.
--
-- SECURITY INVOKER with fixed search_path; service_role only.

CREATE OR REPLACE FUNCTION public.find_crm_contact_id_by_normalized_email(p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_email TEXT;
  v_id    UUID;
BEGIN
  v_email := lower(trim(COALESCE(p_email, '')));

  IF v_email = '' THEN
    RETURN NULL;
  END IF;

  -- A. Primary email (matches idx_crm_contacts_email_unique expression)
  SELECT c.id
    INTO v_id
  FROM public.crm_contacts c
  WHERE lower(trim(c.primary_email)) = v_email
    AND c.is_merged = false
  ORDER BY c.created_at ASC, c.id ASC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- B. Alternate email (matches idx_crm_contact_emails_unique expression)
  SELECT c.id
    INTO v_id
  FROM public.crm_contact_emails ce
  JOIN public.crm_contacts c ON c.id = ce.contact_id
  WHERE lower(trim(ce.email)) = v_email
    AND c.is_merged = false
  ORDER BY ce.created_at ASC, ce.id ASC
  LIMIT 1;

  RETURN v_id;
END;
$func$;

-- ─── 6. EMAIL HELPER EXECUTION ───────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.find_crm_contact_id_by_normalized_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_crm_contact_id_by_normalized_email(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.find_crm_contact_id_by_normalized_email(TEXT) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.find_crm_contact_id_by_normalized_email(TEXT) TO service_role;


-- ============================================================
-- VERIFICATION (commented; run manually after deploy)
-- ============================================================
-- Function hardening:
--   SELECT proname, prosecdef, proconfig
--   FROM pg_proc
--   WHERE oid = 'public.merge_crm_contacts(uuid,uuid,text)'::regprocedure;
--     -- prosecdef = true, proconfig = {search_path=public, pg_catalog}
--
--   SELECT has_function_privilege('anon',          'public.merge_crm_contacts(uuid,uuid,text)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('authenticated', 'public.merge_crm_contacts(uuid,uuid,text)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('service_role',  'public.merge_crm_contacts(uuid,uuid,text)', 'EXECUTE'); -- true
--
--   SELECT has_function_privilege('anon',          'public.find_crm_contact_id_by_normalized_email(text)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('authenticated', 'public.find_crm_contact_id_by_normalized_email(text)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('service_role',  'public.find_crm_contact_id_by_normalized_email(text)', 'EXECUTE'); -- true
--
-- Trigger present:
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.crm_contacts'::regclass AND NOT tgisinternal;
--     -- includes guard_crm_contact_merge_state_trigger and guard_purge_metadata_crm_contacts
--
-- Scenarios:
--   CASE A  Regular Admin edits first_name / phone / lead_status / notes
--           (is_merged, merged_into_id unchanged)                   -> ALLOWED
--   CASE B  Regular Admin sets is_merged = true                     -> ERROR insufficient_privilege
--   CASE C  Regular Admin sets merged_into_id                       -> ERROR insufficient_privilege
--   CASE D  SuperAdmin browser session changes is_merged            -> ERROR insufficient_privilege
--   CASE E  Admin API -> service_role -> merge_crm_contacts(...)    -> ALLOWED
--           (sets is_merged = true AND merged_into_id in one UPDATE)
--   CASE F  service_role: UPDATE ... SET is_merged = true
--           (merged_into_id stays NULL)                             -> ERROR check_violation
--   CASE G  authenticated browser: rpc('merge_crm_contacts', ...)   -> permission denied for function
--   CASE H  service_role: rpc('merge_crm_contacts', ...)            -> ALLOWED
--   CASE I  Normal INSERT (default is_merged = false)               -> ALLOWED
--   CASE J  Stored 'John@Example.com', input 'john@example.com':
--             SELECT public.find_crm_contact_id_by_normalized_email('john@example.com');  -- same Contact id
--   CASE K  Stored ' John@Example.com ', input 'john@example.com'   -> same Contact id
--   CASE L  Contact with purged_at IS NOT NULL, is_merged = false   -> helper STILL returns its id
--   CASE M  Contact with is_merged = true                           -> helper does NOT return it
--
--   -- Blank / NULL input:
--   SELECT public.find_crm_contact_id_by_normalized_email('   ');   -- NULL
--   SELECT public.find_crm_contact_id_by_normalized_email(NULL);    -- NULL
--
--   -- Role simulation (SQL editor), service_role helper call:
--   --   SET LOCAL ROLE service_role;
--   --   SELECT public.find_crm_contact_id_by_normalized_email('john@example.com');
-- ============================================================
