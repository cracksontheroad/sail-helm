import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Sign in + self-service Sign up. A brand-new signed-up user has no school
// membership, so AuthContext routes them into the existing /provisioning flow
// where they create their first school and become its admin (server-side, via
// create_school_with_owner). This page only handles authentication.
export default function Login() {
    const [mode, setMode] = useState('signin') // 'signin' | 'signup'
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [firstName, setFirstName] = useState('')
    const [lastName, setLastName] = useState('')
    const [error, setError] = useState(null)
    const [info, setInfo] = useState(null)       // e.g. "check your email"
    const [submitting, setSubmitting] = useState(false)

    const isSignup = mode === 'signup'

    const handleLogin = async () => {
        if (!email || !password) {
            setError('Enter email and password')
            return
        }
        setError(null)
        setInfo(null)
        setSubmitting(true)
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
        setSubmitting(false)
        if (authError) {
            setError(authError.message)
        }
        // On success, AuthContext will detect the session change and re-render App
    }

    const handleSignup = async () => {
        if (!email || !password) {
            setError('Enter email and password')
            return
        }
        if (password.length < 6) {
            setError('Password must be at least 6 characters')
            return
        }
        setError(null)
        setInfo(null)
        setSubmitting(true)
        const { data, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                // handle_new_user trigger reads first_name / last_name from user metadata.
                data: { first_name: firstName.trim() || null, last_name: lastName.trim() || null },
            },
        })
        setSubmitting(false)
        if (authError) {
            setError(authError.message)
            return
        }
        if (data.session) {
            // Email confirmation OFF: signed in immediately. AuthContext picks up
            // the session; a user with no school is routed to /provisioning.
            return
        }
        // Email confirmation ON: no session yet.
        setInfo('Check your email to confirm your account, then sign in.')
        setMode('signin')
    }

    const submit = isSignup ? handleSignup : handleLogin
    const handleKeyDown = (e) => {
        if (e.key === 'Enter') submit()
    }
    const switchMode = () => {
        setMode(isSignup ? 'signin' : 'signup')
        setError(null)
        setInfo(null)
    }

    const inputStyle = { width: '100%', padding: '8px 10px', fontSize: '1em', boxSizing: 'border-box' }

    return (
        <div style={{ maxWidth: 360, margin: '80px auto', padding: 20 }}>
            <h1 style={{ marginBottom: 4 }}>SAIL Platform</h1>
            <h2 style={{ fontWeight: 400, color: '#666', marginTop: 0 }}>
                {isSignup ? 'Create your account' : 'Sign in'}
            </h2>

            {isSignup && (
                <>
                    <div style={{ marginBottom: 12 }}>
                        <input
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="First name"
                            autoComplete="given-name"
                            style={inputStyle}
                        />
                    </div>
                    <div style={{ marginBottom: 12 }}>
                        <input
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Last name"
                            autoComplete="family-name"
                            style={inputStyle}
                        />
                    </div>
                </>
            )}

            <div style={{ marginBottom: 12 }}>
                <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Email"
                    type="email"
                    autoComplete="email"
                    style={inputStyle}
                />
            </div>

            <div style={{ marginBottom: 12 }}>
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Password"
                    autoComplete={isSignup ? 'new-password' : 'current-password'}
                    style={inputStyle}
                />
            </div>

            {error && (
                <div style={{ color: '#dc2626', marginBottom: 12, fontSize: '0.9em' }}>
                    {error}
                </div>
            )}
            {info && (
                <div style={{ color: '#059669', marginBottom: 12, fontSize: '0.9em' }}>
                    {info}
                </div>
            )}

            <button
                onClick={submit}
                disabled={submitting}
                style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '1em',
                    backgroundColor: '#2563eb',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    opacity: submitting ? 0.6 : 1,
                }}
            >
                {submitting
                    ? (isSignup ? 'Creating account…' : 'Signing in...')
                    : (isSignup ? 'Sign up' : 'Sign In')}
            </button>

            <div style={{ marginTop: 16, fontSize: '0.9em', color: '#666', textAlign: 'center' }}>
                {isSignup ? 'Already have an account? ' : "Don't have an account? "}
                <a
                    role="button"
                    onClick={switchMode}
                    style={{ color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                >
                    {isSignup ? 'Sign in' : 'Create account'}
                </a>
            </div>
        </div>
    )
}
