import { createClient } from '@supabase/supabase-js'

// Read from Vite env (inlined at build time). Local dev: copy
// `.env.example` → `.env` (or `.env.local`) and fill in values. CI:
// `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` GitHub secrets passed
// to the Build step in `.github/workflows/e2e.yml`.
//
// No literal fallback — a missing value MUST fail loudly. A silent
// fallback would mask deploy-config bugs and let a misconfigured build
// silently point at the wrong project.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY
if (!supabaseUrl || !supabaseKey) {
    throw new Error(
        '[supabaseClient] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
        'Copy sail-platform-shell/.env.example to .env (or .env.local) and ' +
        'fill in the values. In CI, configure the GitHub repo secrets and ' +
        'pass them to the Build step.',
    )
}

// ───────────────────────────────────────────────────────────────────────────
// Read-only impersonation context (Phase 1)
// ───────────────────────────────────────────────────────────────────────────
//
// Bridge can launch Helm with `?impersonate=<user-uuid>`. We read that on
// page load and inject `x-impersonate-user-id` on every Supabase request via
// supabase-js `global.headers`. PostgREST exposes the header to Postgres
// via `current_setting('request.headers', true)`, where SAIL-core's
// `public.get_impersonation_user_id()` reads it (gated by is_sail_internal
// — only Bridge superadmin sessions can ever cause an effective_user_id()
// switch).
//
// Important:
//   * We DO NOT mint a custom session. The admin's real Supabase session is
//     what's authenticating this client; the header just signals intent.
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
export const isImpersonating          = Boolean(impersonateUserId)
export const impersonatedUserId       = impersonateUserId
export const impersonationSessionId   = readSessionParam()
export const impersonationRedirect    = readRedirectParam()

// Build the client. supabase-js merges `global.headers` into every fetch,
// so the impersonation header rides along with auth headers automatically.
const baseClient = createClient(supabaseUrl, supabaseKey, {
    global: {
        headers: impersonateUserId
            ? { 'x-impersonate-user-id': impersonateUserId }
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

export const supabase = isImpersonating
    ? wrapWithReadOnlyGuard(baseClient)
    : baseClient
