import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../lib/AuthContext'
import {
    listAssignmentsBySchool,
    listMyAssignmentRows,
    submitAssignment,
} from '../services/assignments'

/**
 * /my-assignments — Phase 6E
 *
 * Student-facing surface. Lists every assignment in the student's school
 * (cross-class) and shows their submission status per row:
 *   * 'not submitted' → textarea + Submit button
 *   * 'submitted'     → read-only content + timestamp
 *   * 'graded'        → same as submitted (no grade UI here — out of
 *                        brief scope for 6E; the legacy /my-grades
 *                        placeholder is the future grade view)
 *
 * Backend reuse — no new RPCs:
 *   * `listAssignmentsBySchool(schoolId)` → bridge_list_assignments(p_school_id)
 *   * `listMyAssignmentRows()` → direct student_assignments SELECT
 *      filtered by student_id=auth.uid() (Phase 6B's tightened RLS
 *      already admits student-own; the `.eq` on student_id is a
 *      defensive narrowing).
 *   * `submitAssignment({assignmentId, content})` → bridge_submit_assignment
 *
 * No supabase import in this file — service module is the only place
 * with that coupling. Errors thrown by services land in inline error
 * blocks per row (or page-level for the initial fetch).
 */

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

export default function MyAssignmentsPage() {
    const { schoolId, role } = useAuth()

    const [assignments, setAssignments] = useState([])
    const [myRows,      setMyRows]      = useState([])  // student_assignments for me
    const [loading,     setLoading]     = useState(true)
    const [error,       setError]       = useState(null)

    // Per-assignment local state — submission text being drafted, plus
    // submitting/error flags. Keyed by assignment.id.
    const [drafts,       setDrafts]       = useState({})       // { [id]: text }
    const [submittingId, setSubmittingId] = useState(null)
    const [rowErrors,    setRowErrors]    = useState({})       // { [id]: error }

    const refresh = useCallback(async () => {
        if (!schoolId) {
            setLoading(false)
            setError({ message: 'You are not a member of any school yet. Ask your school admin to add you.' })
            return
        }
        setLoading(true); setError(null)
        try {
            const [assignmentRows, myAssignmentRows] = await Promise.all([
                listAssignmentsBySchool(schoolId),
                listMyAssignmentRows(),
            ])
            setAssignments(assignmentRows)
            setMyRows(myAssignmentRows)
        } catch (err) {
            setError(err)
        } finally {
            setLoading(false)
        }
    }, [schoolId])

    useEffect(() => { refresh() }, [refresh])

    // Index myRows by assignment_id for O(1) lookup per row render.
    const myRowByAssignment = useMemo(() => {
        const m = {}
        for (const r of myRows) m[r.assignment_id] = r
        return m
    }, [myRows])

    const onSubmit = async (assignmentId) => {
        if (submittingId) return
        const text = (drafts[assignmentId] || '').trim()
        if (!text) {
            setRowErrors(prev => ({ ...prev, [assignmentId]: { message: 'Type a submission first.' } }))
            return
        }
        setSubmittingId(assignmentId)
        setRowErrors(prev => { const n = { ...prev }; delete n[assignmentId]; return n })
        try {
            const newRow = await submitAssignment({ assignmentId, content: text })
            // Merge the new/updated row into myRows so the UI flips to
            // submitted state without a full refetch.
            setMyRows(prev => {
                const without = prev.filter(r => r.assignment_id !== assignmentId)
                return newRow ? [...without, newRow] : without
            })
            setDrafts(prev => { const n = { ...prev }; delete n[assignmentId]; return n })
        } catch (err) {
            setRowErrors(prev => ({ ...prev, [assignmentId]: err }))
        } finally {
            setSubmittingId(null)
        }
    }

    if (loading) {
        return <div style={{ padding: 20, color: '#888' }}>Loading assignments…</div>
    }
    if (error) {
        return (
            <div style={{ padding: 20 }}>
                <h2>My Assignments</h2>
                <ErrorBox error={error} />
            </div>
        )
    }

    return (
        <div>
            <h2 style={{ marginTop: 0 }}>My Assignments</h2>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
                {assignments.length} assignment{assignments.length === 1 ? '' : 's'} across your school
            </div>

            {assignments.length === 0 ? (
                <p style={{ color: '#888', fontSize: 14 }}>
                    No assignments yet. Your teachers will post them here when ready.
                </p>
            ) : (
                <div>
                    {assignments.map((a) => {
                        const myRow = myRowByAssignment[a.id]
                        const isSubmitted = myRow && (myRow.status === 'submitted' || myRow.status === 'graded')
                        const draft = drafts[a.id] ?? ''
                        const isThisSubmitting = submittingId === a.id
                        const rowError = rowErrors[a.id]

                        return (
                            <div
                                key={a.id}
                                style={{
                                    border: '1px solid #e2e8f0',
                                    borderRadius: 6,
                                    padding: '12px 16px',
                                    margin: '8px 0',
                                    background: isSubmitted ? '#f0fdf4' : '#fff',
                                }}
                            >
                                {/* ── Title row ─────────────────────────── */}
                                <div style={{
                                    display: 'flex', alignItems: 'baseline',
                                    justifyContent: 'space-between', gap: 10,
                                    flexWrap: 'wrap',
                                }}>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: 15 }}>
                                            {a.title}
                                        </div>
                                        {a.class_name && (
                                            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                                                {a.class_name}
                                            </div>
                                        )}
                                    </div>
                                    <span style={{
                                        fontSize: 11.5,
                                        padding: '2px 8px',
                                        borderRadius: 4,
                                        background: isSubmitted ? '#bbf7d0' : '#fef3c7',
                                        color:      isSubmitted ? '#166534' : '#92400e',
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                    }}>
                                        {isSubmitted ? '✓ submitted' : 'not submitted'}
                                    </span>
                                </div>

                                {a.description && (
                                    <div style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>
                                        {a.description}
                                    </div>
                                )}

                                {/* ── Content area ───────────────────────── */}
                                {isSubmitted ? (
                                    <div style={{ marginTop: 10, padding: 10, background: '#fff', border: '1px solid #d1fae5', borderRadius: 4 }}>
                                        <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 4 }}>
                                            Submitted {myRow?.created_at ? new Date(myRow.created_at).toLocaleString() : ''}
                                            {myRow?.status === 'graded' ? ' · graded' : ''}
                                        </div>
                                        <div style={{
                                            whiteSpace: 'pre-wrap',
                                            fontSize: 13.5,
                                            color: '#0f172a',
                                        }}>
                                            {myRow?.content || <span style={{ color: '#94a3b8' }}>(no content recorded)</span>}
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ marginTop: 10 }}>
                                        <textarea
                                            value={draft}
                                            onChange={(e) => setDrafts(prev => ({ ...prev, [a.id]: e.target.value }))}
                                            placeholder="Write your submission here…"
                                            disabled={isThisSubmitting}
                                            rows={4}
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
                                        <ErrorBox error={rowError} />
                                        <div style={{ marginTop: 6 }}>
                                            <button
                                                type="button"
                                                onClick={() => onSubmit(a.id)}
                                                disabled={isThisSubmitting || !draft.trim()}
                                                style={{
                                                    background: '#2563eb',
                                                    color: '#fff',
                                                    border: 'none',
                                                    padding: '6px 14px',
                                                    borderRadius: 4,
                                                    cursor: (isThisSubmitting || !draft.trim()) ? 'not-allowed' : 'pointer',
                                                    opacity: (isThisSubmitting || !draft.trim()) ? 0.6 : 1,
                                                    fontSize: 13,
                                                }}
                                            >
                                                {isThisSubmitting ? 'Submitting…' : 'Submit'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {/*
              Read-only courtesy hint for non-students who happen to land
              on this URL — the route is open to any authenticated user;
              service-side RLS handles the actual visibility. For a
              teacher / admin viewing this URL, listMyAssignmentRows
              returns whatever student_assignments rows they own (likely
              none), so every row would render in the "not submitted"
              shape. This banner makes the experience honest.
            */}
            {role && role !== 'student' && (
                <div style={{
                    marginTop: 16, padding: '8px 12px',
                    background: '#fefce8', border: '1px solid #fde68a',
                    borderRadius: 4, color: '#713f12', fontSize: 12.5,
                }}>
                    You're viewing this page as <strong>{role}</strong>. Only students see their own
                    submissions; the submit form is meant for student accounts.
                </div>
            )}
        </div>
    )
}
