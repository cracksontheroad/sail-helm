import { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { useAuth } from '../lib/AuthContext'
import { CAN, ROLE_LABELS } from '../lib/permissions'

/**
 * Members — Phase 1 Route 3 of the Helm rebuild (HELM_REBUILD_PLAN.md §3).
 *
 * Lists the current school's members (email + role) and lets admins
 * (a) add a member by email and (b) change an existing member's role.
 *
 * Architecture:
 *   - All reads go through `list_school_members(p_school_id)`. Clients
 *     cannot select from auth.users directly, so the email column has
 *     to come from an RPC join.
 *   - All writes go through `add_school_member(...)` and
 *     `update_school_member_role(...)`. The client NEVER writes to
 *     `school_members` — both writes set the role column server-side
 *     (Block 10 / PR-08 forbids client-side role assignment).
 *   - CAN.viewMembers / CAN.addMember / CAN.changeMemberRole gate
 *     visibility. Non-admins do not reach this page (route is gated
 *     in App.jsx) and the component double-checks defensively.
 */

const ASSIGNABLE_ROLES = ['student', 'teacher', 'admin']

export default function Members() {
    const { role, schoolId } = useAuth()

    const [members, setMembers] = useState([])
    // 'loading' | 'ready' | 'error'
    const [status, setStatus] = useState('loading')
    const [errorMessage, setErrorMessage] = useState(null)

    // Add-member form local state.
    const [addEmail, setAddEmail] = useState('')
    const [addRole, setAddRole] = useState('teacher')
    const [addStatus, setAddStatus] = useState('idle')   // 'idle' | 'submitting' | 'error'
    const [addError, setAddError]   = useState(null)

    // Per-row "pending role change" state, keyed by member_id.
    const [pendingRow, setPendingRow] = useState(null)

    const loadMembers = useCallback(async () => {
        if (!schoolId) return
        setStatus('loading')
        setErrorMessage(null)
        const { data, error } = await api.members.list(schoolId)
        if (error) {
            setErrorMessage(error.message || 'Could not load members.')
            setStatus('error')
            return
        }
        setMembers(data || [])
        setStatus('ready')
    }, [schoolId])

    useEffect(() => {
        loadMembers()
    }, [loadMembers])

    // Page-level defensive gate. Route registration in App.jsx already
    // checks CAN.viewMembers; this is the second layer.
    if (!CAN.viewMembers(role)) {
        return (
            <div>
                <h2>Members</h2>
                <p>You do not have access to this page.</p>
            </div>
        )
    }
    if (!schoolId) {
        // Should not be reachable — Dashboard redirects unattached
        // users to /provisioning before they can route to /members —
        // but render a sane state in case of a weird auth/route race.
        return (
            <div>
                <h2>Members</h2>
                <p>No school context. Reload the page.</p>
            </div>
        )
    }

    async function handleAdd(event) {
        event.preventDefault()
        const trimmed = addEmail.trim()
        if (!trimmed) return
        setAddStatus('submitting')
        setAddError(null)

        const { error } = await api.members.add(schoolId, trimmed, addRole)
        if (error) {
            setAddError(error.message || 'Could not add member.')
            setAddStatus('error')
            return
        }
        setAddStatus('idle')
        setAddEmail('')
        setAddRole('teacher')
        await loadMembers()
    }

    async function handleRoleChange(member, nextRole) {
        if (member.role === nextRole) return
        // list_school_members returns `id` (the school_members row id),
        // not `member_id`. The api wrapper passes it as p_member_id
        // to the RPC; the column name on this side stays `id`.
        setPendingRow(member.id)
        const { error } = await api.members.updateRole(member.id, nextRole)
        setPendingRow(null)
        if (error) {
            // Surface inline. We don't unmount the list — just show the
            // error and let the user retry. Reload to ensure UI matches
            // server truth even on failure.
            setErrorMessage(error.message || 'Could not change role.')
            await loadMembers()
            return
        }
        await loadMembers()
    }

    return (
        <div>
            <h2>Members</h2>

            {status === 'loading' && <p>Loading members…</p>}

            {status === 'error' && (
                <p style={ERROR_STYLE}>
                    Could not load members: <code>{errorMessage}</code>
                </p>
            )}

            {status === 'ready' && (
                <>
                    {errorMessage && (
                        <p style={ERROR_STYLE}>
                            <code>{errorMessage}</code>
                        </p>
                    )}

                    {members.length === 0 && (
                        <p>No members yet. Use the form below to add one.</p>
                    )}

                    {members.length > 0 && (
                        <table style={TABLE_STYLE}>
                            <thead>
                                <tr>
                                    <th style={TH_STYLE}>Email</th>
                                    <th style={TH_STYLE}>Role</th>
                                </tr>
                            </thead>
                            <tbody>
                                {members.map((m) => (
                                    <tr key={m.id}>
                                        <td style={TD_STYLE}>
                                            {m.email || <em>(no email)</em>}
                                        </td>
                                        <td style={TD_STYLE}>
                                            {CAN.changeMemberRole(role) ? (
                                                <select
                                                    value={m.role}
                                                    disabled={pendingRow === m.id}
                                                    onChange={(e) => handleRoleChange(m, e.target.value)}
                                                >
                                                    {ASSIGNABLE_ROLES.map((r) => (
                                                        <option key={r} value={r}>
                                                            {ROLE_LABELS[r] || r}
                                                        </option>
                                                    ))}
                                                </select>
                                            ) : (
                                                ROLE_LABELS[m.role] || m.role
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {CAN.addMember(role) && (
                        <form onSubmit={handleAdd} style={FORM_STYLE}>
                            <h3 style={H3_STYLE}>Add a member</h3>
                            <input
                                type="email"
                                value={addEmail}
                                onChange={(e) => setAddEmail(e.target.value)}
                                placeholder="user@example.com"
                                disabled={addStatus === 'submitting'}
                                required
                                style={INPUT_STYLE}
                            />
                            <select
                                value={addRole}
                                onChange={(e) => setAddRole(e.target.value)}
                                disabled={addStatus === 'submitting'}
                                style={INPUT_STYLE}
                            >
                                {ASSIGNABLE_ROLES.map((r) => (
                                    <option key={r} value={r}>
                                        {ROLE_LABELS[r] || r}
                                    </option>
                                ))}
                            </select>
                            <button
                                type="submit"
                                disabled={addStatus === 'submitting' || !addEmail.trim()}
                                style={BUTTON_STYLE}
                            >
                                {addStatus === 'submitting' ? 'Adding…' : 'Add member'}
                            </button>
                            {addStatus === 'error' && addError && (
                                <p style={ERROR_STYLE}>
                                    <code>{addError}</code>
                                </p>
                            )}
                        </form>
                    )}
                </>
            )}
        </div>
    )
}

// ─── Minimal styling — match the rest of the v6-lite shell. ─────────────────

const TABLE_STYLE = {
    borderCollapse: 'collapse',
    marginTop:      8,
    minWidth:       360,
}
const TH_STYLE = {
    textAlign:     'left',
    padding:       '4px 12px 4px 0',
    borderBottom:  '1px solid #ccc',
    fontSize:      13,
}
const TD_STYLE = {
    padding:      '6px 12px 6px 0',
    borderBottom: '1px solid #eee',
    fontSize:     14,
}
const FORM_STYLE = {
    display:       'flex',
    flexDirection: 'column',
    gap:           8,
    maxWidth:      360,
    marginTop:     24,
}
const H3_STYLE = {
    fontSize:   15,
    fontWeight: 600,
    margin:     '0 0 4px 0',
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
    color:     '#a00',
    fontSize:  14,
    marginTop: 12,
}
