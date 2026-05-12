// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Helm — /timeline (per-student unified event stream)
// ─────────────────────────────────────────────────────────────────────────────
// Read-only unified view of a student's attendance + behaviour +
// assignment events. Server-side join + ordering live in the Bridge
// RPC; this page renders.
//
// Staff flow (matches /behaviour exactly):
//   1. Pick a class.
//   2. Pick a student from the class roster.
//   3. Header shows student detail (full_name, role, joined_at).
//      Below: event stream most-recent-first.
//
// Student flow (degenerate single-step, mirrors /behaviour):
//   - No selectors. The student IS the student.
//   - Header shows their own detail. Below: their own event stream.
//
// Read-only by design. Resolve / mark-present / mark-submitted live on
// the existing Behaviour / Attendance / Assignments surfaces — the
// Timeline does NOT introduce inline actions (the planner's "don't
// invent new patterns" rule).
//
// `meta` is opaque jsonb from the Bridge function. We only parse what
// we display, and we never reshape it.
//
// One RPC per "show timeline for student X" interaction (plus one for
// the student-detail header). No per-roster-member fan-out.
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN, isStudentRole } from '../lib/permissions'

const TYPE_TONE = {
    attendance:          { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', label: 'Attendance' },
    behaviour:           { bg: '#fef3c7', border: '#fde68a', color: '#92400e', label: 'Behaviour'  },
    assignment_assigned: { bg: '#f3e8ff', border: '#e9d5ff', color: '#6b21a8', label: 'Assignment' },
    assignment_graded:   { bg: '#ecfdf5', border: '#a7f3d0', color: '#065f46', label: 'Graded'     },
}

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

function TypePill({ type }) {
    const tone = TYPE_TONE[type] || { bg: '#f3f4f6', border: '#e5e7eb', color: '#374151', label: type }
    return (
        <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            color: tone.color,
        }}>
            {tone.label}
        </span>
    )
}

function StudentHeader({ student }) {
    if (!student) return null
    const joined = student.joined_at ? new Date(student.joined_at).toLocaleDateString() : null
    return (
        <div style={{
            padding: '10px 12px',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#fafafa',
            marginBottom: 12,
        }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{student.full_name || student.email || student.user_id}</div>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                {student.role && <>Role: <strong>{student.role}</strong></>}
                {joined && <> · Joined {joined}</>}
            </div>
        </div>
    )
}

// `meta` is opaque jsonb; render only the fields we know about per
// event type. Anything unknown is ignored — never crash on shape drift.
function EventMeta({ row }) {
    const m = row.meta || {}
    const className = m.class_name
    const actorName = m.actor_name

    switch (row.type) {
        case 'attendance':
            return (
                <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>
                    {className && <>in <strong>{className}</strong></>}
                    {m.session_date && <> on {m.session_date}</>}
                    {actorName && <> · marked by {actorName}</>}
                </div>
            )
        case 'behaviour':
            return (
                <>
                    <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>
                        {className && <>in <strong>{className}</strong></>}
                        {actorName && <> · logged by {actorName}</>}
                        {m.status === 'resolved' && <> · resolved</>}
                    </div>
                    {m.note && (
                        <div style={{
                            marginTop: 6,
                            padding: 8,
                            background: '#fff',
                            border: '1px solid #fde68a',
                            borderRadius: 4,
                            fontSize: 13,
                            whiteSpace: 'pre-wrap',
                        }}>
                            {m.note}
                        </div>
                    )}
                </>
            )
        case 'assignment_assigned':
            return (
                <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>
                    {className && <>in <strong>{className}</strong></>}
                    {m.status && <> · status: <em>{m.status}</em></>}
                    {actorName && <> · by {actorName}</>}
                </div>
            )
        case 'assignment_graded':
            return (
                <div style={{ color: '#475569', fontSize: 13, marginTop: 4 }}>
                    {className && <>in <strong>{className}</strong></>}
                    {m.ai_grade && <> · grade: <strong>{m.ai_grade}</strong></>}
                </div>
            )
        default:
            return null
    }
}

function EventsList({ events }) {
    if (events.length === 0) {
        return (
            <p style={{ color: '#888', fontSize: 14, marginTop: 12 }}>
                No timeline events yet.
            </p>
        )
    }
    return (
        <div style={{ marginTop: 12 }}>
            {events.map((row, idx) => (
                <div
                    key={`${row.type}-${row.ts}-${idx}`}
                    style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: 6,
                        padding: '10px 12px',
                        margin: '6px 0',
                        background: '#fff',
                    }}
                >
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: 10,
                        flexWrap: 'wrap',
                    }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <TypePill type={row.type} />
                            <strong style={{ fontSize: 14 }}>{row.title}</strong>
                        </div>
                        <div style={{ fontSize: 11.5, color: '#94a3b8' }}>
                            {row.ts ? new Date(row.ts).toLocaleString() : ''}
                        </div>
                    </div>
                    <EventMeta row={row} />
                </div>
            ))}
        </div>
    )
}

export default function Timeline() {
    const { role, schoolId, userId } = useAuth()
    const isStudent = isStudentRole(role)

    // Staff selectors
    const [classes,    setClasses]    = useState([])
    const [classesErr, setClassesErr] = useState(null)
    const [classId,    setClassId]    = useState('')

    const [roster,    setRoster]    = useState([])
    const [rosterErr, setRosterErr] = useState(null)
    const [studentId, setStudentId] = useState('')

    // Detail + events
    const [studentDetail, setStudentDetail] = useState(null)
    const [studentErr,    setStudentErr]    = useState(null)

    const [events,    setEvents]    = useState([])
    const [eventsErr, setEventsErr] = useState(null)
    const [status,    setStatus]    = useState('idle')

    // ── Staff: load classes ─────────────────────────────────────────────

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

    // ── Staff: load roster when class changes ───────────────────────────

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

    // ── Effective target (student self vs staff-selected) ───────────────

    const targetStudentId = isStudent ? userId : studentId

    // ── Load student detail + timeline whenever target changes ──────────

    const loadAll = useCallback(async () => {
        if (!targetStudentId || !schoolId) {
            setStudentDetail(null)
            setEvents([])
            setStatus('idle')
            return
        }
        setStatus('loading')
        setStudentErr(null)
        setEventsErr(null)

        const [{ data: detail, error: detailErr }, { data: rows, error: rowsErr }] = await Promise.all([
            api.students.get({ studentUserId: targetStudentId, schoolId }),
            api.timeline.getForStudent({ studentUserId: targetStudentId, schoolId }),
        ])

        if (detailErr) setStudentErr(detailErr)
        if (rowsErr)   setEventsErr(rowsErr)

        setStudentDetail(Array.isArray(detail) ? detail[0] : detail)
        setEvents(rows || [])
        setStatus((detailErr || rowsErr) ? 'error' : 'ready')
    }, [targetStudentId, schoolId])

    useEffect(() => { loadAll() }, [loadAll])

    // ── Defensive gate ──────────────────────────────────────────────────

    if (!CAN.viewTimeline(role)) {
        return <Navigate to="/" replace />
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Timeline</h2>
                <p style={{ color: '#666' }}>No school context. Reload the page.</p>
            </div>
        )
    }

    // ── Student view ────────────────────────────────────────────────────

    if (isStudent) {
        return (
            <div>
                <h2 style={{ marginTop: 0 }}>My Timeline</h2>
                <p style={{ color: '#6b7280', fontSize: 13, marginTop: 0 }}>
                    Recent activity across attendance, behaviour, and assignments.
                </p>
                <ErrorBox error={studentErr} />
                <ErrorBox error={eventsErr} />
                <StudentHeader student={studentDetail} />
                {status === 'loading' && <p style={{ color: '#888' }}>Loading…</p>}
                {status === 'ready'   && <EventsList events={events} />}
            </div>
        )
    }

    // ── Staff view ──────────────────────────────────────────────────────

    return (
        <div>
            <h2 style={{ marginTop: 0 }}>Timeline</h2>

            <ErrorBox error={classesErr} />

            <div style={{
                display: 'flex',
                gap: 12,
                alignItems: 'end',
                flexWrap: 'wrap',
                marginBottom: 12,
            }}>
                <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                    Class
                    <select
                        id="timeline-class"
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
                        id="timeline-student"
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
            <ErrorBox error={studentErr} />
            <ErrorBox error={eventsErr} />

            <StudentHeader student={studentDetail} />

            {status === 'loading' && <p style={{ color: '#888' }}>Loading timeline…</p>}
            {status === 'ready'   && <EventsList events={events} />}
        </div>
    )
}
