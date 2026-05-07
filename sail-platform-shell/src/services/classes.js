// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Classes Service — Helm-side
// ─────────────────────────────────────────────────────────────────────────────
// Phase 6D — single helper wrapping the per-class metadata fetch.
//
// Helm /class/:classId is keyed by class_id, not school_id, so the Bridge
// `bridge_list_classes(school_id)` RPC isn't the right shape. A direct
// SELECT on the classes table with a school name lookup is sufficient
// and respects the existing RLS (same-school members see; schools.read
// holders see; everyone else sees nothing).
//
// If a class is not found OR the caller lacks read access, the function
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
 * Throws if classes RLS denies (covered same way as supabase errors —
 * caller renders the message in an inline error block).
 *
 * @param {string} classId
 */
export async function getClass(classId) {
    if (!classId) throw new Error('classId is required')

    // 1) class metadata via RLS (admits same-school members + schools.read)
    const { data: classRow, error: classErr } = await supabase
        .from('classes')
        .select('id, school_id, name, subject, teacher_id, created_at')
        .eq('id', classId)
        .single()

    if (classErr) throw classErr
    if (!classRow) throw new Error('Class not found')

    // 2) school name lookup (RLS on schools admits same-school members
    //    + schools.read; for the staff signed into Helm this is always
    //    their own school, so the lookup never fails for legitimate
    //    callers).
    const { data: schoolRow } = await supabase
        .from('schools')
        .select('id, name')
        .eq('id', classRow.school_id)
        .single()

    return { ...classRow, school: schoolRow || null }
}
