-- ─────────────────────────────────────────────────────────────────────────────
-- Helm M11 — student-scoped behaviour events listing with status.
--
-- Stage 3 Helm rebuild, 2026-05-12.
--
-- Status: APPLIED to gidyonbzxjorrgpicctt on 2026-05-12 (Supabase migration
--         name: helm_list_behaviour_for_student_text_cast — final iteration
--         after two minor fixes: ambiguous `school_id` qualifier + explicit
--         ::text casts because auth.users.email is varchar(255)).
--
-- Why this exists: bridge_list_behaviour_for_student is SECURITY INVOKER
-- and joins auth.users for `logger_email`, raising `permission denied
-- for table users` (SQLSTATE 42501) for authenticated callers — verified
-- by direct probe as authenticated alice. Additionally, the Bridge
-- function's return shape OMITS the `behaviour_events.status` column
-- even though the table has it, which is needed by the /behaviour UI
-- to render the resolved vs open distinction after a Resolve action.
--
-- M11 is a new implementation (M10-style) — body queries directly,
-- adds `status` to the projection. Mirrors M9 ONLY on the security
-- pattern: SECDEF + STABLE + search_path = public,auth + auth.uid()
-- guard raising 42501 + permission check + idempotent CREATE OR REPLACE.
-- No Bridge function is modified.
--
-- Permission model:
--   - Caller is the student themselves              → allow (self-read)
--   - Caller is admin of the student's school       → allow
--   - Caller is a teacher of a class the student
--     is currently enrolled in                      → allow
--   - else 42501
--
-- Idempotent: CREATE OR REPLACE FUNCTION makes re-apply a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.helm_list_behaviour_for_student(
    p_student_user_id uuid,
    p_limit           int DEFAULT 20,
    p_offset          int DEFAULT 0
)
RETURNS TABLE (
    id              uuid,
    student_user_id uuid,
    class_id        uuid,
    school_id       uuid,
    type            text,
    note            text,
    status          text,
    created_by      uuid,
    created_at      timestamptz,
    class_name      text,
    logger_name     text,
    logger_email    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid             uuid := auth.uid();
    v_student_school  uuid;
    v_is_self         boolean;
    v_is_school_admin boolean;
    v_is_teacher_of_a_shared_class boolean;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_student_user_id IS NULL THEN
        RAISE EXCEPTION 'p_student_user_id is required' USING ERRCODE = 'P0001';
    END IF;

    -- Locate the student's school. Qualified `sm.school_id` because
    -- the RETURNS TABLE has a column named `school_id` too.
    SELECT sm.school_id INTO v_student_school
      FROM public.school_members sm
     WHERE sm.user_id = p_student_user_id
       AND sm.role    = 'student'
     LIMIT 1;
    IF v_student_school IS NULL THEN
        RAISE EXCEPTION 'Student % not found in any school', p_student_user_id
            USING ERRCODE = 'P0002';
    END IF;

    v_is_self         := (v_uid = p_student_user_id);
    v_is_school_admin := public.is_school_admin(v_student_school);
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

    RETURN QUERY
    SELECT
        e.id,
        e.student_user_id,
        e.class_id,
        e.school_id,
        e.type,
        e.note,
        e.status,
        e.created_by,
        e.created_at,
        c.name::text AS class_name,
        COALESCE(
            NULLIF(TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')), ''),
            au.email::text
        )::text       AS logger_name,
        au.email::text AS logger_email
      FROM public.behaviour_events e
      LEFT JOIN public.classes  c  ON c.id  = e.class_id
      LEFT JOIN public.profiles p  ON p.id  = e.created_by
      LEFT JOIN auth.users      au ON au.id = e.created_by
     WHERE e.student_user_id = p_student_user_id
     ORDER BY e.created_at DESC
     LIMIT  GREATEST(LEAST(COALESCE(p_limit, 20), 100), 1)
     OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.helm_list_behaviour_for_student(uuid, int, int) TO authenticated;
