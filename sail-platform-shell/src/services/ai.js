// ═══════════════════════════════════════════════════════════════════════════════
// SAIL AI Service — Frontend client for AI calls
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 Slice 11 — fallback is now SCOPED to APP_NOT_ENABLED only.
//
// Slice 10 introduced ai-proxy v4 as the primary path with a blanket
// Netlify fallback on any non-success — that masked real bugs. Slice 11
// tightens: invokeSailAiProxy throws structured errors with err.code;
// callAI ONLY falls back when err.code === 'APP_NOT_ENABLED'. Every
// other failure mode (CONSENT_REQUIRED, DENIED, PROVIDER_ERROR, network
// faults, malformed payloads, JSON-parse failures) propagates to the
// caller — they're real bugs that should surface, not be silently
// papered over with a different backend.
//
// Behavioral matrix:
//   Greenfield (enabled)        → ai-proxy ONLY. No Netlify call.
//   Other schools (disabled)    → ai-proxy 403 APP_NOT_ENABLED → Netlify fallback.
//   Proxy network/infra error   → throws upstream. NO fallback.
//   Proxy returns malformed     → throws upstream. NO fallback.
//   Consent missing             → throws upstream. NO fallback. (All 6
//                                  current users are grandfathered, so
//                                  this should not fire today; future
//                                  new-user onboarding needs a consent
//                                  flow before this slice can apply to
//                                  them.)
//
// Primary path: supabase.functions.invoke('ai-proxy', { body: ... })
//   * verify_jwt: true at the runtime — Helm session must be live
//   * has_consent('ai_processing') gate — Phase 0.4 grandfathered users
//   * is_app_enabled gate — Phase 0.6 Slice 7+9. ai_grading is enabled
//     for Greenfield International School via the Slice 10 seed.
//   * Logs to ai_requests on success/provider-error
//   * Logs to school_app_events on APP_NOT_ENABLED block
//
// Fallback path: legacy Netlify /.netlify/functions/ai-proxy
//   * Triggered ONLY by APP_NOT_ENABLED. Will be removed once Bridge
//     admin UI seeds ai_grading for all needed schools.
//
// Response shape contract (preserved from the Netlify-only era so callers
// like Assignments.jsx don't need changes): the function returns the
// PARSED JSON object from the AI's response. ai-proxy v4 returns the AI
// response as a raw text string (data.response); we JSON.parse it here
// to maintain the contract.
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabaseClient'

const NETLIFY_AI_PROXY_URL = '/.netlify/functions/ai-proxy'

// ─────────────────────────────────────────────────────────────────────────────
// Phase B4-prep (Stage 2 Helm stabilisation, 2026-05-07) — feature-flagged
// proxy-only mode + OPENAI_API_KEY safety override + structured outcome logs.
//
// Single canonical flag: `VITE_USE_AI_PROXY_ONLY` (the flag-rename evolves
// the Phase B2 `VITE_STRICT_AI_PROXY` flag with a clearer name and an
// added safety override). The old name is still honored as a deprecated
// alias for one cycle so a stale .env doesn't fail open.
//
// USE_AI_PROXY_ONLY=false (DEFAULT — current production posture):
//   * Primary call to SAIL Core ai-proxy v9.
//   * On APP_NOT_ENABLED 403 → fall back to legacy Netlify function.
//   * Other proxy errors (CONSENT_REQUIRED, PROVIDER_ERROR, INVOKE_ERROR,
//     PARSE_ERROR, UNEXPECTED_PAYLOAD, DENIED) propagate raw to the
//     caller (Slice-11 scoped-fallback behaviour, preserved verbatim).
//
// USE_AI_PROXY_ONLY=true (the cutover state — flip after the OPENAI_API_KEY
// secret is set on the Edge Function and the live success-path probe lands):
//   * Primary call to SAIL Core ai-proxy v9.
//   * NO fallback. APP_NOT_ENABLED throws an explicit teacher-readable
//     error. Other errors run through normalizeAIError for a stable
//     UX shape.
//   * EXCEPTION (the safety override): if the proxy returns
//     PROVIDER_ERROR with the literal "OPENAI_API_KEY not configured"
//     message, the fallback fires regardless of flag value. This
//     prevents accidental outage during the brief window between
//     flipping the flag and setting the secret. The override is
//     removed in B4 itself when the Netlify function is deleted.
//
// Outcome logs (one line per call, structured, greppable):
//   [ai-proxy] proxy_success         { school_id, model, request_id, latency_ms }
//   [ai-proxy] proxy_error_fallback_used    { school_id, code, reason, will_fallback:true }
//   [ai-proxy] proxy_safety_fallback_used   { school_id, code, reason:'openai_key_missing' }
//   [ai-proxy] proxy_error_no_fallback      { school_id, code, reason, proxy_only:true }
//
// ⚠️  ACTIVATION (no source code edit):
//      Set in deploy env (or .env.local):
//        VITE_USE_AI_PROXY_ONLY=true
//      Then:
//        cd sail-helm-core-v6-lite/sail-platform-shell && npm run build
//      and deploy.
//
// Vite inlines `import.meta.env.VITE_*` at build time, so a rebuild is
// required after flipping. The flag-true bundle is *smaller* than the
// flag-false bundle because Vite tree-shakes the unreachable
// `invokeNetlifyFallback` branches once the constant folds.
//
// Default-deny on missing env: `import.meta.env.VITE_USE_AI_PROXY_ONLY`
// resolves to `undefined` when unset; `undefined === 'true'` is false.
// The literal string 'true' is the only enable value.
// ─────────────────────────────────────────────────────────────────────────────
const USE_AI_PROXY_ONLY    = import.meta.env.VITE_USE_AI_PROXY_ONLY === 'true'
const _LEGACY_STRICT_FLAG  = import.meta.env.VITE_STRICT_AI_PROXY === 'true'  // Phase B2 alias
const PROXY_ONLY           = USE_AI_PROXY_ONLY || _LEGACY_STRICT_FLAG
// Kept as `STRICT_AI_PROXY` for back-compat with any internal log strings
// or downstream readers; semantically identical to PROXY_ONLY.
const STRICT_AI_PROXY      = PROXY_ONLY

/**
 * Map a raw error from invokeSailAiProxy into a teacher-safe Error.
 * Used only when STRICT_AI_PROXY is true; raw errors throw when false.
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
    // Throw an Error instance (preserves stack + supports `instanceof Error`)
    // rather than a plain object — callers like Assignments.gradeStudent
    // do `aiErr.message`, which works either way; the Error wrapper is
    // strictly safer for any future `instanceof` / cause-chain consumers.
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
 * @param {string} opts.system     - System prompt
 * @param {string} opts.prompt     - User prompt
 * @param {number} [opts.maxTokens=600] - Max tokens (Netlify-only honored)
 * @param {string} [opts.feature='unknown'] - Feature name for logging
 * @param {string} [opts.userId]         - Current user ID
 * @param {string} [opts.schoolId]       - Current school ID (REQUIRED by ai-proxy v4 enforcement gate when app_source !== 'sandbox')
 * @param {string} [opts.role]           - Current user role
 * @param {string} [opts.deploymentMode] - Deployment mode
 * @returns {Promise<object>}            - Parsed JSON object from the AI
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
    // ── Primary path: SAIL Core ai-proxy v9 ─────────────────────────────
    // Phase B4-prep (2026-05-07). Outcome of every call lands in exactly
    // ONE of four structured log lines:
    //
    //   proxy_success                — primary path returned ok:true
    //   proxy_safety_fallback_used   — proxy lacked OPENAI_API_KEY; fellback regardless of flag
    //   proxy_error_fallback_used    — proxy errored, flag=false → Netlify fallback ran
    //   proxy_error_no_fallback      — proxy errored, flag=true (no fallback) OR error not in scoped-fallback set
    //
    // The flag (PROXY_ONLY) controls ONLY the APP_NOT_ENABLED branch —
    // every other proxy-side failure (CONSENT_REQUIRED, INVOKE_ERROR,
    // PARSE_ERROR, UNEXPECTED_PAYLOAD, DENIED, PROVIDER_ERROR≠key-missing)
    // propagates regardless of flag. This preserves Slice-11 scoping;
    // the flag toggles whether disabled schools fall back vs. error out.
    try {
        const result = await invokeSailAiProxy({ system, prompt, schoolId, feature })
        // Primary path success. result.* fields aren't directly available
        // here (invokeSailAiProxy returns the parsed JSON only), so log
        // the call shape rather than the response payload.
        console.log('[ai-proxy] proxy_success', {
            school_id:  schoolId,
            feature,
            proxy_only: PROXY_ONLY,
        })
        return result
    } catch (sailErr) {
        const code            = sailErr?.code ?? null
        const message         = sailErr?.message ?? ''
        const isAppNotEnabled = code === 'APP_NOT_ENABLED'

        // ── Safety override ─────────────────────────────────────────────
        // The proxy is missing its OPENAI_API_KEY env var. Falling back is
        // explicit safety: prevents accidental outage during the brief
        // window between flipping PROXY_ONLY=true and setting the secret.
        // This branch is REMOVED as part of Phase B4 when the Netlify
        // fallback is deleted.
        const isMissingProviderKey =
            code === 'PROVIDER_ERROR'
            && /OPENAI_API_KEY not configured/i.test(message)
        if (isMissingProviderKey) {
            console.warn('[ai-proxy] proxy_safety_fallback_used', {
                school_id:    schoolId,
                code,
                reason:       'openai_key_missing',
                will_fallback: true,
                proxy_only:   PROXY_ONLY,
            })
            return await invokeNetlifyFallback({
                system, prompt, maxTokens, feature, userId, schoolId, role, deploymentMode,
            })
        }

        // ── Scoped fallback (PROXY_ONLY=false, APP_NOT_ENABLED only) ───
        if (!PROXY_ONLY && isAppNotEnabled) {
            console.warn('[ai-proxy] proxy_error_fallback_used', {
                school_id:    schoolId,
                code,
                reason:       message,
                will_fallback: true,
                proxy_only:   PROXY_ONLY,
            })
            return await invokeNetlifyFallback({
                system, prompt, maxTokens, feature, userId, schoolId, role, deploymentMode,
            })
        }

        // ── No-fallback paths ───────────────────────────────────────────
        console.error('[ai-proxy] proxy_error_no_fallback', {
            school_id:  schoolId,
            code,
            reason:     message,
            proxy_only: PROXY_ONLY,
            request_id: sailErr.proxyData?.request_id ?? null,
        })

        // PROXY_ONLY=true + APP_NOT_ENABLED: throw a loud, school-specific
        // message so the failure in the UI is actionable (not a generic
        // "AI grading is unavailable").
        if (PROXY_ONLY && isAppNotEnabled) {
            throw new Error(
                `[USE_AI_PROXY_ONLY] fallback blocked. ` +
                `school_id=${schoolId ?? '(null)'} got APP_NOT_ENABLED from ai-proxy v9 ` +
                `but VITE_USE_AI_PROXY_ONLY=true forbids the legacy Netlify path. ` +
                `Either enable ai_grading in school_apps for this school, OR ` +
                `unset VITE_USE_AI_PROXY_ONLY to re-allow the scoped fallback (NOT RECOMMENDED).`,
            )
        }

        // All remaining failure modes (CONSENT_REQUIRED, PROVIDER_ERROR
        // [non-key-missing], INVOKE_ERROR, PARSE_ERROR, UNEXPECTED_PAYLOAD,
        // DENIED) propagate. Under PROXY_ONLY=true the error is normalized
        // to a stable teacher-readable shape; under PROXY_ONLY=false the
        // raw error propagates (Slice-11 verbatim).
        if (PROXY_ONLY) {
            throw normalizeAIError(sailErr)
        }
        throw sailErr
    }
}

// ─── Internal: SAIL Core ai-proxy v4 ────────────────────────────────────────
// Throws Error-with-code on every non-success path. Possible codes:
//   APP_NOT_ENABLED  - 3c gate: school doesn't have ai_grading enabled
//   CONSENT_REQUIRED - 3b gate: user hasn't granted ai_processing consent
//   PROVIDER_ERROR   - 4 / 6: OpenAI failed (incl. no key configured)
//   DENIED           - 1: auth / consent infra error
//   VALIDATION_ERROR - 2: body shape rejected by proxy
//   INVOKE_ERROR     - supabase.functions.invoke surfaced an error
//   UNEXPECTED_PAYLOAD - data.ok=true but no usable response field
//   PARSE_ERROR      - data.response wasn't valid JSON
async function invokeSailAiProxy({ system, prompt, schoolId, feature }) {
    // Slice 13 prep: structured rollout-mode log. One line per call so we
    // can correlate per-school traffic with whichever mode is active in
    // a given deploy. `route: 'ai_grading'` mirrors the proxy's
    // `app_source` and lets logs be greppable for future surfaces.
    console.log('[AI_PROXY_MODE]', {
        strict: STRICT_AI_PROXY,
        school_id: schoolId,
        route: 'ai_grading',
        feature,
    })

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
                // Slice 12.5: surface school_id into the ai_requests row's
                // metadata so per-school metrics (success rate, latency,
                // fallback usage) can JOIN cleanly against schools. The
                // proxy already gets school_id at the top level for the
                // is_app_enabled gate, but doesn't propagate it into the
                // logged row's metadata; we duplicate it here.
                school_id: schoolId,
            },
        },
    })

    if (error) {
        const e = new Error(`ai-proxy invoke error: ${error.message || 'unknown'}`)
        e.code = 'INVOKE_ERROR'
        e.cause = error
        throw e
    }
    if (data && data.ok === false) {
        // Structured denial from the proxy. Pass the proxy's code through
        // verbatim so callAI can match on it (callAI looks for
        // 'APP_NOT_ENABLED' specifically; everything else propagates).
        const e = new Error(data.error || 'ai-proxy denied the request')
        e.code = data.code || 'DENIED'
        e.proxyData = data
        throw e
    }
    if (!data || typeof data.response !== 'string' || data.response.length === 0) {
        const e = new Error('ai-proxy returned an unexpected payload (missing response field)')
        e.code = 'UNEXPECTED_PAYLOAD'
        e.proxyData = data
        throw e
    }

    // Helm callers expect parsed JSON. The grading prompt instructs the
    // AI to return JSON; ai-proxy v4 returns the raw text. Parse here.
    try {
        return JSON.parse(data.response)
    } catch (parseErr) {
        const e = new Error(`ai-proxy response not parseable as JSON: ${parseErr.message}`)
        e.code = 'PARSE_ERROR'
        e.cause = parseErr
        throw e
    }
}

// ─── Internal: legacy Netlify fallback ──────────────────────────────────────
// Verbatim of the previous callAI body — preserved as the "old default"
// so a Supabase outage doesn't take down grading. Will be removed in a
// follow-up slice once the primary path is proven.
async function invokeNetlifyFallback({
    system,
    prompt,
    maxTokens,
    feature,
    userId,
    schoolId,
    role,
    deploymentMode,
}) {
    let response
    try {
        response = await fetch(NETLIFY_AI_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
