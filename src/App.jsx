import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const KEY = 'sail_helm_core_config_v6'

function readConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : { url: '', key: '' }
  } catch {
    return { url: '', key: '' }
  }
}

function average(nums) {
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export default function App() {
  const [config, setConfig] = useState(readConfig)
  const [view, setView] = useState('dashboard')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [session, setSession] = useState(null)
  const [status, setStatus] = useState('Enter Supabase URL and Key, then sign in.')
  const [lastResult, setLastResult] = useState(null)

  const supabase = useMemo(() => {
    if (!config.url || !config.key) return null
    return createClient(config.url, config.key)
  }, [config])

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
    })
  }, [supabase])

  async function signIn() {
    if (!supabase) return
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setStatus('Sign in failed')
      setLastResult(error)
    } else {
      setStatus('Signed in')
      setLastResult({ ok: true })
    }
  }

  return (
    <div style={{ padding: 40, color: "white", fontFamily: "sans-serif" }}>
      <h1>SAIL Helm Core v6</h1>

      <h2>Supabase Config</h2>
      <input
        placeholder="Project URL"
        value={config.url}
        onChange={e => {
          const next = { ...config, url: e.target.value }
          setConfig(next)
          localStorage.setItem(KEY, JSON.stringify(next))
        }}
      />
      <br /><br />
      <textarea
        placeholder="Publishable Key"
        rows="4"
        value={config.key}
        onChange={e => {
          const next = { ...config, key: e.target.value }
          setConfig(next)
          localStorage.setItem(KEY, JSON.stringify(next))
        }}
      />

      <h2>Sign In</h2>
      <input
        placeholder="Email"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      <br /><br />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
      />
      <br /><br />
      <button onClick={signIn}>Sign In</button>

      <h2>Navigation</h2>
      <button onClick={() => setView('dashboard')}>Dashboard</button>
      <button onClick={() => setView('gradebook')}>Gradebook</button>
      <button onClick={() => setView('analytics')}>Analytics</button>
      <button onClick={() => setView('csv')}>CSV Import</button>

      <h2>Current View: {view}</h2>

      <div style={{ marginTop: 20 }}>
        {view === 'dashboard' && <div>Dashboard Loading...</div>}
        {view === 'gradebook' && <div>Gradebook Loading...</div>}
        {view === 'analytics' && <div>Analytics Loading...</div>}
        {view === 'csv' && <div>CSV Import Loading...</div>}
      </div>

      <pre>{JSON.stringify({ session }, null, 2)}</pre>
      <pre>{JSON.stringify(lastResult, null, 2)}</pre>
      <p>Status: {status}</p>
    </div>
  )
}