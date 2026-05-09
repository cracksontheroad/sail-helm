// ═══════════════════════════════════════════════════════════════════════════
// SAIL Helm — Behaviour service (Phase A)
// ─────────────────────────────────────────────────────────────────────────
// Thin wrappers around two SAIL-core RPCs:
//
//   * logBehaviourEvent({ studentUserId, classId, type, note })
//       → bridge_log_behaviour_event(p_student_user_id, p_class_id, p_type, p_note)
//       Returns the inserted event row (camelCase).
//
//   * listBehaviourForStudent({ studentUserId, limit, offset })
//       → bridge_list_behaviour_for_student(p_student_user_id, p_limit, p_offset)
//       Returns recent events joined with class_name + logger
//       identity. SECURITY INVOKER on the backend; RLS does the
//       gating.
//
// Style — matches services/attendance.js:
//   * Throw on error.
//   * Named exports.
//   * RPC-only (no `supabase.from(...)` calls anywhere).
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

/**
 * Log a single behaviour event for a student.
 *
 * @param {{
 *   studentUserId: string,
 *   classId?: string|null,    // optional — when absent, the RPC derives
 *                             // school_id from a school where both the
 *                             // caller and student are members.
 *   type: 'positive'|'negative'|'note',
 *   note?: string|null
 * }} args
 * @returns {Promise<{ id, studentUserId, classId, schoolId, type, note, createdBy, createdAt }>}
 */
export async function logBehaviourEvent({ studentUserId, classId = null, type, note = null } = {}) {
    if (!studentUserId) throw new Error('studentUserId is required')
    if (!type)          throw new Error('type is required')
    const { data, error } = await supabase.rpc('bridge_log_behaviour_event', {
        p_student_user_id: studentUserId,
        p_class_id:        classId,
        p_type:            type,
        p_note:            note,
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    if (!row) throw new Error('bridge_log_behaviour_event returned no row')
    return {
        id:              row.id,
        studentUserId:   row.student_user_id,
        classId:         row.class_id,
        schoolId:        row.school_id,
        type:            row.type,
        note:            row.note,
        createdBy:       row.created_by,
        createdAt:       row.created_at,
    }
}

/**
 * Phase D — quick "Resolve" action from the StudentTimeline
 * behaviour row. Flips a single open behaviour event's
 * `status` to 'resolved' and records the actor via the audit
 * trail. Idempotent in shape (re-resolving an already-resolved
 * row is a no-op against the CHECK constraint), so a stale-
 * cache replay from the UI is safe.
 *
 * Permission gate matches bridge_log_behaviour_event:
 * `is_staff_of_school OR has_permission('manage_behaviour')`.
 * Anyone who can record behaviour can resolve it.
 *
 * @param {{ eventId: string }} args
 * @returns {Promise<{ behaviour_event_id, school_id, student_user_id, status }>}
 */
export async function resolveBehaviourEvent({ eventId } = {}) {
    if (!eventId) throw new Error('eventId is required')
    const { data, error } = await supabase.rpc('bridge_resolve_behaviour_event', {
        p_event_id: eventId,
    })
    if (error) throw error
    return data
}

/**
 * List recent behaviour events for one student. Returns events
 * ordered newest-first, joined with class_name + the logger's name +
 * email so the UI can render rows without extra round-trips.
 *
 * @param {{ studentUserId: string, limit?: number, offset?: number }} args
 * @returns {Promise<Array<{ id, studentUserId, classId, schoolId, type, note,
 *                           createdBy, createdAt, className, loggerName, loggerEmail }>>}
 */
export async function listBehaviourForStudent({ studentUserId, limit = 20, offset = 0 } = {}) {
    if (!studentUserId) throw new Error('studentUserId is required')
    const { data, error } = await supabase.rpc('bridge_list_behaviour_for_student', {
        p_student_user_id: studentUserId,
        p_limit:           limit,
        p_offset:          offset,
    })
    if (error) throw error
    return (data || []).map((r) => ({
        id:            r.id,
        studentUserId: r.student_user_id,
        classId:       r.class_id,
        schoolId:      r.school_id,
        type:          r.type,
        note:          r.note,
        createdBy:     r.created_by,
        createdAt:     r.created_at,
        className:     r.class_name,
        loggerName:    r.logger_name,
        loggerEmail:   r.logger_email,
    }))
}
