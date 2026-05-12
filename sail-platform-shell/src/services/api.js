import { supabase } from '../lib/supabaseClient'

/**
 * Helm API client — the only place this app calls Supabase.
 *
 * Every Helm page MUST go through this object. No `supabase.from(...)`,
 * no `supabase.rpc(...)` inside page components. The only legitimate
 * exception is `auth` operations on the `supabase.auth` namespace
 * (sign-in, sign-out, session events) which AuthContext owns.
 *
 * Why this exists:
 *   - Pages only see Helm-named domain operations (`api.classes.create(...)`).
 *   - When an RPC name or shape changes, the diff is contained here.
 *   - Bridge passthroughs (intentional carve-outs) are visible in one
 *     place — they can't sneak into page components.
 *
 * Conventions:
 *   - Each method returns whatever `supabase.rpc(...)` returns:
 *     `{ data, error }`. Pages handle the destructuring.
 *   - Parameter names match the RPC's `p_*` params 1:1; this file
 *     translates JS-friendly camelCase callers into the database's
 *     snake_case parameter names so page code stays idiomatic.
 *
 * Carve-outs (Bridge-direct calls, planner-locked):
 *   - `attendance.createSession`, `attendance.saveRegister`,
 *     `attendance.getSessionForDate`, `attendance.listSessionsForClass`
 *     — Bridge owns the session-anchored attendance model; Helm UI
 *     calls Bridge directly per the M5 spec. The Helm-named
 *     `attendance.listStudentHistory` IS a wrapper (the only one).
 *   - `auth.stopImpersonation` — bridge_stop_impersonation is the
 *     canonical impersonation exit; Helm has no reason to wrap it.
 *   - `auth.getEffectiveProfile` — get_effective_user_profile is the
 *     canonical identity resolver; not a domain RPC but a session
 *     primitive.
 */

// ─── Schools ──────────────────────────────────────────────────────────────

export const schools = {
    /**
     * Create a new school. The caller is auto-added as 'admin'.
     * @param {string} name
     */
    create: (name) =>
        supabase.rpc('create_school_with_owner', { p_school_name: name }),

    /**
     * Fetch a school's metadata. Caller must be a member of the school.
     * @param {string} schoolId
     */
    get: (schoolId) =>
        supabase.rpc('get_school', { p_school_id: schoolId }),

    /**
     * Update the school's name. plan_type and status are preserved.
     * Admin-only at the database level.
     * @param {string} schoolId
     * @param {string} name
     */
    updateSettings: (schoolId, name) =>
        supabase.rpc('update_school_settings', {
            p_school_id: schoolId,
            p_name:      name,
        }),
}

// ─── Members ──────────────────────────────────────────────────────────────

export const members = {
    /**
     * List all members of a school. Returns rows with email + role.
     * @param {string} schoolId
     */
    list: (schoolId) =>
        supabase.rpc('list_school_members', { p_school_id: schoolId }),

    /**
     * Add a user (by email) as a member of the school.
     * The user must already exist in auth.users; the wrapper resolves
     * email → user_id and raises a clear error if not found.
     * @param {string} schoolId
     * @param {string} email
     * @param {string} role  one of 'student' | 'teacher' | 'admin'
     */
    add: (schoolId, email, role) =>
        supabase.rpc('add_school_member', {
            p_school_id: schoolId,
            p_email:     email,
            p_role:      role,
        }),

    /**
     * Change an existing member's role. The member_id resolves to the
     * school the member belongs to; cross-school mutation is impossible
     * because Bridge checks the caller's permission against THAT school.
     * @param {string} memberId
     * @param {string} role
     */
    updateRole: (memberId, role) =>
        supabase.rpc('update_school_member_role', {
            p_member_id: memberId,
            p_role:      role,
        }),
}

// ─── Classes ──────────────────────────────────────────────────────────────

export const classes = {
    /**
     * List classes the caller can see in this school. Admin: all
     * active. Teacher: own. Student: enrolled. Filtered to status=active.
     * @param {string} schoolId
     */
    list: (schoolId) =>
        supabase.rpc('list_school_classes', { p_school_id: schoolId }),

    /**
     * Create a class. The named teacher is auto-enrolled as 'teacher'
     * via the dual-write contract.
     * @param {string} schoolId
     * @param {string} name
     * @param {string|null} subject
     * @param {string} teacherUserId
     */
    create: (schoolId, name, subject, teacherUserId) =>
        supabase.rpc('create_class', {
            p_school_id:        schoolId,
            p_name:             name,
            p_subject:          subject,
            p_teacher_user_id:  teacherUserId,
        }),

    /**
     * Update name / subject / teacher. Teacher reassignment is admin-only.
     * Pass `null` for fields you don't want to change.
     * @param {string} classId
     * @param {string} name
     * @param {string|null} subject
     * @param {string|null} teacherUserId
     */
    update: (classId, name, subject, teacherUserId) =>
        supabase.rpc('update_class', {
            p_class_id:        classId,
            p_name:            name,
            p_subject:         subject,
            p_teacher_user_id: teacherUserId,
        }),

    /**
     * Soft-delete a class. Admin-only.
     * @param {string} classId
     */
    archive: (classId) =>
        supabase.rpc('archive_class', { p_class_id: classId }),

    /**
     * List members enrolled in a class (teachers + students).
     * Admin-of-school OR teacher-of-class only.
     * @param {string} classId
     */
    listEnrollments: (classId) =>
        supabase.rpc('list_class_enrollments', { p_class_id: classId }),

    /**
     * Enroll a student in a class.
     * Admin-of-school OR teacher-of-class only.
     * @param {string} classId
     * @param {string} userId
     */
    enrollStudent: (classId, userId) =>
        supabase.rpc('enroll_student_in_class', {
            p_class_id: classId,
            p_user_id:  userId,
        }),

    /**
     * Remove a student from a class.
     * Admin-of-school OR teacher-of-class only.
     * @param {string} classId
     * @param {string} userId
     */
    unenrollStudent: (classId, userId) =>
        supabase.rpc('unenroll_student_from_class', {
            p_class_id: classId,
            p_user_id:  userId,
        }),
}

// ─── Assignments ──────────────────────────────────────────────────────────

export const assignments = {
    /**
     * Role-aware listing. Staff: all + counts. Student: only those
     * distributed to them + their status.
     * @param {string} classId
     */
    list: (classId) =>
        supabase.rpc('list_class_assignments', { p_class_id: classId }),

    /**
     * Create assignment. Admin-of-school OR teacher-of-class.
     * @param {string} classId
     * @param {string} title
     * @param {string|null} description
     * @param {string|null} dueDate  ISO timestamp string or null
     * @param {object|null} rubric   jsonb
     */
    create: (classId, title, description, dueDate, rubric) =>
        supabase.rpc('create_assignment', {
            p_class_id:    classId,
            p_title:       title,
            p_description: description,
            p_due_date:    dueDate,
            p_rubric:      rubric,
        }),

    update: (assignmentId, title, description, dueDate, rubric) =>
        supabase.rpc('update_assignment', {
            p_assignment_id: assignmentId,
            p_title:         title,
            p_description:   description,
            p_due_date:      dueDate,
            p_rubric:        rubric,
        }),

    /**
     * Hard delete with cascade to student_assignments.
     * Admin-of-school OR teacher-of-class.
     * @param {string} assignmentId
     */
    delete: (assignmentId) =>
        supabase.rpc('delete_assignment', { p_assignment_id: assignmentId }),

    /**
     * Distribute to all currently-enrolled students. Sources from
     * `enrollments` table; fails loudly if zero enrolled students.
     * Returns `{ data: insertedCount }`.
     * @param {string} assignmentId
     */
    distribute: (assignmentId) =>
        supabase.rpc('distribute_assignment', { p_assignment_id: assignmentId }),

    /**
     * Student submits. Wrapper verifies enrollment in the assignment's
     * class via `enrollments` (not school_members).
     * @param {string} assignmentId
     * @param {string} submissionText
     */
    submit: (assignmentId, submissionText) =>
        supabase.rpc('submit_assignment', {
            p_assignment_id:   assignmentId,
            p_submission_text: submissionText,
        }),

    /**
     * Gradebook view. Staff: all submissions with student detail.
     * Student: own row only, AND only if status='graded'.
     * @param {string} assignmentId
     */
    listSubmissions: (assignmentId) =>
        supabase.rpc('list_assignment_submissions', {
            p_assignment_id: assignmentId,
        }),

    /**
     * Grade or re-grade a submission. Admin-of-school OR teacher-of-class.
     * Audit records previous_grade for history.
     * @param {string} studentAssignmentId
     * @param {string} grade
     * @param {string|null} feedback
     */
    grade: (studentAssignmentId, grade, feedback) =>
        supabase.rpc('grade_submission', {
            p_student_assignment_id: studentAssignmentId,
            p_grade:                 grade,
            p_feedback:              feedback,
        }),
}

// ─── Attendance ────────────────────────────────────────────────────────────
//
// CARVE-OUT — staff-side attendance WRITE paths intentionally call
// Bridge directly. Per the M5 reconciliation spec, Helm does NOT wrap
// the session-anchored attendance model for writes
// (`bridge_create_attendance_session`, `bridge_save_attendance_register`
//  are SECDEF and authenticated-safe).
//
// READ paths go through Helm SECDEF wrappers (M9) because the Bridge
// read RPCs are SECURITY INVOKER and join `auth.users` directly,
// raising `permission denied for table users` for authenticated callers.
// The wrappers re-check permission (admin-of-school OR teacher-of-class)
// and delegate to the Bridge function under elevated privilege.

export const attendance = {
    /**
     * (Bridge direct) Create or fetch an attendance session for a
     * (class, date) pair. Returns the session row + `is_new` flag.
     * Staff-only at the database level.
     * @param {string} classId
     * @param {string} sessionDate  YYYY-MM-DD
     * @param {object} context      jsonb audit context, can be {}
     */
    createSession: (classId, sessionDate, context = {}) =>
        supabase.rpc('bridge_create_attendance_session', {
            p_class_id:     classId,
            p_session_date: sessionDate,
            p_context:      context,
        }),

    /**
     * (Bridge direct) Save the full register for a session. Records is
     * an array of `{ student_user_id, status }`. ON CONFLICT upsert.
     * Returns an aggregate count summary.
     * @param {string} sessionId
     * @param {Array}  records
     * @param {object} context  jsonb audit context
     */
    saveRegister: (sessionId, records, context = {}) =>
        supabase.rpc('bridge_save_attendance_register', {
            p_attendance_session_id: sessionId,
            p_records:               records,
            p_context:               context,
        }),

    /**
     * (Helm SECDEF wrapper, M9) Get the session and its records for a
     * given date. Returns jsonb — the UI parses.
     * @param {string} classId
     * @param {string} sessionDate
     */
    getSessionForDate: (classId, sessionDate) =>
        supabase.rpc('helm_get_attendance_session_for_date', {
            p_class_id:     classId,
            p_session_date: sessionDate,
        }),

    /**
     * (Helm SECDEF wrapper, M9) Past session history for a class with
     * per-session present/absent/late counts.
     * @param {string} classId
     * @param {number} limit
     */
    listSessionsForClass: (classId, limit = 50) =>
        supabase.rpc('helm_list_attendance_sessions_for_class', {
            p_class_id: classId,
            p_limit:    limit,
        }),

    /**
     * (Helm) Student's own attendance history for a class. The only
     * Helm-named attendance RPC. Enforces enrollment via `enrollments`
     * (not school_members). Cross-student access structurally impossible.
     * @param {string} classId
     */
    listStudentHistory: (classId) =>
        supabase.rpc('list_student_attendance', { p_class_id: classId }),
}

// ─── Auth (session primitives) ────────────────────────────────────────────
//
// CARVE-OUT — these aren't domain RPCs, they're session primitives.
// AuthContext.jsx owns this surface.

export const auth = {
    /**
     * Canonical lens-aware identity resolver (used by AuthContext).
     * Returns { user_id, email, role, school_id, is_impersonating,
     * real_user_id, real_user_email }.
     */
    getEffectiveProfile: () =>
        supabase.rpc('get_effective_user_profile'),

    /**
     * (Bridge direct) Audit-log the impersonation exit. Called by the
     * banner exit button in App.jsx.
     * @param {string|null} targetUserId
     * @param {string|null} sessionId
     */
    stopImpersonation: (targetUserId, sessionId) =>
        supabase.rpc('bridge_stop_impersonation', {
            p_target_user_id: targetUserId,
            p_session_id:     sessionId,
        }),
}

// ─── Default export — composite API surface ───────────────────────────────

const api = {
    schools,
    members,
    classes,
    assignments,
    attendance,
    auth,
}

export default api
