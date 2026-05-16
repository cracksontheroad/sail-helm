import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { usePermissions } from '../app/providers/PermissionsProvider'

/**
 * Gradebook — Phase 2 Route 3 of the Helm rebuild.
 *
 * Spec contract: HELM_PHASE_2_SPEC.md §3.3 (locked 2026-05-12).
 *
 * Thin layer on top of `assignments`. Same class → assignment
 * selector flow; replaces the per-row submission detail with a
 * grade input + feedback textarea for staff, and a read-only grade
 * panel for students.
 *
 * Access control is enforced server-side by
 * `list_assignment_submissions`:
 *   - staff (teacher-of-class OR admin-of-school) → all submissions
 *   - enrolled student → own row only, only if status='graded'
 *   - anyone else → RPC raises 42501
 *
 * No batch RPC. Staff click "Save" per row; if you need to grade 30
 * students, that's 30 calls. Phase 2.5+ can add a thin batch RPC if
 * the UX warrants it.
 */
export default function Gradebook() {
    const { schoolId } = useAuth()
    // DB-backed gates (2026-05-16 Gradebook batch). The view/access split
    // between staff and students is intentional per the architectural
    // decision documented in MyAssignments.jsx — students access /gradebook
    // and see their own filtered rows (server-side RPC scope), staff
    // additionally have grading capability.
    const { can } = usePermissions()

    const [classes, setClasses] = useState([])
    const [selectedClassId, setSelectedClassId] = useState('')
    const [assignments, setAssignments] = useState([])
    const [selectedAssignmentId, setSelectedAssignmentId] = useState('')
    const [submissions, setSubmissions] = useState([])

    const [classesStatus, setClassesStatus] = useState('idle')
    const [classesError, setClassesError]   = useState(null)
    const [aStatus, setAStatus] = useState('idle')
    const [aError, setAError]   = useState(null)
    const [sStatus, setSStatus] = useState('idle')
    const [sError, setSError]   = useState(null)

    const canGrade = can('helm.submissions.grade')

    const loadClasses = useCallback(async () => {
        if (!schoolId) return
        setClassesStatus('loading')
        setClassesError(null)
        const { data, error } = await api.classes.list(schoolId)
        if (error) {
            setClassesError(error.message || 'Could not load classes.')
            setClassesStatus('error')
            return
        }
        setClasses(data || [])
        setClassesStatus('ready')
        if ((data || []).length > 0 && !selectedClassId) {
            setSelectedClassId(data[0].class_id)
        }
    }, [schoolId, selectedClassId])

    const loadAssignments = useCallback(async () => {
        if (!selectedClassId) {
            setAssignments([])
            setAStatus('idle')
            return
        }
        setAStatus('loading')
        setAError(null)

        // Role-aware dispatch lives inside the api layer
        // (`assignments.listForGradebook` selects the staff or student
        // RPC based on the `canGrade` boolean). Keeping it there means
        // the Gradebook component doesn't carry RPC names + doesn't risk
        // re-introducing the staff-RPC-for-student 403 if a future
        // refactor splits this branch differently.
        const { data, error } = await api.assignments.listForGradebook({
            classId:  selectedClassId,
            canGrade,
        })
        if (error) {
            setAError(error.message || 'Could not load assignments.')
            setAStatus('error')
            return
        }
        setAssignments(data || [])
        setAStatus('ready')
        // Don't auto-select an assignment — caller needs to pick.
    }, [selectedClassId, canGrade])

    const loadSubmissions = useCallback(async () => {
        if (!selectedAssignmentId) {
            setSubmissions([])
            setSStatus('idle')
            return
        }
        setSStatus('loading')
        setSError(null)
        const { data, error } = await api.assignments.listSubmissions(selectedAssignmentId)
        if (error) {
            setSError(error.message || 'Could not load submissions.')
            setSStatus('error')
            return
        }
        setSubmissions(data || [])
        setSStatus('ready')
    }, [selectedAssignmentId])

    useEffect(() => { loadClasses() }, [loadClasses])
    useEffect(() => { loadAssignments() }, [loadAssignments])
    useEffect(() => { loadSubmissions() }, [loadSubmissions])

    if (!can('helm.gradebook.view')) {
        return (
            <div>
                <h2>Gradebook</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Gradebook</h2>
                <p>No school context. Reload the page.</p>
            </div>
        )
    }

    return (
        <div>
            <h2>Gradebook</h2>

            {/* Class selector */}
            {classesStatus === 'loading' && <p>Loading classes…</p>}
            {classesStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load classes: <code>{classesError}</code>
                </p>
            )}
            {classesStatus === 'ready' && classes.length === 0 && (
                <p>No classes available.</p>
            )}
            {classesStatus === 'ready' && classes.length > 0 && (
                <div style={ROW_STYLE}>
                    <label htmlFor="gb-class" style={LABEL_STYLE}>Class:</label>
                    <select
                        id="gb-class"
                        value={selectedClassId}
                        onChange={(e) => {
                            setSelectedClassId(e.target.value)
                            setSelectedAssignmentId('')
                            setSubmissions([])
                        }}
                        style={INPUT_STYLE}
                    >
                        {classes.map((c) => (
                            <option key={c.class_id} value={c.class_id}>
                                {c.name}{c.subject ? ` — ${c.subject}` : ''}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {/* Assignment selector */}
            {selectedClassId && aStatus === 'loading' && <p>Loading assignments…</p>}
            {aStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load assignments: <code>{aError}</code>
                </p>
            )}
            {aStatus === 'ready' && assignments.length === 0 && (
                <p>No assignments in this class.</p>
            )}
            {aStatus === 'ready' && assignments.length > 0 && (
                <div style={ROW_STYLE}>
                    <label htmlFor="gb-assignment" style={LABEL_STYLE}>Assignment:</label>
                    <select
                        id="gb-assignment"
                        value={selectedAssignmentId}
                        onChange={(e) => setSelectedAssignmentId(e.target.value)}
                        style={INPUT_STYLE}
                    >
                        <option value="">— select an assignment —</option>
                        {assignments.map((a) => (
                            <option key={a.assignment_id} value={a.assignment_id}>
                                {a.title}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {/* Submissions */}
            {selectedAssignmentId && sStatus === 'loading' && <p>Loading submissions…</p>}
            {sStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load submissions: <code>{sError}</code>
                </p>
            )}

            {sStatus === 'ready' && (
                canGrade
                    ? <TeacherSubmissions
                          submissions={submissions}
                          onChanged={loadSubmissions}
                      />
                    : <StudentGradeView submissions={submissions} />
            )}
        </div>
    )
}

// ─── Teacher view: per-submission grading row ──────────────────────────────

function TeacherSubmissions({ submissions, onChanged }) {
    if (submissions.length === 0) {
        return <p>No students for this assignment yet. Distribute it first from the Assignments page.</p>
    }
    return (
        <div style={GRID_STYLE}>
            {submissions.map((s) => (
                <SubmissionRow
                    key={s.student_assignment_id}
                    submission={s}
                    onChanged={onChanged}
                />
            ))}
        </div>
    )
}

function SubmissionRow({ submission, onChanged }) {
    const canGradeThis = submission.status === 'submitted' || submission.status === 'graded'

    const [draftGrade, setDraftGrade] = useState(submission.grade || '')
    const [draftFeedback, setDraftFeedback] = useState(submission.feedback || '')
    // 'idle' | 'saving' | 'error' | 'saved'
    const [status, setStatus] = useState('idle')
    const [errorMessage, setErrorMessage] = useState(null)

    async function handleSave(event) {
        event.preventDefault()
        const g = draftGrade.trim()
        if (!g) return
        setStatus('saving')
        setErrorMessage(null)
        const { error } = await api.assignments.grade(
            submission.student_assignment_id,
            g,
            draftFeedback.trim(),
        )
        if (error) {
            setErrorMessage(error.message || 'Could not save grade.')
            setStatus('error')
            return
        }
        setStatus('saved')
        await onChanged()
    }

    return (
        <form onSubmit={handleSave} style={SUBMISSION_STYLE}>
            <div style={SUBMISSION_HEAD_STYLE}>
                <strong>{submission.email || <em>(unknown)</em>}</strong>
                <span style={STATUS_PILL_STYLE(submission.status)}>
                    {submission.status || 'no row'}
                </span>
            </div>

            {submission.submission_text ? (
                <div style={SUBMISSION_TEXT_STYLE}>{submission.submission_text}</div>
            ) : (
                <p style={META_STYLE}>
                    {submission.status === 'distributed'
                        ? 'Not yet submitted.'
                        : '(No submission text.)'}
                </p>
            )}

            {canGradeThis && (
                <>
                    <div style={ROW_STYLE}>
                        <label style={LABEL_STYLE}>Grade</label>
                        <input
                            type="text"
                            value={draftGrade}
                            onChange={(e) => { setDraftGrade(e.target.value); if (status === 'saved') setStatus('idle') }}
                            maxLength={100}
                            disabled={status === 'saving'}
                            placeholder="A / 85 / etc."
                            style={INPUT_STYLE}
                            required
                        />
                    </div>
                    <div style={ROW_STYLE}>
                        <label style={LABEL_STYLE}>Feedback</label>
                        <textarea
                            value={draftFeedback}
                            onChange={(e) => { setDraftFeedback(e.target.value); if (status === 'saved') setStatus('idle') }}
                            rows={3}
                            disabled={status === 'saving'}
                            style={{ ...INPUT_STYLE, fontFamily: 'inherit' }}
                        />
                    </div>
                    <div style={ROW_STYLE}>
                        <button
                            type="submit"
                            disabled={status === 'saving' || !draftGrade.trim()}
                            style={BUTTON_STYLE}
                        >
                            {status === 'saving' ? 'Saving…' : 'Save grade'}
                        </button>
                        {status === 'saved' && (
                            <span style={SUCCESS_STYLE}>Saved.</span>
                        )}
                        {submission.graded_at && (
                            <span style={META_STYLE}>
                                Last graded: {formatDate(submission.graded_at)}
                            </span>
                        )}
                    </div>
                    {status === 'error' && errorMessage && (
                        <p style={ERROR_STYLE}><code>{errorMessage}</code></p>
                    )}
                </>
            )}
        </form>
    )
}

// ─── Student view: own grade + feedback only ───────────────────────────────

function StudentGradeView({ submissions }) {
    // RPC already returned at most one row, filtered to status='graded'.
    if (submissions.length === 0) {
        return <p>No grade for you on this assignment yet.</p>
    }
    const s = submissions[0]
    return (
        <div style={STUDENT_PANEL_STYLE}>
            <div style={SUBMISSION_HEAD_STYLE}>
                <strong>Your grade</strong>
                <span style={STATUS_PILL_STYLE(s.status)}>{s.status}</span>
            </div>
            <div style={GRADE_DISPLAY_STYLE}>{s.grade}</div>
            {s.feedback && (
                <div style={FEEDBACK_DISPLAY_STYLE}>{s.feedback}</div>
            )}
            {s.graded_at && (
                <p style={META_STYLE}>Graded: {formatDate(s.graded_at)}</p>
            )}
            {s.submission_text && (
                <details>
                    <summary style={DETAILS_SUMMARY_STYLE}>Your submission</summary>
                    <div style={SUBMISSION_TEXT_STYLE}>{s.submission_text}</div>
                </details>
            )}
        </div>
    )
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatDate(value) {
    if (!value) return '—'
    try {
        const d = new Date(value)
        if (Number.isNaN(d.getTime())) return '—'
        return d.toLocaleString()
    } catch {
        return '—'
    }
}

// ─── Styles — minimal, consistent with v6-lite. ────────────────────────────

const GRID_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           14,
    marginTop:     8,
}
const SUBMISSION_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           6,
    padding:       12,
    border:        '1px solid #ddd',
    borderRadius:  4,
    background:    '#fff',
    maxWidth:      720,
}
const SUBMISSION_HEAD_STYLE = {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
    fontSize:   14,
}
const SUBMISSION_TEXT_STYLE = {
    fontSize:     14,
    whiteSpace:   'pre-wrap',
    background:   '#fafafa',
    border:       '1px solid #eee',
    padding:      '8px 10px',
    borderRadius: 4,
    maxHeight:    240,
    overflow:     'auto',
}
const STUDENT_PANEL_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           10,
    padding:       16,
    border:        '1px solid #ddd',
    borderRadius:  4,
    background:    '#fff',
    maxWidth:      720,
    marginTop:     8,
}
const GRADE_DISPLAY_STYLE = {
    fontSize:   32,
    fontWeight: 700,
    color:      '#111',
}
const FEEDBACK_DISPLAY_STYLE = {
    fontSize:   14,
    whiteSpace: 'pre-wrap',
    color:      '#222',
}
const DETAILS_SUMMARY_STYLE = {
    fontSize: 13,
    color:    '#555',
    cursor:   'pointer',
}
const ROW_STYLE = {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    flexWrap:   'wrap',
}
const LABEL_STYLE = {
    fontSize:   13,
    fontWeight: 600,
    minWidth:   72,
}
const INPUT_STYLE = {
    padding:      '6px 8px',
    border:       '1px solid #ccc',
    borderRadius: 4,
    fontSize:     14,
    flex:         1,
    minWidth:     0,
}
const BUTTON_STYLE = {
    padding:      '6px 12px',
    border:       '1px solid #888',
    borderRadius: 4,
    background:   '#f6f6f6',
    cursor:       'pointer',
    fontSize:     14,
}
const SUCCESS_STYLE = {
    color:    '#0a0',
    fontSize: 13,
}
const ERROR_STYLE = {
    color:     '#a00',
    fontSize:  14,
    marginTop: 6,
}
const META_STYLE = {
    fontSize: 12,
    color:    '#666',
    margin:   0,
}

function STATUS_PILL_STYLE(status) {
    const palette = {
        distributed: { bg: '#eef4ff', fg: '#1e40af' },
        submitted:   { bg: '#fff7ed', fg: '#9a3412' },
        graded:      { bg: '#ecfdf5', fg: '#065f46' },
    }
    const p = palette[status] || { bg: '#f3f4f6', fg: '#374151' }
    return {
        background:   p.bg,
        color:        p.fg,
        padding:      '2px 8px',
        borderRadius: 10,
        fontSize:     12,
        fontWeight:   600,
    }
}
