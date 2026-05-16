import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { usePermissions } from '../app/providers/PermissionsProvider'

/**
 * Settings — Phase 1 Route 4 of the Helm rebuild (HELM_REBUILD_PLAN.md §3).
 *
 * Minimum viable: show + update the school's `name`. Other settings
 * (timezone, branding, etc.) will extend this page once their backend
 * fields exist.
 *
 * Architecture:
 *   - Read: direct `from('schools').select('name').eq('id', ...)` — RLS
 *     scopes by `school_members` membership.
 *   - Write: `update_school_settings(p_school_id, p_name)` RPC. The
 *     client NEVER updates `schools` directly — this RPC is the
 *     audit-emitting + admin-gated entry point.
 *   - Optimistic UI is deliberately NOT used. The form text is the
 *     "draft"; the saved state comes from the round-trip back to
 *     Supabase. Planner direction (2026-05-12): no local optimistic
 *     mutation without server confirmation.
 *   - Gating: `can('helm.school.manage')` at the page level and in the
 *     route registration (App.jsx). Non-admins do not see Settings.
 *     DB-backed via PermissionsProvider; static CAN.manageSchool is no
 *     longer consulted here (migrated 2026-05-16).
 */
export default function Settings() {
    const { schoolId } = useAuth()
    // DB-backed page-level gate. Route registration in App.jsx already
    // gates on the same permission; this is defense in depth.
    const { can } = usePermissions()

    const [savedName, setSavedName] = useState('')
    const [draftName, setDraftName] = useState('')
    // 'loading' | 'ready' | 'error'
    const [status, setStatus] = useState('loading')
    const [errorMessage, setErrorMessage] = useState(null)

    // Save flow.
    // 'idle' | 'submitting' | 'success' | 'error'
    const [saveStatus, setSaveStatus] = useState('idle')
    const [saveError, setSaveError] = useState(null)

    const loadSettings = useCallback(async () => {
        if (!schoolId) return
        setStatus('loading')
        setErrorMessage(null)
        const { data, error } = await api.schools.get(schoolId)
        if (error) {
            setErrorMessage(error.message || 'Could not load settings.')
            setStatus('error')
            return
        }
        // get_school returns a single-row TABLE; use [0].
        const name = (data && data[0]?.name) || ''
        setSavedName(name)
        setDraftName(name)
        setStatus('ready')
    }, [schoolId])

    useEffect(() => {
        loadSettings()
    }, [loadSettings])

    // Defensive page-level gate.
    if (!can('helm.school.manage')) {
        return (
            <div>
                <h2>Settings</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }
    if (!schoolId) {
        return (
            <div>
                <h2>Settings</h2>
                <p>No school context. Reload the page.</p>
            </div>
        )
    }

    async function handleSave(event) {
        event.preventDefault()
        const trimmed = draftName.trim()
        if (!trimmed) return
        if (trimmed === savedName) return  // no-op on the client too

        setSaveStatus('submitting')
        setSaveError(null)

        const { error } = await api.schools.updateSettings(schoolId, trimmed)
        if (error) {
            setSaveError(error.message || 'Could not save settings.')
            setSaveStatus('error')
            return
        }

        // Server-confirmed truth: re-fetch the row instead of optimistically
        // setting savedName from the draft. If the server normalised the
        // value (trim, case, etc.) the displayed savedName will reflect
        // that.
        await loadSettings()
        setSaveStatus('success')
    }

    const submitting = saveStatus === 'submitting'
    const dirty = draftName.trim() !== savedName && draftName.trim() !== ''

    return (
        <div>
            <h2>Settings</h2>

            {status === 'loading' && <p>Loading settings…</p>}

            {status === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load settings: <code>{errorMessage}</code>
                </p>
            )}

            {status === 'ready' && (
                <form onSubmit={handleSave} style={FORM_STYLE}>
                    <label htmlFor="school-name" style={LABEL_STYLE}>
                        School name
                    </label>
                    <input
                        id="school-name"
                        type="text"
                        value={draftName}
                        onChange={(e) => {
                            setDraftName(e.target.value)
                            if (saveStatus === 'success') setSaveStatus('idle')
                        }}
                        maxLength={200}
                        disabled={submitting}
                        style={INPUT_STYLE}
                    />
                    <div style={ROW_STYLE}>
                        <button
                            type="submit"
                            disabled={submitting || !dirty}
                            style={BUTTON_STYLE}
                        >
                            {submitting ? 'Saving…' : 'Save'}
                        </button>
                        {saveStatus === 'success' && !dirty && (
                            <span style={SUCCESS_STYLE}>Saved.</span>
                        )}
                    </div>
                    {saveStatus === 'error' && saveError && (
                        <p style={ERROR_STYLE}>
                            <code>{saveError}</code>
                        </p>
                    )}
                </form>
            )}
        </div>
    )
}

// ─── Minimal styling — matches the rest of the v6-lite shell. ──────────────

const FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           8,
    maxWidth:      360,
    marginTop:     12,
}
const LABEL_STYLE = {
    fontSize:   13,
    fontWeight: 600,
}
const INPUT_STYLE = {
    padding:      '6px 8px',
    border:       '1px solid #ccc',
    borderRadius: 4,
    fontSize:     14,
}
const ROW_STYLE = {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
}
const BUTTON_STYLE = {
    padding:      '6px 12px',
    border:       '1px solid #888',
    borderRadius: 4,
    background:   '#f6f6f6',
    cursor:       'pointer',
    fontSize:     14,
    width:        'fit-content',
}
const SUCCESS_STYLE = {
    color:    '#0a0',
    fontSize: 13,
}
const ERROR_STYLE = {
    color:     '#a00',
    fontSize:  14,
    marginTop: 12,
}
