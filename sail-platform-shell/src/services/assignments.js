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
 * caller (filtered by RLS — Phase 6B's tightened SELECT policy admits
 * `student_id = effective_user_id()` for student-self-read).
 *
 * Phase 6E: powers the per-assignment status badge ("not submitted" vs
 * "submitted") on /my-assignments. Returning all rows in one query
 * avoids N+1 calls to listSubmissions(assignmentId) per assignment.
 *
 * Direct table query lives in this service so the page never imports
 * supabase — the architectural property the Phase 6D refactor pinned in.
 *
 * @returns {Promise<Array<{id, student_id, assignment_id, status, content,
 *                          submission_hash, created_at}>>}
 */
export async function listMyAssignmentRows() {
    // Resolve the caller via the live session. Cheaper than threading
    // the user.id through every component call.
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr) throw userErr
    const userId = userData?.user?.id
    if (!userId) throw new Error('not authenticated')

    const { data, error } = await supabase
        .from('student_assignments')
        .select('id, student_id, assignment_id, status, content, submission_hash, created_at')
        .eq('student_id', userId)
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
