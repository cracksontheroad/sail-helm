import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { callAI } from '../services/ai'

// ─── Configuration ──────────────────────────────────────────────────────────
const BATCH_SIZE = 5                      // students per batch when grading entire class

// ─── Helpers ────────────────────────────────────────────────────────────────

// Simple hash for submission change detection (not crypto — just cache‑busting)
function simpleHash(str) {
    if (!str) return ''
    let h = 0
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0
    }
    return String(h)
}

// Parse feedback stored as JSON; fall back gracefully for legacy plain-text values
function parseFeedback(raw) {
    if (!raw) return null
    try {
        return JSON.parse(raw)
    } catch {
        return { overall: raw, rubric: null }
    }
}

const RUBRIC_CRITERIA = ['structure', 'argument', 'grammar', 'clarity']

// ─── AI grading call (via backend proxy) ────────────────────────────────────

const GRADING_SYSTEM_PROMPT =
    'You are a strict but fair educational grading assistant. ' +
    'Always respond with valid JSON and nothing else. ' +
    'Be consistent: the same submission must always receive the same grade.'

function buildGradingPrompt(assignmentTitle, submission) {
    return (
        `Grade the following student submission for the assignment titled "${assignmentTitle}".\n\n` +
        `Submission:\n"${submission}"\n\n` +
        `Score using these four criteria (each out of 10):\n` +
        `- structure: organisation, introduction, body, conclusion\n` +
        `- argument: quality of reasoning and evidence\n` +
        `- grammar: spelling, punctuation, sentence structure\n` +
        `- clarity: how clearly ideas are expressed\n\n` +
        `Respond with this exact JSON shape:\n` +
        `{\n` +
        `  "suggested_grade": "<A/B/C/D/F>",\n` +
        `  "overall": "<2–3 sentence overall comment>",\n` +
        `  "rubric": {\n` +
        `    "structure": { "score": "<n>/10", "comment": "<one sentence>" },\n` +
        `    "argument":  { "score": "<n>/10", "comment": "<one sentence>" },\n` +
        `    "grammar":   { "score": "<n>/10", "comment": "<one sentence>" },\n` +
        `    "clarity":   { "score": "<n>/10", "comment": "<one sentence>" }\n` +
        `  }\n` +
        `}`
    )
}

async function gradeWithAI(assignmentTitle, submission, identity = {}) {
    return callAI({
        system: GRADING_SYSTEM_PROMPT,
        prompt: buildGradingPrompt(assignmentTitle, submission),
        maxTokens: 600,
        feature: 'grading',
        userId: identity.userId ?? null,
        role: identity.role ?? null,
        schoolId: identity.schoolId ?? null,
        deploymentMode: identity.deploymentMode ?? null,
    })
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function Assignments() {
    const { user, role, schoolId } = useAuth()
    const deploymentMode = import.meta.env.VITE_DEPLOYMENT_MODE ?? null

    const [classes, setClasses] = useState([])
    const [assignments, setAssignments] = useState([])
    const [students, setStudents] = useState([])
    const [selectedClass, setSelectedClass] = useState('')
    const [selectedAssignment, setSelectedAssignment] = useState('')
    const [newTitle, setNewTitle] = useState('')
    const [assigning, setAssigning] = useState(false)

    // { student_id -> student_assignment row }
    const [studentAssignments, setStudentAssignments] = useState({})
    // { student_id -> grade string }
    const [gradeInputs, setGradeInputs] = useState({})
    // { student_id -> bool }
    const [aiLoading, setAiLoading] = useState({})

    // Batch grading state
    const [batchGrading, setBatchGrading] = useState(false)
    const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0, skipped: 0, failed: 0 })
    // { student_id -> error message } — surfaces real failure causes per-row
    const [rowErrors, setRowErrors] = useState({})

    // Derived counts for the diagnostics panel and the "nothing to grade" alert.
    // Keeps the breakdown reasons in one place so UI and alert never disagree.
    const gradingStats = useMemo(() => {
        let noRow = 0, withAiGrade = 0, withTeacherGrade = 0, eligible = 0
        for (const s of students) {
            const sa = studentAssignments[s.id]
            if (!sa) { noRow++; continue }
            const hasAi = sa.ai_grade != null && sa.ai_grade !== ''
            const hasTeacher = sa.grade != null && sa.grade !== ''
            if (hasAi) withAiGrade++
            if (hasTeacher) withTeacherGrade++
            if (!hasAi && !hasTeacher) eligible++
        }
        return {
            students: students.length,
            rows: Object.keys(studentAssignments).length,
            noRow,
            withAiGrade,
            withTeacherGrade,
            eligible,
        }
    }, [students, studentAssignments])

    useEffect(() => {
        if (schoolId) loadClasses()
    }, [schoolId])

    useEffect(() => {
        if (selectedClass) {
            loadAssignments()
            loadStudents()
        } else {
            setAssignments([])
            setStudents([])
            setSelectedAssignment('')
        }
    }, [selectedClass])

    useEffect(() => {
        if (selectedAssignment) {
            loadStudentAssignments()
        } else {
            setStudentAssignments({})
            setGradeInputs({})
        }
    }, [selectedAssignment])

    async function loadClasses() {
        let query = supabase.from('classes').select('*')
        if (schoolId) query = query.eq('school_id', schoolId)
        const { data } = await query
        setClasses(data || [])
    }

    async function loadAssignments() {
        const { data } = await supabase
            .from('assignments')
            .select('*')
            .eq('class_id', selectedClass)
        setAssignments(data || [])
    }

    async function loadStudents() {
        // Use auth schoolId directly — no extra query needed
        let membersQuery = supabase
            .from('school_members')
            .select('user_id')
            .eq('role', 'student')

        if (schoolId) {
            membersQuery = membersQuery.eq('school_id', schoolId)
        }

        const { data: members, error: membersErr } = await membersQuery
        if (membersErr) {
            console.error('[loadStudents] school_members query failed:', membersErr.message, '— if RLS is enabled, this is the cause')
        }
        console.log(`[loadStudents] school_members rows: ${members?.length ?? 0} (school_id=${schoolId ?? 'any'})`)

        if (!members || members.length === 0) {
            setStudents([])
            return
        }

        const ids = members.map(m => m.user_id)
        const { data: profiles, error: profilesErr } = await supabase
            .from('profiles')
            .select('id, first_name, last_name')
            .in('id', ids)
        if (profilesErr) {
            console.error('[loadStudents] profiles query failed:', profilesErr.message)
        }

        const formatted = (profiles || []).map(p => ({
            id: p.id,
            name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.id,
        }))

        setStudents(formatted)
    }

    async function loadStudentAssignments() {
        const { data, error } = await supabase
            .from('student_assignments')
            .select('*')
            .eq('assignment_id', selectedAssignment)
        if (error) {
            console.error(
                `[loadStudentAssignments] query failed for assignment_id=${selectedAssignment}:`,
                error.message,
                '— if student_assignments RLS is enabled, this is the cause'
            )
        }
        console.log(
            `[loadStudentAssignments] assignment_id=${selectedAssignment} → ${data?.length ?? 0} rows`,
            (data || []).map(r => ({ student_id: r.student_id, ai_grade: r.ai_grade, grade: r.grade, status: r.status }))
        )

        const map = {}
        const grades = {}
        for (const row of (data || [])) {
            map[row.student_id] = row
            grades[row.student_id] = row.grade ?? ''
        }
        setStudentAssignments(map)
        setGradeInputs(grades)
    }

    async function createAssignment() {
        if (!newTitle.trim() || !selectedClass) {
            alert('Enter a title and select a class')
            return
        }

        const { error } = await supabase
            .from('assignments')
            .insert([{ title: newTitle.trim(), class_id: selectedClass }])

        if (error) {
            alert(error.message)
        } else {
            setNewTitle('')
            loadAssignments()
        }
    }

    async function assignToAllStudents() {
        if (!selectedAssignment) {
            alert('Select an assignment first')
            return
        }
        if (students.length === 0) {
            alert('No students found for this class')
            return
        }

        setAssigning(true)
        const records = students.map(s => ({
            student_id: s.id,
            assignment_id: selectedAssignment,
            status: 'assigned',
        }))

        const { error } = await supabase.from('student_assignments').insert(records)

        setAssigning(false)

        if (error) {
            alert(error.message)
        } else {
            loadStudentAssignments()
        }
    }

    async function markSubmitted(studentId) {
        const row = studentAssignments[studentId]
        if (!row) return

        const { error } = await supabase
            .from('student_assignments')
            .update({ status: 'submitted' })
            .eq('id', row.id)

        if (error) alert(error.message)
        else loadStudentAssignments()
    }

    async function saveGrade(studentId) {
        const row = studentAssignments[studentId]
        if (!row) return

        const grade = gradeInputs[studentId] ?? ''

        const { error } = await supabase
            .from('student_assignments')
            .update({ grade, status: 'graded' })
            .eq('id', row.id)

        if (error) alert(error.message)
        else loadStudentAssignments()
    }

    // ─── Core grading logic (single student) ────────────────────────────────

    /**
     * Grade a single student.
     * Returns 'graded' | 'already_graded' | 'no_row' | 'cached'.
     * @param {string}  studentId
     * @param {boolean} forceRegrade  - ignore existing grades and cache
     */
    async function gradeStudent(studentId, forceRegrade = false) {
        const row = studentAssignments[studentId]
        if (!row) {
            console.log(`[gradeStudent] ${studentId}: no row found`)
            return 'no_row'
        }

        console.log(`[gradeStudent] ${studentId}:`, {
            ai_grade: row.ai_grade,
            grade: row.grade,
            submission: row.submission ? `"${row.submission.slice(0, 40)}…"` : row.submission,
            status: row.status,
            forceRegrade,
        })

        // Requirement 1: skip already graded unless force
        // Treat null, undefined, and empty string as "not graded"
        const hasAiGrade = row.ai_grade != null && row.ai_grade !== ''
        const hasTeacherGrade = row.grade != null && row.grade !== ''
        if (!forceRegrade && (hasAiGrade || hasTeacherGrade)) {
            console.log(`[gradeStudent] ${studentId}: skipping — already graded (ai_grade=${row.ai_grade}, grade=${row.grade})`)
            return 'already_graded'
        }

        const assignmentTitle = assignments.find(a => a.id === selectedAssignment)?.title ?? 'Untitled'
        // Use submission text if available; fall back to a placeholder so grading can proceed
        const submission = (row.submission && row.submission.trim())
            ? row.submission
            : `[No submission yet from student ${studentId}]`

        // Requirement 2: cache — compare submission hash
        const currentHash = simpleHash(submission)
        if (!forceRegrade && row.submission_hash === currentHash && row.ai_grade) {
            return 'cached'
        }

        // Call AI via backend proxy — tag the error if it fails so callers can see it came from the proxy
        let result
        try {
            result = await gradeWithAI(assignmentTitle, submission, {
                userId: user?.id ?? null,
                role,
                schoolId,
                deploymentMode,
            })
        } catch (aiErr) {
            throw new Error(`AI call failed: ${aiErr.message}`)
        }

        const updatePayload = {
            ai_grade: result.suggested_grade,
            feedback: JSON.stringify({
                overall: result.overall,
                rubric: result.rubric,
            }),
            submission_hash: currentHash,
        }

        const { error } = await supabase
            .from('student_assignments')
            .update(updatePayload)
            .eq('id', row.id)

        if (error) throw new Error(`DB update failed: ${error.message}`)

        return 'graded'
    }

    // ─── Single student feedback (existing button) ──────────────────────────

    const generateFeedback = useCallback(async (studentId, forceRegrade = false) => {
        if (aiLoading[studentId]) return               // prevent double-click

        setAiLoading(prev => ({ ...prev, [studentId]: true }))
        setRowErrors(prev => {
            if (!(studentId in prev)) return prev
            const next = { ...prev }; delete next[studentId]; return next
        })

        try {
            const outcome = await gradeStudent(studentId, forceRegrade)
            if (outcome === 'already_graded') {
                alert('This student already has a grade. Use "Force Regrade" to overwrite.')
            } else if (outcome === 'cached') {
                // No API call needed — submission unchanged
            }
            loadStudentAssignments()
        } catch (err) {
            console.error(`[generateFeedback] ${studentId} failed:`, err)
            setRowErrors(prev => ({ ...prev, [studentId]: err.message }))
            alert(`AI error: ${err.message}`)
        } finally {
            setAiLoading(prev => ({ ...prev, [studentId]: false }))
        }
    }, [aiLoading, studentAssignments, assignments, selectedAssignment, user, role, schoolId])

    // ─── Batch: Grade Entire Class ──────────────────────────────────────────

    const gradeEntireClass = useCallback(async () => {
        if (batchGrading) return                        // prevent double-click

        // Include all student_assignments without an existing grade.
        // Treat null, undefined, and '' as "not graded".
        console.log('[gradeEntireClass] students:', students.length, 'studentAssignments keys:', Object.keys(studentAssignments))
        const eligibleIds = students
            .filter(s => {
                const sa = studentAssignments[s.id]
                if (!sa) {
                    console.log(`[gradeEntireClass] ${s.id} (${s.name}): no student_assignment row`)
                    return false
                }
                const hasAiGrade = sa.ai_grade != null && sa.ai_grade !== ''
                const hasTeacherGrade = sa.grade != null && sa.grade !== ''
                const dominated = hasAiGrade || hasTeacherGrade
                console.log(`[gradeEntireClass] ${s.id} (${s.name}): ai_grade=${JSON.stringify(sa.ai_grade)} grade=${JSON.stringify(sa.grade)} → ${dominated ? 'SKIP' : 'ELIGIBLE'}`)
                return !dominated
            })
            .map(s => s.id)

        if (eligibleIds.length === 0) {
            // Build an accurate explanation from the breakdown rather than guessing.
            const lines = [
                `Nothing to grade for assignment ${selectedAssignment}.`,
                '',
                `Students in school: ${gradingStats.students}`,
                `student_assignments rows for this assignment: ${gradingStats.rows}`,
                `  • ${gradingStats.noRow} student(s) with NO row (need "Assign to all students" first)`,
                `  • ${gradingStats.withAiGrade} already have an AI grade`,
                `  • ${gradingStats.withTeacherGrade} already have a teacher grade`,
                `  • ${gradingStats.eligible} eligible for grading`,
            ]
            if (gradingStats.students === 0) {
                lines.push('', 'Cause: 0 students returned by school_members query — check console for query errors (RLS / school_id).')
            } else if (gradingStats.rows === 0) {
                lines.push('', 'Cause: 0 student_assignments rows for this assignment_id — click "Assign to all students" first, or check console for query errors.')
            } else if (gradingStats.eligible === 0) {
                lines.push('', 'Cause: every assigned student already has a grade. Use "Force Regrade" on a row to override.')
            }
            alert(lines.join('\n'))
            return
        }

        console.log(`[gradeEntireClass] ${eligibleIds.length} eligible for grading`)

        setBatchGrading(true)
        setBatchProgress({ done: 0, total: eligibleIds.length, skipped: 0, failed: 0 })
        setRowErrors({})                                // clear stale errors before a new run

        let done = 0, skipped = 0, failed = 0
        const failureMessages = []                      // [{ name, message }]

        // Process in batches
        for (let i = 0; i < eligibleIds.length; i += BATCH_SIZE) {
            const batch = eligibleIds.slice(i, i + BATCH_SIZE)

            const results = await Promise.allSettled(
                batch.map(async (sid) => {
                    setAiLoading(prev => ({ ...prev, [sid]: true }))
                    try {
                        return await gradeStudent(sid, false)
                    } finally {
                        setAiLoading(prev => ({ ...prev, [sid]: false }))
                    }
                })
            )

            results.forEach((r, idx) => {
                const sid = batch[idx]
                if (r.status === 'fulfilled') {
                    if (r.value === 'graded') done++
                    else skipped++ // already_graded, no_submission, no_row, cached
                } else {
                    failed++
                    const msg = r.reason?.message || String(r.reason) || 'unknown error'
                    const studentName = students.find(s => s.id === sid)?.name || sid
                    console.error(`[gradeEntireClass] ${studentName} (${sid}) failed:`, r.reason)
                    failureMessages.push({ name: studentName, message: msg })
                    setRowErrors(prev => ({ ...prev, [sid]: msg }))
                }
            })

            setBatchProgress({ done, total: eligibleIds.length, skipped, failed })

            // Refresh data after each batch so the UI updates progressively
            await loadStudentAssignments()
        }

        setBatchGrading(false)

        // Surface real failure causes — first few, plus a hint to check the console for the rest
        let summary = `Batch grading complete — ${done} graded, ${skipped} skipped, ${failed} failed.`
        if (failureMessages.length > 0) {
            const preview = failureMessages.slice(0, 3)
                .map(f => `• ${f.name}: ${f.message}`)
                .join('\n')
            const more = failureMessages.length > 3
                ? `\n…and ${failureMessages.length - 3} more (see console).`
                : ''
            summary += `\n\nFailures:\n${preview}${more}`
        }
        alert(summary)
    }, [batchGrading, students, studentAssignments, assignments, selectedAssignment, user, role, schoolId, gradingStats])

    // ─── Render ─────────────────────────────────────────────────────────────

    return (
        <div>
            <h2>Assignments</h2>

            <label>Class: </label>
            <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                <option value="">Select Class</option>
                {classes.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>

            {selectedClass && (
                <>
                    <br /><br />

                    <div>
                        <input
                            placeholder="New assignment title"
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                        />
                        {' '}
                        <button onClick={createAssignment}>Add Assignment</button>
                    </div>

                    <br />

                    <label>Assignment: </label>
                    <select value={selectedAssignment} onChange={(e) => setSelectedAssignment(e.target.value)}>
                        <option value="">Select Assignment</option>
                        {assignments.map(a => (
                            <option key={a.id} value={a.id}>{a.title}</option>
                        ))}
                    </select>

                    {selectedAssignment && (
                        <>
                            {' '}
                            <button onClick={assignToAllStudents} disabled={assigning}>
                                {assigning ? 'Assigning…' : `Assign to all students (${students.length})`}
                            </button>
                            {' '}
                            <button
                                onClick={gradeEntireClass}
                                disabled={batchGrading}
                                style={{
                                    backgroundColor: '#2563eb',
                                    color: '#fff',
                                    border: 'none',
                                    padding: '6px 14px',
                                    borderRadius: 4,
                                    cursor: batchGrading ? 'not-allowed' : 'pointer',
                                    opacity: batchGrading ? 0.6 : 1,
                                }}
                            >
                                {batchGrading
                                    ? `Grading… ${batchProgress.done}/${batchProgress.total}`
                                    : 'Grade Entire Class'}
                            </button>
                        </>
                    )}

                    {batchGrading && (
                        <div style={{ margin: '8px 0', fontSize: '0.9em', color: '#555' }}>
                            Progress: {batchProgress.done} graded, {batchProgress.skipped} skipped, {batchProgress.failed} failed
                            {' / '}{batchProgress.total} total
                        </div>
                    )}

                    {selectedAssignment && (
                        <div style={{
                            margin: '12px 0',
                            padding: '8px 12px',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 4,
                            fontSize: '0.85em',
                            color: '#334155',
                            fontFamily: 'monospace',
                        }}>
                            <div><strong>Diagnostics</strong></div>
                            <div>assignment_id: {selectedAssignment}</div>
                            <div>students in school: {gradingStats.students}</div>
                            <div>student_assignments rows for this assignment: {gradingStats.rows}</div>
                            <div>
                                breakdown — eligible: {gradingStats.eligible}
                                {' · '}has AI grade: {gradingStats.withAiGrade}
                                {' · '}has teacher grade: {gradingStats.withTeacherGrade}
                                {' · '}no row (not yet assigned): {gradingStats.noRow}
                            </div>
                        </div>
                    )}

                    <br />

                    <h3>Students ({students.length})</h3>

                    {students.length === 0 && <p>No students found for this class</p>}

                    {students.map((s) => {
                        const sa = studentAssignments[s.id]
                        const loading = aiLoading[s.id]
                        const hasExistingGrade = sa?.ai_grade || sa?.grade
                        const rowError = rowErrors[s.id]
                        return (
                            <div key={s.id} style={{ border: '1px solid #ccc', margin: '6px 0', padding: '10px 14px' }}>
                                <div>
                                    <strong>{s.name}</strong>
                                    {' — '}
                                    {sa ? (
                                        <>
                                            <span>Status: <em>{sa.status}</em></span>
                                            {'  '}
                                            {sa.status === 'assigned' && (
                                                <button onClick={() => markSubmitted(s.id)}>
                                                    Mark Submitted
                                                </button>
                                            )}
                                            {'  '}
                                            <input
                                                placeholder="Grade"
                                                value={gradeInputs[s.id] ?? ''}
                                                onChange={(e) =>
                                                    setGradeInputs(prev => ({ ...prev, [s.id]: e.target.value }))
                                                }
                                                style={{ width: 80 }}
                                            />
                                            {' '}
                                            <button onClick={() => saveGrade(s.id)}>Save Grade</button>
                                            {'  '}
                                            <button
                                                onClick={() => generateFeedback(s.id, false)}
                                                disabled={loading || batchGrading}
                                            >
                                                {loading ? 'Generating…' : 'Generate Feedback'}
                                            </button>
                                            {hasExistingGrade && (
                                                <>
                                                    {' '}
                                                    <button
                                                        onClick={() => generateFeedback(s.id, true)}
                                                        disabled={loading || batchGrading}
                                                        style={{
                                                            backgroundColor: '#dc2626',
                                                            color: '#fff',
                                                            border: 'none',
                                                            padding: '4px 10px',
                                                            borderRadius: 4,
                                                            cursor: (loading || batchGrading) ? 'not-allowed' : 'pointer',
                                                            opacity: (loading || batchGrading) ? 0.6 : 1,
                                                            fontSize: '0.85em',
                                                        }}
                                                    >
                                                        Force Regrade
                                                    </button>
                                                </>
                                            )}
                                        </>
                                    ) : (
                                        <span style={{ color: '#999' }}>Not assigned</span>
                                    )}
                                </div>

                                {rowError && (
                                    <div style={{
                                        marginTop: 8,
                                        padding: '6px 10px',
                                        background: '#fef2f2',
                                        border: '1px solid #fecaca',
                                        borderRadius: 4,
                                        color: '#991b1b',
                                        fontSize: '0.85em',
                                    }}>
                                        <strong>Grading error:</strong> {rowError}
                                    </div>
                                )}

                                {(sa?.ai_grade || sa?.feedback) && (() => {
                                    const parsed = parseFeedback(sa.feedback)
                                    return (
                                        <div style={{
                                            marginTop: 10,
                                            paddingTop: 10,
                                            borderTop: '1px dashed #ddd',
                                        }}>
                                            {sa.ai_grade && (
                                                <div style={{ marginBottom: 8 }}>
                                                    <strong>AI Grade: </strong>
                                                    <span style={{ fontSize: '1.15em', fontWeight: 700 }}>
                                                        {sa.ai_grade}
                                                    </span>
                                                </div>
                                            )}
                                            {parsed?.rubric && (
                                                <div style={{ marginBottom: 8 }}>
                                                    {RUBRIC_CRITERIA.map(criterion => {
                                                        const item = parsed.rubric[criterion]
                                                        if (!item) return null
                                                        return (
                                                            <div key={criterion} style={{ marginBottom: 4 }}>
                                                                <span style={{
                                                                    display: 'inline-block',
                                                                    width: 90,
                                                                    fontWeight: 600,
                                                                    textTransform: 'capitalize',
                                                                }}>
                                                                    {criterion}
                                                                </span>
                                                                <span style={{ color: '#777', marginRight: 6 }}>
                                                                    {item.score}
                                                                </span>
                                                                <span style={{ color: '#444' }}>
                                                                    {item.comment}
                                                                </span>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            )}
                                            {parsed?.overall && (
                                                <div style={{ color: '#444', fontStyle: 'italic' }}>
                                                    {parsed.overall}
                                                </div>
                                            )}
                                        </div>
                                    )
                                })()}
                            </div>
                        )
                    })}
                </>
            )}
        </div>
    )
}
