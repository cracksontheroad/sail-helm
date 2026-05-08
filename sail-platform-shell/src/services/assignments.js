// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Assignments Service — Helm-side
// ─────────────────────────────────────────────────────────────────────────────
// Phase 6D — Helm-local wrapper around the Bridge backend RPCs:
//
//   * listAssignmentsByClass(classId) → bridge_list_assignments(p_class_id)
//     Phase 6D extended bridge_list_assignments to accept either p_school_id
//     or p_class_id (mutually exclusive). Helm only ever uses class-scope
//     since the teacher pages all key off classId.
//
//   * createAssignment({ classId, title, description })
//     → bridge_create_assignment(p_class_id, p_title, p_description)
//     Phase 6C signature: takes class_id directly (no more "first class for
//     school" hack). Backend gates on is_staff_of_school OR assignments.write.
//
//   * listSubmissions(assignmentId) → bridge_list_submissions(p_assignment_id)
//     Phase 6B. SECURITY INVOKER so RLS fires for the caller — student sees
//     only own; staff sees school's; platform sees via assignments.read.
//
// Style — matches services/ai.js's house pattern:
//   * Throw on error. Each function returns the data directly (or throws).
//   * Named exports. No object-of-methods.
//   * No client-side fallback paths. Errors propagate so callers can handle
//     (e.g., the page renders an inline error block).
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

/**
 * List all assignments belonging to a single class.
 * @param {string} classId
 * @returns {Promise<Array<{id, class_id, class_name, title, description,
 *                          due_date, created_by, created_at}>>}
 */
export async function listAssignmentsByClass(classId) {
    if (!classId) throw new Error('classId is required')
    const { data, error } = await supabase.rpc('bridge_list_assignments', {
        p_class_id: classId,
    })
    if (error) throw error
    return data || []
}

/**
 * Create an assignment under the specified class.
 * Backend gates on is_staff_of_school(class.school_id) OR
 * has_permission('assignments.write'). Audit row is emitted by the
 * AFTER INSERT trigger — no explicit log call needed.
 *
 * @param {{classId: string, title: string, description?: string|null}} args
 * @returns {Promise<{id, class_id, title, description, created_by, created_at}>}
 */
export async function createAssignment({ classId, title, description = null } = {}) {
    if (!classId) throw new Error('classId is required')
    if (!title || !title.trim()) throw new Error('title is required')
    const { data, error } = await supabase.rpc('bridge_create_assignment', {
        p_class_id:    classId,
        p_title:       title.trim(),
        p_description: description ? String(description).trim() || null : null,
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] : data
}

/**
 * List submissions for an assignment. Visibility filtered by RLS:
 *   * student → only their own row
 *   * teacher / school admin → all rows in their school
 *   * platform reader (assignments.read) → all rows
 * @param {string} assignmentId
 * @returns {Promise<Array<{id, student_id, student_name, status, content,
 *                          submission_hash, created_at}>>}
 */
export async function listSubmissions(assignmentId) {
    if (!assignmentId) throw new Error('assignmentId is required')
    const { data, error } = await supabase.rpc('bridge_list_submissions', {
        p_assignment_id: assignmentId,
    })
    if (error) throw error
    return data || []
}

/**
 * List every assignment in a school (joined with class_name). Phase 6E
 * student surface: students view assignments across all classes in
 * their school, since they don't pick a class first.
 *
 * Same RPC as Phase 6D (Helm Class.jsx uses class-scope; this uses
 * school-scope — the Phase 6A original semantic, preserved verbatim
 * by the 6D extension).
 *
 * @param {string} schoolId
 * @returns {Promise<Array<{id, class_id, class_name, title, description,
 *                          due_date, created_by, created_at}>>}
 */
export async function listAssignmentsBySchool(schoolId) {
    if (!schoolId) throw new Error('schoolId is required')
    const { data, error } = await supabase.rpc('bridge_list_assignments', {
        p_school_id: schoolId,
    })
    if (error) throw error
    return data || []
}

/**
 * List every student_assignments row owned by the current authenticated
 * caller. Powers the per-assignment status badge ("not submitted" vs
 * "submitted") on /my-assignments. Returning all rows in one round-trip
 * avoids N+1 calls to listSubmissions(assignmentId) per assignment.
 *
 * Phase B27.1 (read-path consolidation, 2026-05-08): switched from a
 * `from('student_assignments').select(...).eq('student_id', userId)`
 * direct-table read (which required a separate `supabase.auth.getUser()`
 * round-trip to resolve the caller) to the
 * `bridge_list_my_assignment_rows()` RPC. The RPC filters server-side
 * via `WHERE student_id = effective_user_id()`, which:
 *   * uses one round-trip instead of two (no auth.getUser preamble)
 *   * honors the impersonation lens correctly (a Bridge admin viewing
 *     as a student sees that student's rows, not the admin's)
 *   * matches the Bridge architectural pattern: Helm reaches for
 *     `bridge_*` RPCs only, never `supabase.from(...)` directly.
 *
 * @returns {Promise<Array<{id, student_id, assignment_id, status, content,
 *                          submission_hash, created_at}>>}
 */
export async function listMyAssignmentRows() {
    const { data, error } = await supabase.rpc('bridge_list_my_assignment_rows')
    if (error) throw error
    return data || []
}

/**
 * Submit work for an assignment. Phase 6B RPC body handles three paths:
 *   * existing 'assigned' row from teacher distribution → UPDATE in place
 *     (status → 'submitted', content + submission_hash set)
 *   * no existing row → INSERT a new one with status='submitted'
 *   * existing 'submitted' or 'graded' row → P0001 'already submitted'
 *
 * Audit emission via the AFTER trigger:
 *   INSERT path → student_assignment.created
 *   UPDATE path → student_assignment.updated (with status + submission_hash diff)
 *
 * @param {{assignmentId: string, content: string}} args
 * @returns {Promise<{id, assignment_id, student_id, status, content, created_at}>}
 */
export async function submitAssignment({ assignmentId, content } = {}) {
    if (!assignmentId) throw new Error('assignmentId is required')
    if (!content || !content.trim()) throw new Error('content is required')
    const { data, error } = await supabase.rpc('bridge_submit_assignment', {
        p_assignment_id: assignmentId,
        p_content:       content.trim(),
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] : data
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase B27.2 — write-path consolidation (2026-05-08)
//
// Four new RPC wrappers replace the last direct supabase.from(...).insert/.update
// sites in pages/Assignments.jsx. Each underlying RPC:
//   * SECURITY DEFINER + locked search_path
//   * Permission gate: is_staff_of_school(class.school_id) OR
//     has_permission('assignments.write')
//   * Refuses during impersonation
//   * Sets app.audit_context with surface='helm.assignments' so the
//     AFTER trigger's audit row picks up surface metadata
//   * Emits a higher-level "semantic" audit row from the RPC body
//     (assignment.distributed / submission.received / submission.graded /
//     submission.ai_graded) IN ADDITION to the trigger's per-row
//     student_assignment.* event. Both granularities are queryable.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bulk-distribute an assignment to a list of students. Idempotent —
 * pre-existing (assignment_id, student_id) pairs are skipped via
 * NOT EXISTS, so re-clicking "Assign to All" is safe (returns 0
 * inserted but the assignment.distributed audit row is still emitted
 * for the operator's intent).
 *
 * @param {{assignmentId: string, studentIds: string[]}} args
 * @returns {Promise<number>} count of newly-inserted rows
 */
export async function distributeAssignment({ assignmentId, studentIds } = {}) {
    if (!assignmentId) throw new Error('assignmentId is required')
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
        throw new Error('studentIds must be a non-empty array')
    }
    const { data, error } = await supabase.rpc('bridge_distribute_assignment', {
        p_assignment_id: assignmentId,
        p_student_ids:   studentIds,
    })
    if (error) throw error
    // RPC returns a scalar integer. supabase-js wraps scalar returns
    // in `data` directly (not an array).
    return typeof data === 'number' ? data : Number(data) || 0
}

/**
 * Teacher-side override: mark a row as 'submitted' without going
 * through the student-self submit flow. Status-only update. Audit:
 * submission.received (semantic) + student_assignment.updated (trigger).
 *
 * @param {string} studentAssignmentId
 * @returns {Promise<{id, assignment_id, student_id, status, ...}>}
 */
export async function markSubmissionReceived(studentAssignmentId) {
    if (!studentAssignmentId) throw new Error('studentAssignmentId is required')
    const { data, error } = await supabase.rpc('bridge_mark_submission_received', {
        p_student_assignment_id: studentAssignmentId,
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] : data
}

/**
 * Record a teacher grade + optional feedback. Sets status='graded'.
 * Audit: submission.graded (semantic, with previous_grade) +
 * student_assignment.updated (trigger, with grade + status diff).
 *
 * @param {{studentAssignmentId: string, grade: string, feedback?: string|null}} args
 * @returns {Promise<{id, ..., grade, status, feedback}>}
 */
export async function gradeSubmission({ studentAssignmentId, grade, feedback = null } = {}) {
    if (!studentAssignmentId) throw new Error('studentAssignmentId is required')
    if (grade == null) throw new Error('grade is required')
    const { data, error } = await supabase.rpc('bridge_grade_submission', {
        p_student_assignment_id: studentAssignmentId,
        p_grade:                 String(grade),
        p_feedback:              feedback,
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] : data
}

/**
 * Record an AI grading result. Distinct from gradeSubmission because
 * it does NOT change status — teacher still has the final say. Stamps
 * ai_graded_at = now() server-side. Audit: submission.ai_graded
 * (semantic) + student_assignment.updated (trigger, with ai_grade +
 * submission_hash diff).
 *
 * @param {{studentAssignmentId: string, aiGrade: string,
 *           feedback: string, submissionHash: string}} args
 * @returns {Promise<{id, ai_grade, feedback, submission_hash, ai_graded_at, ...}>}
 */
export async function recordAiGrade({ studentAssignmentId, aiGrade, feedback, submissionHash } = {}) {
    if (!studentAssignmentId) throw new Error('studentAssignmentId is required')
    if (aiGrade == null) throw new Error('aiGrade is required')
    if (feedback == null) throw new Error('feedback is required')
    if (submissionHash == null) throw new Error('submissionHash is required')
    const { data, error } = await supabase.rpc('bridge_record_ai_grade', {
        p_student_assignment_id: studentAssignmentId,
        p_ai_grade:              String(aiGrade),
        p_ai_feedback:           String(feedback),
        p_submission_hash:       String(submissionHash),
    })
    if (error) throw error
    return Array.isArray(data) ? data[0] : data
}
