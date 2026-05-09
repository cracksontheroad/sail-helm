// ═══════════════════════════════════════════════════════════════════════════
// SAIL Helm — Students service (Phase D pair-route support)
// ─────────────────────────────────────────────────────────────────────────
// Tiny wrapper around `bridge_get_student_in_school`, used by the
// Student parent page to render a meaningful header (name + email +
// role) instead of a bare UUID. SECURITY INVOKER on the backend; RLS
// gates visibility.
//
// Style consistent with services/timeline.js + services/behaviour.js:
//   * Throw on error.
//   * Named exports.
//   * RPC-only.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

/**
 * Fetch one student's identity within a school.
 *
 * @param {{ studentId: string, schoolId: string }} args
 * @returns {Promise<{ userId, fullName, email, role, joinedAt } | null>}
 *   Returns null when the student isn't visible to the caller (RLS)
 *   or simply isn't a member of the school. The caller renders an
 *   empty-state header in that case.
 */
export async function getStudentInSchool({ studentId, schoolId } = {}) {
    if (!studentId) throw new Error('studentId is required')
    if (!schoolId)  throw new Error('schoolId is required')
    const { data, error } = await supabase.rpc('bridge_get_student_in_school', {
        p_student_user_id: studentId,
        p_school_id:       schoolId,
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    if (!row) return null
    return {
        userId:    row.user_id,
        fullName:  row.full_name,
        email:     row.email,
        role:      row.role,
        joinedAt:  row.joined_at,
    }
}
