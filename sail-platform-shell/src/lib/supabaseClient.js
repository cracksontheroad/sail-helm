import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://gidyonbzxjorrgpicctt.supabase.co'
const supabaseKey = 'sb_publishable_9gCdvH0NEcmkCf_IKuWTvg_vZLpfJ-r'

// ───────────────────────────────────────────────────────────────────────────
// Read-only impersonation context (Phase 1)
// ───────────────────────────────────────────────────────────────────────────
//
// Bridge can launch Helm with `?impersonate=<user-uuid>&session=<session-uuid>`.
// We read both on page load and inject TWO headers on every Supabase request
// via supabase-js `global.headers`:
//
//   x-impersonate-user-id        — the target user's uuid
//   x-impersonation-session-id   — the audit session uuid Bridge minted
//
// Both are required. PostgREST exposes them to Postgres via
// `current_setting('request.headers', true)`, where SAIL-core's
// `public.get_impersonation_user_id()` validates them against audit_logs:
// the gate only honours the lens when a matching impersonation.started
// audit row exists (same session_id, same target, actor_id = auth.uid())
// AND no impersonation.stopped row has been written for that session_id.
// "No audit log = no impersonation" is the runtime invariant.
//
// What this means in practice:
//   * Bridge clicks "End" → audit_logs gets a stopped row → the next
//     Helm request returns NULL from the gate → effective_user_id()
//     falls back to auth.uid() → banner auto-disappears, lens lifts.
//   * A hand-crafted ?impersonate=<uuid>&session=<garbage> URL produces
//     no impersonation: validation fails, gate returns NULL.
//   * A legitimate Bridge-launched URL on a non-superadmin session also
//     produces no impersonation: is_sail_internal() check fails first.
//
// Important:
//   * We DO NOT mint a custom session. The admin's real Supabase session is
//     what's authenticating this client; the headers just signal intent.
//   * We do NOT persist the impersonation id. It lives in module memory
//     for the life of this tab. Closing the tab ends impersonation.
//   * Phase 1 ships with a CLIENT-SIDE mutation lock (see below) as a
//     safety belt while RLS policies are still using auth.uid(). Phase 2
//     swaps SELECT policies to effective_user_id() and the server becomes
//     the real boundary.
function readImpersonateParam() {
    if (typeof window === 'undefined') return null
    try {
        const params = new URLSearchParams(window.location.search)
        const raw = params.get('impersonate')
        if (!raw) return null
        // Defensive UUID shape check — a malformed value should fall
        // through to "no impersonation" rather than send a bad header.
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        return uuidRe.test(raw) ? raw : null
    } catch {
        return null
    }
}

/**
 * Optional session id minted by Bridge's `bridge_start_impersonation`
 * RPC and propagated through the Helm URL. Read once at module load
 * (NOT localStorage — closing the tab ends the session). Passed back
 * into `bridge_stop_impersonation` on exit so the start/stop pair
 * shares a correlation key in audit_logs.metadata.session_id.
 *
 * May be null when:
 *   - URL didn't include &session=… (legacy or hand-crafted link)
 *   - value isn't UUID-shaped (defensive parse)
 * In both cases the stop RPC accepts NULL gracefully and just logs
 * a partial row.
 */
function readSessionParam() {
    if (typeof window === 'undefined') return null
    try {
        const params = new URLSearchParams(window.location.search)
        const raw = params.get('session')
        if (!raw) return null
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        return uuidRe.test(raw) ? raw : null
    } catch {
        return null
    }
}

/**
 * Optional in-app redirect target propagated from Bridge — e.g. when a
 * support agent clicks "View → Assignments" we land them directly on
 * /assignments instead of the role-default route.
 *
 * Validation rules:
 *   - must start with "/" (in-app path)
 *   - must NOT start with "//" (open-redirect / protocol-relative URL)
 *   - must NOT contain whitespace
 * Anything failing those checks falls through to null and Helm uses
 * the role-default route.
 */
function readRedirectParam() {
    if (typeof window === 'undefined') return null
    try {
        const params = new URLSearchParams(window.location.search)
        const raw = params.get('redirect')
        if (!raw) return null
        if (!raw.startsWith('/'))  return null
        if (raw.startsWith('//'))  return null
        if (/\s/.test(raw))        return null
        return raw
    } catch {
        return null
    }
}

const impersonateUserId = readImpersonateParam()
const impersonateSessionId = readSessionParam()
// URL flag: do we *intend* to impersonate? Server still has the final
// say (the audit-log validation in get_impersonation_user_id() can veto
// us). We require BOTH params before injecting headers because the
// server gate now requires both — sending only one would just produce
// a request the server rejects, with no UX benefit.
const hasFullImpersonationIntent = Boolean(impersonateUserId && impersonateSessionId)

export const isImpersonating          = hasFullImpersonationIntent
export const impersonatedUserId       = impersonateUserId
export const impersonationSessionId   = impersonateSessionId
export const impersonationRedirect    = readRedirectParam()

// Build the client. supabase-js merges `global.headers` into every fetch,
// so the impersonation headers ride along with auth headers automatically.
// We send BOTH x-impersonate-user-id and x-impersonation-session-id; the
// server gate requires the pair to validate against audit_logs.
const baseClient = createClient(supabaseUrl, supabaseKey, {
    global: {
        headers: hasFullImpersonationIntent
            ? {
                'x-impersonate-user-id':       impersonateUserId,
                'x-impersonation-session-id':  impersonateSessionId,
              }
            : {},
    },
})

/**
 * Wrap a supabase client so any direct table mutation
 * (.insert / .update / .delete / .upsert) throws while impersonating.
 *
 * This is a Phase 1 safety belt — Phase 2 RLS policies will keep
 * INSERT/UPDATE/DELETE bound to auth.uid() (the real admin), so a
 * malicious header injection on a write can't actually impersonate
 * anyone for write purposes. But until those policies land, blocking
 * writes UI-side prevents an admin from accidentally writing AS the
 * impersonated user's POV (the data they'd see) while actually writing
 * AS the admin (the auth id RLS sees).
 *
 * RPC calls are deliberately NOT blocked: many RPCs are read-side
 * (e.g. `bridge_list_*`), and any write RPC would write under the
 * admin's auth.uid() anyway. Block-list RPCs case-by-case if needed.
 */
function wrapWithReadOnlyGuard(client) {
    const blocked = (table, method) => () => {
        throw new Error(
            `[impersonation] ${method} on '${table}' blocked: this Helm session is in read-only impersonation mode.`,
        )
    }
    const origFrom = client.from.bind(client)
    client.from = function from(table) {
        const builder = origFrom(table)
        // Shadow the mutation entry points on the builder instance.
        // Reads (.select / .order / .eq / .single / etc.) are untouched.
        builder.insert = blocked(table, 'insert')
        builder.update = blocked(table, 'update')
        builder.delete = blocked(table, 'delete')
        builder.upsert = blocked(table, 'upsert')
        return builder
    }
    return client
}

export const supabase = hasFullImpersonationIntent
    ? wrapWithReadOnlyGuard(baseClient)
    : baseClient
