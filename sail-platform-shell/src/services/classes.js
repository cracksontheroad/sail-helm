// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Classes Service — Helm-side
// ─────────────────────────────────────────────────────────────────────────────
// Phase 6D introduced a per-class metadata fetch backed by direct
// `from('classes')` + `from('schools')` reads, with the comment
// justifying it as "the Bridge bridge_list_classes(school_id) RPC isn't
// the right shape" for a by-class-id lookup.
//
// Phase B27.1 (2026-05-08) closes that gap: bridge_get_class_detail(class_id)
// composes the class + school join server-side as a single thin
// LANGUAGE sql STABLE function. Same RLS posture (school_id-keyed
// visibility on classes + schools); one round-trip instead of two; no
// `supabase.from(...)` reach in this service anymore.
//
// If a class is not found OR the caller lacks read access, this function
// throws with a clear error — caller handles it inline.
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

/**
 * Fetch a single class plus its school name. Returns:
 *   {
 *     id, school_id, name, subject, teacher_id, created_at,
 *     school: { id, name } | null
 *   }
 *
 * The RPC return shape is flat (school_name as a column); this wrapper
 * adapts it back to the historical `school: { id, name }` nested shape
 * so existing consumers (Class.jsx, etc.) keep working unchanged.
 *
 * @param {string} classId
 */
export async function getClass(classId) {
    if (!classId) throw new Error('classId is required')

    const { data, error } = await supabase.rpc('bridge_get_class_detail', {
        p_class_id: classId,
    })
    if (error) throw error
    // RPC returns RETURNS TABLE → array of zero or one row.
    const row = Array.isArray(data) ? data[0] : data
    if (!row) throw new Error('Class not found')

    return {
        id:         row.id,
        school_id:  row.school_id,
        name:       row.name,
        subject:    row.subject,
        teacher_id: row.teacher_id,
        created_at: row.created_at,
        // Adapt flat school_name back to the nested {id, name} shape the
        // historical caller code expects. id is the class's school_id
        // (already validated by the RPC's join).
        school:     row.school_name
            ? { id: row.school_id, name: row.school_name }
            : null,
    }
}
