import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'

const AuthContext = createContext()

// Wrap a promise with a timeout — resolves to fallback if the promise takes too long
function withTimeout(promise, ms, fallback) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
    ])
}

/**
 * Helm's identity context — single source of truth.
 *
 * Replaces the previous split between:
 *   - supabase.auth.getUser()                (real session, real email)
 *   - supabase.rpc('get_effective_user_membership') (lens-aware role)
 *
 * with one server-side resolution via `get_effective_user_profile()`,
 * which returns both the lens-aware identity (email / role / school_id)
 * and the real-session identity (real_user_id / real_user_email).
 *
 * Why move *all* identity to the RPC instead of keeping email from
 * supabase.auth: when impersonating, the auth session belongs to the
 * admin but the UI should display the impersonated user's email
 * everywhere except the banner. Resolving both sides server-side in
 * one round-trip removes any chance of the two going out of sync.
 *
 * Exposed shape:
 *   userId          — effective uid (impersonated or real)
 *   email           — effective user's email
 *   role            — effective user's role (school_members.role)
 *   schoolId        — effective user's school_id
 *   isImpersonating — server-confirmed (header was honoured by the
 *                     is_sail_internal gate). Distinct from the
 *                     URL-derived flag in supabaseClient.js, which is
 *                     a CLIENT signal only — the server is the truth.
 *   realUserId      — auth.uid(); equals userId when not impersonating
 *   realUserEmail   — auth.users.email for realUserId; equals email
 *                     when not impersonating
 *   loading         — true until first resolve completes
 */
export function AuthProvider({ children }) {
    const [auth, setAuth] = useState({
        userId:           null,
        email:            null,
        role:             null,
        schoolId:         null,
        isImpersonating:  false,
        realUserId:       null,
        realUserEmail:    null,
        loading:          true,
    })
    // Transient flag — flips true for ~5s when the polling loop detects
    // that impersonation ended server-side (Bridge clicked End, or the
    // session was force-stopped from the Active Impersonations panel).
    // Consumers render a small "Impersonation ended" toast off this.
    const [impersonationEnded, setImpersonationEnded] = useState(false)
    const pendingRef = useRef(0)

    // Fetch the unified identity payload via get_effective_user_profile.
    // Returns the same fallback shape as `auth` so a failure can be
    // merged in without dropping fields.
    const fetchProfile = useCallback(async () => {
        const fallback = {
            userId:          null,
            email:           null,
            role:            null,
            schoolId:        null,
            isImpersonating: false,
            realUserId:      null,
            realUserEmail:   null,
        }

        try {
            const query = supabase.rpc('get_effective_user_profile')
            const { data, error } = await withTimeout(query, 5000, { data: null, error: { message: 'timeout' } })

            if (error) {
                console.warn('[Auth] profile lookup failed:', error.message)
                return fallback
            }
            // RPC returns jsonb, which supabase-js surfaces as a plain object.
            if (!data || typeof data !== 'object') {
                console.warn('[Auth] empty profile payload')
                return fallback
            }

            return {
                userId:          data.user_id          ?? null,
                email:           data.email            ?? null,
                role:            data.role             ?? null,
                schoolId:        data.school_id        ?? null,
                isImpersonating: Boolean(data.is_impersonating),
                realUserId:      data.real_user_id     ?? null,
                realUserEmail:   data.real_user_email  ?? null,
            }
        } catch (err) {
            console.warn('[Auth] profile exception:', err.message)
            return fallback
        }
    }, [])

    useEffect(() => {
        const { data: listener } = supabase.auth.onAuthStateChange(
            (event, session) => {
                const requestId = ++pendingRef.current

                // PII hygiene (Stage 2 Phase A, 2026-05-07): never log the
                // signed-in user's email — DevTools, error reporters, and
                // bystanders see this. Just signal whether a session is
                // present, opaque to identity. The full user/role/school
                // payload still resolves through fetchProfile() below.
                console.log('[Auth] event:', event, 'has-session:', !!session?.user)

                if (!session?.user) {
                    // No session — go straight to login. We still write
                    // the full shape so consumers don't crash on missing
                    // keys.
                    setAuth({
                        userId:          null,
                        email:           null,
                        role:            null,
                        schoolId:        null,
                        isImpersonating: false,
                        realUserId:      null,
                        realUserEmail:   null,
                        loading:         false,
                    })
                    return
                }

                // Resolve the unified profile. The RPC reads
                // effective_user_id() server-side, which honours the
                // impersonation header automatically.
                fetchProfile()
                    .then((profile) => {
                        if (requestId !== pendingRef.current) return // stale
                        setAuth({ ...profile, loading: false })
                    })
                    .catch(() => {
                        // Should never reach here (fetchProfile catches),
                        // but guarantee loading clears.
                        if (requestId !== pendingRef.current) return
                        setAuth({
                            userId:          null,
                            email:           session.user.email ?? null,
                            role:            null,
                            schoolId:        null,
                            isImpersonating: false,
                            realUserId:      session.user.id ?? null,
                            realUserEmail:   session.user.email ?? null,
                            loading:         false,
                        })
                    })
            }
        )

        // Safety: if onAuthStateChange never fires (broken Supabase client),
        // force loading=false so the UI doesn't hang forever.
        const timeout = setTimeout(() => {
            setAuth(prev => {
                if (prev.loading) {
                    console.warn('[Auth] safety timeout — forcing loading=false')
                    return { ...prev, loading: false }
                }
                return prev
            })
        }, 4000)

        return () => {
            clearTimeout(timeout)
            listener.subscription.unsubscribe()
        }
    }, [fetchProfile])

    // ─────────────────────────────────────────────────────────────────────
    // Awareness loop: while we believe we're impersonating, poll the
    // server every ~7s to check whether the session is still live.
    //
    // Why we need it: Phase-2 hardening made the runtime gate
    // (`get_impersonation_user_id`) cross-check audit_logs on every
    // request. The moment a Bridge admin clicks "End", new data fetches
    // already come back un-lensed. But this AuthContext only resolves
    // identity on `onAuthStateChange`, so the banner / role / userId in
    // memory can lag the server by an arbitrary amount until the next
    // auth event fires. Polling closes that gap with bounded, cheap UX.
    //
    // Why polling and not realtime: invalidation is already
    // server-driven and stateless; this loop is purely "sync UI with
    // reality". Realtime would add a websocket and a subscription to
    // audit_logs filtered to our session id — strictly more complex for
    // the same outcome at this scale (a handful of admin tabs at a time).
    //
    // Self-terminating: when the poll discovers `is_impersonating: false`,
    // setAuth flips `auth.isImpersonating` → false → this useEffect's
    // cleanup runs → clearInterval. No "stop polling" call needed.
    //
    // Stale-write protection: shares pendingRef with onAuthStateChange,
    // so a signOut / re-auth that fires mid-poll wins.
    // ─────────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!auth.isImpersonating) return undefined

        let cancelled = false
        let intervalId = null

        const tick = async () => {
            const requestId = ++pendingRef.current
            const profile = await fetchProfile()
            if (cancelled) return
            if (requestId !== pendingRef.current) return // superseded by another event

            // Server says impersonation is over. We were impersonating
            // (otherwise this effect wouldn't be running), so this is
            // unambiguously a transition — surface a toast.
            if (!profile.isImpersonating) {
                setImpersonationEnded(true)
            }
            setAuth({ ...profile, loading: false })
        }

        // Adaptive cadence: most "End" clicks in support workflows happen
        // shortly after start (admin peeks, confirms intent, ends). A
        // first re-check at ~1.5 s catches that fast-end case before the
        // long 7 s rhythm starts, so the typical lag drops from up to
        // 7 s to well under 2 s without extra steady-state load.
        const firstTickTimeoutId = setTimeout(() => {
            tick()
            // Only start the steady cadence if we're still mounted +
            // still impersonating. If the first tick already flipped us
            // out (server said stopped), the effect will tear down
            // before this assignment matters — but `cancelled` guard in
            // tick() already prevents stale setAuth either way.
            intervalId = setInterval(tick, 7000)
        }, 1500)

        return () => {
            cancelled = true
            clearTimeout(firstTickTimeoutId)
            if (intervalId !== null) clearInterval(intervalId)
        }
    }, [auth.isImpersonating, fetchProfile])

    // Auto-dismiss the "Impersonation ended" flag after 5 s. Independent
    // of the polling effect so the toast lifetime is unaffected by
    // subsequent polls / re-renders.
    useEffect(() => {
        if (!impersonationEnded) return undefined
        const t = setTimeout(() => setImpersonationEnded(false), 5000)
        return () => clearTimeout(t)
    }, [impersonationEnded])

    const signOut = useCallback(async () => {
        pendingRef.current++ // invalidate in-flight profile lookups
        setAuth({
            userId:          null,
            email:           null,
            role:            null,
            schoolId:        null,
            isImpersonating: false,
            realUserId:      null,
            realUserEmail:   null,
            loading:         false,
        })
        await supabase.auth.signOut().catch(() => {})
    }, [])

    // Manual dismiss — App.jsx renders an X on the toast. Independent of
    // the auto-dismiss timer; whichever fires first wins.
    const dismissImpersonationEnded = useCallback(() => {
        setImpersonationEnded(false)
    }, [])

    return (
        <AuthContext.Provider value={{
            // Effective identity (lens-aware)
            userId:          auth.userId,
            email:           auth.email,
            role:            auth.role,
            schoolId:        auth.schoolId,
            // Real session (always the actual authenticated user)
            realUserId:      auth.realUserId,
            realUserEmail:   auth.realUserEmail,
            isImpersonating: auth.isImpersonating,
            loading:         auth.loading,
            signOut,
            // Awareness-loop signal: true for ~5s after the polling tick
            // detects the session ended server-side. Consumers show a
            // toast off this.
            impersonationEnded,
            dismissImpersonationEnded,
            // Back-compat alias: existing pages reference `user` for
            // email/id. We surface the *effective* user here so pages
            // automatically render lens-aware data without a refactor.
            user: auth.userId
                ? { id: auth.userId, email: auth.email }
                : null,
        }}>
            {children}
        </AuthContext.Provider>
    )
}

export const useAuth = () => useContext(AuthContext)
