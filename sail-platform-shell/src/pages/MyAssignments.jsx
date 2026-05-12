// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Helm — /my-assignments (student-facing cross-class list)
// ─────────────────────────────────────────────────────────────────────────────
// Port of the copilot prototype's MyAssignments page, simplified to use
// the single Helm RPC `helm_list_assignments_for_student` (migration M10)
// which does the server-side join: assignments × classes ×
// student_assignments, filtered to the calling student's own rows.
//
// Per-row UX:
//   * my_status ∈ {null, 'assigned'}     → textarea + Submit button
//   * my_status ∈ {'submitted','graded'} → read-only content + timestamp
//   * graded grade display intentionally NOT shown here. Gradebook is
//     the canonical surface for that and admits students (server-side
//     filters to their own graded rows). Don't fork the grade surface.
//
// Permission model:
//   * CAN.viewOwnAssignments(role) === student only.
//   * Route + nav link gated on the same in App.jsx.
//   * Defensive page-level <Navigate to="/" replace /> if rendered for
//     an ineligible role; placed AFTER all hooks (rules-of-hooks safe).
// ═══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN } from '../lib/permissions'

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

function isSubmittedStatus(s) {
    return s === 'submitted' || s === 'graded'
}

export default function MyAssignments() {
    const { role, schoolId } = useAuth()

    // 'loading' | 'ready' | 'error'
    const [status, setStatus]           = useState('loading')
    const [pageError, setPageError]     = useState(null)
    const [rows, setRows]               = useState([])

    // Per-row local state for the submit form. Keyed by assignment_id.
    const [drafts,       setDrafts]       = useState({})
    const [submittingId, setSubmittingId] = useState(null)
    const [rowErrors,    setRowErrors]    = useState({})

    const refresh = useCallback(async () => {
        setStatus('loading')
        setPageError(null)
        const { data, error } = await api.assignments.listForStudent()
        if (error) {
            setPageError(error)
            setStatus('error')
            return
        }
        setRows(data || [])
        setStatus('ready')
    }, [])

    useEffect(() => { refresh() }, [refresh])

    const onSubmit = async (assignmentId) => {
        if (submittingId) return
        const text = (drafts[assignmentId] || '').trim()
        if (!text) {
            setRowErrors((prev) => ({ ...prev, [assignmentId]: { message: 'Type a submission first.' } }))
            return
        }
        setSubmittingId(assignmentId)
        setRowErrors((prev) => { const n = { ...prev }; delete n[assignmentId]; return n })

        const { error } = await api.assignments.submit(assignmentId, text)
        if (error) {
            setRowErrors((prev) => ({ ...prev, [assignmentId]: error }))
            setSubmittingId(null)
            return
        }

        // Optimistic in-page update — flip the row to 'submitted' without
        // a full refetch. The next refresh will overwrite this with the
        // canonical server state anyway.
        setRows((prev) => prev.map((r) => (
            r.assignment_id === assignmentId
                ? { ...r, my_status: 'submitted', my_submission_text: text, my_submitted_at: new Date().toISOString() }
                : r
        )))
        setDrafts((prev) => { const n = { ...prev }; delete n[assignmentId]; return n })
        setSubmittingId(null)
    }

    // Defensive double-gate — the route + nav link in App.jsx are
    // already CAN.viewOwnAssignments-gated. Placed AFTER all hooks so
    // hook order stays consistent across renders.
    if (!CAN.viewOwnAssignments(role)) {
        return <Navigate to="/" replace />
    }

    if (!schoolId) {
        return (
            <div>
                <h2>My Assignments</h2>
                <p style={{ color: '#666' }}>
                    You are not a member of any school yet. Ask your school
                    admin to add you.
                </p>
            </div>
        )
    }

    if (status === 'loading') {
        return <div style={{ padding: 20, color: '#888' }}>Loading assignments…</div>
    }
    if (status === 'error') {
        return (
            <div>
                <h2>My Assignments</h2>
                <ErrorBox error={pageError} />
            </div>
        )
    }

    return (
        <div>
            <h2 style={{ marginTop: 0 }}>My Assignments</h2>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
                {rows.length} assignment{rows.length === 1 ? '' : 's'}
            </div>

            {rows.length === 0 ? (
                <p style={{ color: '#888', fontSize: 14 }}>
                    No assignments yet. Your teachers will post them here when ready.
                </p>
            ) : (
                <div>
                    {rows.map((row) => {
                        const isSubmitted = isSubmittedStatus(row.my_status)
                        const draft = drafts[row.assignment_id] ?? ''
                        const isThisSubmitting = submittingId === row.assignment_id
                        const rowError = rowErrors[row.assignment_id]

                        return (
                            <div
                                key={row.assignment_id}
                                style={{
                                    border: '1px solid #e2e8f0',
                                    borderRadius: 6,
                                    padding: '12px 16px',
                                    margin: '8px 0',
                                    background: isSubmitted ? '#f0fdf4' : '#fff',
                                }}
                            >
                                <div style={{
                                    display: 'flex', alignItems: 'baseline',
                                    justifyContent: 'space-between', gap: 10,
                                    flexWrap: 'wrap',
                                }}>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: 15 }}>
                                            {row.title}
                                        </div>
                                        {row.class_name && (
                                            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                                                {row.class_name}
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

                                {row.description && (
                                    <div style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>
                                        {row.description}
                                    </div>
                                )}

                                {isSubmitted ? (
                                    <div style={{
                                        marginTop: 10, padding: 10, background: '#fff',
                                        border: '1px solid #d1fae5', borderRadius: 4,
                                    }}>
                                        <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 4 }}>
                                            Submitted {row.my_submitted_at ? new Date(row.my_submitted_at).toLocaleString() : ''}
                                            {row.my_status === 'graded' ? ' · graded' : ''}
                                        </div>
                                        <div style={{
                                            whiteSpace: 'pre-wrap',
                                            fontSize: 13.5,
                                            color: '#0f172a',
                                        }}>
                                            {row.my_submission_text || <span style={{ color: '#94a3b8' }}>(no content recorded)</span>}
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ marginTop: 10 }}>
                                        <textarea
                                            value={draft}
                                            onChange={(e) => setDrafts((prev) => ({ ...prev, [row.assignment_id]: e.target.value }))}
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
                                                onClick={() => onSubmit(row.assignment_id)}
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
        </div>
    )
}
