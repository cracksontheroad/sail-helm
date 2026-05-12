import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN } from '../lib/permissions'

/**
 * Provisioning — the Phase 1 Route 2 surface (HELM_REBUILD_PLAN.md §3).
 *
 * Creates the FIRST school for a brand-new authenticated user and
 * attaches them as its admin. After this completes successfully the
 * dashboard becomes reachable.
 *
 * Architecture:
 *   - All persistence goes through the `create_school_with_owner` RPC
 *     (see migrations/2026-05-12-helm-provisioning-create-school-with-owner.sql).
 *     The client never inserts into `schools` or `school_members` —
 *     RLS blocks those writes from the browser, and the RPC is the
 *     atomic + audit-emitting + role-assigning entry point.
 *   - The role assignment ('admin') happens server-side inside the
 *     RPC body, not in this file. Per Block 10 (PR-08), no client
 *     code may assign `.role`.
 *   - Access is gated by CAN.provisionSchool(role). For the Phase 1
 *     self-service path this admits role=null users; super_admin is
 *     reserved for future "create another school" flow.
 *
 * After a successful RPC call we hard-reload to `/`. The reload
 * re-triggers Supabase's INITIAL_SESSION event, which causes
 * AuthContext to re-run get_effective_user_profile and pick up the
 * newly-created school + admin role. The dashboard then renders
 * normally.
 */
export default function Provisioning() {
    const { role, schoolId } = useAuth()

    const [name, setName] = useState('')
    // 'idle' | 'submitting' | 'success' | 'error'
    const [status, setStatus] = useState('idle')
    const [errorMessage, setErrorMessage] = useState(null)

    // Page-level gates.
    //
    // (1) If the caller is not allowed to provision at all, refuse.
    //     Hard-block — no redirect — because there is nowhere safer
    //     to send them that wouldn't be another stuck state.
    if (!CAN.provisionSchool(role)) {
        return (
            <div>
                <h2>Provisioning</h2>
                <p>
                    Your account does not have permission to create a school.
                    {' '}
                    If you should be able to do this, contact a SAIL
                    administrator.
                </p>
            </div>
        )
    }

    // (2) If the caller already has a school, they should not be on
    //     this page — bounce them to the dashboard.
    if (schoolId) {
        return <Navigate to="/" replace />
    }

    async function handleSubmit(event) {
        event.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return

        setStatus('submitting')
        setErrorMessage(null)

        const { data, error } = await api.schools.create(trimmed)

        if (error) {
            setErrorMessage(error.message || 'Could not create school.')
            setStatus('error')
            return
        }

        // RPC returns the new school uuid; we don't need it locally —
        // the AuthContext re-fetch will pick it up. But surface a
        // success state briefly before the reload so the user sees
        // that the call landed.
        // eslint-disable-next-line no-console
        console.log('[Provisioning] school created:', data)
        setStatus('success')

        // Hard navigation to `/`. Supabase will re-emit INITIAL_SESSION,
        // AuthContext re-fetches the profile, the new school + admin
        // role appear, and the dashboard renders. A soft navigate()
        // would not re-trigger the auth state machine.
        window.location.assign('/')
    }

    const submitting = status === 'submitting' || status === 'success'

    return (
        <div>
            <h2>Provision a school</h2>
            <p>
                You are signed in but not yet attached to any school. Create
                one below — you will become its admin automatically.
            </p>

            <form onSubmit={handleSubmit} style={FORM_STYLE}>
                <label htmlFor="school-name" style={LABEL_STYLE}>
                    School name
                </label>
                <input
                    id="school-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Roehampton Grammar"
                    maxLength={200}
                    disabled={submitting}
                    autoFocus
                    style={INPUT_STYLE}
                />
                <button
                    type="submit"
                    disabled={submitting || !name.trim()}
                    style={BUTTON_STYLE}
                >
                    {status === 'submitting' && 'Creating…'}
                    {status === 'success'    && 'Created — loading…'}
                    {(status === 'idle' || status === 'error') && 'Create school'}
                </button>
            </form>

            {status === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not create school: <code>{errorMessage}</code>
                </p>
            )}
        </div>
    )
}

// Minimal layout styling only. Match Dashboard.jsx's tone — no theming.
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
const BUTTON_STYLE = {
    padding:      '6px 12px',
    border:       '1px solid #888',
    borderRadius: 4,
    background:   '#f6f6f6',
    cursor:       'pointer',
    fontSize:     14,
    width:        'fit-content',
}
const ERROR_STYLE = {
    color:    '#a00',
    fontSize: 14,
    marginTop: 12,
}
