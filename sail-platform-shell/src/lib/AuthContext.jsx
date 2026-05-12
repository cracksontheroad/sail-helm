import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'
import api from '../services/api'

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
            const query = api.auth.getEffectiveProfile()
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

                console.log('[Auth] event:', event, 'session:', session?.user?.email ?? 'none')

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
