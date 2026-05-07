import { useState, useEffect } from 'react'
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

    async function loadClasses() {
        let query = supabase.from('classes').select('*')
        if (schoolId) query = query.eq('school_id', schoolId)
        const { data } = await query
        setClasses(data || [])
    }

    async function loadGradebook() {
        const { data: classAssignments } = await supabase
            .from('assignments')
            .select('id')
            .eq('class_id', selectedClass)

        if (!classAssignments?.length) {
            setRows([])
            return
        }

        const assignmentIds = classAssignments.map(a => a.id)

        const { data } = await supabase
            .from('student_assignments')
            .select('*, assignments(title)')
            .in('assignment_id', assignmentIds)
            .order('assignment_id')

        setRows(data || [])
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
                                <td>{r.student_id}</td>
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
