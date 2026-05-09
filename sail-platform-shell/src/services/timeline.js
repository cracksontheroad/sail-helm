// ═══════════════════════════════════════════════════════════════════════════
// SAIL Helm — Student timeline service (Phase D)
// ─────────────────────────────────────────────────────────────────────────
// Thin wrapper around the SAIL-core RPC `bridge_get_student_timeline`,
// which UNIONs attendance / behaviour / assignment events for a single
// student into one time-ordered feed. Read-only.
//
// Output shape (locked spec):
//   { type, ts, title, meta }
// where type ∈ ('attendance', 'behaviour',
// 'assignment_assigned', 'assignment_graded'). Titles are
// human-readable strings generated server-side; meta carries
// minimal context (status, note, class_id, etc.) for icon and
// subtext rendering.
//
// Style — matches services/attendance.js + services/behaviour.js:
//   * Throw on error.
//   * Named exports.
//   * RPC-only (no `supabase.from(...)` calls).
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

/**
 * Fetch the unified timeline for one student.
 *
 * @param {{
 *   studentId: string,
 *   schoolId: string,
 *   limit?: number,
 *   beforeTs?: string|null   // ISO 8601; cursor for the next page.
 *                            //   null   → fetch the newest page.
 *                            //   string → fetch events strictly older
 *                            //            than this timestamp.
 * }} args
 *   schoolId required because the RPC validates student-school membership
 *   and prevents cross-tenant disclosure.
 * @returns {Promise<Array<{ type: string, ts: string, title: string, meta: object }>>}
 */
export async function getStudentTimeline({ studentId, schoolId, limit = 50, beforeTs = null } = {}) {
    if (!studentId) throw new Error('studentId is required')
    if (!schoolId)  throw new Error('schoolId is required')
    const { data, error } = await supabase.rpc('bridge_get_student_timeline', {
        p_student_id: studentId,
        p_school_id:  schoolId,
        p_limit:      limit,
        p_before_ts:  beforeTs,
    })
    if (error) throw error
    // RPC returns columns named (type, ts, title, meta) — supabase-js
    // surfaces them with those names verbatim. Pass through unchanged
    // so the UI consumes the locked spec shape directly.
    return (data || []).map((r) => ({
        type:  r.type,
        ts:    r.ts,
        title: r.title,
        meta:  r.meta || {},
    }))
}
