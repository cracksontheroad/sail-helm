-- ─────────────────────────────────────────────────────────────────────────────
-- Helm M12 — Timeline + Student-detail SECDEF wrappers.
--
-- Stage 3 Helm rebuild, 2026-05-12.
--
-- Status: APPLIED to gidyonbzxjorrgpicctt on 2026-05-12 (Supabase migration
--         name: helm_student_timeline_and_detail_wrappers).
--
-- Two thin wrappers (M9-style — no shape changes) around the Bridge
-- read RPCs that the /timeline page needs. Both Bridge functions are
-- SECURITY INVOKER and join auth.users for actor/email enrichment;
-- direct calls from an authenticated client raise
-- `permission denied for table users` (SQLSTATE 42501) — verified by
-- runtime probe as authenticated alice for each.
--
-- M12 is M9-style (thin wrapper) for both because the Bridge return
-- shapes are sufficient for the UI. No JOINs to add, no `status`
-- column to inject. Just permission re-check + delegate. The SECDEF
-- lift makes the inner auth.users joins safe (the inner SECURITY
-- INVOKER function runs as the wrapper's owner — postgres — which
-- has SELECT on auth.users).
--
-- Permission model (same as M11):
--   - Caller is the student themselves              → allow (self-read)
--   - Caller is admin of the student's school       → allow
--   - Caller is a teacher of a class the student
--     is currently enrolled in                      → allow
--   - else 42501
--
-- No Bridge function is modified.
-- Idempotent: CREATE OR REPLACE FUNCTION makes re-apply a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── helm_get_student_timeline ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.helm_get_student_timeline(
    p_student_id uuid,
    p_school_id  uuid,
    p_limit      int         DEFAULT 50,
    p_before_ts  timestamptz DEFAULT NULL
)
RETURNS TABLE (
    type  text,
    ts    timestamptz,
    title text,
    meta  jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid             uuid := auth.uid();
    v_is_self         boolean;
    v_is_school_admin boolean;
    v_is_teacher_of_a_shared_class boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_student_id IS NULL OR p_school_id IS NULL THEN
        RAISE EXCEPTION 'p_student_id and p_school_id are required'
            USING ERRCODE = 'P0001';
    END IF;

    v_is_self         := (v_uid = p_student_id);
    v_is_school_admin := public.is_school_admin(p_school_id);
    v_is_teacher_of_a_shared_class := EXISTS (
        SELECT 1
          FROM public.enrollments e_t
          JOIN public.enrollments e_s ON e_s.class_id = e_t.class_id
         WHERE e_t.user_id = v_uid
           AND e_t.role    = 'teacher'
           AND e_s.user_id = p_student_id
           AND e_s.role    = 'student'
    );

    IF NOT (v_is_self OR v_is_school_admin OR v_is_teacher_of_a_shared_class) THEN
        RAISE EXCEPTION 'Permission denied: must be the student, admin of their school, or teacher of a class they are enrolled in'
            USING ERRCODE = '42501';
    END IF;

    -- Delegate. Bridge already orders by ts DESC server-side; do not
    -- override here. `meta` is opaque to this layer — UI decides what
    -- to render.
    RETURN QUERY
    SELECT t.type, t.ts, t.title, t.meta
      FROM public.bridge_get_student_timeline(p_student_id, p_school_id, p_limit, p_before_ts) t;
END;
$$;

GRANT EXECUTE ON FUNCTION public.helm_get_student_timeline(uuid, uuid, int, timestamptz) TO authenticated;


-- ─── helm_get_student_in_school ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.helm_get_student_in_school(
    p_student_user_id uuid,
    p_school_id       uuid
)
RETURNS TABLE (
    user_id   uuid,
    full_name text,
    email     text,
    role      text,
    joined_at timestamp without time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid             uuid := auth.uid();
    v_is_self         boolean;
    v_is_school_admin boolean;
    v_is_teacher_of_a_shared_class boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_student_user_id IS NULL OR p_school_id IS NULL THEN
        RAISE EXCEPTION 'p_student_user_id and p_school_id are required'
            USING ERRCODE = 'P0001';
    END IF;

    v_is_self         := (v_uid = p_student_user_id);
    v_is_school_admin := public.is_school_admin(p_school_id);
    v_is_teacher_of_a_shared_class := EXISTS (
        SELECT 1
          FROM public.enrollments e_t
          JOIN public.enrollments e_s ON e_s.class_id = e_t.class_id
         WHERE e_t.user_id = v_uid
           AND e_t.role    = 'teacher'
           AND e_s.user_id = p_student_user_id
           AND e_s.role    = 'student'
    );

    IF NOT (v_is_self OR v_is_school_admin OR v_is_teacher_of_a_shared_class) THEN
        RAISE EXCEPTION 'Permission denied: must be the student, admin of their school, or teacher of a class they are enrolled in'
            USING ERRCODE = '42501';
    END IF;

    -- Delegate. Bridge returns at most one row (SQL function uses LIMIT 1).
    RETURN QUERY
    SELECT s.user_id, s.full_name::text, s.email::text, s.role, s.joined_at
      FROM public.bridge_get_student_in_school(p_student_user_id, p_school_id) s;
END;
$$;

GRANT EXECUTE ON FUNCTION public.helm_get_student_in_school(uuid, uuid) TO authenticated;
