// ═══════════════════════════════════════════════════════════════════════════
// Timeline — lightweight client-side action telemetry
// ─────────────────────────────────────────────────────────────────────────
// THIN PROBE, not a system. The job here is to make the action loop
// observable so we can answer questions like:
//
//   * Are users actually confirming actions, or stopping at click?
//   * How often do RPCs fail (and which ones)?
//   * Is the perceived-instant latency assumption holding up?
//   * Are some action types used much more than others?
//
// CONSTRAINTS:
//   * No external SDK, no analytics service, no network call.
//   * No UI surface. No new React state. No loading indicators.
//   * Dev-only console output. Aggregate counts on globalThis so a
//     dev can inspect `window.__timelineMetrics` from the browser
//     console.
//   * When a real backend telemetry sink is added later, only the
//     internal `_emit` function needs to change — the call sites
//     stay identical.
//
// SHAPE OF A LOGGED EVENT:
//   {
//     action:     'attendance.mark_present' | 'behaviour.resolve' | ...,
//     phase:      'click' | 'confirm' | 'success' | 'error',
//     rowType:    string,
//     rowKey:     string,
//     ts:         ISO timestamp (added automatically),
//     durationMs?: number,    // success-only, full RPC + refetch duration
//     error?:      string,    // error-only, error.message
//   }
// ═══════════════════════════════════════════════════════════════════════════

export const TIMELINE_ACTIONS = Object.freeze({
    MARK_PRESENT:      'attendance.mark_present',
    RESOLVE_BEHAVIOUR: 'behaviour.resolve',
    MARK_ASSIGNMENT:   'assignment.mark_submitted',
})

export const TIMELINE_PHASES = Object.freeze({
    CLICK:   'click',
    CONFIRM: 'confirm',
    SUCCESS: 'success',
    ERROR:   'error',
})

/**
 * Lazily initialise the metrics aggregate on globalThis. Lazy so
 * the module import doesn't pollute the global scope until the
 * first action fires.
 */
function _ensureMetrics() {
    if (typeof globalThis === 'undefined') return null
    if (!globalThis.__timelineMetrics) {
        globalThis.__timelineMetrics = {
            byAction: Object.create(null),
            // Last-N error ring buffer for quick diagnostic. Bounded
            // so a steady-state failure doesn't grow memory unbounded.
            recentErrors: [],
        }
    }
    return globalThis.__timelineMetrics
}

const _RECENT_ERROR_CAPACITY = 25

function _bumpAction(action, phase, durationMs, errorMessage) {
    const m = _ensureMetrics()
    if (!m) return
    if (!m.byAction[action]) {
        m.byAction[action] = {
            click: 0, confirm: 0, success: 0, error: 0,
            totalDurationMs: 0,
            lastDurationMs:  null,
            avgDurationMs:   null,
        }
    }
    const slot = m.byAction[action]
    if      (phase === 'click')   slot.click++
    else if (phase === 'confirm') slot.confirm++
    else if (phase === 'success') {
        slot.success++
        if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
            slot.totalDurationMs += durationMs
            slot.lastDurationMs   = durationMs
            slot.avgDurationMs    = slot.totalDurationMs / slot.success
        }
    }
    else if (phase === 'error') {
        slot.error++
        if (errorMessage) {
            m.recentErrors.push({ action, message: errorMessage, ts: new Date().toISOString() })
            if (m.recentErrors.length > _RECENT_ERROR_CAPACITY) {
                m.recentErrors.shift()
            }
        }
    }
}

/**
 * Internal emission point. Single seam to swap in a real sink
 * (Supabase RPC, PostHog, etc.) later — call sites don't change.
 */
function _emit(event) {
    // Dev-only console output. Vite replaces process.env.NODE_ENV
    // with the literal at build time; in node:test runs, NODE_ENV
    // is undefined and we treat that as dev.
    const isProd = typeof process !== 'undefined'
        && process.env?.NODE_ENV === 'production'
    if (isProd) return
    if (typeof console === 'undefined') return
    if (event.phase === 'error') {
        // eslint-disable-next-line no-console
        console.warn('[Timeline]', event)
    } else {
        // eslint-disable-next-line no-console
        console.log('[Timeline]', event)
    }
}

/**
 * Record a structured timeline-action telemetry event.
 *
 * @param {{
 *   action:      string,
 *   phase:       'click'|'confirm'|'success'|'error',
 *   rowType?:    string,
 *   rowKey?:     string,
 *   durationMs?: number,
 *   error?:      string,
 * }} event
 */
export function logTimelineAction(event) {
    if (!event || typeof event !== 'object') return
    if (!event.action || !event.phase) return
    const enriched = { ...event, ts: new Date().toISOString() }
    _bumpAction(event.action, event.phase, event.durationMs, event.error)
    _emit(enriched)
}

/**
 * Test helper — drops the in-memory aggregate so tests don't
 * accumulate state across cases. Not exported as a public API
 * (the underscore prefix is the convention).
 */
export function _resetTimelineMetrics() {
    if (typeof globalThis !== 'undefined' && globalThis.__timelineMetrics) {
        globalThis.__timelineMetrics = undefined
    }
}
