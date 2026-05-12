-- ─────────────────────────────────────────────────────────────────────────────
-- Helm M9 — Attendance read-side SECDEF wrappers
--
-- Stage 3 Helm rebuild, 2026-05-12.
--
-- Status: APPLIED to gidyonbzxjorrgpicctt on 2026-05-12 (Supabase migration
--         name: helm_attendance_session_for_date_wrapper).
--
-- Why this exists: `bridge_get_attendance_session_for_date` and
-- `bridge_list_attendance_sessions_for_class` (Bridge backend functions)
-- are SECURITY INVOKER and join `auth.users` directly. Calling them
-- from an authenticated client raises `permission denied for table users`
-- because the `authenticated` role has no SELECT grant on auth.users.
-- The companion write RPCs (`bridge_create_attendance_session`,
-- `bridge_save_attendance_register`) are SECDEF and unaffected.
--
-- Per the planner-locked M5 "never modify Bridge" rule, we do NOT
-- patch the Bridge functions. Instead we add Helm-owned SECDEF
-- wrappers that re-check permission (admin-of-school OR teacher-of-class)
-- and delegate to the Bridge function. Because the wrapper is SECDEF,
-- the inner Bridge function runs as the wrapper's owner (postgres),
-- which has SELECT on auth.users.
--
-- Frontend (src/services/api.js) calls these wrappers, not the Bridge
-- functions directly, for the two read paths.
--
-- Idempotent: CREATE OR REPLACE FUNCTION makes re-apply a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.helm_get_attendance_session_for_date(
    p_class_id     uuid,
    p_session_date date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid       uuid := auth.uid();
    v_school_id uuid;
    v_is_admin  boolean;
    v_is_teach  boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT school_id INTO v_school_id
      FROM public.classes WHERE id = p_class_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Class not found' USING ERRCODE = 'P0002';
    END IF;

    v_is_admin := public.is_school_admin(v_school_id);
    v_is_teach := EXISTS (
        SELECT 1 FROM public.enrollments e
         WHERE e.class_id = p_class_id
           AND e.user_id  = v_uid
           AND e.role     = 'teacher'
    );
    IF NOT (v_is_admin OR v_is_teach) THEN
        RAISE EXCEPTION 'Permission denied: must be admin of school or teacher of class'
            USING ERRCODE = '42501';
    END IF;

    -- Bridge function is SECURITY INVOKER and joins auth.users; calling
    -- it from this SECDEF wrapper makes it run as the wrapper's owner
    -- (postgres), which has SELECT on auth.users.
    RETURN public.bridge_get_attendance_session_for_date(p_class_id, p_session_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.helm_get_attendance_session_for_date(uuid, date) TO authenticated;


CREATE OR REPLACE FUNCTION public.helm_list_attendance_sessions_for_class(
    p_class_id uuid,
    p_limit    int DEFAULT 50
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid       uuid := auth.uid();
    v_school_id uuid;
    v_is_admin  boolean;
    v_is_teach  boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    SELECT school_id INTO v_school_id
      FROM public.classes WHERE id = p_class_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Class not found' USING ERRCODE = 'P0002';
    END IF;
    v_is_admin := public.is_school_admin(v_school_id);
    v_is_teach := EXISTS (
        SELECT 1 FROM public.enrollments e
         WHERE e.class_id = p_class_id
           AND e.user_id  = v_uid
           AND e.role     = 'teacher'
    );
    IF NOT (v_is_admin OR v_is_teach) THEN
        RAISE EXCEPTION 'Permission denied: must be admin of school or teacher of class'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT row_to_json(t)::jsonb
      FROM public.bridge_list_attendance_sessions_for_class(p_class_id, p_limit) t;
END;
$$;

GRANT EXECUTE ON FUNCTION public.helm_list_attendance_sessions_for_class(uuid, int) TO authenticated;
