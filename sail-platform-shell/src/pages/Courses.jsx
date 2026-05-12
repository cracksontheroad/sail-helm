import { useState, useEffect, useCallback, Fragment } from 'react'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN, ROLE_LABELS, isStudentRole, isStaffRole } from '../lib/permissions'

/**
 * Courses — Phase 2 Route 1 of the Helm rebuild.
 *
 * Spec contract: HELM_PHASE_2_SPEC.md §3.1 (locked 2026-05-12).
 *
 * Surfaces:
 *   - Class list, role-filtered server-side via `list_school_classes`.
 *   - Expandable per-class detail row with edit + archive + enrollment
 *     management.
 *   - Admin-only "create class" form below the list.
 *
 * Architecture:
 *   - All reads via SECURITY DEFINER RPCs (`list_school_classes`,
 *     `list_class_enrollments`). Clients never select from
 *     `classes` / `class_enrollments` / `auth.users` directly.
 *   - All mutations via SECURITY DEFINER RPCs. The client never
 *     touches `role` or `teacher_id` directly — those are set
 *     server-side inside the RPC bodies (Block 10 / PR-08).
 *   - CAN.* gates UI visibility; the RPC bodies re-check
 *     admin-of-school / teacher-of-class. Two layers, server is the
 *     truth.
 */
export default function Courses() {
    const { role, schoolId } = useAuth()

    const [classes, setClasses] = useState([])
    // 'loading' | 'ready' | 'error'
    const [status, setStatus] = useState('loading')
    const [errorMessage, setErrorMessage] = useState(null)
    const [expandedClassId, setExpandedClassId] = useState(null)

    // Staff + student roster of the current school — used by the create
    // form's teacher picker and the enrollment add picker. Only loaded if
    // the caller can use one of those mutations (saves an RPC for read-only
    // students).
    const [members, setMembers] = useState([])

    const loadClasses = useCallback(async () => {
        if (!schoolId) return
        setStatus('loading')
        setErrorMessage(null)
        const { data, error } = await api.classes.list(schoolId)
        if (error) {
            setErrorMessage(error.message || 'Could not load classes.')
            setStatus('error')
            return
        }
        setClasses(data || [])
        setStatus('ready')
    }, [schoolId])

    const loadMembers = useCallback(async () => {
        // Only admins reach list_school_members (that RPC is admin-only).
        // Teachers do their enrollment via the page's add-by-picker UI,
        // which means teachers also need the roster — but list_school_members
        // is admin-gated. For Phase 2 R1 we surface members only to admins;
        // teachers see a free-text "student email" input instead (handled
        // by ExpandedClass below). This avoids opening up list_school_members.
        if (!schoolId || !CAN.createClass(role)) return
        const { data, error } = await api.members.list(schoolId)
        if (!error) setMembers(data || [])
    }, [schoolId, role])

    useEffect(() => {
        loadClasses()
        loadMembers()
    }, [loadClasses, loadMembers])

    if (!CAN.viewCourses(role)) {
        return (
            <div>
                <h2>Courses</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Courses</h2>
                <p>No school context. Reload the page.</p>
            </div>
        )
    }

    return (
        <div>
            <h2>Courses</h2>

            {status === 'loading' && <p>Loading classes…</p>}
            {status === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load classes: <code>{errorMessage}</code>
                </p>
            )}

            {status === 'ready' && (
                <>
                    {classes.length === 0 && (
                        <p>
                            No classes yet
                            {CAN.createClass(role) && '. Use the form below to create one.'}
                            {!CAN.createClass(role) && '.'}
                        </p>
                    )}

                    {classes.length > 0 && (
                        <table style={TABLE_STYLE}>
                            <thead>
                                <tr>
                                    <th style={TH_STYLE}>Name</th>
                                    <th style={TH_STYLE}>Subject</th>
                                    <th style={TH_STYLE}>Teacher</th>
                                    <th style={TH_STYLE}>Students</th>
                                    <th style={TH_STYLE}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {classes.map((c) => (
                                    <Fragment key={c.class_id}>
                                        <tr>
                                            <td style={TD_STYLE}>{c.name}</td>
                                            <td style={TD_STYLE}>{c.subject || '—'}</td>
                                            <td style={TD_STYLE}>{c.teacher_email || '(none)'}</td>
                                            <td style={TD_STYLE}>{c.enrollment_count}</td>
                                            <td style={TD_STYLE}>
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedClassId(
                                                        expandedClassId === c.class_id ? null : c.class_id,
                                                    )}
                                                    style={LINK_BUTTON_STYLE}
                                                >
                                                    {expandedClassId === c.class_id ? 'Close' : 'Details'}
                                                </button>
                                            </td>
                                        </tr>
                                        {expandedClassId === c.class_id && (
                                            <tr>
                                                <td colSpan={5} style={EXPANDED_TD_STYLE}>
                                                    <ExpandedClass
                                                        classRow={c}
                                                        members={members}
                                                        role={role}
                                                        onChanged={loadClasses}
                                                    />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {CAN.createClass(role) && (
                        <CreateClassForm
                            schoolId={schoolId}
                            members={members}
                            onCreated={loadClasses}
                        />
                    )}
                </>
            )}
        </div>
    )
}

// ─── Expanded class detail (edit + archive + enrollment) ───────────────────

function ExpandedClass({ classRow, members, role, onChanged }) {
    const isStaff = CAN.updateClass(role)
    const isAdmin = CAN.archiveClass(role)

    // Local draft state for the edit form.
    const [draftName, setDraftName] = useState(classRow.name)
    const [draftSubject, setDraftSubject] = useState(classRow.subject || '')
    const [draftTeacherId, setDraftTeacherId] = useState(classRow.teacher_user_id || '')

    const [saveStatus, setSaveStatus] = useState('idle')  // 'idle' | 'saving' | 'error'
    const [saveError, setSaveError]   = useState(null)
    const [archiveStatus, setArchiveStatus] = useState('idle')  // 'idle' | 'confirming' | 'archiving' | 'error'
    const [archiveError, setArchiveError]   = useState(null)

    // Enrollment local state.
    const [enrollments, setEnrollments] = useState([])
    const [enrStatus, setEnrStatus] = useState('loading')
    const [enrError, setEnrError]   = useState(null)
    const [enrAddInput, setEnrAddInput] = useState('')
    const [enrAddStatus, setEnrAddStatus] = useState('idle')
    const [enrAddError, setEnrAddError]   = useState(null)

    const loadEnrollments = useCallback(async () => {
        setEnrStatus('loading')
        setEnrError(null)
        const { data, error } = await api.classes.listEnrollments(classRow.class_id)
        if (error) {
            setEnrError(error.message || 'Could not load enrollments.')
            setEnrStatus('error')
            return
        }
        setEnrollments(data || [])
        setEnrStatus('ready')
    }, [classRow.class_id])

    useEffect(() => {
        loadEnrollments()
    }, [loadEnrollments])

    async function handleSave(event) {
        event.preventDefault()
        setSaveStatus('saving')
        setSaveError(null)
        // Only admins are allowed to reassign teacher_id; for teachers we
        // omit p_teacher_user_id (server-side null = keep existing).
        const { error } = await api.classes.update(
            classRow.class_id,
            draftName.trim(),
            draftSubject.trim(),
            isAdmin ? (draftTeacherId || null) : null,
        )
        if (error) {
            setSaveError(error.message || 'Could not save class.')
            setSaveStatus('error')
            return
        }
        setSaveStatus('idle')
        await onChanged()
    }

    async function handleArchive() {
        setArchiveStatus('archiving')
        setArchiveError(null)
        const { error } = await api.classes.archive(classRow.class_id)
        if (error) {
            setArchiveError(error.message || 'Could not archive class.')
            setArchiveStatus('error')
            return
        }
        setArchiveStatus('idle')
        await onChanged()
    }

    // Enroll: admins use the members dropdown (CAN.createClass loaded
    // members above). Teachers do not have list_school_members access
    // in Phase 2; they type the student's user_id directly. UX is rough
    // on purpose — Phase 2 minimum. Refine in 2.5+.
    async function handleEnroll(event) {
        event.preventDefault()
        const studentUserId = enrAddInput.trim()
        if (!studentUserId) return
        setEnrAddStatus('submitting')
        setEnrAddError(null)
        // Note: previous code passed p_student_user_id; the live RPC uses
        // p_user_id. The api client uses the correct name.
        const { error } = await api.classes.enrollStudent(classRow.class_id, studentUserId)
        if (error) {
            setEnrAddError(error.message || 'Could not enroll student.')
            setEnrAddStatus('error')
            return
        }
        setEnrAddInput('')
        setEnrAddStatus('idle')
        await loadEnrollments()
        await onChanged()  // refresh enrollment_count in the outer table
    }

    async function handleUnenroll(studentUserId) {
        const { error } = await api.classes.unenrollStudent(classRow.class_id, studentUserId)
        if (error) {
            setEnrError(error.message || 'Could not unenroll student.')
            return
        }
        await loadEnrollments()
        await onChanged()
    }

    const studentMembers = (members || []).filter((m) => isStudentRole(m.role))
    const staffMembers   = (members || []).filter((m) => isStaffRole(m.role))

    return (
        <div style={EXPANDED_INNER_STYLE}>
            {/* Edit form */}
            {isStaff ? (
                <form onSubmit={handleSave} style={EDIT_FORM_STYLE}>
                    <div style={ROW_STYLE}>
                        <label style={LABEL_STYLE}>Name</label>
                        <input
                            type="text"
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            disabled={saveStatus === 'saving'}
                            maxLength={200}
                            style={INPUT_STYLE}
                        />
                    </div>
                    <div style={ROW_STYLE}>
                        <label style={LABEL_STYLE}>Subject</label>
                        <input
                            type="text"
                            value={draftSubject}
                            onChange={(e) => setDraftSubject(e.target.value)}
                            disabled={saveStatus === 'saving'}
                            maxLength={200}
                            style={INPUT_STYLE}
                        />
                    </div>
                    {isAdmin && (
                        <div style={ROW_STYLE}>
                            <label style={LABEL_STYLE}>Teacher</label>
                            <select
                                value={draftTeacherId}
                                onChange={(e) => setDraftTeacherId(e.target.value)}
                                disabled={saveStatus === 'saving'}
                                style={INPUT_STYLE}
                            >
                                <option value="">(unchanged)</option>
                                {staffMembers.map((m) => (
                                    <option key={m.user_id} value={m.user_id}>
                                        {m.email} — {ROLE_LABELS[m.role] || m.role}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    <div style={ROW_STYLE}>
                        <button
                            type="submit"
                            disabled={saveStatus === 'saving' || !draftName.trim()}
                            style={BUTTON_STYLE}
                        >
                            {saveStatus === 'saving' ? 'Saving…' : 'Save class'}
                        </button>
                        {isAdmin && (
                            <button
                                type="button"
                                onClick={handleArchive}
                                disabled={archiveStatus === 'archiving'}
                                style={DANGER_BUTTON_STYLE}
                            >
                                {archiveStatus === 'archiving' ? 'Archiving…' : 'Archive class'}
                            </button>
                        )}
                    </div>
                    {saveStatus === 'error' && saveError && (
                        <p style={ERROR_STYLE}>
                            <code>{saveError}</code>
                        </p>
                    )}
                    {archiveStatus === 'error' && archiveError && (
                        <p style={ERROR_STYLE}>
                            <code>{archiveError}</code>
                        </p>
                    )}
                </form>
            ) : (
                <p style={SUBHEADING_STYLE}>Class details (read-only).</p>
            )}

            {/* Enrollment */}
            <h4 style={H4_STYLE}>Enrolled students</h4>

            {enrStatus === 'loading' && <p>Loading enrollments…</p>}
            {enrStatus === 'error' && (
                <p style={ERROR_STYLE}>
                    <code>{enrError}</code>
                </p>
            )}

            {enrStatus === 'ready' && enrollments.length === 0 && (
                <p>No students enrolled.</p>
            )}

            {enrStatus === 'ready' && enrollments.length > 0 && (
                <table style={NESTED_TABLE_STYLE}>
                    <thead>
                        <tr>
                            <th style={TH_STYLE}>Email</th>
                            {CAN.manageEnrollment(role) && <th style={TH_STYLE}></th>}
                        </tr>
                    </thead>
                    <tbody>
                        {enrollments.map((e) => (
                            <tr key={e.enrollment_id}>
                                <td style={TD_STYLE}>{e.email || <em>(no email)</em>}</td>
                                {CAN.manageEnrollment(role) && (
                                    <td style={TD_STYLE}>
                                        <button
                                            type="button"
                                            onClick={() => handleUnenroll(e.user_id)}
                                            style={LINK_BUTTON_STYLE}
                                        >
                                            Remove
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {CAN.manageEnrollment(role) && (
                <form onSubmit={handleEnroll} style={ENROLL_FORM_STYLE}>
                    {studentMembers.length > 0 ? (
                        <select
                            value={enrAddInput}
                            onChange={(e) => setEnrAddInput(e.target.value)}
                            disabled={enrAddStatus === 'submitting'}
                            style={INPUT_STYLE}
                        >
                            <option value="">— pick a student to enroll —</option>
                            {studentMembers.map((m) => (
                                <option key={m.user_id} value={m.user_id}>
                                    {m.email}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            value={enrAddInput}
                            onChange={(e) => setEnrAddInput(e.target.value)}
                            placeholder="student user_id (UUID)"
                            disabled={enrAddStatus === 'submitting'}
                            style={INPUT_STYLE}
                        />
                    )}
                    <button
                        type="submit"
                        disabled={enrAddStatus === 'submitting' || !enrAddInput.trim()}
                        style={BUTTON_STYLE}
                    >
                        {enrAddStatus === 'submitting' ? 'Adding…' : 'Add student'}
                    </button>
                    {enrAddStatus === 'error' && enrAddError && (
                        <p style={ERROR_STYLE}>
                            <code>{enrAddError}</code>
                        </p>
                    )}
                </form>
            )}
        </div>
    )
}

// ─── Create-class form (admin only) ────────────────────────────────────────

function CreateClassForm({ schoolId, members, onCreated }) {
    const [name, setName] = useState('')
    const [subject, setSubject] = useState('')
    const [teacherId, setTeacherId] = useState('')
    const [status, setStatus] = useState('idle')  // 'idle' | 'submitting' | 'error'
    const [errorMessage, setErrorMessage] = useState(null)

    const staffMembers = (members || []).filter((m) => isStaffRole(m.role))

    async function handleSubmit(event) {
        event.preventDefault()
        if (!name.trim() || !teacherId) return
        setStatus('submitting')
        setErrorMessage(null)
        const { error } = await api.classes.create(
            schoolId,
            name.trim(),
            subject.trim(),
            teacherId,
        )
        if (error) {
            setErrorMessage(error.message || 'Could not create class.')
            setStatus('error')
            return
        }
        setName('')
        setSubject('')
        setTeacherId('')
        setStatus('idle')
        await onCreated()
    }

    return (
        <form onSubmit={handleSubmit} style={CREATE_FORM_STYLE}>
            <h3 style={H3_STYLE}>Create a class</h3>
            <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Class name"
                maxLength={200}
                disabled={status === 'submitting'}
                required
                style={INPUT_STYLE}
            />
            <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject (optional)"
                maxLength={200}
                disabled={status === 'submitting'}
                style={INPUT_STYLE}
            />
            <select
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
                disabled={status === 'submitting'}
                required
                style={INPUT_STYLE}
            >
                <option value="">— pick a teacher —</option>
                {staffMembers.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                        {m.email} — {ROLE_LABELS[m.role] || m.role}
                    </option>
                ))}
            </select>
            <button
                type="submit"
                disabled={status === 'submitting' || !name.trim() || !teacherId}
                style={BUTTON_STYLE}
            >
                {status === 'submitting' ? 'Creating…' : 'Create class'}
            </button>
            {status === 'error' && errorMessage && (
                <p style={ERROR_STYLE}>
                    <code>{errorMessage}</code>
                </p>
            )}
        </form>
    )
}

// ─── Minimal styles — match the rest of the v6-lite shell. ─────────────────

const TABLE_STYLE = {
    borderCollapse: 'collapse',
    marginTop:      8,
    minWidth:       560,
}
const NESTED_TABLE_STYLE = {
    borderCollapse: 'collapse',
    marginTop:      4,
    minWidth:       300,
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
const EXPANDED_INNER_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           12,
}
const EDIT_FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           6,
    maxWidth:      460,
}
const CREATE_FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           8,
    maxWidth:      360,
    marginTop:     24,
}
const ENROLL_FORM_STYLE = {
    display:    'flex',
    gap:        8,
    marginTop:  8,
    alignItems: 'center',
    maxWidth:   460,
}
const ROW_STYLE = {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
}
const LABEL_STYLE = {
    fontSize: 13,
    fontWeight: 600,
    minWidth: 72,
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
const H4_STYLE = {
    fontSize:   14,
    fontWeight: 600,
    margin:     '8px 0 4px 0',
}
const SUBHEADING_STYLE = {
    fontSize: 13,
    color:    '#666',
    margin:   '4px 0',
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
const ERROR_STYLE = {
    color:    '#a00',
    fontSize: 14,
    marginTop: 6,
}
