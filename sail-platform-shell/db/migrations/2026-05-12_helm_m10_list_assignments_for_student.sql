-- ─────────────────────────────────────────────────────────────────────────────
-- Helm M10 — student-facing cross-class assignments view.
--
-- Stage 3 Helm rebuild, 2026-05-12.
--
-- Status: APPLIED to gidyonbzxjorrgpicctt on 2026-05-12 (Supabase migration
--         name: helm_list_assignments_for_student).
--
-- Why this exists: the /my-assignments page (PR B) needs a single query
-- that returns the assignments distributed to the calling student,
-- joined with class name and the student's own submission state. The
-- two Bridge functions that exist (`bridge_list_assignments` school-
-- scoped, `bridge_list_my_assignment_rows` student-scoped) give us the
-- pieces but not the join, and a client-side join would mean two
-- round-trips per page load.
--
-- Mirrors M9's auth pattern exactly (SECDEF + STABLE + search_path =
-- public,auth + auth.uid() guard at top raising 42501 on missing/wrong
-- identity). Body is a new implementation (M8-style) because no single
-- Bridge function returns the joined shape, but the security pattern
-- is identical to M9. No Bridge function is modified.
--
-- Row filter is `sa.student_id = auth.uid()` — admits ONLY the
-- caller's own student_assignments. Cross-student access structurally
-- impossible. No role gate at the DB layer: a teacher who somehow
-- reaches this RPC only sees their own student_assignments rows from
-- some prior life as a student (rare but possible in long-lived test
-- fixtures). The /my-assignments route is gated on CAN.viewOwnAssignments
-- (student-only) at the UI, which is the practical guard.
--
-- Idempotent: CREATE OR REPLACE FUNCTION makes re-apply a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.helm_list_assignments_for_student()
RETURNS TABLE (
    student_assignment_id uuid,
    assignment_id         uuid,
    class_id              uuid,
    class_name            text,
    title                 text,
    description           text,
    due_date              timestamp without time zone,
    my_status             text,
    my_submission_text    text,
    my_submitted_at       timestamp without time zone,
    created_at            timestamp without time zone
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

    RETURN QUERY
    SELECT
        sa.id            AS student_assignment_id,
        a.id             AS assignment_id,
        a.class_id,
        c.name           AS class_name,
        a.title,
        a.description,
        a.due_date,
        sa.status        AS my_status,
        sa.content       AS my_submission_text,
        sa.created_at    AS my_submitted_at,
        a.created_at
    FROM       public.student_assignments sa
    JOIN       public.assignments a ON a.id = sa.assignment_id
    JOIN       public.classes      c ON c.id = a.class_id
    WHERE      sa.student_id = v_uid
    ORDER BY   a.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.helm_list_assignments_for_student() TO authenticated;
