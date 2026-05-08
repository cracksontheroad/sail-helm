import { useEffect, useRef } from 'react'
import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { CAN, ROLE_LABELS, getDefaultRoute } from './lib/permissions'
import {
    impersonatedUserId,
    impersonationSessionId,
    impersonationRedirect,
    supabase,
} from './lib/supabaseClient'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Assignments from './pages/Assignments'
import Gradebook from './pages/Gradebook'
import ClassPage from './pages/Class'
import AttendancePage from './pages/Attendance'
import MyAssignmentsPage from './pages/MyAssignments'

/**
 * Banner shown across the top of Helm whenever the page was opened with
 * a `?impersonate=<uuid>` query param (Bridge "View as user" flow).
 *
 * Read-only signal: the supabase client is wrapped to throw on
 * insert/update/delete/upsert, the header rides along on every request,
 * and the SAIL-core RLS layer (Phase 2) is what actually enforces the
 * lens. This banner exists so the admin can never accidentally forget
 * which user's view they're looking at.
 */
async function exitImpersonation() {
    // Fire-and-forget audit log on the way out. We don't block the
    // window.close() on it — the audit row is best-effort, and a stuck
    // RPC shouldn't strand the operator inside the impersonation tab.
    // The is_sail_internal() gate inside `bridge_stop_impersonation`
    // keeps this safe regardless of who calls.
    //
    // p_session_id correlates this stop event with the matching start
    // event written by Bridge. Pass NULL when we lost the URL state
    // (e.g. legacy hand-crafted link) — the RPC accepts NULL and just
    // logs a partial row; better than failing the exit flow.
    try {
        await supabase.rpc('bridge_stop_impersonation', {
            p_target_user_id: impersonatedUserId,
            p_session_id:     impersonationSessionId,
        })
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[impersonation] stop audit failed', err)
    }
    // Closing the tab unloads the module-scope `impersonateUserId`, which
    // is the only place we hold the impersonation context (NOT
    // localStorage), so this also fully terminates the session.
    window.close()
}

/**
 * Banner shown across the top of Helm whenever the server confirmed
 * the impersonation header (via `is_impersonating` in
 * get_effective_user_profile). We trust the server's truth here, not
 * the URL param — if a non-admin opened the same URL, the header would
 * be silently ignored and the banner stays hidden.
 *
 * Two-line composition:
 *   1. "Viewing as <impersonated-email> (Role)" — what data the page is showing
 *   2. "Signed in as <admin-email>"             — who is actually authenticated
 *
 * No ambiguity: the lens is named, the actor is named, and the action
 * (exit) is one click away.
 */
function ImpersonationBanner({ email, role, realUserEmail }) {
    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                background: '#fff7e6',
                color: '#7a4a00',
                borderBottom: '1px solid #f0c87a',
                padding: '8px 14px',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 14,
                marginBottom: 12,
            }}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span>
                    <strong>Read-only impersonation</strong> · viewing as{' '}
                    <strong>{email || impersonatedUserId}</strong>
                    {role ? ` (${ROLE_LABELS[role] || role})` : ''} · mutations
                    are blocked client-side.
                </span>
                {realUserEmail && (
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                        Signed in as <strong>{realUserEmail}</strong>
                    </span>
                )}
            </div>
            <button
                type="button"
                onClick={exitImpersonation}
                style={{
                    background: 'transparent',
                    border: '1px solid #f0c87a',
                    color: '#7a4a00',
                    padding: '3px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: 'pointer',
                    flexShrink: 0,
                }}
                title="Logs an audit event and closes the tab"
            >
                Exit impersonation
            </button>
        </div>
    )
}

/**
 * Transient confirmation that an impersonation session ended.
 *
 * Surfaces only when AuthContext's polling loop detects the server now
 * reports `is_impersonating: false` while we previously thought we were
 * impersonating. The banner has already disappeared by this point —
 * this toast is the "what just happened" cue so the operator isn't
 * confused by the silent UI change. Auto-dismissed by AuthContext after
 * 5 s; the X button calls `dismissImpersonationEnded` for instant clear.
 */
function ImpersonationEndedToast({ onDismiss }) {
    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 16,
                right: 16,
                zIndex: 9999,
                background: '#e6f4ea',
                color: '#1e6b3a',
                border: '1px solid #b6d8c1',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 13,
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
            }}
        >
            <span>Impersonation ended — viewing as yourself.</span>
            <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#1e6b3a',
                    cursor: 'pointer',
                    fontSize: 16,
                    lineHeight: 1,
                    padding: 0,
                }}
            >
                ×
            </button>
        </div>
    )
}

function App() {
    const {
        user,
        role,
        loading,
        signOut,
        // Server-confirmed impersonation state: distinct from the
        // URL-derived flag exported by supabaseClient.js. The URL flag
        // controls header injection at client-creation time; this flag
        // controls UI presentation and reflects what the server actually
        // honoured.
        isImpersonating,
        email,
        realUserEmail,
        // Awareness-loop signal: flips true when the polling tick
        // detects the session was ended server-side; auto-clears after
        // 5s. Renders the small "Impersonation ended" toast below.
        impersonationEnded,
        dismissImpersonationEnded,
    } = useAuth()
    const navigate = useNavigate()
    // Guard so the deep-link redirect fires exactly once per page load.
    // Without this, every re-render after the navigate() would try to
    // navigate again (the URL still contains ?redirect=…).
    const didRedirectRef = useRef(false)

    // Deep-link redirect: when Bridge opens Helm with `?redirect=/path`,
    // navigate there once auth has resolved. We wait for `loading=false`
    // because navigating during the loading phase can race with the
    // route-table render. We don't gate on `user` because the redirect
    // is desirable even on the login page (after sign-in completes,
    // Helm's existing flow lands on the role-default route — the
    // redirect overrides that and lands the operator on the support
    // target instead).
    useEffect(() => {
        if (loading) return
        if (didRedirectRef.current) return
        if (!impersonationRedirect) return
        didRedirectRef.current = true
        navigate(impersonationRedirect, { replace: true })
    }, [loading, navigate])

    // Show loading spinner while checking auth
    if (loading) {
        return (
            <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
                Loading...
            </div>
        )
    }

    // Not logged in → show login
    if (!user) {
        return <Login />
    }

    // Logged in but no role found in school_members
    if (!role) {
        return (
            <div style={{ padding: 20 }}>
                <h2>Account not configured</h2>
                <p>Your account exists but has no role assigned in any school.</p>
                <p>Contact your school administrator to be added as a teacher, student, or admin.</p>
                <br />
                <button onClick={signOut}>Sign Out</button>
            </div>
        )
    }

    const defaultRoute = getDefaultRoute(role)

    return (
        <div style={{ padding: 20 }}>
            {isImpersonating && (
                <ImpersonationBanner
                    email={email}
                    role={role}
                    realUserEmail={realUserEmail}
                />
            )}
            {impersonationEnded && (
                <ImpersonationEndedToast onDismiss={dismissImpersonationEnded} />
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>SAIL Platform</h1>
                <div style={{ fontSize: '0.9em', color: '#666' }}>
                    <span style={{
                        background: '#f0f0f0',
                        padding: '3px 8px',
                        borderRadius: 4,
                        fontWeight: 600,
                        marginRight: 10,
                    }}>
                        {ROLE_LABELS[role] || role}
                    </span>
                    {user.email}
                    {' '}
                    <button
                        onClick={signOut}
                        style={{
                            background: 'none',
                            border: '1px solid #ccc',
                            padding: '3px 10px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: '0.9em',
                        }}
                    >
                        Sign Out
                    </button>
                </div>
            </div>

            <nav>
                {CAN.viewDashboard(role) && (
                    <><Link to="/">Dashboard</Link> | </>
                )}
                {CAN.viewAssignments(role) && (
                    <><Link to="/assignments">Assignments</Link> | </>
                )}
                {CAN.viewGradebook(role) && (
                    <><Link to="/gradebook">Gradebook</Link></>
                )}
                {CAN.viewMyAssignments(role) && (
                    <><Link to="/my-assignments">My Assignments</Link> | </>
                )}
                {role === 'student' && (
                    <><Link to="/my-grades">My Grades</Link></>
                )}
            </nav>

            <hr />

            <Routes>
                {/* Staff routes */}
                {CAN.viewDashboard(role) && (
                    <Route path="/" element={<Dashboard />} />
                )}
                {CAN.viewAssignments(role) && (
                    <Route path="/assignments" element={<Assignments />} />
                )}
                {/*
                  Phase 6D: per-class teacher surface. Route is open to
                  any authenticated member with a school role — RLS on
                  classes / assignments / student_assignments enforces
                  what's actually visible (same-school-member SELECT,
                  staff-only writes via the RPC's own gate). Students
                  hitting this URL see the page in read-only mode (no
                  Create button renders because CAN.createAssignment is
                  false for student).
                */}
                <Route path="/class/:classId" element={<ClassPage />} />
                {/* Phase A — attendance vertical. Same RLS posture as
                    /class/:classId: any school member can land on the
                    page; only staff can mark (the bridge_create_*
                    RPC's own gate enforces that, the page renders
                    read-only for non-staff). */}
                <Route path="/class/:classId/attendance" element={<AttendancePage />} />
                {CAN.viewGradebook(role) && (
                    <Route path="/gradebook" element={<Gradebook />} />
                )}

                {/* Student routes */}
                {/*
                  Phase 6E: /my-assignments is the student's primary
                  surface. Lists every assignment in their school,
                  shows submission status per row, accepts inline
                  submissions via bridge_submit_assignment. RLS
                  filters submissions to the caller's own rows so
                  there's no cross-student visibility risk even if
                  a non-student lands here.
                */}
                {CAN.viewMyAssignments(role) && (
                    <Route path="/my-assignments" element={<MyAssignmentsPage />} />
                )}
                {CAN.viewOwnGrades(role) && (
                    <Route path="/my-grades" element={
                        <div>
                            <h2>My Grades</h2>
                            <p>Student grade view coming soon.</p>
                        </div>
                    } />
                )}

                {/* Catch-all → redirect to role-appropriate default */}
                <Route path="*" element={<Navigate to={defaultRoute} />} />
            </Routes>
        </div>
    )
}

export default App
