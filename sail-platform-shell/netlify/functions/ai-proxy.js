// ═══════════════════════════════════════════════════════════════════════════════
// SAIL AI Proxy — Netlify Function
// ─────────────────────────────────────────────────────────────────────────────
// All AI calls from the frontend route through this function.
// The API key never leaves the server.
//
// POST /.netlify/functions/ai-proxy
// Headers: Authorization: Bearer <supabase-auth-jwt>   ← REQUIRED (added 2026-05-16)
// Body:    { system, prompt, maxTokens, feature, userId, schoolId, role }
// Returns: { result, model, usage }
//
// Auth: the function verifies the inbound Supabase JWT (asymmetric ES256
// via the project's JWKS endpoint) before any OpenAI call. body.userId is
// advisory only; the verified JWT sub is the authoritative user_id and is
// what gets logged + forwarded to OpenAI as the user field. Failure
// returns 401 before any tokens are spent. See verifyJwt() below.
//
// Future: add rate limiting, ai_usage_log writes, tenant-aware controls.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Load .env for local dev (Netlify injects env vars in production) ───────
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// ─── Provider pinning ───────────────────────────────────────────────────────
// This proxy is OpenAI-only by design. Do NOT add Anthropic logic here —
// callers that need Anthropic should get their own proxy with its own pin.
const PROVIDER = 'openai'
const PROVIDER_KEY_ENV = 'OPENAI_API_KEY'
const PROVIDER_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
// OpenAI keys begin with `sk-` (legacy `sk-…`, project `sk-proj-…`, service-account `sk-svcacct-…`).
// Anthropic keys begin with `sk-ant-` — accept that prefix only because it would still match `sk-`,
// so we explicitly reject it to catch the most common mismixed-provider mistake.
const PROVIDER_KEY_PREFIX = 'sk-'
const FORBIDDEN_KEY_PREFIXES = ['sk-ant-']    // Anthropic — wrong provider for this proxy

// Read the .env file every time and report back what we found, so a stale
// shell-level OPENAI_API_KEY can't silently override a freshly-edited .env.
function readEnvFile() {
    const candidates = [
        join(process.cwd(), '.env'),
        join(process.cwd(), 'sail-platform-shell', '.env'),
    ]
    for (const envPath of candidates) {
        if (!existsSync(envPath)) continue
        try {
            const out = {}
            const envContent = readFileSync(envPath, 'utf8')
            for (const line of envContent.split('\n')) {
                const trimmed = line.trim()
                if (!trimmed || trimmed.startsWith('#')) continue
                const eqIdx = trimmed.indexOf('=')
                if (eqIdx > 0) {
                    const key = trimmed.slice(0, eqIdx).trim()
                    let val = trimmed.slice(eqIdx + 1).trim()
                    // Strip optional surrounding quotes
                    if ((val.startsWith('"') && val.endsWith('"')) ||
                        (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1)
                    }
                    out[key] = val
                }
            }
            return { path: envPath, values: out }
        } catch { /* continue to next candidate */ }
    }
    return { path: null, values: {} }
}

// Resolve the API key, preferring .env (the user's authoritative local config)
// over a possibly-stale shell-inherited value. Returns enough metadata for safe logging.
function resolveProviderConfig() {
    const envFile = readEnvFile()
    const fileKey = envFile.values[PROVIDER_KEY_ENV] || null
    const procKey = process.env[PROVIDER_KEY_ENV] || null

    let key = null
    let keySource = 'none'
    if (fileKey && procKey && fileKey !== procKey) {
        // Stale shell/Netlify env disagreed with .env — prefer .env and shout about it.
        console.warn(
            `[ai-proxy] ${PROVIDER_KEY_ENV} differs between .env (${fileKey.slice(0, 8)}…) ` +
            `and process.env (${procKey.slice(0, 8)}…). Using .env value. ` +
            `Unset the shell variable to silence this warning.`
        )
        key = fileKey
        keySource = `.env (${envFile.path})`
    } else if (fileKey) {
        key = fileKey
        keySource = `.env (${envFile.path})`
    } else if (procKey) {
        key = procKey
        keySource = 'process.env (shell or Netlify)'
    }

    return {
        provider: PROVIDER,
        endpoint: PROVIDER_ENDPOINT,
        envName: PROVIDER_KEY_ENV,
        key,
        keySource,
        keyPrefix: key ? key.slice(0, 8) : null,
        keyLength: key ? key.length : 0,
        envFilePath: envFile.path,
    }
}

// Validate the resolved key matches the pinned provider. Returns null if OK,
// or an error message string describing the mismatch.
function validateProviderConfig(cfg) {
    if (!cfg.key) {
        return `No ${cfg.envName} found in .env or process.env`
    }
    for (const bad of FORBIDDEN_KEY_PREFIXES) {
        if (cfg.key.startsWith(bad)) {
            return `${cfg.envName} starts with "${bad}" which is not an ${cfg.provider} key. ` +
                   `This proxy is pinned to ${cfg.provider} (${cfg.endpoint}). ` +
                   `Replace ${cfg.envName} in ${cfg.envFilePath || '.env'} with an ${cfg.provider} key.`
        }
    }
    if (!cfg.key.startsWith(PROVIDER_KEY_PREFIX)) {
        return `${cfg.envName} does not start with "${PROVIDER_KEY_PREFIX}" — ` +
               `expected an ${cfg.provider} key. Got prefix "${cfg.keyPrefix}".`
    }
    return null
}

// ─── Supabase JWT verification (added 2026-05-16) ───────────────────────────
// Inbound requests MUST carry an `Authorization: Bearer <jwt>` header signed
// by the SAIL-core Supabase project. Without this gate, the proxy trusts the
// request body's userId/schoolId/role fields verbatim and forwards to OpenAI
// — i.e. any anonymous caller can spoof identity and consume tokens.
//
// Verification (asymmetric ES256, no shared secret needed):
//   1. Read Supabase URL from env (SUPABASE_URL, falling back to
//      VITE_SUPABASE_URL for compat with the existing .env).
//   2. Lazily create a remote JWKS reference against the project's
//      /auth/v1/.well-known/jwks.json endpoint. jose caches keys
//      internally (default 30min TTL) so we don't pay the fetch cost
//      per request.
//   3. jwtVerify validates signature, expiry, issuer (<url>/auth/v1),
//      and audience ("authenticated"). Any failure throws -> 401.
//   4. The verified payload's sub is the user_id of record. We log a
//      warning when the request body's userId disagrees but the
//      verified sub is what gets logged/forwarded — never the body.

function readEnvValue(name) {
    const envFile = readEnvFile()
    return envFile.values[name] || process.env[name] || null
}

function resolveSupabaseUrl() {
    return readEnvValue('SUPABASE_URL') || readEnvValue('VITE_SUPABASE_URL')
}

let _jwksRef = null
let _jwksUrl = null
function getJwks(supabaseUrl) {
    const jwksUrl = new URL('/auth/v1/.well-known/jwks.json', supabaseUrl)
    if (_jwksRef && _jwksUrl === jwksUrl.href) return _jwksRef
    _jwksRef = createRemoteJWKSet(jwksUrl)
    _jwksUrl = jwksUrl.href
    return _jwksRef
}

async function verifyJwt(event, supabaseUrl) {
    const raw = event.headers?.authorization || event.headers?.Authorization
    if (!raw) {
        throw new Error('missing Authorization header')
    }
    const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
    if (!m) {
        throw new Error('Authorization header must be "Bearer <token>"')
    }
    const token = m[1]
    if (!supabaseUrl) {
        throw new Error('SUPABASE_URL (or VITE_SUPABASE_URL) not set on the function environment')
    }
    const issuer = new URL('/auth/v1', supabaseUrl).href
    const jwks = getJwks(supabaseUrl)
    const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: 'authenticated',
    })
    // Belt-and-braces with the audience check above: Supabase puts the
    // session-class in payload.role. Anonymous tokens carry 'anon';
    // service-role tokens carry 'service_role'. Either would have
    // bypassed downstream RBAC if accepted here. Enforce that only
    // human-session ('authenticated') tokens can drive an OpenAI call.
    if (payload.role !== 'authenticated') {
        throw new Error(`invalid role: expected 'authenticated', got '${payload.role ?? '(missing)'}'`)
    }
    return {
        sub:   payload.sub,
        email: payload.email || null,
        payload,
    }
}

// ─── Configuration ──────────────────────────────────────────────────────────
// Centralised model name — change here to upgrade everywhere.
const AI_MODEL = 'gpt-4o-mini'

// Hard ceiling to prevent runaway cost from malformed requests.
const MAX_TOKENS_CEILING = 2000

// ─── CORS headers (allow same-origin + local dev) ───────────────────────────
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ─── Handler ────────────────────────────────────────────────────────────────
export const handler = async (event) => {
    // Preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS_HEADERS, body: '' }
    }

    // Only POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Method not allowed' }),
        }
    }

    // ── Authenticate the caller (added 2026-05-16) ──────────────────────────
    // Fail closed: any verification failure returns 401 BEFORE we resolve the
    // OpenAI key or spend any tokens. The error message names the failure
    // mode but does NOT echo the token back.
    const supabaseUrl = resolveSupabaseUrl()
    let identity
    try {
        identity = await verifyJwt(event, supabaseUrl)
    } catch (authErr) {
        console.warn('[ai-proxy] auth rejected:', authErr.message)
        return {
            statusCode: 401,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: `Unauthorized: ${authErr.message}` }),
        }
    }

    // Resolve provider config fresh on every invocation so .env edits are picked up
    // without restarting `netlify dev`. Cheap (one tiny file read).
    const cfg = resolveProviderConfig()

    // ── Safe debug log: provider, env var, key prefix only, endpoint ────────
    // Prefix-only — never log the full key.
    console.log('[ai-proxy] provider config', {
        provider: cfg.provider,
        envName: cfg.envName,
        keySource: cfg.keySource,
        keyPrefix: cfg.keyPrefix,           // first 8 chars only
        keyLength: cfg.keyLength,
        endpoint: cfg.endpoint,
    })

    const cfgError = validateProviderConfig(cfg)
    if (cfgError) {
        console.error('[ai-proxy] provider config error:', cfgError)
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: cfgError }),
        }
    }

    // Parse request body
    let body
    try {
        body = JSON.parse(event.body)
    } catch {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Invalid JSON in request body' }),
        }
    }

    const {
        system,
        prompt,
        maxTokens = 600,
        // Metadata — not used for AI call yet, but accepted for future logging/rate-limiting
        feature = 'unknown',
        userId = null,
        schoolId = null,
        role = null,
    } = body

    // Validate required fields
    if (!prompt) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Missing required field: prompt' }),
        }
    }

    // Clamp maxTokens
    const clampedMaxTokens = Math.min(Math.max(1, maxTokens), MAX_TOKENS_CEILING)

    // Build messages array
    const messages = []
    if (system) {
        messages.push({ role: 'system', content: system })
    }
    messages.push({ role: 'user', content: prompt })

    // ── Log request metadata (future: write to ai_usage_log table) ──────────
    // Identity comes from the verified JWT (`identity.sub`), NOT the request
    // body. Body-supplied userId is kept for backward compat with the
    // existing log shape but is treated as advisory only — if it disagrees
    // with the verified sub, we log a warning so the spoof attempt is
    // visible in production logs.
    if (userId && userId !== identity.sub) {
        console.warn('[ai-proxy] body.userId disagrees with verified JWT sub', {
            body_userId:  userId,
            verified_sub: identity.sub,
        })
    }
    console.log('[ai-proxy]', {
        feature,
        verified_user_id: identity.sub,         // authoritative (from JWT)
        verified_email:   identity.email,       // authoritative (from JWT)
        body_userId:      userId,               // advisory only
        body_schoolId:    schoolId,             // advisory only
        body_role:        role,                 // advisory only
        model:            AI_MODEL,
        maxTokens:        clampedMaxTokens,
        promptLength:     prompt.length,
    })

    // ── Call provider (pinned to OpenAI) ────────────────────────────────────
    let aiResponse
    try {
        const res = await fetch(cfg.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.key}`,
            },
            body: JSON.stringify({
                model: AI_MODEL,
                response_format: { type: 'json_object' },
                temperature: 0,
                max_tokens: clampedMaxTokens,
                messages,
                // OpenAI's per-user abuse-tracking hint. Sourced from the
                // verified JWT sub (NOT the body) so a forged body.userId
                // can't help an attacker disassociate their requests.
                user: identity.sub,
            }),
        })

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}))
            const msg = errData?.error?.message || `AI provider returned HTTP ${res.status}`
            // Tie the upstream error back to the key prefix and source — makes "valid issuer" / 401 errors
            // diagnosable without exposing the key. This is the field that confirmed the mismatch hypothesis.
            console.error('[ai-proxy] AI provider error:', {
                status: res.status,
                message: msg,
                provider: cfg.provider,
                endpoint: cfg.endpoint,
                keyPrefix: cfg.keyPrefix,
                keySource: cfg.keySource,
            })
            return {
                statusCode: 502,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: `AI provider error: ${msg}` }),
            }
        }

        aiResponse = await res.json()
    } catch (networkErr) {
        console.error('[ai-proxy] Network error calling AI provider:', networkErr.message)
        return {
            statusCode: 502,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: `Network error reaching AI provider: ${networkErr.message}` }),
        }
    }

    // ── Parse and return ────────────────────────────────────────────────────
    const content = aiResponse.choices?.[0]?.message?.content
    if (!content) {
        return {
            statusCode: 502,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'AI provider returned an empty response' }),
        }
    }

    // Try to parse as JSON (we requested json_object format)
    let parsed
    try {
        parsed = JSON.parse(content)
    } catch {
        // Return raw text if JSON parsing fails — let the frontend decide
        parsed = { _raw: content }
    }

    return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            result: parsed,
            model: AI_MODEL,
            usage: aiResponse.usage || null,
        }),
    }
}
