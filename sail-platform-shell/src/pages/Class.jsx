import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { CAN } from '../lib/permissions'
import {
    listAssignmentsByClass,
    createAssignment,
    listSubmissions,
} from '../services/assignments'
import { getClass } from '../services/classes'

/**
 * /class/:classId — Phase 6D
 *
 * Teacher-facing class page. Reuses backend layers built in Phases
 * 6A → 6C without duplicating any logic in the page itself:
 *
 *   * class metadata + school name → classesService.getClass(classId)
 *   * assignments list             → assignmentsService.listAssignmentsByClass(classId)
 *                                    (Phase 6D-extended bridge_list_assignments
 *                                    with class-scope)
 *   * create assignment            → assignmentsService.createAssignment({classId,…})
 *                                    (Phase 6C bridge_create_assignment)
 *   * list submissions             → assignmentsService.listSubmissions(assignmentId)
 *                                    (Phase 6B bridge_list_submissions)
 *
 * Permissions reuse Helm's local CAN module (school-role-based, not
 * platform RBAC). Bridge-tier overrides (assignments.read /
 * assignments.write) flow through the backend gates automatically when
 * a Bridge-platform user is signed in — no Helm-side change needed.
 *
 * UI: minimal, click-to-expand. No modals. No pagination. No styling
 * beyond basic layout. Per the brief: "functional surface, not polished
 * product".
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
            margin: '8px 0',
        }}>
            {error.message || String(error)}
        </div>
    )
}

export default function ClassPage() {
    const { classId } = useParams()
    const { role } = useAuth()

    // Permission split:
    //   * canCreate gates the Create Assignment affordance. Local CAN
    //     resolves teacher/admin → true, student → false (the dead
    //     `super_admin` rank was removed in Phase Lockdown C 2026-05-07).
    //     If a Bridge-tier user (assignments.write override) ever signs
    //     into Helm, they'd have role='admin' per their school
    //     membership, so this still works without a separate gate.
    const canCreate = CAN.createAssignment(role)

    const [klass,        setKlass]        = useState(null)
    const [assignments,  setAssignments]  = useState([])
    const [loading,      setLoading]      = useState(true)
    const [error,        setError]        = useState(null)

    // Create form
    const [showForm,    setShowForm]    = useState(false)
    const [titleInput,  setTitleInput]  = useState('')
    const [descInput,   setDescInput]   = useState('')
    const [submitting,  setSubmitting]  = useState(false)
    const [submitError, setSubmitError] = useState(null)

    // Click-to-expand submissions state. One assignment open at a time.
    // Submissions cache: { [assignmentId]: Array }. Lazy-loaded.
    const [openAssignmentId,  setOpenAssignmentId]  = useState(null)
    const [submissionsCache,  setSubmissionsCache]  = useState({})
    const [submissionsLoading, setSubmissionsLoading] = useState(null)
    const [submissionsError,   setSubmissionsError]   = useState(null)

    const refresh = useCallback(async () => {
        if (!classId) return
        setLoading(true); setError(null)
        try {
            const [classRow, assignmentRows] = await Promise.all([
                getClass(classId),
                listAssignmentsByClass(classId),
            ])
            setKlass(classRow)
            setAssignments(assignmentRows)
        } catch (err) {
            setError(err)
        } finally {
            setLoading(false)
        }
    }, [classId])

    useEffect(() => { refresh() }, [refresh])

    const toggleAssignment = useCallback(async (assignmentId) => {
        if (openAssignmentId === assignmentId) {
            setOpenAssignmentId(null)
            return
        }
        setOpenAssignmentId(assignmentId)
        if (submissionsCache[assignmentId]) return
        setSubmissionsLoading(assignmentId)
        setSubmissionsError(null)
        try {
            const subs = await listSubmissions(assignmentId)
            setSubmissionsCache(prev => ({ ...prev, [assignmentId]: subs }))
        } catch (err) {
            setSubmissionsError({ id: assignmentId, error: err })
        } finally {
            setSubmissionsLoading(null)
        }
    }, [openAssignmentId, submissionsCache])

    const submitNew = async () => {
        if (!canCreate || submitting) return
        const trimmed = titleInput.trim()
        if (!trimmed) {
            setSubmitError({ message: 'Title is required.' })
            return
        }
        setSubmitting(true); setSubmitError(null)
        try {
            const newRow = await createAssignment({
                classId,
                title:       trimmed,
                description: descInput.trim() || null,
            })
            // Optimistic prepend (note: createAssignment returns a row
            // without the joined class_name, but the page already has
            // the class context so we don't render that field per row).
            if (newRow) setAssignments(prev => [newRow, ...prev])
            setTitleInput(''); setDescInput(''); setShowForm(false)
        } catch (err) {
            setSubmitError(err)
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) {
        return <div style={{ padding: 20, color: '#888' }}>Loading class…</div>
    }
    if (error) {
        return (
            <div style={{ padding: 20 }}>
                <ErrorBox error={error} />
                <p><Link to="/assignments">← Back to assignments</Link></p>
            </div>
        )
    }
    if (!klass) {
        return (
            <div style={{ padding: 20 }}>
                <p>Class not found.</p>
                <Link to="/assignments">← Back to assignments</Link>
            </div>
        )
    }

    return (
        <div>
            {/* ── Header ────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>{klass.name || '(unnamed class)'}</h2>
                {klass.subject && (
                    <span style={{ fontSize: 13, color: '#777' }}>{klass.subject}</span>
                )}
                {/* Phase A — attendance entry point. Sits on the header
                    so it's discoverable from the canonical class page.
                    Read-only RLS lets the link render for any school
                    member; the page itself enforces "only staff can
                    mark" via the RPC gate. */}
                <span style={{ flex: 1 }} />
                <Link
                    to={`/class/${classId}/attendance`}
                    style={{ fontSize: 12.5, color: '#3b6cd8' }}
                >
                    Take Register →
                </Link>
                <Link
                    to={`/class/${classId}/behaviour`}
                    style={{ fontSize: 12.5, color: '#3b6cd8', marginLeft: 12 }}
                >
                    Behaviour →
                </Link>
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
                {klass.school?.name ? <>School: <strong>{klass.school.name}</strong></> : null}
                {' · '}
                {assignments.length} assignment{assignments.length === 1 ? '' : 's'}
            </div>

            <hr style={{ margin: '12px 0' }} />

            {/* ── Section A: Assignments ────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>Assignments</h3>
                {canCreate && !showForm && (
                    <button
                        type="button"
                        onClick={() => { setShowForm(true); setSubmitError(null) }}
                        style={{
                            background: '#2563eb',
                            color: '#fff',
                            border: 'none',
                            padding: '5px 12px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 13,
                        }}
                    >
                        + Create Assignment
                    </button>
                )}
            </div>

            {showForm && canCreate && (
                <div style={{
                    border: '1px solid #cbd5e1',
                    background: '#f8fafc',
                    padding: 12,
                    borderRadius: 6,
                    marginBottom: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                }}>
                    <input
                        type="text"
                        placeholder="Assignment title"
                        value={titleInput}
                        onChange={(e) => { setTitleInput(e.target.value); setSubmitError(null) }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !submitting) { e.preventDefault(); submitNew() }
                            if (e.key === 'Escape') { setShowForm(false); setSubmitError(null) }
                        }}
                        disabled={submitting}
                        autoFocus
                        style={{ padding: '6px 10px', fontSize: 14, border: '1px solid #cbd5e1', borderRadius: 4 }}
                    />
                    <textarea
                        placeholder="Description (optional)"
                        value={descInput}
                        onChange={(e) => setDescInput(e.target.value)}
                        disabled={submitting}
                        rows={3}
                        style={{
                            padding: '6px 10px', fontSize: 14, border: '1px solid #cbd5e1',
                            borderRadius: 4, fontFamily: 'inherit', resize: 'vertical',
                        }}
                    />
                    <ErrorBox error={submitError} />
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            type="button"
                            onClick={submitNew}
                            disabled={submitting || !titleInput.trim()}
                            style={{
                                background: '#2563eb', color: '#fff', border: 'none',
                                padding: '6px 14px', borderRadius: 4,
                                cursor: (submitting || !titleInput.trim()) ? 'not-allowed' : 'pointer',
                                opacity: (submitting || !titleInput.trim()) ? 0.6 : 1,
                                fontSize: 13,
                            }}
                        >
                            {submitting ? 'Saving…' : 'Save'}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setShowForm(false); setSubmitError(null) }}
                            disabled={submitting}
                            style={{
                                background: 'transparent', border: '1px solid #cbd5e1',
                                padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {assignments.length === 0 ? (
                <p style={{ color: '#888', fontSize: 14 }}>
                    No assignments yet.{canCreate ? ' Click "Create Assignment" to get started.' : ''}
                </p>
            ) : (
                <div>
                    {assignments.map((a) => {
                        const isOpen = openAssignmentId === a.id
                        const subs = submissionsCache[a.id]
                        const isLoadingSubs = submissionsLoading === a.id
                        const subsErr = submissionsError?.id === a.id ? submissionsError.error : null
                        return (
                            <div
                                key={a.id}
                                style={{
                                    border: '1px solid #e2e8f0',
                                    borderRadius: 6,
                                    padding: '10px 14px',
                                    margin: '6px 0',
                                    background: isOpen ? '#f8fafc' : '#fff',
                                }}
                            >
                                {/* ── Section B trigger row (the assignment itself) ─── */}
                                <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => toggleAssignment(a.id)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault()
                                            toggleAssignment(a.id)
                                        }
                                    }}
                                    style={{
                                        cursor: 'pointer', display: 'flex',
                                        alignItems: 'baseline', justifyContent: 'space-between',
                                        gap: 10,
                                    }}
                                    title={isOpen ? 'Hide submissions' : 'Show submissions'}
                                >
                                    <div>
                                        <span style={{ fontWeight: 600 }}>
                                            {isOpen ? '▾' : '▸'} {a.title}
                                        </span>
                                        {a.description && (
                                            <div style={{ color: '#666', fontSize: 13, marginTop: 2, marginLeft: 14 }}>
                                                {a.description}
                                            </div>
                                        )}
                                    </div>
                                    <span style={{ color: '#94a3b8', fontSize: 12, whiteSpace: 'nowrap' }}>
                                        {new Date(a.created_at).toLocaleString()}
                                    </span>
                                </div>

                                {/* ── Section B body: submissions for the open assignment ─── */}
                                {isOpen && (
                                    <div style={{ marginTop: 10, marginLeft: 14 }}>
                                        {isLoadingSubs ? (
                                            <span style={{ color: '#888', fontSize: 13 }}>
                                                Loading submissions…
                                            </span>
                                        ) : subsErr ? (
                                            <ErrorBox error={subsErr} />
                                        ) : !subs || subs.length === 0 ? (
                                            <span style={{ color: '#888', fontSize: 13 }}>
                                                No submissions yet.
                                            </span>
                                        ) : (
                                            <div>
                                                <div style={{ color: '#666', fontSize: 12, marginBottom: 4 }}>
                                                    {subs.length} submission{subs.length === 1 ? '' : 's'}
                                                </div>
                                                {subs.map((s) => (
                                                    <div
                                                        key={s.id}
                                                        style={{
                                                            border: '1px solid #e2e8f0',
                                                            borderRadius: 4,
                                                            padding: '6px 10px',
                                                            marginTop: 4,
                                                            background: '#fff',
                                                            fontSize: 13,
                                                        }}
                                                    >
                                                        <div style={{
                                                            display: 'flex', justifyContent: 'space-between',
                                                            alignItems: 'baseline', marginBottom: 3,
                                                        }}>
                                                            <span>
                                                                <strong>
                                                                    {s.student_name
                                                                        || `student ${s.student_id?.slice(0, 8)}…`}
                                                                </strong>
                                                                <span style={{
                                                                    color: '#94a3b8', marginLeft: 8, fontSize: 12,
                                                                }}>
                                                                    · {s.status}
                                                                </span>
                                                            </span>
                                                            <span style={{ color: '#94a3b8', fontSize: 12 }}>
                                                                {new Date(s.created_at).toLocaleString()}
                                                            </span>
                                                        </div>
                                                        {s.content && (
                                                            <div style={{
                                                                whiteSpace: 'pre-wrap',
                                                                color: '#475569', fontSize: 12.5,
                                                            }}>
                                                                {s.content.length > 240
                                                                    ? `${s.content.slice(0, 240)}…`
                                                                    : s.content}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
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
