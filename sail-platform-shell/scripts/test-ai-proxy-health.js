#!/usr/bin/env node
/**
 * SAIL ai-proxy v11 (Phase B11-lite) preflight health probe harness.
 *
 * Hits POST /functions/v1/ai-proxy with body `{ mode: "health" }` after
 * signing in as the probe user. The function should:
 *   * pass JWT verification (gateway + auth.getUser)
 *   * detect the health branch BEFORE any side-effect path
 *   * return 200 with shape:
 *       { ok: true, mode: "health", provider: "openai",
 *         provider_configured: <bool>, timestamp: <iso> }
 *
 * Usage (defaults to the existing probe user):
 *   node scripts/test-ai-proxy-health.js
 *
 *   # Override:
 *   HARNESS_USER_EMAIL=... HARNESS_USER_PASSWORD=... \
 *     node scripts/test-ai-proxy-health.js
 *
 *   # body shape:           default {mode:'health'}
 *   #   HEALTH_BODY_FORM=mode_field        → {mode:'health'}
 *   #   HEALTH_BODY_FORM=health_bool       → {health: true}
 *
 * Verification matrix (negative case — OPENAI_API_KEY NOT set):
 *   ✓ HTTP 200
 *   ✓ ok === true
 *   ✓ mode === 'health'
 *   ✓ provider === 'openai'
 *   ✓ provider_configured === false
 *   ✓ timestamp parses as ISO
 *   ✓ no ai_requests row created (verify via SQL afterwards)
 *
 * Negative case is the only one runnable from this bridge session — the
 * Edge Function does not have OPENAI_API_KEY set yet. Once the operator
 * sets it, re-run with HEALTH_BODY_FORM=health_bool to also exercise the
 * second activation path; provider_configured must flip to true.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
    || 'https://gidyonbzxjorrgpicctt.supabase.co'
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
    || 'sb_publishable_9gCdvH0NEcmkCf_IKuWTvg_vZLpfJ-r'
const PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`

const PROBE_EMAIL    = process.env.HARNESS_USER_EMAIL    || 'probe+ai@test.com'
const PROBE_PASSWORD = process.env.HARNESS_USER_PASSWORD || 'Test1234!'
const BODY_FORM      = process.env.HEALTH_BODY_FORM      || 'mode_field'

function line() { console.log('─'.repeat(78)) }
function header(s) { console.log(`\n${s}`); line() }
function kv(k, v) { console.log(`  ${k.padEnd(22)} ${v}`) }

async function main() {
    line()
    console.log('SAIL ai-proxy v11 preflight (B11-lite) health probe')
    line()
    kv('PROXY_URL',  PROXY_URL)
    kv('email',      PROBE_EMAIL)
    kv('body form',  BODY_FORM)

    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: signIn, error: signInErr } = await sb.auth.signInWithPassword({
        email: PROBE_EMAIL, password: PROBE_PASSWORD,
    })
    if (signInErr || !signIn?.session?.access_token) {
        console.error('[harness] sign-in failed:', signInErr?.message ?? '(no token)')
        process.exit(1)
    }
    const token  = signIn.session.access_token
    const userId = signIn.user?.id
    kv('user_id',    userId ?? '(unknown)')

    let body
    if (BODY_FORM === 'health_bool') {
        body = JSON.stringify({ health: true })
    } else {
        body = JSON.stringify({ mode: 'health' })
    }

    header(`PROBE: POST {${BODY_FORM === 'health_bool' ? 'health:true' : 'mode:"health"'}}`)
    const t0 = Date.now()
    let res
    try {
        res = await fetch(PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${token}`,
                apikey:          SUPABASE_ANON_KEY,
            },
            body,
        })
    } catch (err) {
        console.error('[harness] network error:', err.message)
        process.exit(1)
    }
    const tookMs = Date.now() - t0
    const text   = await res.text()
    let parsed   = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* */ }

    kv('http status',          res.status)
    kv('took (ms)',             tookMs)
    if (parsed) {
        kv('ok',                  String(parsed.ok))
        kv('mode',                parsed.mode ?? '(missing)')
        kv('provider',            parsed.provider ?? '(missing)')
        kv('provider_configured', String(parsed.provider_configured))
        kv('timestamp',           parsed.timestamp ?? '(missing)')
    } else {
        kv('raw response',        text.slice(0, 200))
    }

    // ── invariant assertions ───────────────────────────────────────
    const fails = []
    if (res.status !== 200)                                fails.push(`http != 200 (got ${res.status})`)
    if (!parsed)                                           fails.push('response not JSON')
    if (parsed && parsed.ok !== true)                      fails.push(`ok != true (got ${parsed.ok})`)
    if (parsed && parsed.mode !== 'health')                fails.push(`mode != 'health' (got ${parsed.mode})`)
    if (parsed && parsed.provider !== 'openai')            fails.push(`provider != 'openai' (got ${parsed.provider})`)
    if (parsed && typeof parsed.provider_configured !== 'boolean') {
        fails.push(`provider_configured is not boolean (got ${typeof parsed.provider_configured})`)
    }
    if (parsed && typeof parsed.timestamp !== 'string')    fails.push('timestamp not string')
    if (parsed?.timestamp) {
        const t = Date.parse(parsed.timestamp)
        if (Number.isNaN(t))                               fails.push(`timestamp not parseable ISO (${parsed.timestamp})`)
    }

    line()
    if (fails.length === 0) {
        console.log('PASS — all invariants hold')
        line()
        console.log(`Verdict: provider_configured = ${parsed.provider_configured}`)
        if (parsed.provider_configured === false) {
            console.log('Negative case confirmed: OPENAI_API_KEY is NOT set on the Edge Function.')
        } else {
            console.log('Positive case confirmed: OPENAI_API_KEY IS set on the Edge Function.')
        }
        process.exit(0)
    } else {
        console.log('FAIL — invariant violations:')
        for (const f of fails) console.log(`  · ${f}`)
        process.exit(1)
    }
}

main().catch((err) => {
    console.error('[harness] unexpected:', err.stack || err.message)
    process.exit(1)
})
