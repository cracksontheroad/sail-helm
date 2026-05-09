import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'

const STATUS_LABEL = {
    assigned: 'Assigned',
    submitted: 'Submitted',
    graded: 'Graded',
}

function StatusBadge({ status }) {
    const className = `badge badge--${status ?? 'assigned'}`
    return <span className={className}>{STATUS_LABEL[status] ?? status ?? '—'}</span>
}

function GradeCell({ value }) {
    if (value === null || value === undefined || value === '') {
        return <span className="muted" aria-label="No grade">—</span>
    }
    return <>{value}</>
}

function FeedbackCell({ text }) {
    if (!text) {
        return <span className="muted" aria-label="No feedback">—</span>
    }
    return (
        <details className="feedback-cell">
            <summary>{text}</summary>
            <div className="feedback-cell__full">{text}</div>
        </details>
    )
}

export default function Gradebook() {
    const { schoolId } = useAuth()

    const [classes, setClasses] = useState([])
    const [selectedClass, setSelectedClass] = useState('')
    const [rows, setRows] = useState([])

    useEffect(() => {
        if (schoolId) loadClasses()
    }, [schoolId])

    useEffect(() => {
        if (selectedClass) loadGradebook()
        else setRows([])
    }, [selectedClass])

    // ── B27.1 read-path consolidation (2026-05-08) ─────────────────────
    // Both reads moved off `supabase.from(...)` onto Core RPCs.
    // bridge_list_class_gradebook collapses the previous two-step query
    // (assignments → student_assignments) into one round-trip and
    // returns the assignment title pre-joined as `assignment_title`,
    // so downstream rendering can use that instead of the previous
    // `assignments(title)` PostgREST embed.

    async function loadClasses() {
        if (!schoolId) {
            setClasses([])
            return
        }
        const { data, error } = await supabase.rpc('bridge_list_classes', {
            p_school_id: schoolId,
        })
        if (error) {
            console.error('[Gradebook.loadClasses] bridge_list_classes failed:', error.message)
        }
        setClasses(data || [])
    }

    async function loadGradebook() {
        if (!selectedClass) {
            setRows([])
            return
        }
        const { data, error } = await supabase.rpc('bridge_list_class_gradebook', {
            p_class_id: selectedClass,
        })
        if (error) {
            console.error('[Gradebook.loadGradebook] bridge_list_class_gradebook failed:', error.message)
        }
        // Shape adjustment: the RPC returns assignment_title as a flat
        // column. Wrap into `assignments: { title }` so the existing
        // render code that reads `r.assignments?.title` keeps working
        // unchanged. Future cleanup: have the JSX read assignment_title
        // directly and drop this adapter.
        const adapted = (data || []).map(r => ({
            ...r,
            assignments: { title: r.assignment_title },
        }))
        setRows(adapted)
    }

    return (
        <section className="app-page gradebook">
            <header className="app-page__header">
                <h2 className="app-page__title">Gradebook</h2>
                <p className="app-page__subtitle">
                    Submissions for the selected class. AI grades shown alongside teacher grades for review.
                </p>
            </header>

            <div className="app-toolbar">
                <div className="app-field">
                    <label className="app-field__label" htmlFor="gradebook-class">Class</label>
                    <select
                        id="gradebook-class"
                        className="app-select"
                        value={selectedClass}
                        onChange={(e) => setSelectedClass(e.target.value)}
                    >
                        <option value="">Select a class…</option>
                        {classes.map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {!selectedClass && (
                <div className="empty-state">Select a class above to view the gradebook.</div>
            )}

            {selectedClass && rows.length === 0 && (
                <div className="empty-state">No assignments distributed yet for this class.</div>
            )}

            {rows.length > 0 && (
                <table className="data-table" aria-label="Gradebook">
                    <thead>
                        <tr>
                            <th scope="col">Student</th>
                            <th scope="col">Assignment</th>
                            <th scope="col">Status</th>
                            <th scope="col">Grade</th>
                            <th scope="col">AI Grade</th>
                            <th scope="col">AI Feedback</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={r.id}>
                                {/* Phase D pair-route — student_id wrapped
                                    as a Link to the canonical Student
                                    parent page. schoolId is at page level
                                    via useAuth(). The cell still shows
                                    the raw uuid (no name lookup here —
                                    Gradebook is data-dense, the link is
                                    enough). */}
                                <td>
                                    {schoolId && r.student_id ? (
                                        <Link
                                            to={`/schools/${schoolId}/students/${r.student_id}`}
                                            style={{ color: 'inherit' }}
                                        >
                                            {r.student_id}
                                        </Link>
                                    ) : (
                                        r.student_id
                                    )}
                                </td>
                                <td>{r.assignments?.title ?? <span className="muted">—</span>}</td>
                                <td><StatusBadge status={r.status} /></td>
                                <td className="num-cell"><GradeCell value={r.grade} /></td>
                                <td className="num-cell"><GradeCell value={r.ai_grade} /></td>
                                <td><FeedbackCell text={r.feedback} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    )
}
