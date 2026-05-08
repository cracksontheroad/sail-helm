import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { CAN } from '../lib/permissions'
import { supabase } from '../lib/supabaseClient'
import { getClass } from '../services/classes'
import {
    createAttendanceSession,
    saveAttendanceRegister,
    getAttendanceSession,
} from '../services/attendance'

/**
 * /class/:classId/attendance — Phase A
 *
 * Teacher-facing attendance register. One vertical slice:
 *
 *   * Open (or re-open) today's session for the class —
 *     bridge_create_attendance_session is idempotent.
 *   * Load the class roster — bridge_list_class_students.
 *   * Load any existing marks for this session —
 *     bridge_get_attendance_session.
 *   * Render a row per student with a status select
 *     (present / absent / late). Default = present for unmarked rows.
 *   * Save → bridge_save_attendance_register (bulk upsert in one RPC).
 *     Per-row audit triggers fire on the backend.
 *
 * UI is intentionally minimal — the goal is "teacher takes register
 * in 30 seconds", not a polished design surface. Matches Class.jsx's
 * inline-style posture so the two pages feel consistent.
 *
 * RLS / permission model:
 *   * Reads (roster + session + records) succeed for any school member
 *     of the class's school (RLS).
 *   * Writes are gated server-side by is_staff_of_school OR
 *     manage_attendance — Helm doesn't pre-check; the RPC raises 42501
 *     for non-staff and we surface that as an inline error.
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

export default function AttendancePage() {
    const { classId } = useParams()
    const { role } = useAuth()
    // Phase A: only staff (teacher / admin) can mark; students see the
    // page but can't save. Mirrors Class.jsx's CAN.createAssignment
    // posture.
    const canMark = CAN.createAssignment(role)

    // Date the operator is taking attendance for. Default = today.
    const [sessionDate, setSessionDate] = useState(todayISO())

    // Loaded data
    const [klass,    setKlass]    = useState(null)
    const [session,  setSession]  = useState(null)   // { id, ... }
    const [roster,   setRoster]   = useState([])     // [{ id, name, email }]
    const [marks,    setMarks]    = useState({})     // { [studentId]: 'present'|'absent'|'late' }
    const [loading,  setLoading]  = useState(true)
    const [error,    setError]    = useState(null)

    // Save state
    const [saving,   setSaving]   = useState(false)
    const [saveErr,  setSaveErr]  = useState(null)
    const [summary,  setSummary]  = useState(null)   // { present_count, absent_count, late_count, total_count }

    const refresh = useCallback(async () => {
        if (!classId || !sessionDate) return
        setLoading(true); setError(null); setSummary(null)
        try {
            // 1) Class metadata (also implicitly gates: if the user
            // can't read this class, getClass throws and we fall into
            // the error block).
            const classRow = await getClass(classId)

            // 2) Roster (RLS: school members of the class's school).
            const { data: rosterRows, error: rosterErr } = await supabase.rpc(
                'bridge_list_class_students', { p_class_id: classId },
            )
            if (rosterErr) throw rosterErr
            const rosterFormatted = (rosterRows || []).map((r) => ({
                id:    r.user_id,
                name:  r.full_name || r.email || r.user_id,
                email: r.email,
            }))

            // 3) Open or re-open the session for the chosen date. If
            // the user is a student, this RPC will refuse with 42501
            // — we catch it below to keep the rest of the page usable
            // (they can still see the roster + their own existing mark
            // via the SECURITY INVOKER read RPC further down).
            let sessionRow = null
            try {
                sessionRow = await createAttendanceSession({
                    classId, sessionDate,
                })
            } catch (rpcErr) {
                // Non-staff falls through here. Surface the message so
                // the operator knows why the page is read-only.
                if (canMark) throw rpcErr
                // For students: we still want to show their existing
                // mark for the day. Look up the session indirectly by
                // listing — but Phase A skips that complexity. Just
                // render the empty roster state with a notice.
            }

            // 4) Load existing records for the session (if any).
            let existingMarks = {}
            if (sessionRow?.id) {
                const sess = await getAttendanceSession(sessionRow.id)
                existingMarks = (sess?.records || []).reduce((acc, r) => {
                    acc[r.student_user_id] = r.status
                    return acc
                }, {})
            }

            // Default unmarked rows to 'present' so a teacher who
            // hits Save without touching anyone has the natural
            // outcome ("everyone's here").
            const initialMarks = {}
            for (const s of rosterFormatted) {
                initialMarks[s.id] = existingMarks[s.id] || 'present'
            }

            setKlass(classRow)
            setRoster(rosterFormatted)
            setSession(sessionRow)
            setMarks(initialMarks)
        } catch (err) {
            setError(err)
        } finally {
            setLoading(false)
        }
    }, [classId, sessionDate, canMark])

    useEffect(() => { refresh() }, [refresh])

    const setStatus = (studentId, status) => {
        setMarks((prev) => ({ ...prev, [studentId]: status }))
        setSummary(null)  // a fresh save will produce a fresh summary
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
                    disabled={saving}
                    style={{ fontSize: 13, padding: '4px 8px', borderRadius: 4, border: '1px solid #d4d8de' }}
                />
                {session && !session.isNew && (
                    <span style={{ fontSize: 11, color: '#7a8290' }}>
                        (re-opening existing register)
                    </span>
                )}
                {session?.isNew && (
                    <span style={{ fontSize: 11, color: '#1f8a4d' }}>
                        (new register)
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
                            }}
                        >
                            <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontWeight: 500, color: '#161b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {s.name}
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
                                    return (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            disabled={!canMark || saving}
                                            onClick={() => setStatus(s.id, opt.value)}
                                            style={{
                                                fontSize: 12,
                                                padding: '4px 10px',
                                                borderRadius: 4,
                                                border: '1px solid ' + (active ? '#3b6cd8' : '#d4d8de'),
                                                background: active ? '#dde6f7' : '#fff',
                                                color: active ? '#1f3d80' : '#161b22',
                                                cursor: canMark && !saving ? 'pointer' : 'default',
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

            {canMark && roster.length > 0 && (
                <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={saving || !session?.id}
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
        </div>
    )
}
