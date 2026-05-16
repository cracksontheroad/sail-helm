import { useState, useEffect, useCallback, Fragment } from 'react'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { usePermissions } from '../app/providers/PermissionsProvider'

/**
 * Assignments — Phase 2 Route 2 of the Helm rebuild.
 *
 * Spec contract: HELM_PHASE_2_SPEC.md §3.2 (locked 2026-05-12).
 *
 * Replaces the v6-lite stub. The previous file did direct .from()
 * writes against `assignments` / `student_assignments`, embedded AI
 * grading (Route 3 territory), and used optimistic mutations — all
 * three are forbidden under the Phase 2 contract.
 *
 * Architecture:
 *   - Reads: SECURITY DEFINER RPCs (`list_school_classes`,
 *     `list_class_assignments`). Clients never select from
 *     `assignments` / `student_assignments` / `class_enrollments`
 *     directly.
 *   - Writes: `create_assignment`, `update_assignment`,
 *     `delete_assignment`, `distribute_assignment`, `submit_assignment`.
 *     Server is the truth — every mutation re-fetches before re-render.
 *   - Role surface: teachers / admins see staff controls; students see
 *     a submission textarea. Same component renders both, gated by
 *     can('helm.assignments.*') + the per-row `my_status` from
 *     `list_class_assignments`.
 *   - No grading UI (Route 3).
 */
export default function Assignments() {
    const { schoolId } = useAuth()
    // All gates DB-backed via can() (cleanup 2026-05-16): viewAssignments,
    // submitAssignment, and (newly) manageAssignment all resolve through
    // the PermissionsProvider. No remaining static CAN.* references.
    const { can } = usePermissions()

    const [classes, setClasses] = useState([])
    const [selectedClassId, setSelectedClassId] = useState('')
    const [assignments, setAssignments] = useState([])

    // 'idle' | 'loading' | 'ready' | 'error'
    const [classesStatus, setClassesStatus] = useState('idle')
    const [classesError, setClassesError]   = useState(null)
    const [aStatus, setAStatus] = useState('idle')
    const [aError, setAError]   = useState(null)

    const [expandedId, setExpandedId] = useState(null)

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
        // Auto-select the first class on first load to save a click.
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
        const { data, error } = await api.assignments.list(selectedClassId)
        if (error) {
            setAError(error.message || 'Could not load assignments.')
            setAStatus('error')
            return
        }
        setAssignments(data || [])
        setAStatus('ready')
    }, [selectedClassId])

    useEffect(() => { loadClasses() }, [loadClasses])
    useEffect(() => { loadAssignments() }, [loadAssignments])

    if (!can('helm.assignments.view')) {
        return (
            <div>
                <h2>Assignments</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Assignments</h2>
                <p>No school context. Reload the page.</p>
            </div>
        )
    }

    // Mapped to helm.assignments.create (2026-05-16 cleanup): the static
    // `manageAssignment` predicate has been removed; `helm.assignments.create`
    // is the DB-side authority for both "create" and "edit/distribute/delete"
    // staff capabilities on assignments. The semantic split between
    // create/manage in the old static map didn't exist at the DB layer
    // and isn't meaningful in practice — staff who can create can also
    // edit/distribute/delete.
    const canManage = can('helm.assignments.create')

    return (
        <div>
            <h2>Assignments</h2>

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
                    <label htmlFor="class-select" style={LABEL_STYLE}>Class:</label>
                    <select
                        id="class-select"
                        value={selectedClassId}
                        onChange={(e) => { setSelectedClassId(e.target.value); setExpandedId(null) }}
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

            {/* Assignments for selected class */}
            {selectedClassId && aStatus === 'loading' && <p>Loading assignments…</p>}
            {aStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load assignments: <code>{aError}</code>
                </p>
            )}

            {aStatus === 'ready' && (
                <>
                    {assignments.length === 0 && (
                        <p>
                            No assignments yet
                            {canManage && '. Use the form below to create one.'}
                            {!canManage && '.'}
                        </p>
                    )}

                    {assignments.length > 0 && (
                        <table style={TABLE_STYLE}>
                            <thead>
                                <tr>
                                    <th style={TH_STYLE}>Title</th>
                                    <th style={TH_STYLE}>Due</th>
                                    {canManage ? (
                                        <>
                                            <th style={TH_STYLE}>Distributed</th>
                                            <th style={TH_STYLE}>Submitted</th>
                                        </>
                                    ) : (
                                        <th style={TH_STYLE}>My status</th>
                                    )}
                                    <th style={TH_STYLE}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {assignments.map((a) => (
                                    <Fragment key={a.assignment_id}>
                                        <tr>
                                            <td style={TD_STYLE}>{a.title}</td>
                                            <td style={TD_STYLE}>{formatDate(a.due_date)}</td>
                                            {canManage ? (
                                                <>
                                                    <td style={TD_STYLE}>{a.distributed_count ?? '—'}</td>
                                                    <td style={TD_STYLE}>{a.submitted_count ?? '—'}</td>
                                                </>
                                            ) : (
                                                <td style={TD_STYLE}>{a.my_status || 'not yet distributed'}</td>
                                            )}
                                            <td style={TD_STYLE}>
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedId(
                                                        expandedId === a.assignment_id ? null : a.assignment_id,
                                                    )}
                                                    style={LINK_BUTTON_STYLE}
                                                >
                                                    {expandedId === a.assignment_id ? 'Close' : 'Details'}
                                                </button>
                                            </td>
                                        </tr>
                                        {expandedId === a.assignment_id && (
                                            <tr>
                                                <td colSpan={5} style={EXPANDED_TD_STYLE}>
                                                    <ExpandedAssignment
                                                        assignment={a}
                                                        canManage={canManage}
                                                        onChanged={loadAssignments}
                                                    />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {canManage && (
                        <CreateAssignmentForm
                            classId={selectedClassId}
                            onCreated={loadAssignments}
                        />
                    )}
                </>
            )}
        </div>
    )
}

// ─── Expanded assignment (staff edit/distribute/delete; student submit) ────

function ExpandedAssignment({ assignment, canManage, onChanged }) {
    // Subscribe to PermissionsProvider directly — cleaner than threading
    // `can` through props from Assignments() above.
    const { can } = usePermissions()
    if (canManage) {
        return <StaffPanel assignment={assignment} onChanged={onChanged} />
    }
    if (can('helm.assignments.submit')) {
        return <StudentPanel assignment={assignment} onChanged={onChanged} />
    }
    // Read-only (e.g. parent — Phase 3).
    return (
        <div style={DETAIL_STYLE}>
            <p style={DESCRIPTION_STYLE}>{assignment.description || <em>(no description)</em>}</p>
        </div>
    )
}

// ─── Staff panel: edit + distribute + delete ───────────────────────────────

function StaffPanel({ assignment, onChanged }) {
    const [draftTitle, setDraftTitle] = useState(assignment.title)
    const [draftDescription, setDraftDescription] = useState(assignment.description || '')
    const [draftDueDate, setDraftDueDate] = useState(toDatetimeLocal(assignment.due_date))

    const [saveStatus, setSaveStatus] = useState('idle')
    const [saveError, setSaveError]   = useState(null)
    const [distStatus, setDistStatus] = useState('idle')
    const [distError, setDistError]   = useState(null)
    const [distResult, setDistResult] = useState(null)
    const [delStatus, setDelStatus]   = useState('idle')
    const [delError, setDelError]     = useState(null)
    const [confirmDelete, setConfirmDelete] = useState(false)

    async function handleSave(event) {
        event.preventDefault()
        setSaveStatus('saving')
        setSaveError(null)
        const { error } = await api.assignments.update(
            assignment.assignment_id,
            draftTitle.trim(),
            draftDescription.trim(),
            fromDatetimeLocal(draftDueDate),
            null,
        )
        if (error) {
            setSaveError(error.message || 'Could not save assignment.')
            setSaveStatus('error')
            return
        }
        setSaveStatus('idle')
        await onChanged()
    }

    async function handleDistribute() {
        setDistStatus('working')
        setDistError(null)
        setDistResult(null)
        const { data, error } = await api.assignments.distribute(assignment.assignment_id)
        if (error) {
            setDistError(error.message || 'Could not distribute.')
            setDistStatus('error')
            return
        }
        setDistResult(typeof data === 'number' ? data : null)
        setDistStatus('done')
        await onChanged()
    }

    async function handleDelete() {
        setDelStatus('working')
        setDelError(null)
        const { error } = await api.assignments.delete(assignment.assignment_id)
        if (error) {
            setDelError(error.message || 'Could not delete.')
            setDelStatus('error')
            return
        }
        setDelStatus('done')
        setConfirmDelete(false)
        await onChanged()
    }

    return (
        <div style={DETAIL_STYLE}>
            <form onSubmit={handleSave} style={EDIT_FORM_STYLE}>
                <div style={ROW_STYLE}>
                    <label style={LABEL_STYLE}>Title</label>
                    <input
                        type="text"
                        value={draftTitle}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        disabled={saveStatus === 'saving'}
                        maxLength={200}
                        style={INPUT_STYLE}
                    />
                </div>
                <div style={ROW_STYLE}>
                    <label style={LABEL_STYLE}>Description</label>
                    <textarea
                        value={draftDescription}
                        onChange={(e) => setDraftDescription(e.target.value)}
                        disabled={saveStatus === 'saving'}
                        rows={3}
                        style={{ ...INPUT_STYLE, fontFamily: 'inherit' }}
                    />
                </div>
                <div style={ROW_STYLE}>
                    <label style={LABEL_STYLE}>Due</label>
                    <input
                        type="datetime-local"
                        value={draftDueDate}
                        onChange={(e) => setDraftDueDate(e.target.value)}
                        disabled={saveStatus === 'saving'}
                        style={INPUT_STYLE}
                    />
                </div>
                <div style={ROW_STYLE}>
                    <button
                        type="submit"
                        disabled={saveStatus === 'saving' || !draftTitle.trim()}
                        style={BUTTON_STYLE}
                    >
                        {saveStatus === 'saving' ? 'Saving…' : 'Save assignment'}
                    </button>
                    <button
                        type="button"
                        onClick={handleDistribute}
                        disabled={distStatus === 'working'}
                        style={BUTTON_STYLE}
                    >
                        {distStatus === 'working' ? 'Distributing…' : 'Distribute to enrolled students'}
                    </button>
                    {!confirmDelete && (
                        <button
                            type="button"
                            onClick={() => setConfirmDelete(true)}
                            style={DANGER_BUTTON_STYLE}
                        >
                            Delete assignment
                        </button>
                    )}
                    {confirmDelete && (
                        <>
                            <span style={CONFIRM_STYLE}>Delete and cascade submissions?</span>
                            <button
                                type="button"
                                onClick={handleDelete}
                                disabled={delStatus === 'working'}
                                style={DANGER_BUTTON_STYLE}
                            >
                                {delStatus === 'working' ? 'Deleting…' : 'Confirm delete'}
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirmDelete(false)}
                                style={LINK_BUTTON_STYLE}
                            >
                                Cancel
                            </button>
                        </>
                    )}
                </div>
                {saveStatus === 'error' && saveError && (
                    <p style={ERROR_STYLE}><code>{saveError}</code></p>
                )}
                {distStatus === 'error' && distError && (
                    <p style={ERROR_STYLE}><code>{distError}</code></p>
                )}
                {distStatus === 'done' && distResult !== null && (
                    <p style={SUCCESS_STYLE}>
                        Distributed to {distResult} new student{distResult === 1 ? '' : 's'}.
                    </p>
                )}
                {delStatus === 'error' && delError && (
                    <p style={ERROR_STYLE}><code>{delError}</code></p>
                )}
            </form>
        </div>
    )
}

// ─── Student panel: submit / resubmit ──────────────────────────────────────

function StudentPanel({ assignment, onChanged }) {
    const [draftText, setDraftText] = useState(assignment.my_submission_text || '')
    const [status, setStatus]       = useState('idle')
    const [error, setError]         = useState(null)

    async function handleSubmit(event) {
        event.preventDefault()
        const text = draftText.trim()
        if (!text) return
        setStatus('submitting')
        setError(null)
        const { error: rpcError } = await api.assignments.submit(assignment.assignment_id, text)
        if (rpcError) {
            setError(rpcError.message || 'Could not submit.')
            setStatus('error')
            return
        }
        setStatus('done')
        await onChanged()
    }

    const hasPriorSubmission = Boolean(assignment.my_submission_text)
    const isResubmit = hasPriorSubmission

    return (
        <div style={DETAIL_STYLE}>
            <p style={DESCRIPTION_STYLE}>{assignment.description || <em>(no description)</em>}</p>
            {assignment.due_date && (
                <p style={META_STYLE}>Due: {formatDate(assignment.due_date)}</p>
            )}

            <form onSubmit={handleSubmit} style={SUBMIT_FORM_STYLE}>
                <label style={LABEL_STYLE}>
                    {isResubmit ? 'Update your submission' : 'Your submission'}
                </label>
                <textarea
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    rows={6}
                    disabled={status === 'submitting'}
                    style={{ ...INPUT_STYLE, fontFamily: 'inherit' }}
                />
                <div style={ROW_STYLE}>
                    <button
                        type="submit"
                        disabled={status === 'submitting' || !draftText.trim()}
                        style={BUTTON_STYLE}
                    >
                        {status === 'submitting'
                            ? 'Submitting…'
                            : (isResubmit ? 'Resubmit' : 'Submit')}
                    </button>
                    {assignment.my_submitted_at && (
                        <span style={META_STYLE}>
                            Last submitted: {formatDate(assignment.my_submitted_at)}
                        </span>
                    )}
                </div>
                {status === 'error' && error && (
                    <p style={ERROR_STYLE}><code>{error}</code></p>
                )}
            </form>
        </div>
    )
}

// ─── Create-assignment form (staff only, below the table) ──────────────────

function CreateAssignmentForm({ classId, onCreated }) {
    const [title, setTitle]             = useState('')
    const [description, setDescription] = useState('')
    const [dueDate, setDueDate]         = useState('')
    const [status, setStatus]           = useState('idle')
    const [error, setError]             = useState(null)

    async function handleSubmit(event) {
        event.preventDefault()
        if (!title.trim()) return
        setStatus('submitting')
        setError(null)
        const { error: rpcError } = await api.assignments.create(
            classId,
            title.trim(),
            description.trim(),
            fromDatetimeLocal(dueDate),
            null,
        )
        if (rpcError) {
            setError(rpcError.message || 'Could not create assignment.')
            setStatus('error')
            return
        }
        setTitle('')
        setDescription('')
        setDueDate('')
        setStatus('idle')
        await onCreated()
    }

    return (
        <form onSubmit={handleSubmit} style={CREATE_FORM_STYLE}>
            <h3 style={H3_STYLE}>Create an assignment</h3>
            <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                maxLength={200}
                disabled={status === 'submitting'}
                required
                style={INPUT_STYLE}
            />
            <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
                rows={3}
                disabled={status === 'submitting'}
                style={{ ...INPUT_STYLE, fontFamily: 'inherit' }}
            />
            <div style={ROW_STYLE}>
                <label style={LABEL_STYLE}>Due</label>
                <input
                    type="datetime-local"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    disabled={status === 'submitting'}
                    style={INPUT_STYLE}
                />
            </div>
            <button
                type="submit"
                disabled={status === 'submitting' || !title.trim()}
                style={BUTTON_STYLE}
            >
                {status === 'submitting' ? 'Creating…' : 'Create assignment'}
            </button>
            {status === 'error' && error && (
                <p style={ERROR_STYLE}><code>{error}</code></p>
            )}
        </form>
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

// HTML5 datetime-local input wants "YYYY-MM-DDTHH:MM" with no Z. Convert a
// timestamp string in either direction.
function toDatetimeLocal(value) {
    if (!value) return ''
    try {
        const d = new Date(value)
        if (Number.isNaN(d.getTime())) return ''
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    } catch {
        return ''
    }
}

function fromDatetimeLocal(value) {
    if (!value) return null
    // Browser provides local-zone string. Treat as local; supabase-js will
    // serialise to ISO. Postgres timestamp (without tz) absorbs that.
    return value
}

// ─── Styles — minimal, consistent with the rest of the v6-lite shell. ──────

const TABLE_STYLE = {
    borderCollapse: 'collapse',
    marginTop:      8,
    minWidth:       560,
}
const TH_STYLE = {
    textAlign:    'left',
    padding:      '4px 12px 4px 0',
    borderBottom: '1px solid #ccc',
    fontSize:     13,
}
const TD_STYLE = {
    padding:      '6px 12px 6px 0',
    borderBottom: '1px solid #eee',
    fontSize:     14,
    verticalAlign: 'top',
}
const EXPANDED_TD_STYLE = {
    padding:    '12px 12px 16px 12px',
    background: '#fafafa',
    borderBottom: '1px solid #eee',
}
const DETAIL_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           10,
    maxWidth:      640,
}
const DESCRIPTION_STYLE = {
    fontSize:    14,
    whiteSpace:  'pre-wrap',
    margin:      0,
}
const META_STYLE = {
    fontSize: 13,
    color:    '#666',
    margin:   0,
}
const EDIT_FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           6,
    maxWidth:      560,
}
const SUBMIT_FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           6,
    maxWidth:      560,
}
const CREATE_FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           8,
    maxWidth:      400,
    marginTop:     24,
}
const ROW_STYLE = {
    display:       'flex',
    alignItems:    'center',
    gap:           8,
    flexWrap:      'wrap',
}
const LABEL_STYLE = {
    fontSize:   13,
    fontWeight: 600,
    minWidth:   88,
}
const INPUT_STYLE = {
    padding:      '6px 8px',
    border:       '1px solid #ccc',
    borderRadius: 4,
    fontSize:     14,
    flex:         1,
    minWidth:     0,
}
const H3_STYLE = {
    fontSize:   15,
    fontWeight: 600,
    margin:     '0 0 4px 0',
}
const BUTTON_STYLE = {
    padding:      '6px 12px',
    border:       '1px solid #888',
    borderRadius: 4,
    background:   '#f6f6f6',
    cursor:       'pointer',
    fontSize:     14,
}
const DANGER_BUTTON_STYLE = {
    padding:      '6px 12px',
    border:       '1px solid #b00',
    borderRadius: 4,
    background:   '#fdf3f3',
    color:        '#b00',
    cursor:       'pointer',
    fontSize:     14,
}
const LINK_BUTTON_STYLE = {
    background: 'transparent',
    border:     'none',
    color:      '#06c',
    cursor:     'pointer',
    fontSize:   13,
    padding:    0,
    textDecoration: 'underline',
}
const CONFIRM_STYLE = {
    fontSize: 13,
    color:    '#a00',
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
