import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getStudentInSchool } from '../services/students'

/**
 * /schools/:schoolId/students/:studentId — Phase D pair-route anchor
 *
 * Minimal Student parent page. Exists so the URL pair
 * (`/schools/:schoolId/students/:studentId` and `.../timeline`) is
 * navigable in either direction without relying on prior state — a
 * deep link to the timeline can offer a deterministic "Back to
 * student" target, and any student-context surface in Helm
 * (Attendance / Gradebook / Class submissions) has a single
 * canonical "View Student" destination.
 *
 * Strict scope (NOT a student profile page):
 *   * Header: name + email + school role + joined date.
 *   * One action: "View Timeline →".
 *   * "← Back" walks browser history (parent has no canonical
 *     predecessor — operators arrive from many places).
 *   * No tabs, no inline timeline, no editing, no breadcrumbs,
 *     no design-system layout.
 *
 * Deep-link safety: all data derived from URL params. No reliance
 * on prior navigation state, no React Router state passing.
 */

function truncateId(id) {
    if (!id || id.length < 10) return id
    return `${id.slice(0, 4)}…${id.slice(-4)}`
}

function formatJoinedDate(iso) {
    if (!iso) return ''
    try {
        const d = new Date(iso)
        return d.toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
        })
    } catch {
        return iso
    }
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

export default function StudentPage() {
    const { schoolId, studentId } = useParams()
    const navigate = useNavigate()

    const [student, setStudent] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error,   setError]   = useState(null)

    useEffect(() => {
        let alive = true
        async function load() {
            if (!schoolId || !studentId) return
            setLoading(true); setError(null)
            try {
                const row = await getStudentInSchool({ studentId, schoolId })
                if (alive) setStudent(row)
            } catch (err) {
                if (alive) { setError(err); setStudent(null) }
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

            <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>
                {loading
                    ? 'Loading student…'
                    : student?.fullName || `Student ${truncateId(studentId)}`}
            </h1>
            <div style={{ fontSize: 13, color: '#5b6877', marginBottom: 20 }}>
                {student?.email && <>{student.email}{(student.role || student.joinedAt) ? ' · ' : ''}</>}
                {student?.role && <>{student.role}{student.joinedAt ? ' · ' : ''}</>}
                {student?.joinedAt && <>Joined {formatJoinedDate(student.joinedAt)}</>}
                {!loading && !student && !error && (
                    <span style={{ color: '#7a8290' }}>
                        Not visible — student may not be in this school, or you may
                        not have access.
                    </span>
                )}
            </div>

            <ErrorBox error={error} />

            {!loading && (
                <Link
                    to={`/schools/${schoolId}/students/${studentId}/timeline`}
                    style={{
                        display: 'inline-block',
                        padding: '8px 16px',
                        borderRadius: 4,
                        background: '#3b6cd8',
                        color: '#fff',
                        fontSize: 13,
                        fontWeight: 500,
                        textDecoration: 'none',
                    }}
                >
                    View Timeline →
                </Link>
            )}
        </div>
    )
}
