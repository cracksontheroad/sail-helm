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
     * Student-facing cross-class listing. Returns one row per
     * assignment distributed to the calling student, joined with
     * class name and the student's own submission state.
     *
     * Wraps `helm_list_assignments_for_student` (migration M10) which
     * applies the SECDEF lift needed to do the assignments x classes
     * x student_assignments join safely from an authenticated client.
     * Row filter is `sa.student_id = auth.uid()` server-side — cross-
     * student access is structurally impossible. Empty array is the
     * "no assignments distributed yet" state and is a real state for
     * a brand-new student.
     *
     * Row shape: { student_assignment_id, assignment_id, class_id,
     * class_name, title, description, due_date, my_status,
     * my_submission_text, my_submitted_at, created_at }.
     */
    listForStudent: () =>
        supabase.rpc('helm_list_assignments_for_student'),

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

// ─── Copilot ──────────────────────────────────────────────────────────────
//
// AI-orchestration surface. The risk model is deterministic and lives
// server-side; the UI just renders suggestions and emits a paired audit
// row. CARVE-OUT: these are Bridge-direct calls (`bridge_copilot_*` is
// already SECDEF). Helm does NOT wrap them.
//
// Bootstrap (PR 0): wires `reviewStruggling` + `recordRead` + the
// `newRequestId` pure helper. PR A will consume these from the
// `/copilot/review-struggling` page. The Copilot prototype's design
// constraints (deterministic risk scoring, first-name + last-initial
// PII discipline, fire-and-forget audit) carry over.

export const copilot = {
    /**
     * (Bridge direct) Generate deterministic at-risk-student suggestions
     * for a class. Risk band ∈ {high, medium, low}; recommended_action ∈
     * {invite_to_review, suggest_reteaching, assign_drill, none}.
     * Caller must be a teacher of the class or hold copilot.read.
     * @param {object} args
     * @param {string} args.schoolId
     * @param {string} args.classId
     * @param {number} [args.windowDays=14]  1..90
     * @param {number} [args.threshold=0.6]  0.0..1.0 — ceil(threshold*3)
     *                                       is the min signal count to surface.
     */
    reviewStruggling: ({ schoolId, classId, windowDays = 14, threshold = 0.6 }) =>
        supabase.rpc('bridge_copilot_review_struggling', {
            p_school_id:   schoolId,
            p_class_id:    classId,
            p_window_days: windowDays,
            p_threshold:   threshold,
        }),

    /**
     * (Bridge direct) Audit-log a copilot read event. Same `requestId`
     * as the paired `reviewStruggling` call so analysts can JOIN
     * ai_requests ↔ audit_logs. Caller MUST treat failures as
     * non-fatal — a stuck audit RPC must never block the workflow.
     * @param {object} args
     * @param {string} args.intentKey                e.g. 'review_struggling_students'
     * @param {string} args.requestId                uuid; reuse the suggestions call's id
     * @param {string} args.schoolId
     * @param {string} args.targetClassId
     * @param {string[]} args.targetStudentIds       uuids
     */
    recordRead: ({ intentKey, requestId, schoolId, targetClassId, targetStudentIds }) =>
        supabase.rpc('bridge_record_copilot_read', {
            p_intent_key:         intentKey,
            p_request_id:         requestId,
            p_school_id:          schoolId,
            p_target_class_id:    targetClassId,
            p_target_student_ids: targetStudentIds,
        }),

    /**
     * (Bridge direct, composes two RPCs) Act on an accepted Copilot
     * suggestion: create an assignment and distribute it to a
     * specific list of students (NOT the whole class). Returns
     * `{ assignment, distributedCount }`.
     *
     * Why this isn't `api.assignments.create` + `.distribute`:
     *   - `api.assignments.create` calls `create_assignment` (Helm
     *     wrapper); this flow needs `bridge_create_assignment` which
     *     accepts `p_request_id` so the per-transaction GUC
     *     `app.copilot_request_id` propagates into the resulting
     *     `assignment.created` audit row.
     *   - `api.assignments.distribute` distributes to ALL enrolled
     *     students. This flow needs TARGETED distribution to a
     *     specific student-id list (typically one student per
     *     accepted Copilot card).
     * The request_id propagation makes the Copilot ↔ assignment
     * audit JOIN deterministic on a single uuid.
     *
     * @param {object} args
     * @param {string} args.classId
     * @param {string} args.title
     * @param {string|null} args.description
     * @param {string[]} args.studentIds          non-empty
     * @param {string|null} [args.requestId=null] uuid reused from the
     *                                            suggestions call's request_id
     * @returns {Promise<{ assignment: object, distributedCount: number }>}
     */
    createTargetedAssignment: async ({ classId, title, description, studentIds, requestId = null }) => {
        if (!classId)                throw new Error('classId is required')
        if (!title || !title.trim()) throw new Error('title is required')
        if (!Array.isArray(studentIds) || studentIds.length === 0) {
            throw new Error('studentIds must be a non-empty array')
        }

        const { data: createRows, error: createErr } = await supabase.rpc(
            'bridge_create_assignment',
            {
                p_class_id:    classId,
                p_title:       title,
                p_description: description || null,
                p_request_id:  requestId,
            },
        )
        if (createErr) throw createErr
        const created = Array.isArray(createRows) ? createRows[0] : createRows
        if (!created || !created.id) {
            throw new Error('bridge_create_assignment returned no row')
        }

        const { data: insertedCount, error: distErr } = await supabase.rpc(
            'bridge_distribute_assignment',
            {
                p_assignment_id: created.id,
                p_student_ids:   studentIds,
                p_request_id:    requestId,
            },
        )
        if (distErr) throw distErr

        return { assignment: created, distributedCount: insertedCount }
    },

    /**
     * Generate a fresh request_id for a single Copilot run. Pure helper;
     * not a network call. Same uuid is reused by both the suggestions
     * call and the audit row.
     */
    newRequestId: () => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID()
        }
        // Defensive fallback for non-browser test environments without
        // a crypto polyfill. Real browsers all have crypto.randomUUID.
        return '00000000-0000-0000-0000-' + Date.now().toString(16).padStart(12, '0')
    },
}

// ─── Behaviour ────────────────────────────────────────────────────────────
//
// Behaviour-events surface (Phase 6A-derived, ported in PR C). Three
// methods: log a new event, resolve an existing event, and list one
// student's recent events.
//
// CARVE-OUT (writes): `bridge_log_behaviour_event` and
// `bridge_resolve_behaviour_event` are SECDEF on the Bridge side and
// are called directly — Helm does not wrap them.
//
// READ wrapped (M11): `helm_list_behaviour_for_student` is the Helm
// SECDEF wrapper around `bridge_list_behaviour_for_student` (which is
// SECURITY INVOKER + joins auth.users → "permission denied for table
// users" for an authenticated client). M11 re-checks permission
// (self / school-admin / teacher-of-class-with-student) and adds the
// `status` column (the Bridge function omits it) so the UI can render
// resolved vs open without a separate refetch.

export const behaviour = {
    /**
     * (Bridge direct) Log a new behaviour event for a student in a
     * class. Staff-only at the DB layer.
     * @param {object} args
     * @param {string} args.studentUserId
     * @param {string} args.classId
     * @param {string} args.type     'positive' | 'negative' | 'note'
     * @param {string} args.note     free text; nullable in the DB
     * @param {object|null} [args.context]  jsonb audit context
     */
    log: ({ studentUserId, classId, type, note, context = null }) =>
        supabase.rpc('bridge_log_behaviour_event', {
            p_student_user_id: studentUserId,
            p_class_id:        classId,
            p_type:            type,
            p_note:            note,
            p_context:         context,
        }),

    /**
     * (Bridge direct) Mark a behaviour event as resolved. Staff-only
     * at the DB layer; the RPC sets `behaviour_events.status = 'resolved'`
     * and emits a paired audit row. Returns jsonb
     * `{ behaviour_event_id, school_id, student_user_id, status: 'resolved' }`.
     * @param {string} eventId
     */
    resolve: (eventId) =>
        supabase.rpc('bridge_resolve_behaviour_event', { p_event_id: eventId }),

    /**
     * (Helm SECDEF wrapper, M11) List a student's recent behaviour
     * events. Includes `status` (Bridge omits it). Permission
     * re-checked server-side: caller is the student themselves OR
     * admin of their school OR teacher of a class they are enrolled in.
     * @param {object} args
     * @param {string} args.studentUserId
     * @param {number} [args.limit=20]
     * @param {number} [args.offset=0]
     *
     * Row shape: { id, student_user_id, class_id, school_id, type,
     * note, status, created_by, created_at, class_name, logger_name,
     * logger_email }.
     */
    listForStudent: ({ studentUserId, limit = 20, offset = 0 }) =>
        supabase.rpc('helm_list_behaviour_for_student', {
            p_student_user_id: studentUserId,
            p_limit:           limit,
            p_offset:          offset,
        }),
}

// ─── Timeline ─────────────────────────────────────────────────────────────
//
// STUB (PR 0 only — populated by PR D).
//
// Will wrap `bridge_get_student_timeline` (currently SECURITY INVOKER —
// needs a Helm SECDEF wrapper, migration M11, before this can be safely
// called from an authenticated student client). The timeline UI also
// uses `resolvePrimaryAction.js` + `timelineTelemetry.js` (ports from
// the copilot prototype) which sit outside this file.

export const timeline = {
    // Intentionally empty. PR D populates: getForStudent and any
    // companion read-side wrappers added by M11.
}

// ─── Students ─────────────────────────────────────────────────────────────
//
// STUB (PR 0 only — populated by PR D).
//
// Will wrap a minimal student-detail read (currently `getStudentInSchool`
// in the copilot prototype, RPC name TBD on port).

export const students = {
    // Intentionally empty. PR D populates: get.
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
    copilot,
    behaviour,
    timeline,
    students,
    auth,
}

export default api
