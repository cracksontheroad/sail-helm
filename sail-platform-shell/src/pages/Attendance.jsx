import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { CAN } from '../lib/permissions'
import { supabase } from '../lib/supabaseClient'
import { getClass } from '../services/classes'
import {
    createAttendanceSession,
    saveAttendanceRegister,
    findAttendanceSessionForDate,
    listAttendanceSessionsForClass,
} from '../services/attendance'

/**
 * /class/:classId/attendance — Phase A + Phase B
 *
 * Phase A shipped the core register: open session → mark students →
 * save. Phase B adds session continuity:
 *
 *   * Page load FINDS the session (read-only lookup), it doesn't
 *     auto-create. If none exists, the operator sees a "Start
 *     register" CTA. This means navigating to the page no longer
 *     spuriously emits attendance.session_started — the audit event
 *     fires only when an operator actively decides to take attendance
 *     for that day.
 *
 *   * Recent Sessions panel shows the last 5 sessions for the class
 *     with present/absent/late counts. Clicking a row sets the date
 *     picker + reloads. Counts come pre-aggregated from
 *     bridge_list_attendance_sessions_for_class so the panel is one
 *     RPC, not N+1.
 *
 *   * After save, the recent list refreshes so the just-saved session
 *     surfaces with its new counts. The selected date is preserved
 *     (no "reset flicker" — the session stays loaded for further
 *     edits).
 *
 * Permissions / RLS — unchanged from Phase A:
 *   * Reads gate on school membership (RLS on attendance_sessions /
 *     attendance_records / classes).
 *   * Writes gate on is_staff_of_school OR has_permission(manage_attendance)
 *     enforced server-side by the RPCs. Helm pre-hides the Save +
 *     Start CTA buttons via CAN.createAssignment(role) for snappier
 *     UX, but the server is the boundary.
 */

const STATUS_OPTIONS = [
    { value: 'present', label: 'Present' },
    { value: 'absent',  label: 'Absent'  },
    { value: 'late',    label: 'Late'    },
]

function ErrorBox({ error }) {
    if (!error) return null
    return (
        <div style={{
            padding: '8px 12px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 4,
            color: '#991b1b',
            fontSize: 13,
            margin: '8px 0',
        }}>
            {error.message || String(error)}
        </div>
    )
}

function todayISO() {
    // Local-time YYYY-MM-DD. The teacher-facing concept is "today's
    // school day", not UTC.
    const d = new Date()
    const yy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yy}-${mm}-${dd}`
}

function formatLongDate(iso) {
    if (!iso) return ''
    // Render YYYY-MM-DD strings as "Mon, May 8" — keeps the recent
    // list scannable. Date constructor with just a date string parses
    // as UTC midnight; we want to show the date as-is so we use
    // toLocaleDateString with timeZone='UTC' to avoid an off-by-one in
    // negative-offset locales.
    try {
        const d = new Date(`${iso}T00:00:00Z`)
        return d.toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric',
            timeZone: 'UTC',
        })
    } catch {
        return iso
    }
}

export default function AttendancePage() {
    const { classId } = useParams()
    const { role } = useAuth()
    // Phase A: only staff (teacher / admin) can mark; students see the
    // page but can't save / start.
    const canMark = CAN.createAssignment(role)

    // Date the operator is taking attendance for. Default = today.
    const [sessionDate, setSessionDate] = useState(todayISO())

    // Loaded data
    const [klass,    setKlass]    = useState(null)
    const [session,  setSession]  = useState(null)   // null when no register exists for this date
    const [roster,   setRoster]   = useState([])     // [{ id, name, email }]
    const [marks,    setMarks]    = useState({})     // { [studentId]: 'present'|'absent'|'late' }
    const [loading,  setLoading]  = useState(true)
    const [error,    setError]    = useState(null)
    const [recentSessions, setRecentSessions] = useState([])

    // Save state
    const [saving,  setSaving]  = useState(false)
    const [saveErr, setSaveErr] = useState(null)
    const [summary, setSummary] = useState(null)   // { present_count, absent_count, late_count, total_count }
    // Phase B — Start register state. Distinct from saving because the
    // Start button enables before any session exists.
    const [starting, setStarting] = useState(false)

    // ── Recent sessions ────────────────────────────────────────────
    // Loaded once on page mount + after each save (so the just-saved
    // session surfaces with new counts). Gracefully empty on error
    // since the recent panel is decorative — failure shouldn't block
    // the main register.
    const refreshRecent = useCallback(async () => {
        if (!classId) return
        try {
            const rows = await listAttendanceSessionsForClass({ classId, limit: 5 })
            setRecentSessions(rows)
        } catch (err) {
            console.error('[Attendance] recent sessions load failed:', err.message)
            setRecentSessions([])
        }
    }, [classId])

    // ── Find-first load (Phase B) ──────────────────────────────────
    // Tries to LOAD the existing session for the chosen date. Does
    // NOT auto-create. If session is null, the UI renders a "Start
    // register" CTA instead of the editor.
    const refresh = useCallback(async () => {
        if (!classId || !sessionDate) return
        setLoading(true); setError(null); setSummary(null)
        try {
            // 1) Class metadata + roster — both unconditional.
            const [classRow, rosterResult, finder] = await Promise.all([
                getClass(classId),
                supabase.rpc('bridge_list_class_students', { p_class_id: classId }),
                findAttendanceSessionForDate({ classId, sessionDate }),
            ])
            if (rosterResult.error) throw rosterResult.error
            const rosterFormatted = (rosterResult.data || []).map((r) => ({
                id:    r.user_id,
                name:  r.full_name || r.email || r.user_id,
                email: r.email,
            }))

            // 2) Build initial marks. If session exists, prefill from
            // its records (fall back to 'present' for unmarked roster
            // members in case a new student joined since the register
            // was last saved). If no session, default everyone to
            // 'present' so a single Save click after Start does the
            // natural outcome.
            const existingMarks = (finder?.records || []).reduce((acc, r) => {
                acc[r.student_user_id] = r.status
                return acc
            }, {})
            const initialMarks = {}
            for (const s of rosterFormatted) {
                initialMarks[s.id] = existingMarks[s.id] || 'present'
            }

            setKlass(classRow)
            setRoster(rosterFormatted)
            setSession(finder?.session || null)
            setMarks(initialMarks)
        } catch (err) {
            setError(err)
        } finally {
            setLoading(false)
        }
    }, [classId, sessionDate])

    useEffect(() => { refresh() }, [refresh])
    useEffect(() => { refreshRecent() }, [refreshRecent])

    const setStatus = (studentId, status) => {
        setMarks((prev) => ({ ...prev, [studentId]: status }))
        setSummary(null)  // any change invalidates the prior save summary
    }

    // ── Phase C — live counts + bulk-mark helpers ──────────────────
    // liveCounts reflects the PENDING state (the marks the operator
    // is about to commit), distinct from `summary` (the post-save
    // banner showing the persisted state). Memoized over `marks`
    // and `roster` so the summary bar updates instantly per click.
    const liveCounts = useMemo(() => {
        let present = 0, absent = 0, late = 0
        for (const s of roster) {
            const status = marks[s.id] || 'present'
            if (status === 'present')      present++
            else if (status === 'absent')  absent++
            else if (status === 'late')    late++
        }
        return { present, absent, late, total: roster.length }
    }, [marks, roster])

    // Phase C — common real-world flow: "everyone is present, then
    // mark exceptions". Sets every roster member to 'present' in one
    // click. Doesn't auto-save — the operator still clicks Save after
    // adjusting exceptions. Silent override: any prior marks the
    // operator made get reset (KISS — they can refresh the page to
    // restore the persisted state, or click again on the exceptions).
    const markAllPresent = () => {
        const next = {}
        for (const s of roster) next[s.id] = 'present'
        setMarks(next)
        setSummary(null)
    }

    // Phase B — explicit "Start register" action. Calls the create
    // RPC (which also emits attendance.session_started exactly once)
    // and re-runs refresh() so the editor renders.
    const onStart = async () => {
        if (!canMark || starting) return
        setStarting(true); setSaveErr(null); setError(null)
        try {
            await createAttendanceSession({ classId, sessionDate })
            await refresh()
            await refreshRecent()
        } catch (err) {
            setSaveErr(err)
        } finally {
            setStarting(false)
        }
    }

    const onSave = async () => {
        if (!session?.id) return
        if (saving) return
        setSaving(true); setSaveErr(null); setSummary(null)
        try {
            const records = roster.map((s) => ({
                studentUserId: s.id,
                status:        marks[s.id] || 'present',
            }))
            const result = await saveAttendanceRegister({
                sessionId: session.id,
                records,
            })
            setSummary(result)
            // Phase B — the just-saved session's counts changed; the
            // Recent panel should reflect that. Don't reload the
            // editor (saving keeps the operator on the same date with
            // their state intact — no flicker).
            await refreshRecent()
        } catch (err) {
            setSaveErr(err)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div style={{ padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
            <div style={{ marginBottom: 12 }}>
                <Link to={`/class/${classId}`} style={{ fontSize: 12, color: '#5b6877' }}>
                    ← Back to class
                </Link>
            </div>
            <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>
                Take Register
            </h1>
            <div style={{ fontSize: 13, color: '#5b6877', marginBottom: 16 }}>
                {klass ? (
                    <>
                        {klass.name}
                        {klass.school?.name ? ` · ${klass.school.name}` : ''}
                    </>
                ) : (
                    'Loading class…'
                )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <label style={{ fontSize: 13, color: '#5b6877' }}>Date</label>
                <input
                    type="date"
                    value={sessionDate}
                    onChange={(e) => setSessionDate(e.target.value)}
                    disabled={saving || starting}
                    style={{ fontSize: 13, padding: '4px 8px', borderRadius: 4, border: '1px solid #d4d8de' }}
                />
                {/* Phase B status label — was "(new register)" / "(re-opening
                    existing register)" in Phase A; now derives from session
                    null vs row, which is the same signal but without the
                    create-on-load side-effect. */}
                {session ? (
                    <span style={{ fontSize: 11, color: '#7a8290' }}>
                        existing register
                    </span>
                ) : (
                    <span style={{ fontSize: 11, color: '#7a8290' }}>
                        no register yet
                    </span>
                )}
            </div>

            <ErrorBox error={error} />
            <ErrorBox error={saveErr} />

            {summary && (
                <div role="status" style={{
                    padding: '8px 12px',
                    background: '#e8f5e9',
                    border: '1px solid #b8d8be',
                    borderRadius: 4,
                    fontSize: 13,
                    margin: '0 0 12px',
                }}>
                    Saved — {summary.present_count} present
                    {summary.absent_count ? `, ${summary.absent_count} absent` : ''}
                    {summary.late_count   ? `, ${summary.late_count} late`     : ''}
                    {' '}({summary.total_count} total).
                </div>
            )}

            {/* ── Phase B: Start CTA when no register exists yet ──────── */}
            {!loading && !session && roster.length > 0 && (
                <div style={{
                    padding: '14px 16px',
                    background: '#f7f9fc',
                    border: '1px dashed #b8c4d4',
                    borderRadius: 6,
                    margin: '0 0 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                }}>
                    <span style={{ fontSize: 13, color: '#3a4654', flex: 1 }}>
                        No register has been started for {formatLongDate(sessionDate)} yet.
                    </span>
                    {canMark ? (
                        <button
                            type="button"
                            onClick={onStart}
                            disabled={starting}
                            style={{
                                fontSize: 13,
                                padding: '6px 14px',
                                borderRadius: 4,
                                border: 'none',
                                background: starting ? '#a8b3c4' : '#3b6cd8',
                                color: '#fff',
                                cursor: starting ? 'wait' : 'pointer',
                                fontWeight: 500,
                            }}
                        >
                            {starting ? 'Starting…' : 'Start register'}
                        </button>
                    ) : (
                        <span style={{ fontSize: 12, color: '#7a8290' }}>
                            Only teachers and admins can start a register.
                        </span>
                    )}
                </div>
            )}

            {/* ── Phase C — live summary bar + "Mark all present"
                  Both rendered only when a session exists (i.e.
                  marking is meaningful). Counts derive from `marks`
                  state so they update instantly per click. */}
            {session && roster.length > 0 && !loading && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                    padding: '8px 12px',
                    margin: '0 0 10px',
                    borderRadius: 6,
                    background: '#f7f9fc',
                    border: '1px solid #e3e6eb',
                    fontSize: 12.5,
                    color: '#3a4654',
                }}>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                        <span>
                            Present <strong style={{ color: '#1f8a4d' }}>{liveCounts.present}</strong>
                        </span>
                        <span>
                            Absent <strong style={{ color: liveCounts.absent > 0 ? '#a04545' : '#3a4654' }}>{liveCounts.absent}</strong>
                        </span>
                        <span>
                            Late <strong style={{ color: liveCounts.late > 0 ? '#a06c20' : '#3a4654' }}>{liveCounts.late}</strong>
                        </span>
                        <span style={{ color: '#7a8290' }}>
                            / {liveCounts.total} total
                        </span>
                    </div>
                    {canMark && (
                        <button
                            type="button"
                            onClick={markAllPresent}
                            disabled={saving}
                            title="Set every student to present (you can then flip exceptions)"
                            style={{
                                fontSize: 12,
                                padding: '4px 10px',
                                borderRadius: 4,
                                border: '1px solid #d4d8de',
                                background: '#fff',
                                color: '#3a4654',
                                cursor: saving ? 'default' : 'pointer',
                            }}
                        >
                            Mark all present
                        </button>
                    )}
                </div>
            )}

            {/* ── Roster + status pills (rendered for both no-session and
                  session-present cases). When no session exists, the
                  pills are disabled — operator must Start first. */}
            {loading ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>Loading register…</div>
            ) : roster.length === 0 ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>No students in this class.</div>
            ) : (
                <div style={{ border: '1px solid #e3e6eb', borderRadius: 6 }}>
                    {roster.map((s, i) => (
                        <div
                            key={s.id}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                padding: '10px 14px',
                                borderTop: i === 0 ? 'none' : '1px solid #e3e6eb',
                                fontSize: 13.5,
                                opacity: !session ? 0.55 : 1,
                            }}
                        >
                            <div style={{ minWidth: 0, flex: 1 }}>
                                {/* Phase D pair-route — student name links
                                    to the canonical Student parent page.
                                    Falls back to plain text when the
                                    page hasn't resolved school context
                                    yet (initial render before getClass
                                    resolves). */}
                                <div style={{ fontWeight: 500, color: '#161b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {klass?.school?.id ? (
                                        <Link
                                            to={`/schools/${klass.school.id}/students/${s.id}`}
                                            style={{ color: '#161b22', textDecoration: 'none' }}
                                        >
                                            {s.name}
                                        </Link>
                                    ) : (
                                        s.name
                                    )}
                                </div>
                                {s.email && s.email !== s.name && (
                                    <div style={{ fontSize: 11.5, color: '#7a8290', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {s.email}
                                    </div>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                {STATUS_OPTIONS.map((opt) => {
                                    const active = (marks[s.id] || 'present') === opt.value
                                    const disabled = !canMark || saving || !session
                                    return (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            disabled={disabled}
                                            onClick={() => setStatus(s.id, opt.value)}
                                            style={{
                                                fontSize: 12,
                                                padding: '4px 10px',
                                                borderRadius: 4,
                                                border: '1px solid ' + (active ? '#3b6cd8' : '#d4d8de'),
                                                background: active ? '#dde6f7' : '#fff',
                                                color: active ? '#1f3d80' : '#161b22',
                                                cursor: disabled ? 'default' : 'pointer',
                                                fontWeight: active ? 600 : 400,
                                            }}
                                        >
                                            {opt.label}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {canMark && roster.length > 0 && session && (
                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={saving}
                        style={{
                            fontSize: 13,
                            padding: '7px 16px',
                            borderRadius: 4,
                            border: 'none',
                            background: saving ? '#a8b3c4' : '#3b6cd8',
                            color: '#fff',
                            cursor: saving ? 'wait' : 'pointer',
                            fontWeight: 500,
                        }}
                    >
                        {saving ? 'Saving…' : 'Save register'}
                    </button>
                </div>
            )}
            {!canMark && (
                <div style={{ marginTop: 16, fontSize: 12, color: '#7a8290' }}>
                    Read-only — only teachers and admins can mark attendance.
                </div>
            )}

            {/* ── Phase B: Recent Sessions panel ────────────────────────────
                  Last 5 sessions for the class with present/absent/late
                  counts, clickable to load. Lives below the main register
                  so it's discoverable without crowding the primary action.
                  Decorative (failure to load isn't fatal). */}
            {recentSessions.length > 0 && (
                <div style={{ marginTop: 32 }}>
                    <h3 style={{ fontSize: 13, fontWeight: 600, color: '#5b6877',
                                 textTransform: 'uppercase', letterSpacing: '0.06em',
                                 margin: '0 0 8px' }}>
                        Recent sessions
                    </h3>
                    <div style={{ border: '1px solid #e3e6eb', borderRadius: 6 }}>
                        {recentSessions.map((s, i) => {
                            const isCurrent = s.sessionDate === sessionDate
                            return (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => setSessionDate(s.sessionDate)}
                                    disabled={isCurrent || saving || starting}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 12,
                                        width: '100%',
                                        padding: '8px 14px',
                                        borderTop: i === 0 ? 'none' : '1px solid #e3e6eb',
                                        background: isCurrent ? '#f0f5ff' : 'none',
                                        border: 'none',
                                        cursor: isCurrent ? 'default' : 'pointer',
                                        textAlign: 'left',
                                        fontSize: 12.5,
                                    }}
                                >
                                    <span style={{ fontWeight: 500, color: '#161b22', minWidth: 130 }}>
                                        {formatLongDate(s.sessionDate)}
                                        {isCurrent && (
                                            <span style={{ marginLeft: 6, fontSize: 11, color: '#3b6cd8' }}>
                                                · current
                                            </span>
                                        )}
                                    </span>
                                    <span style={{ display: 'flex', gap: 10, color: '#5b6877' }}>
                                        <span title="present">✓ {s.presentCount}</span>
                                        <span title="absent" style={{ color: s.absentCount > 0 ? '#a04545' : undefined }}>
                                            ✕ {s.absentCount}
                                        </span>
                                        <span title="late" style={{ color: s.lateCount > 0 ? '#a06c20' : undefined }}>
                                            ⏱ {s.lateCount}
                                        </span>
                                        <span style={{ color: '#7a8290' }} title="total marked">
                                            / {s.totalCount}
                                        </span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                </div>
            )}
        </div>
    )
}
