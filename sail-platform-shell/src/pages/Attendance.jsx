import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN, isStudentRole } from '../lib/permissions'

/**
 * Attendance — Phase 2 Route 4 of the Helm rebuild.
 *
 * Spec contract: HELM_PHASE_2_SPEC.md §3.4 (locked 2026-05-12).
 *
 * Daily per-class attendance. One RPC per session — never one RPC
 * per student.
 *
 * Role-aware:
 *   - Staff (admin / teacher) → class selector + date picker + roster
 *     table with per-row status dropdown + single "Save attendance"
 *     button. Builds `[{student_user_id, status}, …]` and calls
 *     `mark_attendance` once.
 *   - Student → class selector + history list (date + status).
 *
 * Status whitelist: present | absent | late. (Excused deferred.)
 *
 * "(unmarked)" in the dropdown is the explicit "no status yet" option
 * — those rows are NOT sent to the RPC. The teacher must pick a
 * status to record one. This avoids accidental "marked present by
 * default" data entry.
 */
const STATUS_OPTIONS = ['present', 'absent', 'late']
const UNMARKED = ''  // dropdown sentinel for "no record"

export default function Attendance() {
    const { role, schoolId } = useAuth()

    const canMark = CAN.markAttendance(role)

    const [classes, setClasses] = useState([])
    const [selectedClassId, setSelectedClassId] = useState('')

    const [classesStatus, setClassesStatus] = useState('idle')
    const [classesError, setClassesError]   = useState(null)

    const loadClasses = useCallback(async () => {
        if (!schoolId) return
        setClassesStatus('loading')
        setClassesError(null)
        const { data, error } = await api.classes.list(schoolId)
        if (error) {
            setClassesError(error.message || 'Could not load classes.')
            setClassesStatus('error')
            return
        }
        setClasses(data || [])
        setClassesStatus('ready')
        if ((data || []).length > 0 && !selectedClassId) {
            setSelectedClassId(data[0].class_id)
        }
    }, [schoolId, selectedClassId])

    useEffect(() => { loadClasses() }, [loadClasses])

    if (!CAN.viewAttendance(role)) {
        return (
            <div>
                <h2>Attendance</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Attendance</h2>
                <p>No school context. Reload the page.</p>
            </div>
        )
    }

    return (
        <div>
            <h2>Attendance</h2>

            {classesStatus === 'loading' && <p>Loading classes…</p>}
            {classesStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load classes: <code>{classesError}</code>
                </p>
            )}
            {classesStatus === 'ready' && classes.length === 0 && (
                <p>No classes available.</p>
            )}
            {classesStatus === 'ready' && classes.length > 0 && (
                <div style={ROW_STYLE}>
                    <label htmlFor="att-class" style={LABEL_STYLE}>Class:</label>
                    <select
                        id="att-class"
                        value={selectedClassId}
                        onChange={(e) => setSelectedClassId(e.target.value)}
                        style={INPUT_STYLE}
                    >
                        {classes.map((c) => (
                            <option key={c.class_id} value={c.class_id}>
                                {c.name}{c.subject ? ` — ${c.subject}` : ''}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {selectedClassId && (
                canMark
                    ? <StaffPanel classId={selectedClassId} />
                    : <StudentPanel classId={selectedClassId} />
            )}
        </div>
    )
}

// ─── Staff panel: date picker + roster + batch save ─────────────────────────

function StaffPanel({ classId }) {
    const [date, setDate]         = useState(todayIso())
    const [roster, setRoster]     = useState([])
    const [rStatus, setRStatus]   = useState('idle')
    const [rError, setRError]     = useState(null)

    // Local draft: { student_user_id: status }. Hydrated from the
    // server's existing rows; unmarked rows start as '' (sentinel).
    const [draft, setDraft] = useState({})

    const [saveStatus, setSaveStatus] = useState('idle')  // 'idle' | 'saving' | 'error' | 'saved'
    const [saveError, setSaveError]   = useState(null)
    const [saveCount, setSaveCount]   = useState(null)

    const loadRoster = useCallback(async () => {
        if (!classId || !date) return
        setRStatus('loading')
        setRError(null)
        setSaveStatus('idle')
        setSaveCount(null)

        // Bridge has no single "roster + marks for date" RPC. Two calls:
        //   1. Full class enrollment (student-role rows only)
        //   2. Existing attendance session for the date (if any)
        // Merge: each enrolled student + (possibly null) status from the session's records.
        //
        // The two RPCs are INDEPENDENT — neither's response feeds the
        // other's input — so we run them in parallel via Promise.all
        // to save one RTT. Supabase rpc() resolves the promise on
        // server response (errors come back in the result object, not
        // as rejections), so Promise.all settles cleanly with both
        // results regardless of which has an error; we surface the
        // first error we find for a deterministic message.
        const [
            { data: enrolls,     error: enrErr },
            { data: sessionData, error: sErr   },
        ] = await Promise.all([
            api.classes.listEnrollments(classId),
            api.attendance.getSessionForDate(classId, date),
        ])
        if (enrErr) {
            setRError(enrErr.message || 'Could not load roster.')
            setRStatus('error')
            return
        }
        if (sErr) {
            setRError(sErr.message || 'Could not load attendance session.')
            setRStatus('error')
            return
        }
        const students = (enrolls || []).filter((e) => isStudentRole(e.role))

        // sessionData is jsonb: { session: row|null, class: row, records: [...] }
        const records = sessionData?.records || []
        const byStudent = {}
        for (const r of records) {
            byStudent[r.student_user_id] = r
        }

        const merged = students.map((s) => ({
            student_user_id: s.user_id,
            email:           s.email,
            attendance_id:   byStudent[s.user_id]?.id          ?? null,
            status:          byStudent[s.user_id]?.status      ?? null,
            marked_by:       byStudent[s.user_id]?.recorded_by ?? null,
            updated_at:      byStudent[s.user_id]?.recorded_at ?? null,
        }))

        setRoster(merged)
        const next = {}
        for (const r of merged) {
            next[r.student_user_id] = r.status || UNMARKED
        }
        setDraft(next)
        setRStatus('ready')
    }, [classId, date])

    useEffect(() => { loadRoster() }, [loadRoster])

    async function handleSave() {
        // Build payload: only rows with a non-empty status. Unmarked
        // rows are skipped — they remain whatever the server already
        // has (NULL if no row exists yet).
        const records = []
        for (const r of roster) {
            const status = draft[r.student_user_id]
            if (status && status !== UNMARKED) {
                records.push({ student_user_id: r.student_user_id, status })
            }
        }
        if (records.length === 0) {
            setSaveError('Pick a status for at least one student.')
            setSaveStatus('error')
            return
        }

        setSaveStatus('saving')
        setSaveError(null)

        // Bridge's session-anchored model: ensure a session exists for
        // (class, date), then save the register against it.
        const ctx = { surface: 'helm.attendance' }
        const { data: sessionData, error: csErr } = await api.attendance.createSession(
            classId, date, ctx,
        )
        if (csErr) {
            setSaveError(csErr.message || 'Could not create attendance session.')
            setSaveStatus('error')
            return
        }
        // createSession returns a TABLE row (single row); supabase-js gives us an array.
        const sessionId = Array.isArray(sessionData) ? sessionData[0]?.id : sessionData?.id
        if (!sessionId) {
            setSaveError('createSession returned no session id.')
            setSaveStatus('error')
            return
        }

        const { data: result, error: srErr } = await api.attendance.saveRegister(
            sessionId, records, ctx,
        )
        if (srErr) {
            setSaveError(srErr.message || 'Could not save attendance.')
            setSaveStatus('error')
            return
        }
        // saveRegister returns jsonb { total_count, present_count, ... }
        setSaveCount(result?.total_count ?? records.length)
        setSaveStatus('saved')
        await loadRoster()
    }

    return (
        <div style={STAFF_PANEL_STYLE}>
            <div style={ROW_STYLE}>
                <label htmlFor="att-date" style={LABEL_STYLE}>Date:</label>
                <input
                    id="att-date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    style={INPUT_STYLE}
                />
            </div>

            {rStatus === 'loading' && <p>Loading roster…</p>}
            {rStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load roster: <code>{rError}</code>
                </p>
            )}
            {rStatus === 'ready' && roster.length === 0 && (
                <p>No students enrolled in this class.</p>
            )}
            {rStatus === 'ready' && roster.length > 0 && (
                <>
                    <table style={TABLE_STYLE}>
                        <thead>
                            <tr>
                                <th style={TH_STYLE}>Student</th>
                                <th style={TH_STYLE}>Status</th>
                                <th style={TH_STYLE}>Last marked</th>
                            </tr>
                        </thead>
                        <tbody>
                            {roster.map((r) => {
                                const current = draft[r.student_user_id] ?? UNMARKED
                                return (
                                    <tr key={r.student_user_id}>
                                        <td style={TD_STYLE}>
                                            {r.email || <em>(no email)</em>}
                                        </td>
                                        <td style={TD_STYLE}>
                                            <select
                                                value={current}
                                                onChange={(e) =>
                                                    setDraft((d) => ({
                                                        ...d,
                                                        [r.student_user_id]: e.target.value,
                                                    }))
                                                }
                                                disabled={saveStatus === 'saving'}
                                                style={STATUS_SELECT_STYLE}
                                            >
                                                <option value={UNMARKED}>— unmarked —</option>
                                                {STATUS_OPTIONS.map((s) => (
                                                    <option key={s} value={s}>
                                                        {s}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>
                                        <td style={TD_STYLE}>
                                            {r.updated_at ? (
                                                <span style={META_STYLE}>
                                                    {formatDate(r.updated_at)}
                                                </span>
                                            ) : (
                                                <span style={META_STYLE}>—</span>
                                            )}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>

                    <div style={ROW_STYLE}>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={saveStatus === 'saving'}
                            style={BUTTON_STYLE}
                        >
                            {saveStatus === 'saving' ? 'Saving…' : 'Save attendance'}
                        </button>
                        {saveStatus === 'saved' && saveCount !== null && (
                            <span style={SUCCESS_STYLE}>
                                Saved {saveCount} record{saveCount === 1 ? '' : 's'}.
                            </span>
                        )}
                    </div>
                    {saveStatus === 'error' && saveError && (
                        <p style={ERROR_STYLE}><code>{saveError}</code></p>
                    )}
                </>
            )}
        </div>
    )
}

// ─── Student panel: own history for the selected class ─────────────────────

function StudentPanel({ classId }) {
    const [history, setHistory] = useState([])
    const [status, setStatus]   = useState('idle')
    const [error, setError]     = useState(null)

    const loadHistory = useCallback(async () => {
        if (!classId) return
        setStatus('loading')
        setError(null)
        const { data, error: rpcError } = await api.attendance.listStudentHistory(classId)
        if (rpcError) {
            setError(rpcError.message || 'Could not load attendance.')
            setStatus('error')
            return
        }
        setHistory(data || [])
        setStatus('ready')
    }, [classId])

    useEffect(() => { loadHistory() }, [loadHistory])

    if (status === 'loading') return <p>Loading attendance…</p>
    if (status === 'error') {
        return (
            <p style={ERROR_STYLE}>
                Could not load attendance: <code>{error}</code>
            </p>
        )
    }
    if (status === 'ready' && history.length === 0) {
        return <p>No attendance records yet for this class.</p>
    }
    return (
        <table style={TABLE_STYLE}>
            <thead>
                <tr>
                    <th style={TH_STYLE}>Date</th>
                    <th style={TH_STYLE}>Status</th>
                </tr>
            </thead>
            <tbody>
                {history.map((h) => (
                    <tr key={h.attendance_id}>
                        <td style={TD_STYLE}>{h.session_date}</td>
                        <td style={TD_STYLE}>
                            <span style={STATUS_PILL_STYLE(h.status)}>{h.status}</span>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function todayIso() {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatDate(value) {
    if (!value) return '—'
    try {
        const d = new Date(value)
        if (Number.isNaN(d.getTime())) return '—'
        return d.toLocaleString()
    } catch {
        return '—'
    }
}

// ─── Styles — minimal, consistent with v6-lite. ────────────────────────────

const STAFF_PANEL_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           12,
    marginTop:     8,
}
const TABLE_STYLE = {
    borderCollapse: 'collapse',
    marginTop:      4,
    minWidth:       480,
}
const TH_STYLE = {
    textAlign:    'left',
    padding:      '4px 12px 4px 0',
    borderBottom: '1px solid #ccc',
    fontSize:     13,
}
const TD_STYLE = {
    padding:      '6px 12px 6px 0',
    borderBottom: '1px solid #eee',
    fontSize:     14,
    verticalAlign: 'middle',
}
const ROW_STYLE = {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    flexWrap:   'wrap',
}
const LABEL_STYLE = {
    fontSize:   13,
    fontWeight: 600,
    minWidth:   60,
}
const INPUT_STYLE = {
    padding:      '6px 8px',
    border:       '1px solid #ccc',
    borderRadius: 4,
    fontSize:     14,
}
const STATUS_SELECT_STYLE = {
    padding:      '4px 6px',
    border:       '1px solid #ccc',
    borderRadius: 4,
    fontSize:     14,
    minWidth:     120,
}
const BUTTON_STYLE = {
    padding:      '6px 12px',
    border:       '1px solid #888',
    borderRadius: 4,
    background:   '#f6f6f6',
    cursor:       'pointer',
    fontSize:     14,
}
const SUCCESS_STYLE = {
    color:    '#0a0',
    fontSize: 13,
}
const ERROR_STYLE = {
    color:     '#a00',
    fontSize:  14,
    marginTop: 6,
}
const META_STYLE = {
    fontSize: 12,
    color:    '#666',
}

function STATUS_PILL_STYLE(status) {
    const palette = {
        present: { bg: '#ecfdf5', fg: '#065f46' },
        absent:  { bg: '#fef2f2', fg: '#991b1b' },
        late:    { bg: '#fff7ed', fg: '#9a3412' },
    }
    const p = palette[status] || { bg: '#f3f4f6', fg: '#374151' }
    return {
        background:   p.bg,
        color:        p.fg,
        padding:      '2px 8px',
        borderRadius: 10,
        fontSize:     12,
        fontWeight:   600,
    }
}
