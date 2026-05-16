// ═══════════════════════════════════════════════════════════════════════════════
// SAIL AI Service — Frontend client for the AI proxy
// ─────────────────────────────────────────────────────────────────────────────
// All AI calls go through /.netlify/functions/ai-proxy.
// No API keys exist in frontend code.
//
// Auth (2026-05-16): the proxy now verifies the inbound Supabase JWT
// before any OpenAI call. Every request from this client MUST carry
// `Authorization: Bearer <access_token>` from the current session.
// `callAI()` reads the session from supabase-js and fails early when
// none exists — never falls back to an unauthenticated call.
//
// Future: add request deduplication, client-side rate limiting, retry logic.
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

const AI_PROXY_URL = '/.netlify/functions/ai-proxy'

/**
 * Call the SAIL AI proxy.
 *
 * @param {object} opts
 * @param {string} opts.system     - System prompt
 * @param {string} opts.prompt     - User prompt
 * @param {number} [opts.maxTokens=600] - Max tokens
 * @param {string} [opts.feature='unknown'] - Feature name for logging (e.g. 'grading', 'feedback')
 * @param {string} [opts.userId]         - Current user ID
 * @param {string} [opts.schoolId]       - Current school ID
 * @param {string} [opts.role]           - Current user role
 * @param {string} [opts.deploymentMode] - Deployment mode (e.g. 'production', 'pilot')
 * @returns {Promise<object>}            - Parsed JSON result from the AI
 */
export async function callAI({
    system,
    prompt,
    maxTokens = 600,
    feature = 'unknown',
    userId = null,
    schoolId = null,
    role = null,
    deploymentMode = null,
}) {
    // Fail closed when there's no session. We deliberately do NOT fall
    // back to an unauthenticated call — that would reintroduce the
    // exact vulnerability the proxy's JWT gate exists to prevent.
    const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
    if (sessionErr) {
        throw new Error(`AI proxy auth error: could not read session — ${sessionErr.message}`)
    }
    const token = sessionData?.session?.access_token
    if (!token) {
        throw new Error('AI proxy auth error: no active session. Sign in before calling AI features.')
    }

    let response
    try {
        response = await fetch(AI_PROXY_URL, {
            method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Authorization':  `Bearer ${token}`,
            },
            body: JSON.stringify({
                system,
                prompt,
                maxTokens,
                feature,
                userId,
                schoolId,
                role,
                deploymentMode,
            }),
        })
    } catch (networkErr) {
        throw new Error(`AI proxy network error: ${networkErr.message}`)
    }

    const rawText = await response.text()
    let data = null
    try { data = rawText ? JSON.parse(rawText) : null } catch { /* non-JSON body */ }

    if (!response.ok) {
        const detail = data?.error || (rawText ? rawText.slice(0, 200) : '')
        throw new Error(`AI proxy HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }

    if (!data?.result) {
        throw new Error('AI proxy returned an empty result')
    }

    return data.result
}
