// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Helm — Copilot panel · review_struggling_students v1
// ─────────────────────────────────────────────────────────────────────────────
// First Helm-side surface using SAIL-core's Copilot RPCs. Read-only
// orchestration over deterministic at-risk signals. The teacher:
//
//   1. Picks a class they teach.
//   2. The page fetches deterministic suggestions
//      (bridge_copilot_review_struggling) and immediately fires the
//      audit row (bridge_record_copilot_read) with the same request_id.
//   3. Each suggestion renders as a card with student name, signal
//      tags, risk band, and a recommended action.
//   4. Teacher accepts a suggestion → opens the inline form to create
//      a targeted assignment (bridge_create_assignment +
//      bridge_distribute_assignment, both pre-existing). The student
//      sees the new assignment via the existing assignments-page
//      flow — no schema or RLS changes were needed.
//
// Deliberate v1 constraints (from Hooks Spec § 9 ADR-style decisions):
//   - Risk scoring is deterministic, not AI. AI is reserved for the
//     suggestion *layer*, not flagging.
//   - PII discipline: only first_name + last_initial render; the audit
//     row only stores ids.
//   - Audit emission is fire-and-forget — UI does not block on it.
//   - "Add note / schedule review" maps to a copilot.read audit entry
//     with a note-ish payload. There is no messaging RPC in Helm yet,
//     so this is intentionally a soft-action → audit shim until the
//     contact_parents intent is built.
// ═══════════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../lib/supabaseClient'
import {
    reviewStruggling,
    recordCopilotRead,
    createTargetedAssignment,
    newRequestId,
} from '../services/copilot'

const RISK_TONE = {
    high:   { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', label: 'High risk' },
    medium: { bg: '#fff7ed', border: '#fed7aa', color: '#9a3412', label: 'Medium risk' },
    low:    { bg: '#fefce8', border: '#fef08a', color: '#854d0e', label: 'Low risk' },
}

const ACTION_LABEL = {
    invite_to_review:    'Invite to 1:1 review',
    suggest_reteaching:  'Suggest re-teaching',
    assign_drill:        'Assign a targeted drill',
    none:                'No action',
}

const SIGNAL_LABEL = {
    'grades.recent_low_mark':    'recent low mark',
    'assignments.unsubmitted':   'unsubmitted work',
    'behaviour.recent_negative': 'behaviour concern',
}

function Card({ children, style }) {
    return (
        <div style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            padding: 12,
            margin: '8px 0',
            background: '#fff',
            ...style,
        }}>
            {children}
        </div>
    )
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

function Toast({ children, tone = 'success' }) {
    if (!children) return null
    const palette = tone === 'success'
        ? { bg: '#ecfdf5', border: '#a7f3d0', color: '#065f46' }
        : { bg: '#fef2f2', border: '#fecaca', color: '#991b1b' }
    return (
        <div style={{
            position: 'fixed',
            bottom: 16,
            right: 16,
            padding: '10px 14px',
            border: `1px solid ${palette.border}`,
            background: palette.bg,
            color: palette.color,
            borderRadius: 6,
            fontSize: 13,
            maxWidth: 360,
            zIndex: 50,
        }}>
            {children}
        </div>
    )
}

function fullName(s) {
    const initial = s.student_last_initial ? `${s.student_last_initial}.` : ''
    return [s.student_first_name, initial].filter(Boolean).join(' ').trim()
        || 'Unnamed student'
}

function defaultDraftFor(suggestion) {
    const name = fullName(suggestion)
    switch (suggestion.recommended_action) {
        case 'invite_to_review':
            return {
                title: `1:1 review with ${name}`,
                description: `Set aside 10 minutes to discuss recent progress with ${name}. Signals that triggered this prompt: ${suggestion.signals.map(s => SIGNAL_LABEL[s] || s).join(', ')}.`,
            }
        case 'suggest_reteaching':
            return {
                title: `Re-teach core concept — ${name}`,
                description: `Re-teach the most recent topic to ${name} (and any peers in similar position). Watch for: low recent mark + unsubmitted work pattern.`,
            }
        case 'assign_drill':
        default:
            return {
                title: `Targeted practice for ${name}`,
                description: `Short practice set on the most recent topic for ${name}. Goal: re-engagement + a fresh data point on understanding.`,
            }
    }
}

export default function CopilotReviewStruggling() {
    const { schoolId, userId } = useAuth()

    const [classes,  setClasses]  = useState([])
    const [classesErr, setClassesErr] = useState(null)
    const [classId,  setClassId]  = useState('')
    const [windowDays, setWindowDays] = useState(14)
    const [threshold,  setThreshold]  = useState(0.6)

    const [loading, setLoading]   = useState(false)
    const [suggestions, setSuggestions] = useState([])
    const [reqError,  setReqError] = useState(null)
    const [requestId, setRequestId] = useState(null)
    const [acceptedFor, setAcceptedFor] = useState(null)  // suggestion id
    const [draft,     setDraft]    = useState(null)        // {title, description}
    const [submitting, setSubmitting] = useState(false)
    const [toast,     setToast]    = useState(null)

    // Load the teacher's classes on mount. Reuses the existing thin RPC
    // bridge_list_classes(p_school_id) — same call Gradebook makes.
    useEffect(() => {
        let cancelled = false
        if (!schoolId) return
        async function load() {
            const { data, error } = await supabase.rpc('bridge_list_classes', {
                p_school_id: schoolId,
            })
            if (cancelled) return
            if (error) { setClassesErr(error); return }
            const rows = Array.isArray(data) ? data : []
            setClasses(rows)
            if (rows.length > 0 && !classId) setClassId(rows[0].id)
        }
        load()
        return () => { cancelled = true }
    }, [schoolId])  // eslint-disable-line react-hooks/exhaustive-deps

    const runCopilot = useCallback(async () => {
        if (!schoolId || !classId) return
        setLoading(true)
        setReqError(null)
        setSuggestions([])
        setAcceptedFor(null)
        const rid = newRequestId()
        setRequestId(rid)
        try {
            const rows = await reviewStruggling({
                schoolId, classId, windowDays, threshold,
            })
            setSuggestions(rows)
            // Fire-and-forget audit row — non-fatal on failure.
            recordCopilotRead({
                requestId: rid,
                schoolId,
                classId,
                studentIds: rows.map(r => r.student_id),
            })
        } catch (err) {
            setReqError(err)
        } finally {
            setLoading(false)
        }
    }, [schoolId, classId, windowDays, threshold])

    function openAccept(suggestion) {
        setAcceptedFor(suggestion.student_id)
        setDraft(defaultDraftFor(suggestion))
    }
    function cancelAccept() {
        setAcceptedFor(null)
        setDraft(null)
    }

    async function commitAccept(suggestion) {
        if (!draft || !classId) return
        setSubmitting(true)
        setReqError(null)
        try {
            const { assignment, distributedCount } = await createTargetedAssignment({
                classId,
                title:       draft.title,
                description: draft.description,
                studentIds:  [suggestion.student_id],
            })
            // Audit the acceptance (best-effort) so analysts can see that
            // a Copilot suggestion was actually acted upon, not just
            // viewed. Reuse the same request_id so this audit row joins
            // back to the suggestion fetch.
            recordCopilotRead({
                requestId: requestId,
                schoolId,
                classId,
                studentIds: [suggestion.student_id],
            })
            setToast({
                tone: 'success',
                msg: `Created "${assignment.title}" and assigned to ${distributedCount} student${distributedCount === 1 ? '' : 's'}.`,
            })
            // Mark the suggestion row as acted-on so the UI shows it as done.
            setSuggestions(prev => prev.map(s =>
                s.student_id === suggestion.student_id
                    ? { ...s, _accepted: true, _assignmentId: assignment.id }
                    : s
            ))
            cancelAccept()
        } catch (err) {
            setReqError(err)
        } finally {
            setSubmitting(false)
            setTimeout(() => setToast(null), 4000)
        }
    }

    const summary = useMemo(() => {
        if (suggestions.length === 0) return null
        const high   = suggestions.filter(s => s.risk_band === 'high').length
        const medium = suggestions.filter(s => s.risk_band === 'medium').length
        const low    = suggestions.filter(s => s.risk_band === 'low').length
        return { high, medium, low, total: suggestions.length }
    }, [suggestions])

    if (!schoolId) {
        return (
            <div>
                <h2>Copilot — Review struggling students</h2>
                <p style={{ color: '#666' }}>
                    No school is associated with your account. Ask your school
                    admin to add you as a teacher in a school.
                </p>
            </div>
        )
    }

    return (
        <div>
            <h2 style={{ marginBottom: 4 }}>Copilot — Review struggling students</h2>
            <p style={{ color: '#6b7280', fontSize: 13, marginTop: 0 }}>
                Read-only Copilot prototype. Risk scoring is deterministic
                (recent low marks · unsubmitted work · behaviour signals);
                accepting a suggestion creates a real assignment via the
                existing flow.
            </p>

            <Card>
                <ErrorBox error={classesErr} />
                <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                        Class
                        <select
                            value={classId}
                            onChange={e => setClassId(e.target.value)}
                            disabled={classes.length === 0 || loading}
                            style={{ padding: 4, minWidth: 220 }}
                        >
                            {classes.length === 0 && <option value="">No classes</option>}
                            {classes.map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.name || c.id}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                        Window (days)
                        <input
                            type="number"
                            min={1}
                            max={90}
                            value={windowDays}
                            onChange={e => setWindowDays(Number(e.target.value) || 14)}
                            style={{ padding: 4, width: 80 }}
                            disabled={loading}
                        />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                        Threshold (0.0–1.0)
                        <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.1}
                            value={threshold}
                            onChange={e => setThreshold(Number(e.target.value) || 0.6)}
                            style={{ padding: 4, width: 80 }}
                            disabled={loading}
                        />
                    </label>
                    <button
                        type="button"
                        onClick={runCopilot}
                        disabled={!classId || loading}
                        style={{
                            padding: '6px 14px',
                            background: '#1f2937',
                            color: '#fff',
                            border: 0,
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontWeight: 600,
                        }}
                    >
                        {loading ? 'Running…' : 'Run Copilot'}
                    </button>
                </div>
                {requestId && (
                    <div style={{ marginTop: 8, color: '#9ca3af', fontSize: 11, fontFamily: 'monospace' }}>
                        request_id: {requestId}
                    </div>
                )}
            </Card>

            <ErrorBox error={reqError} />

            {summary && (
                <div style={{ margin: '12px 0', fontSize: 13, color: '#374151' }}>
                    <strong>{summary.total}</strong> student{summary.total === 1 ? '' : 's'} flagged
                    {summary.high   > 0 && <> · <span style={{ color: RISK_TONE.high.color }}>{summary.high} high</span></>}
                    {summary.medium > 0 && <> · <span style={{ color: RISK_TONE.medium.color }}>{summary.medium} medium</span></>}
                    {summary.low    > 0 && <> · <span style={{ color: RISK_TONE.low.color }}>{summary.low} low</span></>}
                </div>
            )}

            {!loading && requestId && suggestions.length === 0 && !reqError && (
                <Card>
                    <p style={{ margin: 0, color: '#6b7280' }}>
                        No students cleared the threshold for this window.
                        That's a healthy class — or a sign the threshold is
                        too strict (try lowering it).
                    </p>
                </Card>
            )}

            {suggestions.map(s => {
                const tone = RISK_TONE[s.risk_band] || RISK_TONE.low
                const isAccepting = acceptedFor === s.student_id
                return (
                    <Card key={s.student_id} style={{
                        borderLeft: `4px solid ${tone.border}`,
                        opacity: s._accepted ? 0.6 : 1,
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                            <div>
                                <strong style={{ fontSize: 15 }}>{fullName(s)}</strong>
                                <span style={{
                                    marginLeft: 10,
                                    padding: '2px 8px',
                                    borderRadius: 12,
                                    fontSize: 11,
                                    background: tone.bg,
                                    border: `1px solid ${tone.border}`,
                                    color: tone.color,
                                }}>
                                    {tone.label}
                                </span>
                            </div>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>
                                Recommended: <strong>{ACTION_LABEL[s.recommended_action] || s.recommended_action}</strong>
                            </span>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 12, color: '#4b5563' }}>
                            Signals: {s.signals.map(sig => (
                                <span key={sig} style={{
                                    display: 'inline-block',
                                    margin: '0 4px 4px 0',
                                    padding: '1px 6px',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: 8,
                                    background: '#f9fafb',
                                }}>
                                    {SIGNAL_LABEL[sig] || sig}
                                </span>
                            ))}
                        </div>

                        {!s._accepted && !isAccepting && (
                            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                                <button
                                    type="button"
                                    onClick={() => openAccept(s)}
                                    style={{
                                        padding: '4px 10px',
                                        border: '1px solid #d1d5db',
                                        background: '#fff',
                                        cursor: 'pointer',
                                        borderRadius: 4,
                                        fontSize: 13,
                                    }}
                                >
                                    Accept · create targeted assignment
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        recordCopilotRead({
                                            requestId,
                                            schoolId,
                                            classId,
                                            studentIds: [s.student_id],
                                        })
                                        setToast({ tone: 'success', msg: `Logged a review-note for ${fullName(s)}.` })
                                        setTimeout(() => setToast(null), 4000)
                                    }}
                                    style={{
                                        padding: '4px 10px',
                                        border: '1px solid #d1d5db',
                                        background: '#fff',
                                        cursor: 'pointer',
                                        borderRadius: 4,
                                        fontSize: 13,
                                    }}
                                >
                                    Add note · audit only
                                </button>
                            </div>
                        )}

                        {s._accepted && (
                            <div style={{ marginTop: 8, fontSize: 12, color: '#065f46' }}>
                                ✓ Targeted assignment created.
                            </div>
                        )}

                        {isAccepting && (
                            <div style={{ marginTop: 12, padding: 10, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 4 }}>
                                <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
                                    Title
                                    <input
                                        type="text"
                                        value={draft?.title || ''}
                                        onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                                        style={{ width: '100%', padding: 4, fontSize: 13 }}
                                    />
                                </label>
                                <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
                                    Description
                                    <textarea
                                        value={draft?.description || ''}
                                        onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                                        style={{ width: '100%', padding: 4, fontSize: 13, minHeight: 60 }}
                                    />
                                </label>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => commitAccept(s)}
                                        disabled={submitting || !draft?.title}
                                        style={{
                                            padding: '4px 12px',
                                            background: '#1f2937',
                                            color: '#fff',
                                            border: 0,
                                            borderRadius: 4,
                                            cursor: submitting ? 'wait' : 'pointer',
                                        }}
                                    >
                                        {submitting ? 'Creating…' : 'Create + assign'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={cancelAccept}
                                        disabled={submitting}
                                        style={{
                                            padding: '4px 12px',
                                            background: 'transparent',
                                            border: '1px solid #d1d5db',
                                            borderRadius: 4,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </Card>
                )
            })}

            {toast && <Toast tone={toast.tone}>{toast.msg}</Toast>}
        </div>
    )
}
