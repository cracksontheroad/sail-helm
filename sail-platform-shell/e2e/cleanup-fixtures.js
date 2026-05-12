// Fixture cleanup helpers for the e2e suite.
//
// The Helm e2e suite runs against the LIVE SAIL-core database (no
// mocking). The fixture class accumulates TEST-titled rows across every
// run, which slows page renders over time and eventually pushes the
// assignments-lifecycle test past its 30 s wall-clock budget (this
// happened intermittently on local + on CI's first PR B run before we
// hardened selectors).
//
// This helper signs in as alice with the same credentials the e2e suite
// uses, then calls `list_class_assignments` + `delete_assignment` for
// every row whose title starts with the given prefix. Idempotent +
// safe to call before every run.
//
// Why not use a service-role key:
//   - That would require a new CI secret and a different auth flow.
//   - Alice already has DB-side permission to delete assignments in her
//     test class (admin-of-school + teacher-of-class). The same code
//     path the tests already exercise.
//
// Why not RLS-direct DELETE: alice's anon-session token wouldn't have
// RLS write access; the RPC `delete_assignment` is the canonical path
// and it re-checks server-side.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
                  || 'https://gidyonbzxjorrgpicctt.supabase.co'
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
                       || 'sb_publishable_9gCdvH0NEcmkCf_IKuWTvg_vZLpfJ-r'

// Same fallback as e2e/helpers.js — both honour the optional
// E2E_TEST_PASSWORD secret if set.
const ALICE_EMAIL    = 'alice@test.com'
const ALICE_PASSWORD = process.env.E2E_TEST_PASSWORD || 'E2eHelmTest!2026'

/**
 * Delete every assignment in `classId` whose title starts with
 * `titlePrefix`. Best-effort: errors are logged + swallowed so a
 * pre-test cleanup failure does NOT block the test itself (the test
 * will still create its own uniquely-titled row — the cleanup is an
 * optimization, not a correctness requirement).
 *
 * @param {object} args
 * @param {string} args.classId
 * @param {string} args.titlePrefix
 * @returns {Promise<{ deleted: number, scanned: number, error?: Error }>}
 */
export async function cleanupTestAssignments({ classId, titlePrefix }) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

    const { error: signInErr } = await supabase.auth.signInWithPassword({
        email:    ALICE_EMAIL,
        password: ALICE_PASSWORD,
    })
    if (signInErr) {
        // eslint-disable-next-line no-console
        console.warn('[cleanup-fixtures] sign-in failed, skipping cleanup:', signInErr.message)
        return { deleted: 0, scanned: 0, error: signInErr }
    }

    try {
        const { data: rows, error: listErr } = await supabase.rpc('list_class_assignments', {
            p_class_id: classId,
        })
        if (listErr) {
            // eslint-disable-next-line no-console
            console.warn('[cleanup-fixtures] list failed, skipping cleanup:', listErr.message)
            return { deleted: 0, scanned: 0, error: listErr }
        }

        const all = Array.isArray(rows) ? rows : []
        const stale = all.filter((r) => typeof r.title === 'string' && r.title.startsWith(titlePrefix))

        let deleted = 0
        for (const row of stale) {
            const { error: delErr } = await supabase.rpc('delete_assignment', {
                p_assignment_id: row.assignment_id,
            })
            if (delErr) {
                // Log but keep going — partial cleanup is still better
                // than no cleanup.
                // eslint-disable-next-line no-console
                console.warn(`[cleanup-fixtures] delete ${row.assignment_id} failed:`, delErr.message)
            } else {
                deleted += 1
            }
        }

        return { deleted, scanned: all.length }
    } finally {
        await supabase.auth.signOut().catch(() => {})
    }
}
