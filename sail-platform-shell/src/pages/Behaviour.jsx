import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { CAN } from '../lib/permissions'
import { supabase } from '../lib/supabaseClient'
import { getClass } from '../services/classes'
import { logBehaviourEvent, listBehaviourForStudent } from '../services/behaviour'

/**
 * /class/:classId/behaviour — Phase A
 *
 * Teacher-facing behaviour log. One vertical slice — log a single
 * positive / negative / note event against a student, then see the
 * student's recent events.
 *
 * Flow:
 *   1. Page loads class + roster.
 *   2. Operator picks a student from the roster.
 *   3. Quick-log form: type buttons + optional note + Log button.
 *   4. Below the form: that student's recent behaviour events
 *      (last 20), joined server-side with class_name + logger name.
 *
 * Permissions / RLS:
 *   * Reads gate on school membership (RLS on behaviour_events +
 *     classes); the student themselves can read their own events
 *     too (the SELECT policy includes student_user_id = effective_user_id()).
 *   * Writes gate on is_staff_of_school OR has_permission(manage_behaviour)
 *     enforced by the RPC. Helm pre-hides the form for non-staff.
 *
 * Scope discipline (per planner): NO scoring, NO category taxonomies,
 * NO trends, NO charts. Pure log → view → audit.
 */

const TYPE_OPTIONS = [
    { value: 'positive', label: 'Positive', tone: '#1f8a4d' },
    { value: 'negative', label: 'Negative', tone: '#a04545' },
    { value: 'note',     label: 'Note',     tone: '#3a4654' },
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

function formatTimestamp(iso) {
    if (!iso) return ''
    try {
        const d = new Date(iso)
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        })
    } catch {
        return iso
    }
}

function typeChip({ type }) {
    const opt = TYPE_OPTIONS.find((o) => o.value === type) || TYPE_OPTIONS[2]
    return (
        <span style={{
            display: 'inline-block',
            padding: '1px 7px',
            fontSize: 11,
            fontWeight: 600,
            borderRadius: 3,
            color: opt.tone,
            border: `1px solid ${opt.tone}33`,
            background: `${opt.tone}11`,
            textTransform: 'lowercase',
            letterSpacing: 0.3,
        }}>
            {opt.label}
        </span>
    )
}

export default function BehaviourPage() {
    const { classId } = useParams()
    const { role } = useAuth()
    const canLog = CAN.createAssignment(role)  // staff-only, mirrors Attendance

    const [klass,   setKlass]   = useState(null)
    const [roster,  setRoster]  = useState([])     // [{ id, name, email }]
    const [loading, setLoading] = useState(true)
    const [error,   setError]   = useState(null)

    // Selected student + their recent events.
    const [selectedStudentId, setSelectedStudentId] = useState(null)
    const [events,            setEvents]            = useState([])
    const [eventsLoading,     setEventsLoading]     = useState(false)
    const [eventsError,       setEventsError]       = useState(null)

    // Log form state (per-student; resets after submit).
    const [logType, setLogType] = useState('positive')
    const [logNote, setLogNote] = useState('')
    const [logging, setLogging] = useState(false)
    const [logError, setLogError] = useState(null)

    const loadClassAndRoster = useCallback(async () => {
        if (!classId) return
        setLoading(true); setError(null)
        try {
            const [classRow, rosterResult] = await Promise.all([
                getClass(classId),
                supabase.rpc('bridge_list_class_students', { p_class_id: classId }),
            ])
            if (rosterResult.error) throw rosterResult.error
            const rosterFormatted = (rosterResult.data || []).map((r) => ({
                id:    r.user_id,
                name:  r.full_name || r.email || r.user_id,
                email: r.email,
            }))
            setKlass(classRow)
            setRoster(rosterFormatted)
            // Auto-select first student so the page is immediately useful
            // for the common "log against any student in this class" case.
            if (rosterFormatted.length > 0 && !selectedStudentId) {
                setSelectedStudentId(rosterFormatted[0].id)
            }
        } catch (err) {
            setError(err)
        } finally {
            setLoading(false)
        }
    }, [classId, selectedStudentId])

    const loadEvents = useCallback(async () => {
        if (!selectedStudentId) {
            setEvents([])
            return
        }
        setEventsLoading(true); setEventsError(null)
        try {
            const rows = await listBehaviourForStudent({
                studentUserId: selectedStudentId,
                limit: 20,
            })
            setEvents(rows)
        } catch (err) {
            setEventsError(err)
            setEvents([])
        } finally {
            setEventsLoading(false)
        }
    }, [selectedStudentId])

    useEffect(() => { loadClassAndRoster() }, [loadClassAndRoster])
    useEffect(() => { loadEvents() },         [loadEvents])

    const onLog = async () => {
        if (!selectedStudentId || logging || !canLog) return
        setLogging(true); setLogError(null)
        try {
            await logBehaviourEvent({
                studentUserId: selectedStudentId,
                classId:       classId,           // always pass — we're on a class page
                type:          logType,
                note:          logNote.trim() || null,
            })
            // Reset form fields but preserve the type — operators often
            // log multiple events of the same type in a row.
            setLogNote('')
            // Refresh the events list so the new row appears at top.
            await loadEvents()
        } catch (err) {
            setLogError(err)
        } finally {
            setLogging(false)
        }
    }

    const selectedStudent = roster.find((s) => s.id === selectedStudentId)

    return (
        <div style={{ padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
            <div style={{ marginBottom: 12 }}>
                <Link to={`/class/${classId}`} style={{ fontSize: 12, color: '#5b6877' }}>
                    ← Back to class
                </Link>
            </div>
            <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Behaviour log</h1>
            <div style={{ fontSize: 13, color: '#5b6877', marginBottom: 16 }}>
                {klass ? (
                    <>
                        {klass.name}
                        {klass.school?.name ? ` · ${klass.school.name}` : ''}
                    </>
                ) : 'Loading class…'}
            </div>

            <ErrorBox error={error} />

            {/* ── Student picker ─────────────────────────────────────── */}
            <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, color: '#5b6877' }}>
                    Student
                </label>
                <select
                    value={selectedStudentId || ''}
                    onChange={(e) => { setSelectedStudentId(e.target.value); setLogError(null) }}
                    disabled={loading || logging}
                    style={{ fontSize: 13, padding: '4px 8px', borderRadius: 4, border: '1px solid #d4d8de', minWidth: 240 }}
                >
                    {roster.length === 0 ? (
                        <option value="">(no students)</option>
                    ) : (
                        roster.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))
                    )}
                </select>
                {/* Phase D — entry link to the unified student timeline.
                    Only renders when school + student context is loaded;
                    school_id derived from getClass payload. */}
                {selectedStudentId && klass?.school?.id && (
                    <Link
                        to={`/schools/${klass.school.id}/students/${selectedStudentId}/timeline`}
                        style={{ fontSize: 12.5, color: '#3b6cd8' }}
                    >
                        View Timeline →
                    </Link>
                )}
            </div>

            {/* ── Quick-log form ─────────────────────────────────────── */}
            {canLog && selectedStudentId && (
                <div style={{
                    padding: '12px 14px',
                    border: '1px solid #e3e6eb',
                    borderRadius: 6,
                    background: '#f7f9fc',
                    marginBottom: 18,
                }}>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                        {TYPE_OPTIONS.map((opt) => {
                            const active = logType === opt.value
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setLogType(opt.value)}
                                    disabled={logging}
                                    style={{
                                        fontSize: 12,
                                        padding: '4px 12px',
                                        borderRadius: 4,
                                        border: '1px solid ' + (active ? opt.tone : '#d4d8de'),
                                        background: active ? `${opt.tone}11` : '#fff',
                                        color: active ? opt.tone : '#161b22',
                                        cursor: logging ? 'default' : 'pointer',
                                        fontWeight: active ? 600 : 400,
                                    }}
                                >
                                    {opt.label}
                                </button>
                            )
                        })}
                    </div>
                    <textarea
                        rows={2}
                        value={logNote}
                        onChange={(e) => setLogNote(e.target.value)}
                        placeholder={
                            logType === 'note'
                                ? 'Note (required for notes is encouraged but not enforced)…'
                                : 'Optional note (context, what happened)…'
                        }
                        disabled={logging}
                        style={{
                            width: '100%',
                            fontSize: 13,
                            padding: '6px 8px',
                            borderRadius: 4,
                            border: '1px solid #d4d8de',
                            fontFamily: 'inherit',
                            resize: 'vertical',
                            boxSizing: 'border-box',
                            marginBottom: 8,
                        }}
                    />
                    <ErrorBox error={logError} />
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            onClick={onLog}
                            disabled={logging}
                            style={{
                                fontSize: 13,
                                padding: '6px 14px',
                                borderRadius: 4,
                                border: 'none',
                                background: logging ? '#a8b3c4' : '#3b6cd8',
                                color: '#fff',
                                cursor: logging ? 'wait' : 'pointer',
                                fontWeight: 500,
                            }}
                        >
                            {logging ? 'Logging…' : `Log ${logType}`}
                        </button>
                    </div>
                </div>
            )}
            {!canLog && selectedStudentId && (
                <div style={{ fontSize: 12, color: '#7a8290', marginBottom: 18 }}>
                    Read-only — only teachers and admins can log behaviour events.
                </div>
            )}

            {/* ── Recent events for the selected student ────────────── */}
            <h3 style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#5b6877',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                margin: '0 0 8px',
            }}>
                {selectedStudent
                    ? `Recent events for ${selectedStudent.name}`
                    : 'Recent events'}
            </h3>
            <ErrorBox error={eventsError} />
            {eventsLoading ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>Loading events…</div>
            ) : events.length === 0 ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>
                    No behaviour events logged yet for this student.
                </div>
            ) : (
                <div style={{ border: '1px solid #e3e6eb', borderRadius: 6 }}>
                    {events.map((e, i) => (
                        <div
                            key={e.id}
                            style={{
                                padding: '10px 14px',
                                borderTop: i === 0 ? 'none' : '1px solid #e3e6eb',
                                fontSize: 13,
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: e.note ? 4 : 0 }}>
                                {typeChip({ type: e.type })}
                                <span style={{ fontSize: 11.5, color: '#7a8290' }}>
                                    {formatTimestamp(e.createdAt)}
                                    {e.loggerName ? ` · by ${e.loggerName}` : ''}
                                    {e.className ? ` · ${e.className}` : ''}
                                </span>
                            </div>
                            {e.note && (
                                <div style={{ color: '#161b22', whiteSpace: 'pre-wrap' }}>
                                    {e.note}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
