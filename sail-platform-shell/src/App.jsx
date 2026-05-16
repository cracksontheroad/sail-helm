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

    // ── First DB-permission consumer (observation-only) ────────────────
    // FOUNDATION step: read can() from the new DB-backed PermissionsProvider
    // and compare its answer for `helm.dashboard.view` against the existing
    // static `CAN.viewDashboard(role)` gate. The render decision below
    // (`{CAN.viewDashboard(role) && <Link to="/">Dashboard</Link>}`) is
    // INTENTIONALLY UNCHANGED — static remains the source of truth for
    // visibility. The dual-check exists so a divergence (e.g. DB grants
    // drift away from the static predicate, or a role we haven't mapped
    // yet signs in) is observable via a console warning rather than
    // silently rendering the wrong UI. Remove or expand to additional
    // gates after the foundation has soaked.
    const { can } = usePermissions()
    useEffect(() => {
        const allowedStatic = CAN.viewDashboard(role)
        const allowedDB     = can('helm.dashboard.view')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.dashboard.view',
                staticKey:     'viewDashboard',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])

    // Second drift probe — `helm.grades.view_own` (2026-05-16). Same shape as
    // the dashboard probe above. Picked specifically because it inverts the
    // role polarity (dashboard = staff-only; grades.view_own = student-only)
    // and uses a different static predicate shape (`r === 'student'` vs
    // `isStaff(r)`). If anything in the permissions layer were subtly biased
    // toward higher-rank roles, this is where it would surface.
    useEffect(() => {
        const allowedStatic = CAN.viewOwnAssignments(role)
        const allowedDB     = can('helm.grades.view_own')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.grades.view_own',
                staticKey:     'viewOwnAssignments',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])

    // Third drift probe — `helm.members.view` (2026-05-16). Members is the
    // first FEATURE-AREA batch migration: nav + route + Members.jsx page-
    // level gate all flip together. Static `isAdmin(r)` admits admin OR
    // super_admin; DB grants admit admin only — so this probe would fire
    // for super_admin sessions (none in current fixtures, but the
    // observable warning is what would catch a future super_admin signing
    // in before the static predicate is tightened or the DB grant added).
    useEffect(() => {
        const allowedStatic = CAN.viewMembers(role)
        const allowedDB     = can('helm.members.view')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.members.view',
                staticKey:     'viewMembers',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])

    // Fourth drift probe — `helm.school.manage` (2026-05-16). School/Settings
    // is the second FEATURE-AREA batch: nav + route + Settings.jsx page-level
    // gate + two Dashboard.jsx usages (members-fetch gate + members stat-card
    // render). Same shape as members: static `isAdmin(r)` admits admin OR
    // super_admin; DB admits admin only → drift surfaces for super_admin
    // sessions only.
    useEffect(() => {
        const allowedStatic = CAN.manageSchool(role)
        const allowedDB     = can('helm.school.manage')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.school.manage',
                staticKey:     'manageSchool',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])

    // Fifth/sixth/seventh drift probes — Assignments surface (2026-05-16).
    // FIRST INTENTIONAL DRIFT BATCH: static `viewAssignments(r) = Boolean(r)`
    // is overly permissive (Phase 2 R2 transitional state — students still
    // had /assignments access before /my-assignments shipped); DB grants
    // restrict to staff. The flip below tightens UI to match DB, removing
    // a redundant secondary student surface. After the flip, drift stops
    // firing because both paths agree.
    useEffect(() => {
        const allowedStatic = CAN.viewAssignments(role)
        const allowedDB     = can('helm.assignments.view')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.assignments.view',
                staticKey:     'viewAssignments',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])
    useEffect(() => {
        const allowedStatic = CAN.createAssignment(role)
        const allowedDB     = can('helm.assignments.create')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.assignments.create',
                staticKey:     'createAssignment',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])
    useEffect(() => {
        const allowedStatic = CAN.submitAssignment(role)
        const allowedDB     = can('helm.assignments.submit')
        if (allowedStatic !== allowedDB) {
            // eslint-disable-next-line no-console
            console.warn('[Permissions drift]', {
                permission:    'helm.assignments.submit',
                staticKey:     'submitAssignment',
                role,
                allowedStatic,
                allowedDB,
            })
        }
    }, [role, can])

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
                {CAN.viewGradebook(role) && (
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
                {CAN.viewGradebook(role) && (
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
