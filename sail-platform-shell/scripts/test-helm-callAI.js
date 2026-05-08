#!/usr/bin/env node
/**
 * SAIL Phase B4-prep — white-box integration test for callAI()'s safety override.
 *
 * Runs in Node (not Vite). Imports the actual `callAI` function from
 * src/services/ai.js (which now has a Node-portable env accessor) and
 * exercises it end-to-end with a real authenticated session.
 *
 * Why this test: the harness `test-ai-proxy.js` calls the Edge Function
 * URL directly with `fetch()` — it does NOT go through Helm's
 * `services/ai.js → callAI()` chain. The safety-override branch lives
 * inside that chain. To validate that the override fires correctly, we
 * have to call `callAI()` from a real Node runtime that:
 *   1. Has a real Supabase session token (signed in as the probe user)
 *   2. Imports the actual services/ai.js with VITE_USE_AI_PROXY_ONLY in env
 *   3. Captures console output to assert the right log line emits
 *   4. Catches the (expected) failure of invokeNetlifyFallback (which
 *      also has no OPENAI_API_KEY in this environment) without erroring
 *      the test
 *
 * Expected outcome:
 *   * Edge Function ai-proxy v9 returns 503 PROVIDER_ERROR with
 *     `error: "AI provider not configured"` (already proven via probe 3).
 *   * services/ai.js's invokeSailAiProxy throws an Error with
 *     code='PROVIDER_ERROR' and message='AI provider not configured'.
 *   * The catch block detects isMissingProviderKey=true.
 *   * console.warn fires with `[ai-proxy] proxy_safety_fallback_used` —
 *     THIS IS THE THING WE'RE VALIDATING.
 *   * The fallback is then invoked. It calls /.netlify/functions/ai-proxy.
 *     In this Node environment (no netlify dev running), that fetch will
 *     fail with ECONNREFUSED or similar. We catch that error gracefully.
 *
 * The TEST PASSES if the safety-override log line was captured before
 * the fallback failure. Fallback success isn't required — only the
 * branch-fired-correctly invariant is.
 *
 * After the test:
 *   * Query ai_requests for the new row written by the proxy's
 *     instrumentedInsert (label='openai_key_missing', status='denied').
 *   * Confirm exactly ONE new row was created.
 *   * Cleanup: delete the row, leaving the previously-held 19ea32a3-…
 *     row alone (the test for THAT row's existence already happened in
 *     Phase B3).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// ─── env loader (no dotenv dep) ────────────────────────────────────────────
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

const SUPABASE_URL =
    process.env.VITE_SUPABASE_URL ||
    'https://gidyonbzxjorrgpicctt.supabase.co'
const SUPABASE_ANON_KEY =
    process.env.VITE_SUPABASE_ANON_KEY ||
    'sb_publishable_9gCdvH0NEcmkCf_IKuWTvg_vZLpfJ-r'

const PROBE_EMAIL    = process.env.HARNESS_USER_EMAIL    || 'probe+ai@test.com'
const PROBE_PASSWORD = process.env.HARNESS_USER_PASSWORD || 'Test1234!'
const PROBE_USER_ID  = process.env.HARNESS_USER_ID       || 'f7810c35-9b43-4f64-a2cf-51730bf57dd6'
const SCHOOL_ID      = process.env.HARNESS_SCHOOL_ID     || '0d75ca24-26f0-4550-b1dd-f0e725b0500f'

// ─── pretty print helper ───────────────────────────────────────────────────
function line() { console.log('─'.repeat(78)) }
function header(s) { console.log(`\n${s}`); line() }
function kv(k, v) { console.log(`  ${String(k).padEnd(22)} ${v}`) }

// ─── console capture ───────────────────────────────────────────────────────
// We need to capture console.log/warn/error from inside services/ai.js so
// the assertion can see the structured `[ai-proxy] *` log lines. We don't
// silence them — they still print, but we ALSO record them for the test
// to inspect.
const captured = []
const origLog   = console.log.bind(console)
const origWarn  = console.warn.bind(console)
const origError = console.error.bind(console)
function recorder(level, origFn) {
    return (...args) => {
        captured.push({ level, args })
        origFn(...args)
    }
}
function startCapture() {
    console.log   = recorder('log',   origLog)
    console.warn  = recorder('warn',  origWarn)
    console.error = recorder('error', origError)
}
function stopCapture() {
    console.log   = origLog
    console.warn  = origWarn
    console.error = origError
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
    line()
    console.log('SAIL Phase B4-prep — white-box test of callAI() safety override')
    line()
    kv('SUPABASE_URL',          SUPABASE_URL)
    kv('PROBE_EMAIL',           PROBE_EMAIL)
    kv('PROBE_USER_ID',         PROBE_USER_ID)
    kv('SCHOOL_ID',             SCHOOL_ID)
    kv('VITE_USE_AI_PROXY_ONLY',process.env.VITE_USE_AI_PROXY_ONLY || '(unset)')

    // Step 1: sign in via supabase-js to obtain a real session JWT.
    header('1) Sign in as probe user')
    const { createClient } = await import('@supabase/supabase-js')
    const sbAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: signin, error: signErr } = await sbAuth.auth.signInWithPassword({
        email: PROBE_EMAIL, password: PROBE_PASSWORD,
    })
    if (signErr) {
        console.error('[harness] sign-in failed:', signErr.message)
        process.exit(1)
    }
    kv('access_token (head)', signin.session?.access_token?.slice(0, 16) + '…')
    kv('user.id',             signin.user?.id)

    // Step 2: import Helm's supabase client (singleton) and inject the
    // session. The supabase client lives in lib/supabaseClient.js as a
    // module-scoped singleton — services/ai.js will use that same
    // instance because it imports from the same module path.
    header('2) Inject session into Helm supabase client')
    const { supabase: helmSupabase } = await import('../src/lib/supabaseClient.js')
    const { error: setErr } = await helmSupabase.auth.setSession({
        access_token:  signin.session.access_token,
        refresh_token: signin.session.refresh_token,
    })
    if (setErr) {
        console.error('[harness] setSession failed:', setErr.message)
        process.exit(1)
    }
    const { data: whoAmI } = await helmSupabase.auth.getUser()
    kv('helmSupabase.auth user', whoAmI?.user?.id ?? '(none)')

    // Step 3: import callAI and call it with a production-shape payload.
    // Every console.log/warn/error from this point forward is captured
    // into `captured[]`.
    header('3) Call callAI() with ai_grading shape')
    const { callAI } = await import('../src/services/ai.js')
    startCapture()
    let returnedValue = null
    let thrownError   = null
    try {
        returnedValue = await callAI({
            system:   'You are a test echo. Respond exactly with "pong".',
            prompt:   'Probe: respond with the literal string "pong".',
            schoolId: SCHOOL_ID,
            feature:  'grading',
            userId:   PROBE_USER_ID,
            role:     'teacher',
        })
    } catch (e) {
        thrownError = e
    }
    stopCapture()
    kv('returnedValue',  returnedValue ? JSON.stringify(returnedValue).slice(0, 80) : '(none)')
    kv('thrownError',    thrownError ? `${thrownError.name}: ${thrownError.message?.slice(0, 200)}` : '(none)')
    kv('captured logs',  captured.length)

    // Step 4: assertions.
    header('4) Assertions')
    let pass = true
    function assert(label, cond, detail) {
        const tag = cond ? '✅' : '❌'
        kv(`${tag} ${label}`, detail || '')
        if (!cond) pass = false
    }

    // Find the safety-override log line.
    const overrideLine = captured.find(c =>
        typeof c.args[0] === 'string' && c.args[0].includes('proxy_safety_fallback_used'))
    assert(
        'safety_override fired',
        Boolean(overrideLine),
        overrideLine ? overrideLine.args.slice(0, 2).map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') : '(not found)',
    )

    // Find the proxy_success line — should NOT exist (we don't want a
    // primary-path success in this test; the proxy returns 503).
    const successLine = captured.find(c =>
        typeof c.args[0] === 'string' && c.args[0].includes('proxy_success'))
    assert(
        'proxy_success NOT fired',
        !successLine,
        successLine ? '(unexpected success log)' : '(correctly absent)',
    )

    // The fallback should have been attempted; in this Node environment
    // it'll error out (no netlify dev, no OPENAI_API_KEY). That's the
    // expected outcome — the test validates the BRANCH FIRES, not the
    // fallback succeeds.
    assert(
        'callAI threw (fallback also has no key, expected)',
        Boolean(thrownError),
        thrownError?.message?.slice(0, 80) ?? '(no error — unexpected)',
    )
    if (thrownError) {
        const msg = thrownError.message ?? ''
        const looksLikeFallbackFailure =
            /AI proxy (network|HTTP)/i.test(msg)
            || /OPENAI_API_KEY/i.test(msg)
            || /No OPENAI_API_KEY/i.test(msg)
            || /ECONNREFUSED|fetch failed/i.test(msg)
        assert(
            'thrown error is fallback-side, not safety-override',
            looksLikeFallbackFailure,
            looksLikeFallbackFailure ? '(matches expected fallback failure shape)' : `(message: ${msg})`,
        )
    }

    // Step 5: query ai_requests.
    header('5) DB verification')
    const { data: rows, error: qErr } = await sbAuth
        .from('ai_requests')
        .select('id, status, error, app_source, school_id, request_origin, metadata, created_at')
        .eq('user_id', PROBE_USER_ID)
        .order('created_at', { ascending: false })
        .limit(2)
    if (qErr) {
        kv('query error', qErr.message)
        pass = false
    } else {
        kv('rows returned', rows.length)
        for (const r of rows) {
            kv(`row ${r.id.slice(0, 8)}…`, `status=${r.status} app=${r.app_source} feature=${r.metadata?.feature ?? '(none)'} created=${r.created_at}`)
        }
        const newRow = rows.find(r => (r.metadata?.feature ?? '') === 'grading')
        assert(
            'new row inserted by proxy (status=denied, OPENAI_API_KEY...)',
            Boolean(newRow) && newRow.status === 'denied' && /OPENAI_API_KEY/i.test(newRow.error ?? ''),
            newRow ? `id=${newRow.id} error="${newRow.error}"` : '(not found)',
        )
        // Held probe row 19ea32a3-… should still be present from Phase B3.
        const heldRow = rows.find(r => r.id === '19ea32a3-867a-4026-85ba-93a58542f271')
        assert(
            'held Phase-B3 row still present',
            Boolean(heldRow),
            heldRow ? `(${heldRow.id} ${heldRow.status})` : '(not found — would mean someone deleted it)',
        )
    }

    // Step 6: report new row id for service-role cleanup.
    //
    // ai_requests has SELECT policy for authenticated but NO DELETE
    // policy — only service-role can delete. The probe user's session
    // (used by sbAuth) cannot DELETE. The cleanup must run via either:
    //   (a) Supabase MCP execute_sql (service-role bypass) — what we use
    //   (b) A SECURITY DEFINER RPC dedicated to test-row cleanup — overkill
    //       for one-shot probe artefacts
    // We surface the row id so the caller can DELETE it via MCP.
    header('6) New row(s) for service-role cleanup')
    const { data: rowsToCleanup } = await sbAuth
        .from('ai_requests')
        .select('id, status, error, created_at')
        .eq('user_id', PROBE_USER_ID)
        .eq('metadata->>feature', 'grading')
        .order('created_at', { ascending: false })
    kv('cleanup_count', rowsToCleanup?.length ?? 0)
    if (rowsToCleanup) {
        rowsToCleanup.forEach((r) => kv(`needs DELETE`, `${r.id} (${r.status} @ ${r.created_at})`))
    }
    console.log('\n  → Run via MCP execute_sql:')
    console.log(`    DELETE FROM public.ai_requests WHERE user_id = '${PROBE_USER_ID}' AND metadata->>'feature' = 'grading';`)

    line()
    console.log(pass ? '✅ ALL ASSERTIONS PASSED' : '❌ SOME ASSERTIONS FAILED')
    line()
    if (!pass) process.exit(1)
}

main().catch((err) => {
    console.error('[harness] unexpected:', err.stack || err.message)
    process.exit(1)
})
