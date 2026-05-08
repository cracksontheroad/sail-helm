// ═══════════════════════════════════════════════════════════════════════════
// SAIL Helm — Attendance service (Phase A)
// ─────────────────────────────────────────────────────────────────────────
// Thin wrappers around the SAIL-core attendance RPCs:
//
//   * createAttendanceSession({ classId, sessionDate })
//       → bridge_create_attendance_session(p_class_id, p_session_date)
//       Idempotent. Returns { id, classId, sessionDate, createdBy, createdAt, isNew }.
//
//   * saveAttendanceRegister({ sessionId, records })
//       → bridge_save_attendance_register(p_attendance_session_id, p_records)
//       records = [{ studentUserId, status }] where status ∈
//       ('present','absent','late'). Returns the present/absent/late
//       count summary the RPC emits.
//
//   * getAttendanceSession(sessionId)
//       → bridge_get_attendance_session(p_attendance_session_id)
//       Returns { session, class, records }. SECURITY INVOKER on the
//       backend, so RLS does the gating.
//
// Style — matches services/assignments.js + services/classes.js:
//   * Throw on error. Each function returns the data directly (or throws).
//   * Named exports. No object-of-methods.
//   * No client-side fallback paths. Errors propagate so callers can
//     handle (e.g. the page renders an inline error block).
//   * NEVER touches `supabase.from(...)` directly — RPC-only, per the
//     post-B27.2 invariant Helm-wide.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

/**
 * Open a register for a class on a given school-day. Idempotent —
 * re-calling for the same (classId, sessionDate) returns the existing
 * session and emits no audit row (the backend's `is_new` flag is
 * surfaced for the UI).
 *
 * @param {{ classId: string, sessionDate: string }} args
 *   sessionDate is an ISO 'YYYY-MM-DD' string.
 * @returns {Promise<{ id, classId, sessionDate, createdBy, createdAt, isNew }>}
 */
export async function createAttendanceSession({ classId, sessionDate } = {}) {
    if (!classId)     throw new Error('classId is required')
    if (!sessionDate) throw new Error('sessionDate is required')
    const { data, error } = await supabase.rpc('bridge_create_attendance_session', {
        p_class_id:     classId,
        p_session_date: sessionDate,
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    if (!row) throw new Error('bridge_create_attendance_session returned no row')
    // Snake → camel for the consumer.
    return {
        id:           row.id,
        classId:      row.class_id,
        sessionDate:  row.session_date,
        createdBy:    row.created_by,
        createdAt:    row.created_at,
        isNew:        Boolean(row.is_new),
    }
}

/**
 * Bulk-upsert a roster of attendance marks. Per-row backend triggers
 * emit `attendance.marked` (insert) or `attendance.updated` (UPDATE
 * when status actually changes); the RPC body emits one semantic
 * `attendance.register_saved` with present/absent/late counts.
 *
 * @param {{ sessionId: string, records: Array<{ studentUserId: string, status: 'present'|'absent'|'late' }> }} args
 * @returns {Promise<{ attendance_session_id, present_count, absent_count, late_count, total_count }>}
 */
export async function saveAttendanceRegister({ sessionId, records } = {}) {
    if (!sessionId)             throw new Error('sessionId is required')
    if (!Array.isArray(records)) throw new Error('records must be an array')
    if (records.length === 0)   throw new Error('records must be non-empty')
    const { data, error } = await supabase.rpc('bridge_save_attendance_register', {
        p_attendance_session_id: sessionId,
        p_records: records.map((r) => ({
            student_user_id: r.studentUserId,
            status:          r.status,
        })),
    })
    if (error) throw error
    return data
}

/**
 * Fetch one register's full state — session header, class metadata,
 * and the per-student record list (joined with name + email
 * server-side, so the UI doesn't need a separate roster lookup just
 * to label rows).
 *
 * @param {string} sessionId
 * @returns {Promise<{ session, class, records }>}
 */
export async function getAttendanceSession(sessionId) {
    if (!sessionId) throw new Error('sessionId is required')
    const { data, error } = await supabase.rpc('bridge_get_attendance_session', {
        p_attendance_session_id: sessionId,
    })
    if (error) throw error
    return data || { session: null, class: null, records: [] }
}

/**
 * Phase B — read-only lookup by (classId, sessionDate). Returns the
 * same payload shape as getAttendanceSession but with `session: null`
 * when no register exists yet for that pair. Helm uses the null vs
 * row distinction to render a "Start register" CTA without
 * spuriously emitting `attendance.session_started` on every page
 * load.
 *
 * @param {{ classId: string, sessionDate: string }} args
 *   sessionDate is an ISO 'YYYY-MM-DD' string.
 * @returns {Promise<{ session: object|null, class: object|null, records: Array }>}
 */
export async function findAttendanceSessionForDate({ classId, sessionDate } = {}) {
    if (!classId)     throw new Error('classId is required')
    if (!sessionDate) throw new Error('sessionDate is required')
    const { data, error } = await supabase.rpc('bridge_get_attendance_session_for_date', {
        p_class_id:     classId,
        p_session_date: sessionDate,
    })
    if (error) throw error
    return data || { session: null, class: null, records: [] }
}

/**
 * Phase B — recent sessions for a class with present/absent/late
 * counts pre-aggregated server-side. Powers the Recent Sessions panel
 * on the Helm Attendance page so the operator can jump back to a
 * previous register without going through a date-picker hunt.
 *
 * @param {{ classId: string, limit?: number }} args
 * @returns {Promise<Array<{ id, classId, sessionDate, createdBy, createdAt, totalCount, presentCount, absentCount, lateCount }>>}
 */
export async function listAttendanceSessionsForClass({ classId, limit = 5 } = {}) {
    if (!classId) throw new Error('classId is required')
    const { data, error } = await supabase.rpc('bridge_list_attendance_sessions_for_class', {
        p_class_id: classId,
        p_limit:    limit,
    })
    if (error) throw error
    return (data || []).map((r) => ({
        id:           r.id,
        classId:      r.class_id,
        sessionDate:  r.session_date,
        createdBy:    r.created_by,
        createdAt:    r.created_at,
        totalCount:   r.total_count,
        presentCount: r.present_count,
        absentCount:  r.absent_count,
        lateCount:    r.late_count,
    }))
}
