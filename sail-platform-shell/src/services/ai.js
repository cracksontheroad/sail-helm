// ═══════════════════════════════════════════════════════════════════════════════
// SAIL AI Service — Frontend client for AI calls
// ─────────────────────────────────────────────────────────────────────────────
// Phase B4 (Stage 2 Helm stabilisation, 2026-05-08) — proxy-only.
//
// SINGLE PATH. Every AI call routes through the SAIL Core ai-proxy v9
// Edge Function. There is no fallback. There is no escape hatch. There
// is no flag.
//
//   * verify_jwt: true  — Helm session must be live
//   * has_consent('ai_processing') gate (Phase 0.4 grandfathered users)
//   * is_app_enabled gate (Phase 0.6 Slice 7+9; Phase B1 enabled all 7 schools)
//   * Logs every call to ai_requests (success, denied, provider_error,
//     rate_limited)
//   * Logs APP_NOT_ENABLED blocks to school_app_events
//
// Outcome — exactly ONE structured log line per call:
//
//   [ai-proxy] proxy_success
//     { school_id, feature }
//   [ai-proxy] provider_not_configured
//     { school_id, code, request_id, action }
//     ↑ specifically when OPENAI_API_KEY isn't set on the Edge Function.
//       Loud + ops-actionable: set the secret in Supabase dashboard.
//   [ai-proxy] proxy_error
//     { school_id, code, reason, request_id }
//     ↑ catch-all for every other failure (CONSENT_REQUIRED,
//       APP_NOT_ENABLED, PROVIDER_ERROR for non-key-missing, RATE_LIMITED,
//       INVOKE_ERROR, PARSE_ERROR, UNEXPECTED_PAYLOAD, DENIED,
//       VALIDATION_ERROR).
//
// All errors are normalised through `normalizeAIError` before being
// thrown to the caller, giving stable teacher-readable messages with
// `.type` / `.originalCode` for ops correlation.
//
// Response shape contract: `callAI(...)` returns the parsed JSON object
// from the AI's response. The grading prompt instructs the model to
// return JSON; the proxy hands back `data.response` as raw text; we
// JSON.parse it here.
//
// History note (deleted in this commit):
//   * VITE_USE_AI_PROXY_ONLY / VITE_STRICT_AI_PROXY env flags
//   * invokeNetlifyFallback() function
//   * Safety override + scoped-fallback branches
//   * netlify/functions/ai-proxy.js (Netlify Function file)
// All gone. Single-path enforced. See B4 commit message + sail_memory.
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient.js'

/**
 * Map a raw error from invokeSailAiProxy into a teacher-safe Error.
 *
 * Returned Error has:
 *   message       — short, teacher-readable text
 *   type          — stable code for UI / telemetry switches
 *   originalCode  — the proxy's code (for ops correlation with
 *                    school_app_events / ai_requests)
 *   cause         — original error (for debug breadcrumbs)
 */
function normalizeAIError(err) {
    let normalized
    if (err?.code === 'APP_NOT_ENABLED') {
        normalized = {
            type:    'AI_NOT_ENABLED',
            message: 'AI grading is not enabled for this school yet.',
        }
    } else if (err?.code === 'CONSENT_REQUIRED') {
        normalized = {
            type:    'AI_CONSENT_REQUIRED',
            message: 'AI processing consent is required to use this feature.',
        }
    } else if (err?.code === 'RATE_LIMITED') {
        normalized = {
            type:    'AI_RATE_LIMITED',
            message: 'Too many AI requests in a short window. Please try again shortly.',
        }
    } else if (err?.code === 'PROVIDER_ERROR') {
        normalized = {
            type:    'AI_PROVIDER_ERROR',
            message: 'AI grading is temporarily unavailable. Please try again.',
        }
    } else {
        normalized = {
            type:    'AI_UNKNOWN_ERROR',
            message: 'Something went wrong while generating the grade.',
        }
    }
    const e = new Error(normalized.message)
    e.type         = normalized.type
    e.originalCode = err?.code ?? null
    e.cause        = err
    return e
}

/**
 * Call the SAIL AI service.
 *
 * @param {object} opts
 * @param {string} opts.system       - System prompt
 * @param {string} opts.prompt       - User prompt
 * @param {string} [opts.schoolId]   - REQUIRED for non-sandbox app_source
 *                                     (the Edge Function's
 *                                     ai_requests_school_id_not_null
 *                                     CHECK rejects NULL school_id when
 *                                     app_source !== 'sandbox')
 * @param {string} [opts.feature='unknown'] - Surface tag for ai_requests metadata
 *
 * Backward-compat parameters (still accepted, currently unused — kept so
 * existing call sites in pages/Assignments.jsx don't need a touch):
 * @param {number} [opts.maxTokens]      — was used by deleted Netlify fallback
 * @param {string} [opts.userId]         — surfaced by the proxy from auth.uid
 * @param {string} [opts.role]           — was used by deleted Netlify fallback
 * @param {string} [opts.deploymentMode] — was used by deleted Netlify fallback
 *
 * @returns {Promise<object>} - Parsed JSON object from the AI
 * @throws {Error} - normalised teacher-safe error with .type, .originalCode, .cause
 */
export async function callAI({
    system,
    prompt,
    schoolId = null,
    feature  = 'unknown',
    // Back-compat (unused post-B4)
    /* eslint-disable no-unused-vars */
    maxTokens = null,
    userId    = null,
    role      = null,
    deploymentMode = null,
    /* eslint-enable no-unused-vars */
}) {
    try {
        const result = await invokeSailAiProxy({ system, prompt, schoolId, feature })
        console.log('[ai-proxy] proxy_success', {
            school_id: schoolId,
            feature,
        })
        return result
    } catch (sailErr) {
        const code    = sailErr?.code ?? null
        const message = sailErr?.message ?? ''
        const reqId   = sailErr.proxyData?.request_id ?? null

        // Specific log for the actionable missing-key case. The proxy returns
        //   code: 'PROVIDER_ERROR'
        //   error: 'AI provider not configured'   (HTTP body — what we see)
        //   ai_requests.error: 'OPENAI_API_KEY not configured' (DB-only)
        // Match either string for robustness against future Edge Function
        // message alignment.
        const isMissingProviderKey =
            code === 'PROVIDER_ERROR'
            && (
                /OPENAI_API_KEY not configured/i.test(message)
                || /AI provider not configured/i.test(message)
            )

        if (isMissingProviderKey) {
            console.error('[ai-proxy] provider_not_configured', {
                school_id:  schoolId,
                code,
                request_id: reqId,
                action:     'Set OPENAI_API_KEY on Supabase Edge Function (Dashboard → Edge Functions → ai-proxy → Settings → Secrets)',
            })
            const e = new Error('AI provider not configured (OPENAI_API_KEY missing on Edge Function)')
            e.type         = 'AI_PROVIDER_NOT_CONFIGURED'
            e.originalCode = code
            e.cause        = sailErr
            throw e
        }

        console.error('[ai-proxy] proxy_error', {
            school_id:  schoolId,
            code,
            reason:     message,
            request_id: reqId,
        })
        throw normalizeAIError(sailErr)
    }
}

// ─── Internal: SAIL Core ai-proxy v9 ────────────────────────────────────────
// Throws Error-with-code on every non-success path. Possible codes:
//   APP_NOT_ENABLED  - 3c gate: school doesn't have ai_grading enabled
//   CONSENT_REQUIRED - 3b gate: user hasn't granted ai_processing consent
//   RATE_LIMITED     - per-user throttle hit
//   PROVIDER_ERROR   - missing OPENAI_API_KEY on Edge Function, OR OpenAI
//                       upstream failure (status / network / non-200)
//   DENIED           - 1: auth / consent infra error
//   VALIDATION_ERROR - 2: body shape rejected by proxy
//   INVOKE_ERROR     - supabase.functions.invoke surfaced an error AND
//                       no structured proxy body could be recovered from
//                       error.context (the error wasn't a proxy-side
//                       failure; usually network / runtime layer)
//   UNEXPECTED_PAYLOAD - data.ok=true but no usable response field
//   PARSE_ERROR      - data.response wasn't valid JSON
async function invokeSailAiProxy({ system, prompt, schoolId, feature }) {
    const { data, error } = await supabase.functions.invoke('ai-proxy', {
        body: {
            prompt,
            system,
            app_source:     'ai_grading',
            request_origin: 'helm_ui',
            school_id:      schoolId,
            metadata: {
                surface: 'helm.assignments',
                feature,
                // Surface school_id in metadata (in addition to top-level)
                // so per-school analytics on ai_requests can JOIN cleanly.
                school_id: schoolId,
            },
        },
    })

    if (error) {
        // supabase-js v2.x raises a generic FunctionsHttpError on any
        // non-2xx response and discards the body. FunctionsHttpError
        // exposes the original Response via `error.context`. We re-read
        // the body, and if it carries a structured `{code, error}` payload,
        // throw with that code so callAI can branch correctly. Only when
        // no structured body is recoverable do we fall back to INVOKE_ERROR.
        let proxyBody = null
        try {
            if (error.context && typeof error.context.json === 'function') {
                proxyBody = await error.context.json()
            } else if (error.context && typeof error.context.text === 'function') {
                const text = await error.context.text()
                try { proxyBody = JSON.parse(text) } catch { /* not json */ }
            }
        } catch { /* unreadable body — fall through to INVOKE_ERROR */ }

        if (proxyBody && (proxyBody.code || proxyBody.error)) {
            const e = new Error(proxyBody.error || `ai-proxy ${proxyBody.code || 'error'}`)
            e.code      = proxyBody.code || 'DENIED'
            e.proxyData = proxyBody
            e.cause     = error
            throw e
        }

        const e = new Error(`ai-proxy invoke error: ${error.message || 'unknown'}`)
        e.code  = 'INVOKE_ERROR'
        e.cause = error
        throw e
    }
    if (data && data.ok === false) {
        const e = new Error(data.error || 'ai-proxy denied the request')
        e.code      = data.code || 'DENIED'
        e.proxyData = data
        throw e
    }
    if (!data || typeof data.response !== 'string' || data.response.length === 0) {
        const e = new Error('ai-proxy returned an unexpected payload (missing response field)')
        e.code      = 'UNEXPECTED_PAYLOAD'
        e.proxyData = data
        throw e
    }

    // Helm callers expect parsed JSON. The grading prompt instructs the
    // AI to return JSON; ai-proxy returns the raw text; we parse here.
    try {
        return JSON.parse(data.response)
    } catch (parseErr) {
        const e = new Error(`ai-proxy response not parseable as JSON: ${parseErr.message}`)
        e.code  = 'PARSE_ERROR'
        e.cause = parseErr
        throw e
    }
}
