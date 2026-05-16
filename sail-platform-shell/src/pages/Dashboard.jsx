import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { usePermissions } from '../app/providers/PermissionsProvider'
import { CAN, ROLE_LABELS } from '../lib/permissions'

/**
 * Dashboard — Phase 1 anchor surface.
 *
 * Refactored 2026-05-12 (frontend alignment pass):
 *   - All direct `.from(...)` table reads replaced with Helm RPC
 *     calls through the api client.
 *   - Class + assignment counts derived from `api.classes.list()`
 *     (which returns `enrollment_count` and `assignment_count` per
 *     row server-side).
 *   - Member counts only fetched when `can('helm.school.manage')` —
 *     teachers/students do not get a totals card.
 *   - School name fetched via `api.schools.get()` (M7 RPC).
 */
export default function Dashboard() {
    const { email, role, schoolId } = useAuth()
    // DB-backed gate for helm.school.manage (controls members-card fetch
    // and render). viewDashboard and provisionSchool still use static CAN.
    const { can } = usePermissions()
    // Hoisted boolean so the data-fetch effect below can declare a stable
    // primitive dep instead of `can` (whose ref changes on every shadow
    // state update — would re-fire the effect repeatedly without changing
    // outcome). The effect now re-runs only when the answer actually flips.
    const canManageSchool = can('helm.school.manage')

    const [schoolName, setSchoolName] = useState(null)
    const [stats, setStats] = useState({
        classes:     0,
        assignments: 0,
        students:    0,
        members:     0,
    })
    // 'loading' | 'ready' | 'error'
    const [status, setStatus] = useState('loading')
    const [errorMessage, setErrorMessage] = useState(null)

    useEffect(() => {
        if (!schoolId) {
            // Handled by the tenant-required gate below; skip the fetch.
            return undefined
        }

        let cancelled = false

        ;(async () => {
            setStatus('loading')
            setErrorMessage(null)

            try {
                // School metadata (name) via the Helm get_school RPC.
                const { data: schoolRows, error: schoolErr } = await api.schools.get(schoolId)
                if (schoolErr) throw schoolErr

                // Class list — already returns per-class assignment_count
                // and enrollment_count so we can aggregate client-side
                // without further round trips.
                const { data: classRows, error: classesErr } = await api.classes.list(schoolId)
                if (classesErr) throw classesErr

                const classesArr = classRows || []
                const classesCount     = classesArr.length
                const assignmentsCount = classesArr.reduce(
                    (sum, c) => sum + (c.assignment_count ?? 0), 0,
                )
                const studentsCount    = classesArr.reduce(
                    (sum, c) => sum + (c.enrollment_count ?? 0), 0,
                )

                // Members card is admin-only; only fetch when visible. Failure
                // here (e.g. permission denied) should NOT break the rest of
                // the dashboard — fall back to 0 and log.
                let membersCount = 0
                if (canManageSchool) {
                    const { data: memberRows, error: membersErr } = await api.members.list(schoolId)
                    if (membersErr) {
                        // eslint-disable-next-line no-console
                        console.warn('[Dashboard] members list failed (non-blocking):', membersErr.message)
                    } else {
                        membersCount = (memberRows || []).length
                    }
                }

                if (cancelled) return

                setSchoolName((schoolRows && schoolRows[0]?.name) ?? null)
                setStats({
                    classes:     classesCount,
                    assignments: assignmentsCount,
                    students:    studentsCount,
                    members:     membersCount,
                })
                setStatus('ready')
            } catch (err) {
                if (cancelled) return
                // eslint-disable-next-line no-console
                console.warn('[Dashboard] stats load failed:', err?.message)
                setErrorMessage(err?.message ?? 'unknown error')
                setStatus('error')
            }
        })()

        return () => {
            cancelled = true
        }
    }, [schoolId, role, canManageSchool])

    // Defensive double-gate. Route registration in App.jsx already gates
    // `/` on CAN.viewDashboard, but if rendered some other way the page
    // refuses to render for an ineligible role.
    if (!CAN.viewDashboard(role)) {
        return (
            <div>
                <h2>Dashboard</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }

    // Tenant-required, not tenant-aware. Without a school context, redirect
    // to provisioning if allowed; else hard-block.
    if (!schoolId) {
        if (CAN.provisionSchool(role)) {
            return <Navigate to="/provisioning" replace />
        }
        return (
            <div>
                <h2>Dashboard</h2>
                <p>
                    Your account is signed in but is not attached to any school.
                    {' '}
                    Contact your school administrator to be added to a school.
                </p>
            </div>
        )
    }

    return (
        <div>
            <h2>Dashboard</h2>

            <section style={IDENTITY_STRIP_STYLE}>
                <div>
                    <strong>User: </strong>
                    {email || '(unknown)'}
                </div>
                <div>
                    <strong>School: </strong>
                    {schoolName || (schoolId ? '(unnamed)' : 'No school assigned')}
                </div>
                <div>
                    <strong>Role: </strong>
                    {ROLE_LABELS[role] || role || '(unknown)'}
                </div>
            </section>

            {status === 'loading' && <p>Loading dashboard…</p>}

            {status === 'error' && (
                <p>
                    Could not load dashboard data: <code>{errorMessage}</code>
                </p>
            )}

            {status === 'ready' && (
                <section style={CARDS_STYLE}>
                    <StatCard label="Classes"     value={stats.classes} />
                    <StatCard label="Assignments" value={stats.assignments} />
                    <StatCard label="Students"    value={stats.students} />
                    {can('helm.school.manage') && (
                        <StatCard label="Members" value={stats.members} />
                    )}
                </section>
            )}
        </div>
    )
}

// ─── Presentational pieces (kept inline so the page stays one file) ────────

function StatCard({ label, value }) {
    return (
        <div style={CARD_STYLE}>
            <div style={CARD_LABEL_STYLE}>{label}</div>
            <div style={CARD_VALUE_STYLE}>{value}</div>
        </div>
    )
}

const IDENTITY_STRIP_STYLE = {
    display:        'flex',
    flexWrap:       'wrap',
    gap:            16,
    padding:        '8px 0',
    borderTop:      '1px solid #eee',
    borderBottom:   '1px solid #eee',
    margin:         '12px 0',
    fontSize:       14,
}
const CARDS_STYLE = {
    display:  'flex',
    flexWrap: 'wrap',
    gap:      12,
}
const CARD_STYLE = {
    border:       '1px solid #ddd',
    borderRadius: 4,
    padding:      '10px 14px',
    minWidth:     120,
}
const CARD_LABEL_STYLE = {
    fontSize: 12,
    color:    '#666',
}
const CARD_VALUE_STYLE = {
    fontSize:   22,
    fontWeight: 600,
}
