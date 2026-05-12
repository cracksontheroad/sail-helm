-- ─────────────────────────────────────────────────────────────────────────────
-- Helm M8 — list_school_members admit school admins (not just tenants.read)
--
-- Stage 3 Helm rebuild, 2026-05-12.
--
-- Status: APPLIED to gidyonbzxjorrgpicctt on 2026-05-12 (Supabase migration
--         name: helm_list_school_members_admit_school_admin).
--
-- Why this exists: the original Helm rename-wrapper for list_school_members
-- inherited Bridge's strict `has_permission('tenants.read')` capability
-- check via a thin SECURITY DEFINER passthrough. School admins do not
-- have the `tenants.read` capability (it's a platform-staff capability),
-- so the Members page, the Courses teacher picker, and the Dashboard
-- "Members" card all failed with `Permission denied: tenants.read required`
-- for school admins. Caught via Playwright E2E.
--
-- Fix: replace the thin wrapper with a NEW implementation that admits
-- school admins of the target school in addition to platform staff
-- holding tenants.read. Implementation queries school_members joined
-- with profiles and auth.users directly so cross-school access is
-- structurally impossible (filtered by p_school_id and only callable
-- by admins of THAT school).
--
-- Idempotent: CREATE OR REPLACE FUNCTION makes re-apply a no-op.
--
-- Permission model:
--   - is_school_admin(p_school_id) → allow
--   - has_permission(uid, 'tenants.read') → allow (preserves prior path)
--   - else 42501 permission denied
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_school_members(p_school_id uuid)
RETURNS TABLE (
    id          uuid,
    user_id     uuid,
    school_id   uuid,
    role        text,
    email       text,
    first_name  text,
    last_name   text,
    joined_at   timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF NOT (
        public.is_school_admin(p_school_id)
        OR public.has_permission(v_uid, 'tenants.read')
    ) THEN
        RAISE EXCEPTION 'Permission denied: must be admin of school or have tenants.read capability'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        sm.id,
        sm.user_id,
        sm.school_id,
        sm.role,
        au.email,
        p.first_name,
        p.last_name,
        sm.created_at AS joined_at
      FROM public.school_members sm
      LEFT JOIN public.profiles  p  ON p.id  = sm.user_id
      LEFT JOIN auth.users       au ON au.id = sm.user_id
     WHERE sm.school_id = p_school_id
     ORDER BY au.email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_school_members(uuid) TO authenticated;
