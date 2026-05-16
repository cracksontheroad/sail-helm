import { useEffect, useRef } from 'react'
import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from './lib/AuthContext'
import { usePermissions } from './app/providers/PermissionsProvider'
import { CAN, ROLE_LABELS, getDefaultRoute } from './lib/permissions'
import {
    impersonatedUserId,
    impersonationSessionId,
    impersonationRedirect,
} from './lib/supabaseClient'
import api from './services/api'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Assignments from './pages/Assignments'
import Gradebook from './pages/Gradebook'
import Provisioning from './pages/Provisioning'
import Members from './pages/Members'
import Settings from './pages/Settings'
import Courses from './pages/Courses'
import Attendance from './pages/Attendance'
import CopilotReviewStruggling from './pages/CopilotReviewStruggling'
import MyAssignments from './pages/MyAssignments'
import Behaviour from './pages/Behaviour'
import Timeline from './pages/Timeline'

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
        await api.auth.stopImpersonation(impersonatedUserId, impersonationSessionId)
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
    } = useAuth()
    const navigate = useNavigate()
    // Guard so the deep-link redirect fires exactly once per page load.
    // Without this, every re-render after the navigate() would try to
    // navigate again (the URL still contains ?redirect=…).
    const didRedirectRef = useRef(false)

    // DB-backed permission gate used throughout the nav + routes below.
    // The earlier drift probes that compared can() against static CAN.*
    // for each migrated permission have been removed after 7 successive
    // batches of zero-drift verification — see commit history for the
    // observational data they produced. `can()` is now the sole source
    // of truth for migrated permissions; the static CAN.* entries that
    // remain are for surfaces that haven't been migrated yet (courses /
    // attendance / behaviour / timeline / copilot / provisioning, plus
    // a few defensive page-level double-gates).
    const { can, loading: permissionsLoading } = usePermissions()

    // Deep-link redirect: when Bridge opens Helm with `?redirect=/path`,
    // navigate there once auth + permissions have BOTH resolved. We wait
    // for `loading=false` AND `permissionsLoading=false` because
    // navigating during either loading phase races with the route-table
    // render — routes are gated on can() and won't register until
    // permissions resolve, so a too-early navigate hits the catch-all
    // and silently redirects to the role-default route instead of the
    // requested deep-link target. We don't gate on `user` because the
    // redirect is desirable even on the login page (after sign-in
    // completes, Helm's existing flow lands on the role-default route
    // — the redirect overrides that and lands the operator on the
    // support target instead).
    useEffect(() => {
        if (loading) return
        if (permissionsLoading) return
        if (didRedirectRef.current) return
        if (!impersonationRedirect) return
        didRedirectRef.current = true
        navigate(impersonationRedirect, { replace: true })
    }, [loading, permissionsLoading, navigate])

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

    // Auth resolved but permissions still fetching. Without this guard the
    // main render below would compute its Routes block with can() returning
    // false for everything (shadow not yet bound to current authKey), no
    // permission-gated route would register, and the catch-all would
    // silently redirect deep-links to the role-default route. Brief
    // loading state is preferable to that silent breakage.
    //
    // Safe to gate above the !role branch below: `permissionsLoading` is
    // `isAuthed && (...)` where `isAuthed` requires both authUserId AND
    // authSchoolId — so unprovisioned users (no school) skip this guard
    // entirely and land in the provisioning flow without waiting.
    if (permissionsLoading) {
        return (
            <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
                Loading...
            </div>
        )
    }

    // Logged in but no role found in school_members.
    //
    // Phase 1 Route 2 (HELM_REBUILD_PLAN.md §3, planner 2026-05-12):
    // unprovisioned users are routed into the provisioning flow rather
    // than dead-ended on an "Account not configured" screen. The
    // Provisioning page itself re-checks CAN.provisionSchool(role) and
    // hard-blocks if the caller is not allowed. We render a minimal
    // Routes block here so deep links and the catch-all redirect both
    // work cleanly.
    if (!role) {
        return (
            <div style={{ padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h1>SAIL Platform</h1>
                    <div style={{ fontSize: '0.9em', color: '#666' }}>
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
                <hr />
                <Routes>
                    <Route path="/provisioning" element={<Provisioning />} />
                    <Route path="*" element={<Navigate to="/provisioning" replace />} />
                </Routes>
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
                {/* FIRST REAL can() CONSUMER (2026-05-16): the Dashboard
                    nav link is gated by the DB-backed PermissionsProvider
                    via `can('helm.dashboard.view')` instead of the static
                    `CAN.viewDashboard(role)` predicate. The drift probe
                    in the useEffect above continues to compare the two
                    paths and console.warn on divergence — both as
                    runtime assertion during this transition AND so
                    expanding to additional gates remains an observable
                    rollout. The route gate below (line 325) still uses
                    static CAN as a safety belt; flip routes only after
                    additional consumers soak cleanly. */}
                {can('helm.dashboard.view') && (
                    <><Link to="/">Dashboard</Link> | </>
                )}
                {CAN.viewCourses(role) && (
                    <><Link to="/courses">Courses</Link> | </>
                )}
                {/* Assignments nav — Assignments FEATURE-AREA batch
                    (2026-05-16). This batch INTENTIONALLY tightens the
                    student-side: static `Boolean(r)` admitted any role
                    (Phase 2 R2 transitional state), but DB grants restrict
                    to staff. Students now use /my-assignments for their
                    own assignments + submission (already on can()). */}
                {can('helm.assignments.view') && (
                    <><Link to="/assignments">Assignments</Link> | </>
                )}
                {/* Gradebook nav — Gradebook FEATURE-AREA batch
                    (2026-05-16). Policy correction landed in DB
                    (student grant for helm.gradebook.view); UI
                    unchanged. Unified surface preserved: staff +
                    students both access /gradebook, server-side
                    filtering keeps the row-level scope correct. */}
                {can('helm.gradebook.view') && (
                    <><Link to="/gradebook">Gradebook</Link> | </>
                )}
                {CAN.viewAttendance(role) && (
                    <><Link to="/attendance">Attendance</Link> | </>
                )}
                {CAN.viewBehaviour(role) && (
                    <><Link to="/behaviour">Behaviour</Link> | </>
                )}
                {CAN.viewTimeline(role) && (
                    <><Link to="/timeline">Timeline</Link> | </>
                )}
                {CAN.useCopilot(role) && (
                    <><Link to="/copilot/review-struggling">Copilot</Link> | </>
                )}
                {/* Members nav — first FEATURE-AREA batch (2026-05-16).
                    Nav + route below + Members.jsx page gate all flip
                    together to can('helm.members.view'). */}
                {can('helm.members.view') && (
                    <><Link to="/members">Members</Link> | </>
                )}
                {/* Settings nav — School/Settings FEATURE-AREA batch
                    (2026-05-16). Five-surface migration across App.jsx
                    (nav + route) + Settings.jsx (page gate) + Dashboard.jsx
                    (members-fetch gate + stat-card render). */}
                {can('helm.school.manage') && (
                    <><Link to="/settings">Settings</Link></>
                )}
                {/* Second can() consumer (2026-05-16): My Assignments nav.
                    Same pattern as the Dashboard flip — DB-backed via
                    can('helm.grades.view_own'). The route below (~line 368)
                    still uses static CAN.viewOwnAssignments(role) as the
                    safety belt; flip routes after the nav has soaked. */}
                {can('helm.grades.view_own') && (
                    <><Link to="/my-assignments">My Assignments</Link></>
                )}
            </nav>

            <hr />

            <Routes>
                {/* Staff routes */}
                {/* Dashboard route — also gated by can() (2026-05-16),
                    matching the nav link above. Completes end-to-end
                    DB-backed control for `helm.dashboard.view`:
                    nav visibility + route registration both driven by
                    the same source of truth. When can() returns false,
                    this Route isn't registered and the catch-all at
                    the bottom (<Navigate to={defaultRoute} />) handles
                    the redirect for direct URL hits. Other routes
                    remain on static CAN until they migrate. */}
                {can('helm.dashboard.view') && (
                    <Route path="/" element={<Dashboard />} />
                )}
                {CAN.viewCourses(role) && (
                    <Route path="/courses" element={<Courses />} />
                )}
                {/* /assignments route — flipped with the batch. When can()
                    returns false the Route isn't registered; the catch-all
                    redirects students to their defaultRoute (/my-assignments). */}
                {can('helm.assignments.view') && (
                    <Route path="/assignments" element={<Assignments />} />
                )}
                {/* /gradebook route — flipped with the batch. */}
                {can('helm.gradebook.view') && (
                    <Route path="/gradebook" element={<Gradebook />} />
                )}
                {CAN.viewAttendance(role) && (
                    <Route path="/attendance" element={<Attendance />} />
                )}
                {CAN.viewBehaviour(role) && (
                    <Route path="/behaviour" element={<Behaviour />} />
                )}
                {CAN.viewTimeline(role) && (
                    <Route path="/timeline" element={<Timeline />} />
                )}
                {CAN.useCopilot(role) && (
                    <Route path="/copilot/review-struggling" element={<CopilotReviewStruggling />} />
                )}
                {/* Members route — flipped together with the nav and
                    Members.jsx page gate in the same batch. */}
                {can('helm.members.view') && (
                    <Route path="/members" element={<Members />} />
                )}
                {/* Settings route — flipped with the rest of the
                    School/Settings batch (2026-05-16). */}
                {can('helm.school.manage') && (
                    <Route path="/settings" element={<Settings />} />
                )}

                {/* Student routes — /my-assignments now end-to-end
                    can()-controlled (2026-05-16): nav at line ~333 and
                    this route both gate on can('helm.grades.view_own').
                    Same pattern as helm.dashboard.view, exercising the
                    inverse polarity (student-only). When the gate is
                    false the Route isn't registered and the catch-all
                    redirects to the caller's defaultRoute. */}
                {can('helm.grades.view_own') && (
                    <Route path="/my-assignments" element={<MyAssignments />} />
                )}

                {/* Provisioning — available to anyone CAN.provisionSchool admits.
                    The page re-validates and hard-blocks if the caller is
                    not actually permitted. */}
                {CAN.provisionSchool(role) && (
                    <Route path="/provisioning" element={<Provisioning />} />
                )}

                {/* Catch-all → redirect to role-appropriate default */}
                <Route path="*" element={<Navigate to={defaultRoute} />} />
            </Routes>
        </div>
    )
}

export default App
