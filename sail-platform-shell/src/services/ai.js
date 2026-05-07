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
// Phase 2 Slice 13 — Strict proxy mode (env-driven, NOT YET ACTIVE).
//
// When false (default): APP_NOT_ENABLED 403 from ai-proxy v4 falls back to
//   the legacy Netlify function so disabled schools keep working while
//   they're brought online via Bridge admin toggles. This is the Slice 11
//   posture.
//
// When true: APP_NOT_ENABLED becomes terminal — the error propagates with
//   enriched context (school_id, code, request_id) and the caller sees a
//   real failure state. Disabled schools STOP grading. Use only after
//   Slice 12.5 returns SAFE TO PROCEED AND every school that needs
//   ai_grading has been enabled via Bridge SchoolDetailDrawer (or a
//   targeted migration).
//
// ⚠️  ACTIVATION (no source code edit):
//      Set in deploy env (or .env.production):
//        VITE_STRICT_AI_PROXY=true
//      Then:
//        cd sail-helm-core-v6-lite/sail-platform-shell && npm run build
//      and deploy.
//
//   Why VITE_-prefixed: Vite only exposes env vars beginning with VITE_
//   to client-side code. Anything else stays in the build server's
//   process and never reaches the browser bundle.
//
//   Why rebuild required: Vite inlines env values at build time (this
//   is a static-replacement, not a runtime read). To flip without a
//   rebuild, a future slice can add a runtime config fetch — but for
//   today, env+rebuild+deploy is the activation path.
//
// Default-deny on missing env: `import.meta.env.VITE_STRICT_AI_PROXY`
// resolves to `undefined` when unset, and `undefined === 'true'` is
// false. So the flag stays false unless explicitly set to the literal
// string 'true'. Any other value (1, on, yes) → false.
//
// Non-policy failures (CONSENT_REQUIRED, PROVIDER_ERROR, INVOKE_ERROR,
// PARSE_ERROR, UNEXPECTED_PAYLOAD, DENIED) ALREADY surface as errors
// regardless of this flag — Slice 11 made that the default. The flag
// controls only the APP_NOT_ENABLED branch.
//
// User-facing error normalization: when STRICT_AI_PROXY is true, ALL
// thrown errors from callAI run through normalizeAIError below before
// being thrown. The result is an Error instance with a teacher-readable
// `message` plus structured `type`, `originalCode`, and `cause` fields
// for ops/support. When the flag is false, raw errors throw as before —
// UX behavior unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const STRICT_AI_PROXY = import.meta.env.VITE_STRICT_AI_PROXY === 'true'

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
    // ── Primary path: SAIL Core ai-proxy v4 ─────────────────────────────
    // Slice 11: scoped fallback for APP_NOT_ENABLED only.
    // Slice 13 prep: STRICT_AI_PROXY flag (currently false) gates that
    // last fallback branch. When flipped to true, APP_NOT_ENABLED also
    // surfaces and disabled schools stop grading — full enforcement.
    try {
        return await invokeSailAiProxy({ system, prompt, schoolId, feature })
    } catch (sailErr) {
        const isAppNotEnabled = sailErr?.code === 'APP_NOT_ENABLED'

        if (!STRICT_AI_PROXY && isAppNotEnabled) {
            console.warn(
                '[ai-proxy v4] APP_NOT_ENABLED — falling back to Netlify '
                + '(school not yet enabled for ai_grading; STRICT_AI_PROXY=false)',
            )
            return await invokeNetlifyFallback({
                system,
                prompt,
                maxTokens,
                feature,
                userId,
                schoolId,
                role,
                deploymentMode,
            })
        }

        // Strict mode + APP_NOT_ENABLED: log enriched context BEFORE
        // re-throwing so the user-facing error in Assignments has full
        // breadcrumbs available in the console for triage.
        if (STRICT_AI_PROXY && isAppNotEnabled) {
            console.error('[ai-proxy v4] APP_NOT_ENABLED (STRICT mode — no fallback)', {
                school_id:  schoolId,
                code:       sailErr.code,
                request_id: sailErr.proxyData?.request_id ?? null,
                proxy_data: sailErr.proxyData ?? null,
            })
        }

        // All other failure modes (CONSENT_REQUIRED, PROVIDER_ERROR,
        // INVOKE_ERROR, PARSE_ERROR, UNEXPECTED_PAYLOAD, DENIED) — and
        // APP_NOT_ENABLED in strict mode — propagate. Caller
        // (Assignments.gradeStudent) wraps with
        // `throw new Error('AI call failed: ...')` and shows a per-row
        // error in the UI.
        //
        // In STRICT mode, normalize the thrown error to a teacher-safe
        // shape (Error with stable .type and friendly .message). When
        // the flag is false, raw errors throw as before — Slice 11
        // behavior unchanged.
        if (STRICT_AI_PROXY) {
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
