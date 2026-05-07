#!/usr/bin/env node
/**
 * SAIL ai-proxy direct test harness.
 *
 * Phase B3 (Stage 2 Helm stabilisation, 2026-05-07).
 *
 * Hits the deployed ai-proxy edge function with three distinct probes:
 *
 *   1. NO Authorization header        → expect 401 DENIED + log "auth_missing"
 *   2. Bogus Authorization header     → expect 401 DENIED + log "auth_invalid"
 *   3. Authenticated as a real user   → expect 200 SUCCESS or known-shape error,
 *                                        plus log "auth_passed/consent/app_check/
 *                                        provider/insert_attempt/insert_success"
 *
 * Probe 3 is OPTIONAL — only runs if you set HARNESS_USER_EMAIL +
 * HARNESS_USER_PASSWORD (or HARNESS_ACCESS_TOKEN) in the environment.
 * Without those, only probes 1 + 2 run; that's still enough to verify
 * the proxy is reachable and the entry/auth gates fire.
 *
 * Usage:
 *
 *   # Basic reachability + auth-gate proof:
 *   node scripts/test-ai-proxy.js
 *
 *   # Full end-to-end with a real user:
 *   HARNESS_USER_EMAIL=... HARNESS_USER_PASSWORD=... node scripts/test-ai-proxy.js
 *
 *   # OR with a pre-minted JWT:
 *   HARNESS_ACCESS_TOKEN=eyJ... node scripts/test-ai-proxy.js
 *
 * Reads the same .env that Vite/Netlify do (VITE_SUPABASE_URL +
 * VITE_SUPABASE_ANON_KEY; falls back to the hardcoded values in
 * lib/supabaseClient.js if .env doesn't have them).
 *
 * After running, check edge-function logs:
 *   `supabase functions logs ai-proxy --tail` (CLI)
 *   OR Supabase dashboard → Edge Functions → ai-proxy → Logs
 *   OR `mcp__claude_ai_Supabase__get_logs(service: 'edge-function')` from MCP
 *
 * Every log line for a single request shares the [AI_PROXY] prefix.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── env loader (no dotenv dep) ────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

function loadEnvFile(path) {
    if (!existsSync(path)) return
    const text = readFileSync(path, 'utf8')
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        if (!process.env[key]) process.env[key] = value
    }
}

loadEnvFile(join(REPO_ROOT, '.env'))
loadEnvFile(join(REPO_ROOT, '.env.local'))

// Fallback to the hardcoded values that ship in lib/supabaseClient.js so
// the harness works even on a fresh clone without env wiring.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL
    || 'https://gidyonbzxjorrgpicctt.supabase.co'
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
    || 'sb_publishable_9gCdvH0NEcmkCf_IKuWTvg_vZLpfJ-r'

const PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`

// ─── pretty print helper ───────────────────────────────────────────────────
function line() { console.log('─'.repeat(78)) }
function header(s) { console.log(`\n${s}`) ; line() }
function kv(k, v) { console.log(`  ${k.padEnd(18)} ${v}`) }

// ─── one probe ─────────────────────────────────────────────────────────────
async function probe(label, { authorization, body }) {
    header(`PROBE: ${label}`)
    kv('endpoint', PROXY_URL)
    kv('Authorization', authorization || '(none)')
    kv('payload bytes', body ? body.length : 0)

    let res
    try {
        res = await fetch(PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}),
                // The publishable apikey header is required by the
                // Supabase Functions gateway BEFORE verify_jwt runs.
                // Without it, the gateway returns 401 'No API key found'
                // and the function never executes — that would muddy the
                // diagnostic. Send it always.
                apikey: SUPABASE_ANON_KEY,
            },
            body,
        })
    } catch (err) {
        kv('NETWORK_ERROR', err.message)
        return { ok: false, network_error: err.message }
    }

    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* not json */ }

    kv('http status', res.status)
    kv('content-type', res.headers.get('content-type'))
    if (parsed) {
        kv('response.ok', String(parsed.ok))
        kv('response.code', parsed.code ?? '(none)')
        kv('response.error', (parsed.error ?? '').slice(0, 100))
        if (parsed.request_id) kv('request_id', parsed.request_id)
    } else if (text) {
        kv('response (raw)', text.slice(0, 200))
    }

    return { ok: res.ok, status: res.status, parsed, raw: text }
}

// ─── optional auth via supabase-js ─────────────────────────────────────────
async function authenticate() {
    if (process.env.HARNESS_ACCESS_TOKEN) {
        return { token: process.env.HARNESS_ACCESS_TOKEN, source: 'env_token' }
    }
    const email = process.env.HARNESS_USER_EMAIL
    const password = process.env.HARNESS_USER_PASSWORD
    if (!email || !password) return null

    // Lazy-load supabase-js so this script runs even if node_modules is
    // empty (probes 1 + 2 don't need it).
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await sb.auth.signInWithPassword({ email, password })
    if (error) {
        console.error(`[harness] sign-in failed: ${error.message}`)
        return null
    }
    return { token: data.session?.access_token, source: 'password_grant', user_id: data.user?.id, email }
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
    line()
    console.log('SAIL ai-proxy direct test harness')
    line()
    kv('SUPABASE_URL', SUPABASE_URL)
    kv('PROXY_URL',    PROXY_URL)

    const minimalBody = JSON.stringify({
        prompt:         'Probe: respond with the literal string "pong".',
        system:         'You are a test echo. Respond exactly with "pong".',
        app_source:     'sandbox',
        request_origin: 'api',
        // sandbox is in ENFORCEMENT_BYPASS_SOURCES, so school_id can be
        // omitted without tripping the school_id_not_null CHECK. Probes
        // 1 + 2 never reach the insert path anyway (they bounce at auth).
        metadata: { surface: 'harness', feature: 'ai_proxy_probe' },
    })

    const r1 = await probe('1) NO auth header (expect 401 DENIED + log auth_missing)', {
        authorization: null,
        body:          minimalBody,
    })

    const r2 = await probe('2) BOGUS auth header (expect 401 DENIED + log auth_invalid)', {
        authorization: 'Bearer bogus.jwt.token',
        body:          minimalBody,
    })

    let r3 = null
    const auth = await authenticate()
    if (auth?.token) {
        header(`AUTH OK via ${auth.source}${auth.email ? ` (${auth.email})` : ''}`)
        kv('user_id', auth.user_id ?? '(unknown)')
        r3 = await probe('3) AUTHENTICATED (expect 200 SUCCESS + log insert_success)', {
            authorization: `Bearer ${auth.token}`,
            body:          minimalBody,
        })
    } else {
        header('PROBE 3 SKIPPED — set HARNESS_USER_EMAIL+HARNESS_USER_PASSWORD or HARNESS_ACCESS_TOKEN to run')
    }

    line()
    console.log('Summary')
    line()
    kv('probe 1', `${r1.status} ${r1.parsed?.code ?? ''}`)
    kv('probe 2', `${r2.status} ${r2.parsed?.code ?? ''}`)
    if (r3) kv('probe 3', `${r3.status} ${r3.parsed?.code ?? r3.parsed?.ok ? 'OK' : ''}`)
    line()
    console.log('Next: check edge-function logs (look for [AI_PROXY] entries):')
    console.log("  supabase functions logs ai-proxy --tail")
    console.log("  OR  via MCP: mcp__claude_ai_Supabase__get_logs(service: 'edge-function')")
    line()
}

main().catch((err) => {
    console.error('[harness] unexpected:', err.stack || err.message)
    process.exit(1)
})
