// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Helm — /behaviour (per-student behaviour log)
// ─────────────────────────────────────────────────────────────────────────────
// Staff flow (class-centric, matches /attendance + /assignments):
//   1. Pick a class.
//   2. Pick a student from the class roster.
//   3. See that student's recent behaviour events (most recent first,
//      across all their classes — the listing RPC is per-student, not
//      per-class) + a quick-log form (type pill + note + Log button).
//   4. Resolve an open event with a single Resolve button (status flips
//      to 'resolved' inline).
//
// Student flow (degenerate single-step):
//   - The student IS the student; no selectors. Fetch their own events
//     directly via api.behaviour.listForStudent({ studentUserId: self }).
//   - Read-only. No log form, no Resolve buttons.
//
// One RPC per "show events for student X" interaction. The page does
// NOT iterate the roster + fan-out — that would recreate the
// prototype's inefficiency. Single source, single call.
//
// CARVE-OUT: writes (log + resolve) call Bridge RPCs directly via
// api.behaviour.{log, resolve}. Reads go through the M11 Helm SECDEF
// wrapper api.behaviour.listForStudent because the Bridge listing RPC
// is SECURITY INVOKER and joins auth.users (the same M9-pattern the
// attendance read paths use).
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN, isStudentRole } from '../lib/permissions'

const TYPE_OPTIONS = ['positive', 'negative', 'note']

const TYPE_TONE = {
    positive: { bg: '#ecfdf5', border: '#a7f3d0', color: '#065f46', label: 'Positive' },
    negative: { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', label: 'Negative' },
    note:     { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', label: 'Note'     },
}

// ─── Small UI primitives ───────────────────────────────────────────────────

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
            margin: '6px 0',
        }}>
            {error.message || String(error)}
        </div>
    )
}

function TypePill({ type, size = 11 }) {
    const tone = TYPE_TONE[type] || TYPE_TONE.note
    return (
        <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 12,
            fontSize: size,
            fontWeight: 600,
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            color: tone.color,
        }}>
            {tone.label}
        </span>
    )
}

// ─── Events list (shared between staff and student views) ────────────────

function EventsList({ events, canResolve, onResolve, resolvingId }) {
    if (events.length === 0) {
        return (
            <p style={{ color: '#888', fontSize: 14, marginTop: 12 }}>
                No behaviour events recorded yet.
            </p>
        )
    }
    return (
        <div style={{ marginTop: 12 }}>
            {events.map((e) => {
                const isResolved = e.status === 'resolved'
                return (
                    <div
                        key={e.id}
                        style={{
                            border: '1px solid #e5e7eb',
                            borderRadius: 6,
                            padding: '10px 12px',
                            margin: '6px 0',
                            background: isResolved ? '#f8fafc' : '#fff',
                            opacity: isResolved ? 0.75 : 1,
                        }}
                    >
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 10,
                            flexWrap: 'wrap',
                        }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <TypePill type={e.type} />
                                {isResolved && (
                                    <span style={{
                                        fontSize: 11,
                                        padding: '2px 8px',
                                        borderRadius: 12,
                                        background: '#f1f5f9',
                                        border: '1px solid #cbd5e1',
                                        color: '#475569',
                                        fontWeight: 600,
                                    }}>
                                        ✓ resolved
                                    </span>
                                )}
                                {e.class_name && (
                                    <span style={{ color: '#64748b', fontSize: 12 }}>
                                        in {e.class_name}
                                    </span>
                                )}
                            </div>
                            <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                                {e.created_at ? new Date(e.created_at).toLocaleString() : ''}
                                {e.logger_name && <> · {e.logger_name}</>}
                            </div>
                        </div>
                        {e.note && (
                            <div style={{
                                marginTop: 6,
                                fontSize: 13.5,
                                color: '#0f172a',
                                whiteSpace: 'pre-wrap',
                            }}>
                                {e.note}
                            </div>
                        )}
                        {canResolve && !isResolved && (
                            <div style={{ marginTop: 8 }}>
                                <button
                                    type="button"
                                    onClick={() => onResolve(e.id)}
                                    disabled={resolvingId === e.id}
                                    style={{
                                        padding: '3px 10px',
                                        background: 'transparent',
                                        border: '1px solid #cbd5e1',
                                        borderRadius: 4,
                                        fontSize: 12,
                                        cursor: resolvingId === e.id ? 'wait' : 'pointer',
                                        color: '#334155',
                                    }}
                                >
                                    {resolvingId === e.id ? 'Resolving…' : 'Resolve'}
                                </button>
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

// ─── Staff-side log form ───────────────────────────────────────────────────

function LogForm({ disabled, onSubmit, submitting }) {
    const [type, setType]     = useState('positive')
    const [note, setNote]     = useState('')
    const [error, setError]   = useState(null)

    const reset = () => { setNote(''); setError(null) }
    const submit = async () => {
        if (!type) {
            setError({ message: 'Pick a type first.' })
            return
        }
        const { error: err } = await onSubmit({ type, note: note.trim() || null })
        if (err) { setError(err); return }
        reset()
    }

    return (
        <div style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            padding: 12,
            margin: '12px 0',
            background: '#fafafa',
        }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Log new event</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                {TYPE_OPTIONS.map((t) => {
                    const selected = type === t
                    const tone = TYPE_TONE[t]
                    return (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setType(t)}
                            disabled={disabled || submitting}
                            style={{
                                padding: '4px 12px',
                                borderRadius: 12,
                                border: `1px solid ${selected ? tone.color : '#cbd5e1'}`,
                                background: selected ? tone.bg : '#fff',
                                color: selected ? tone.color : '#475569',
                                fontWeight: selected ? 700 : 500,
                                cursor: 'pointer',
                                fontSize: 12,
                            }}
                        >
                            {tone.label}
                        </button>
                    )
                })}
            </div>
            <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note…"
                disabled={disabled || submitting}
                rows={3}
                style={{
                    width: '100%',
                    padding: '6px 10px',
                    fontSize: 14,
                    border: '1px solid #cbd5e1',
                    borderRadius: 4,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                }}
            />
            <ErrorBox error={error} />
            <div style={{ marginTop: 6 }}>
                <button
                    type="button"
                    onClick={submit}
                    disabled={disabled || submitting}
                    style={{
                        background: '#1f2937',
                        color: '#fff',
                        border: 'none',
                        padding: '6px 14px',
                        borderRadius: 4,
                        cursor: submitting ? 'wait' : 'pointer',
                        opacity: submitting ? 0.6 : 1,
                        fontSize: 13,
                    }}
                >
                    {submitting ? 'Logging…' : 'Log'}
                </button>
            </div>
        </div>
    )
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function Behaviour() {
    const { role, schoolId, userId } = useAuth()
    const isStudent = isStudentRole(role)
    const canLog    = CAN.logBehaviour(role)

    // Staff selectors
    const [classes,    setClasses]    = useState([])
    const [classesErr, setClassesErr] = useState(null)
    const [classId,    setClassId]    = useState('')

    const [roster,    setRoster]    = useState([])
    const [rosterErr, setRosterErr] = useState(null)
    const [studentId, setStudentId] = useState('')

    // Events (loaded once a target student is known)
    const [events,    setEvents]    = useState([])
    const [eventsErr, setEventsErr] = useState(null)
    const [eventsStatus, setEventsStatus] = useState('idle')  // idle | loading | ready | error

    const [logging,    setLogging]    = useState(false)
    const [resolvingId, setResolvingId] = useState(null)

    // ── Effects ─────────────────────────────────────────────────────────

    // Load classes for staff. Students don't need this; they read their
    // own events directly.
    useEffect(() => {
        if (isStudent || !schoolId) return undefined
        let cancelled = false
        ;(async () => {
            const { data, error } = await api.classes.list(schoolId)
            if (cancelled) return
            if (error) { setClassesErr(error); return }
            const rows = data || []
            setClasses(rows)
            if (rows.length > 0 && !classId) setClassId(rows[0].class_id)
        })()
        return () => { cancelled = true }
    }, [isStudent, schoolId]) // eslint-disable-line react-hooks/exhaustive-deps

    // Load roster when staff picks a class. Filter to students only.
    useEffect(() => {
        if (isStudent || !classId) return undefined
        let cancelled = false
        setStudentId('')
        setRoster([])
        setRosterErr(null)
        ;(async () => {
            const { data, error } = await api.classes.listEnrollments(classId)
            if (cancelled) return
            if (error) { setRosterErr(error); return }
            const studentsOnly = (data || []).filter((e) => isStudentRole(e.role))
            setRoster(studentsOnly)
            if (studentsOnly.length > 0) setStudentId(studentsOnly[0].user_id)
        })()
        return () => { cancelled = true }
    }, [isStudent, classId])

    // Resolve the effective "who am I fetching events for" id:
    //   - staff: the selected student
    //   - student: themselves
    const targetStudentId = isStudent ? userId : studentId

    const loadEvents = useCallback(async () => {
        if (!targetStudentId) {
            setEvents([])
            setEventsStatus('idle')
            return
        }
        setEventsStatus('loading')
        setEventsErr(null)
        const { data, error } = await api.behaviour.listForStudent({
            studentUserId: targetStudentId,
        })
        if (error) {
            setEventsErr(error)
            setEventsStatus('error')
            return
        }
        setEvents(data || [])
        setEventsStatus('ready')
    }, [targetStudentId])

    useEffect(() => { loadEvents() }, [loadEvents])

    // ── Actions ─────────────────────────────────────────────────────────

    const handleLog = async ({ type, note }) => {
        if (!canLog || !classId || !studentId) {
            return { error: { message: 'Pick a class and a student first.' } }
        }
        setLogging(true)
        const { data, error } = await api.behaviour.log({
            studentUserId: studentId,
            classId,
            type,
            note,
            context: { surface: 'helm.behaviour' },
        })
        setLogging(false)
        if (error) return { error }
        // Optimistic — prepend the new row. The next refresh will
        // overwrite with the canonical server state.
        const inserted = Array.isArray(data) ? data[0] : data
        if (inserted) {
            setEvents((prev) => [{
                ...inserted,
                class_name:   roster.find((r) => r.user_id === studentId)?.class_name
                              || classes.find((c) => c.class_id === classId)?.name
                              || null,
                logger_name:  'You',
                logger_email: null,
            }, ...prev])
        }
        return { error: null }
    }

    const handleResolve = async (eventId) => {
        if (!canLog) return
        setResolvingId(eventId)
        const { error } = await api.behaviour.resolve(eventId)
        setResolvingId(null)
        if (error) {
            setEventsErr(error)
            return
        }
        // Flip status optimistically.
        setEvents((prev) => prev.map((e) => (
            e.id === eventId ? { ...e, status: 'resolved' } : e
        )))
    }

    // ── Defensive gate ──────────────────────────────────────────────────

    if (!CAN.viewBehaviour(role)) {
        return <Navigate to="/" replace />
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Behaviour</h2>
                <p style={{ color: '#666' }}>
                    No school context. Reload the page.
                </p>
            </div>
        )
    }

    // ── Student view ────────────────────────────────────────────────────

    if (isStudent) {
        return (
            <div>
                <h2 style={{ marginTop: 0 }}>My Behaviour Log</h2>
                <p style={{ color: '#6b7280', fontSize: 13, marginTop: 0 }}>
                    Read-only view of behaviour events your teachers have
                    logged for you.
                </p>
                <ErrorBox error={eventsErr} />
                {eventsStatus === 'loading' && (
                    <p style={{ color: '#888' }}>Loading…</p>
                )}
                {eventsStatus === 'ready' && (
                    <EventsList
                        events={events}
                        canResolve={false}
                        onResolve={() => {}}
                        resolvingId={null}
                    />
                )}
            </div>
        )
    }

    // ── Staff view ──────────────────────────────────────────────────────

    return (
        <div>
            <h2 style={{ marginTop: 0 }}>Behaviour</h2>

            <ErrorBox error={classesErr} />

            <div style={{
                display: 'flex',
                gap: 12,
                alignItems: 'end',
                flexWrap: 'wrap',
                marginBottom: 4,
            }}>
                <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                    Class
                    <select
                        id="behaviour-class"
                        value={classId}
                        onChange={(e) => setClassId(e.target.value)}
                        disabled={classes.length === 0}
                        style={{ padding: 4, minWidth: 220 }}
                    >
                        {classes.length === 0 && <option value="">No classes</option>}
                        {classes.map((c) => (
                            <option key={c.class_id} value={c.class_id}>
                                {c.name || c.class_id}
                            </option>
                        ))}
                    </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                    Student
                    <select
                        id="behaviour-student"
                        value={studentId}
                        onChange={(e) => setStudentId(e.target.value)}
                        disabled={roster.length === 0}
                        style={{ padding: 4, minWidth: 220 }}
                    >
                        {roster.length === 0 && <option value="">No students enrolled</option>}
                        {roster.map((s) => (
                            <option key={s.user_id} value={s.user_id}>
                                {s.email || s.user_id}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <ErrorBox error={rosterErr} />

            {canLog && studentId && (
                <LogForm
                    disabled={!studentId}
                    submitting={logging}
                    onSubmit={handleLog}
                />
            )}

            <ErrorBox error={eventsErr} />

            {eventsStatus === 'loading' && (
                <p style={{ color: '#888' }}>Loading events…</p>
            )}
            {eventsStatus === 'ready' && (
                <EventsList
                    events={events}
                    canResolve={canLog}
                    onResolve={handleResolve}
                    resolvingId={resolvingId}
                />
            )}
        </div>
    )
}
