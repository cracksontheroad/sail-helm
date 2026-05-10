// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Helm — Copilot service
// ─────────────────────────────────────────────────────────────────────────────
// Thin wrappers around the SAIL-core Copilot RPCs. Two functions:
//
//   reviewStruggling({ schoolId, classId, windowDays, threshold })
//     Calls bridge_copilot_review_struggling. Returns one row per at-risk
//     student in the class. Risk model is deterministic (not AI) — the
//     scoring lives server-side in the RPC; the UI just renders.
//
//   recordCopilotRead({ intentKey, requestId, schoolId, classId, studentIds })
//     Calls bridge_record_copilot_read. Read-event audit log. The
//     orchestrator (the page) is contractually responsible for emitting
//     this immediately after a successful suggestions call. Failures
//     are non-fatal — we console.error and move on so a stuck audit
//     RPC never blocks the teacher's workflow.
//
// Identity flows through Supabase Auth via `supabase.rpc()`. We do NOT
// pass the user id — the server reads `auth.uid()` and refuses anon.
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

const INTENT_KEY = 'review_struggling_students'

/**
 * Generate a fresh request id for a single Copilot run.
 * Same uuid is used for the suggestions call and the audit row, so
 * analysts can JOIN ai_requests ⟷ audit_logs on (request_id) when an
 * AI hop follows.
 */
export function newRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
    }
    // Defensive fallback — modern browsers all have crypto.randomUUID.
    // This shape is just to keep the call signature alive in tests
    // running under JSDOM with no crypto polyfill.
    return '00000000-0000-0000-0000-' + Date.now().toString(16).padStart(12, '0')
}

/**
 * Fetch deterministic at-risk suggestions for a class.
 *
 * @param {object} args
 * @param {string} args.schoolId      uuid
 * @param {string} args.classId       uuid (must belong to schoolId)
 * @param {number} [args.windowDays]  1–90, default 14
 * @param {number} [args.threshold]   0.0–1.0, default 0.6
 *                                    ceil(threshold*3) ⇒ minimum signal
 *                                    count to surface in the result.
 * @returns {Promise<Array<{
 *   student_id: string,
 *   student_first_name: string,
 *   student_last_initial: string|null,
 *   signals: string[],
 *   signal_count: number,
 *   risk_band: 'high'|'medium'|'low',
 *   recommended_action: 'invite_to_review'|'suggest_reteaching'|'assign_drill'
 * }>>}
 */
export async function reviewStruggling({ schoolId, classId, windowDays = 14, threshold = 0.6 }) {
    if (!schoolId) throw new Error('schoolId is required')
    if (!classId)  throw new Error('classId is required')

    const { data, error } = await supabase.rpc('bridge_copilot_review_struggling', {
        p_school_id:   schoolId,
        p_class_id:    classId,
        p_window_days: windowDays,
        p_threshold:   threshold,
    })
    if (error) throw error
    return Array.isArray(data) ? data : []
}

/**
 * Emit the read-event audit row for this Copilot run. Best-effort;
 * non-fatal failures are logged to console but do NOT bubble up — a
 * stuck audit RPC must not break the teacher's workflow.
 *
 * The contract (per Hooks Spec v1 § 8): exactly one audit row per
 * Copilot retrieval that touches per-student data.
 */
export async function recordCopilotRead({
    intentKey = INTENT_KEY,
    requestId,
    schoolId,
    classId,
    studentIds,
}) {
    if (!requestId) {
        console.error('[copilot] recordCopilotRead missing requestId')
        return
    }
    try {
        const { error } = await supabase.rpc('bridge_record_copilot_read', {
            p_intent_key:         intentKey,
            p_request_id:         requestId,
            p_school_id:          schoolId,
            p_target_class_id:    classId,
            p_target_student_ids: studentIds || [],
        })
        if (error) {
            console.error('[copilot] audit RPC failed', error)
        }
    } catch (err) {
        console.error('[copilot] audit RPC threw', err)
    }
}

/**
 * Compose existing primitives to act on a Copilot suggestion:
 *   1. bridge_create_assignment(class_id, title, desc, request_id?)
 *      → assignmentId
 *   2. bridge_distribute_assignment(assignmentId, student_ids[],
 *      request_id?)
 *      → inserted count
 *
 * Both RPCs already exist (Phases 6A/6C and B27.2) — we are NOT
 * modifying assignments or RLS. The targeting comes for free via
 * bridge_distribute_assignment.
 *
 * `requestId` is optional. When passed, the SAIL-core RPCs set the
 * per-transaction GUC `app.copilot_request_id`, which the audit
 * helper merges into the resulting `assignment.created` and
 * `assignment.distributed` rows under `metadata.request_id`. That
 * makes the Copilot ⟷ assignment audit JOIN deterministic on a
 * single uuid (Migration 004 / 2026-05-10). If a caller omits
 * `requestId`, the propagation does not happen and the legacy
 * audit shape is preserved.
 */
export async function createTargetedAssignment({
    classId,
    title,
    description,
    studentIds,
    requestId = null,
}) {
    if (!classId)                throw new Error('classId is required')
    if (!title || !title.trim()) throw new Error('title is required')
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
        throw new Error('studentIds must be a non-empty array')
    }

    const { data: createRows, error: createErr } = await supabase.rpc('bridge_create_assignment', {
        p_class_id:    classId,
        p_title:       title,
        p_description: description || null,
        p_request_id:  requestId,
    })
    if (createErr) throw createErr
    const created = Array.isArray(createRows) ? createRows[0] : createRows
    if (!created || !created.id) {
        throw new Error('bridge_create_assignment returned no row')
    }

    const { data: insertedCount, error: distErr } = await supabase.rpc('bridge_distribute_assignment', {
        p_assignment_id: created.id,
        p_student_ids:   studentIds,
        p_request_id:    requestId,
    })
    if (distErr) throw distErr

    return {
        assignment: created,
        distributedCount: insertedCount,
    }
}
