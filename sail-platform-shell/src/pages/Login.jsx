import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'

export default function Login() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const handleLogin = async () => {
        if (!email || !password) {
            setError('Enter email and password')
            return
        }

        setError(null)
        setSubmitting(true)

        const { error: authError } = await supabase.auth.signInWithPassword({
            email,
            password,
        })

        setSubmitting(false)

        if (authError) {
            setError(authError.message)
        }
        // On success, AuthContext will detect the session change and re-render App
    }

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') handleLogin()
    }

    return (
        <div style={{ maxWidth: 360, margin: '80px auto', padding: 20 }}>
            <h1 style={{ marginBottom: 4 }}>SAIL Platform</h1>
            <h2 style={{ fontWeight: 400, color: '#666', marginTop: 0 }}>Sign in</h2>

            <div style={{ marginBottom: 12 }}>
                <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Email"
                    type="email"
                    autoComplete="email"
                    style={{ width: '100%', padding: '8px 10px', fontSize: '1em', boxSizing: 'border-box' }}
                />
            </div>

            <div style={{ marginBottom: 12 }}>
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Password"
                    autoComplete="current-password"
                    style={{ width: '100%', padding: '8px 10px', fontSize: '1em', boxSizing: 'border-box' }}
                />
            </div>

            {error && (
                <div style={{ color: '#dc2626', marginBottom: 12, fontSize: '0.9em' }}>
                    {error}
                </div>
            )}

            <button
                onClick={handleLogin}
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
                {submitting ? 'Signing in...' : 'Sign In'}
            </button>
        </div>
    )
}
