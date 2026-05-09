import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getStudentTimeline } from '../services/timeline'

/**
 * /schools/:schoolId/students/:studentId/timeline — Phase D
 *
 * Read-only unified timeline for a single student. Pulls from
 * SAIL-core via bridge_get_student_timeline, which UNIONs:
 *   * attendance (attendance_records)
 *   * behaviour (behaviour_events)
 *   * assignment_assigned (student_assignments.created_at)
 *   * assignment_graded   (student_assignments.ai_graded_at, when set)
 *
 * Each row carries `{type, ts, title, meta}`. Titles are
 * human-readable and generated server-side — the UI renders them
 * verbatim with a per-type icon + optional subtext from meta.
 *
 * Strict scope (Timeline v1 contract):
 *   * No filters, pagination beyond a single limit, editing,
 *     analytics, or tooltips.
 *   * Two states: loading, error, empty, or list.
 *   * One central timestamp formatter — no per-row date math
 *     scattered through the JSX.
 */

const TYPE_DECORATION = {
    attendance:          { icon: '📋', color: '#3b6cd8' },
    behaviour:           { icon: '⚠️', color: '#a04545' },
    assignment_assigned: { icon: '📝', color: '#5b6877' },
    assignment_graded:   { icon: '✅', color: '#1f8a4d' },
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

/**
 * Per-event subtext. Pulled from `meta` per the locked spec — never
 * required for a row to render its primary line. Behaviour notes get
 * surfaced because they're the most operationally useful detail;
 * attendance shows the session_date for context.
 */
function eventSubtext(event) {
    const m = event.meta || {}
    const cls = m.class_name ? `${m.class_name}` : null
    if (event.type === 'attendance') {
        return [m.session_date, cls].filter(Boolean).join(' · ')
    }
    if (event.type === 'behaviour') {
        return [m.note, cls].filter(Boolean).join(' — ')
    }
    if (event.type === 'assignment_assigned' || event.type === 'assignment_graded') {
        return cls
    }
    return null
}

export default function StudentTimelinePage() {
    const { schoolId, studentId } = useParams()
    const navigate = useNavigate()

    const [events,  setEvents]  = useState([])
    const [loading, setLoading] = useState(true)
    const [error,   setError]   = useState(null)

    useEffect(() => {
        let alive = true
        async function load() {
            if (!schoolId || !studentId) return
            setLoading(true); setError(null)
            try {
                const rows = await getStudentTimeline({
                    schoolId, studentId, limit: 100,
                })
                if (alive) setEvents(rows)
            } catch (err) {
                if (alive) { setError(err); setEvents([]) }
            } finally {
                if (alive) setLoading(false)
            }
        }
        load()
        return () => { alive = false }
    }, [schoolId, studentId])

    return (
        <div style={{ padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
            <div style={{ marginBottom: 12 }}>
                <button
                    type="button"
                    onClick={() => navigate(-1)}
                    style={{
                        background: 'none', border: 'none', padding: 0,
                        fontSize: 12, color: '#5b6877', cursor: 'pointer',
                    }}
                >
                    ← Back
                </button>
            </div>
            <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Student timeline</h1>
            <div style={{ fontSize: 13, color: '#5b6877', marginBottom: 16 }}>
                Unified view of attendance, behaviour, and assignment events.
            </div>

            <ErrorBox error={error} />

            {loading ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>Loading timeline…</div>
            ) : events.length === 0 ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>
                    No activity yet for this student.
                </div>
            ) : (
                <div style={{ border: '1px solid #e3e6eb', borderRadius: 6 }}>
                    {events.map((e, i) => {
                        const decor = TYPE_DECORATION[e.type] || { icon: '·', color: '#5b6877' }
                        const sub = eventSubtext(e)
                        return (
                            <div
                                key={`${e.type}-${e.ts}-${i}`}
                                style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: 10,
                                    padding: '10px 14px',
                                    borderTop: i === 0 ? 'none' : '1px solid #e3e6eb',
                                    fontSize: 13,
                                }}
                            >
                                <span
                                    aria-hidden
                                    title={e.type}
                                    style={{
                                        fontSize: 14,
                                        lineHeight: '1.4',
                                        flexShrink: 0,
                                        userSelect: 'none',
                                    }}
                                >
                                    {decor.icon}
                                </span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 500, color: decor.color }}>
                                        {e.title}
                                    </div>
                                    {sub && (
                                        <div style={{
                                            fontSize: 11.5,
                                            color: '#5b6877',
                                            marginTop: 2,
                                            whiteSpace: 'pre-wrap',
                                        }}>
                                            {sub}
                                        </div>
                                    )}
                                </div>
                                <div style={{
                                    fontSize: 11.5,
                                    color: '#7a8290',
                                    flexShrink: 0,
                                    whiteSpace: 'nowrap',
                                }}>
                                    {formatTimestamp(e.ts)}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
