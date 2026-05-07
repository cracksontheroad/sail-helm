// ═══════════════════════════════════════════════════════════════════════════════
// SAIL AI Proxy — Netlify Function
// ─────────────────────────────────────────────────────────────────────────────
// All AI calls from the frontend route through this function.
// The API key never leaves the server.
//
// POST /.netlify/functions/ai-proxy
// Body: { system, prompt, maxTokens, feature, userId, schoolId, role }
// Returns: { result, model, usage }
//
// Future: add rate limiting, ai_usage_log writes, tenant-aware controls.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Load .env for local dev (Netlify injects env vars in production) ───────
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
    console.log('[ai-proxy]', {
        feature,
        userId,
        schoolId,
        role,
        model: AI_MODEL,
        maxTokens: clampedMaxTokens,
        promptLength: prompt.length,
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
