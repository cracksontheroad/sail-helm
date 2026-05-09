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
 * Per-action metadata used by the *interpretation* layer (the
 * debug panel, future dashboards). Mirrors the resolver's
 * `requiresConfirm` policy but lives here, deliberately
 * decoupled — the resolver owns *deciding the action*, this
 * map owns *making sense of the resulting telemetry*.
 *
 * Why duplicate the policy across two modules?
 *   * Each layer has its own concern and its own test suite.
 *   * Coupling them would mean the panel imports from the
 *     resolver, dragging React + handler-builder code into a
 *     pure-data module, or extracting a third "policy" module
 *     that both depend on. Both are heavier than two synced
 *     constants.
 *   * The contract that matters (truthful funnel display) is
 *     enforced by tests on the panel logic, not by the
 *     constants being literally the same object.
 *
 * If a future contributor adds a new action and forgets to
 * update this map, the panel falls back to the conservative
 * default (`requiresConfirm: true`) — funnel shows confirm
 * step which is harmless if the action actually has one and
 * mildly misleading if it doesn't. Acceptable failure mode.
 */
export const TIMELINE_ACTION_META = Object.freeze({
    'attendance.mark_present':   Object.freeze({ requiresConfirm: true  }),
    'behaviour.resolve':         Object.freeze({ requiresConfirm: true  }),
    'assignment.mark_submitted': Object.freeze({ requiresConfirm: false }),
})

/**
 * Safe lookup. Unknown actions get the conservative default
 * (`requiresConfirm: true`) so the panel never under-displays
 * the funnel for an action it doesn't recognise.
 */
export function getActionMeta(action) {
    const m = TIMELINE_ACTION_META[action]
    return m || { requiresConfirm: true }
}

// ── Friction hints ────────────────────────────────────────────────────────
//
// Heuristics that read the metrics aggregate and surface
// suggestions about the action loop's *policy*, not its data.
// Advisory only — they never mutate state and never enforce
// behaviour. The panel renders the hint; the developer decides
// whether to act on it.
//
// Naming convention for future hints: `shouldHint<X>(slot)` →
// boolean. One function per heuristic. Each is independently
// testable. New hints accumulate here; the panel branches on
// each.

/**
 * "Consider removing confirm" — flags actions whose confirm step
 * is no longer pulling its weight. A confirm is justified when
 * users either hesitate at it (giving them a chance to back out)
 * OR when the action sometimes fails (giving them a chance to
 * see a problem before committing). When BOTH of those are
 * absent — high confirm rate, near-zero error rate, enough
 * volume to trust the signal — the confirm step is friction
 * without safety value, and the data is saying "this could go
 * single-click" the same way it did for assignment submission.
 *
 * Thresholds:
 *   * confirm >= 5  — enough samples to trust the signal. Lower
 *                     and noise dominates; higher delays the hint
 *                     beyond what's useful for fast iteration.
 *   * success / confirm >= 0.95 — near-certain follow-through
 *                     after confirming. If 1 in 20 fails after
 *                     confirm, the confirm IS catching something.
 *   * error === 0   — strict zero. A single error in this volume
 *                     is the difference between "confirm is
 *                     friction" and "confirm catches something".
 *                     Stricter than ratio-based because errors
 *                     are signal, not noise.
 *
 * The thresholds are deliberately simple integers/ratios — no
 * config, no tuning, no time decay. If they prove too strict or
 * too loose, change them in this one place. Easier to revisit
 * a hardcoded number than to argue about a config schema.
 *
 * @param {{click,confirm,success,error}|null|undefined} slot
 * @returns {boolean}
 */
export function shouldHintConfirmRemoval(slot) {
    if (!slot) return false
    if (slot.confirm < 5) return false
    if (slot.error   > 0) return false
    return (slot.success / slot.confirm) >= 0.95
}

// ── Self-verification ─────────────────────────────────────────────────────
//
// Funnel-monotonicity invariants. The action loop's correctness rests on
// these holding under all conditions — spam, races, failures — so we
// surface violations live in the panel instead of waiting to discover them
// in production data weeks later.
//
// Invariants for `requiresConfirm: true` actions (3-step funnel):
//   * click   ≥ confirm                  — can't confirm without clicking
//   * confirm ≥ success + error          — every terminal came from a confirm
//
// Invariants for `requiresConfirm: false` actions (2-step funnel):
//   * click ≥ success + error            — every terminal came from a click
//
// Universal invariants:
//   * all four counts are non-negative integers
//   * lastDurationMs / avgDurationMs are non-negative finite (no NaN, no
//     Infinity) when set
//
// What this won't catch:
//   * Off-by-one shifts where (click=2, confirm=2, success=2) is internally
//     consistent but every cycle is double-fired. The funnel doesn't expose
//     a check for "ratio looks suspicious" — only "structure is broken".
//   * Cross-action contamination (e.g. attendance click bumping behaviour
//     counters). Each action is validated independently.
// Both are out of scope for this layer; ratio-based heuristics live in
// `shouldHint*` functions.

/**
 * Validate one action's metric slot against its policy.
 *
 * @param {object|null|undefined} slot — { click, confirm, success, error,
 *                                          lastDurationMs, avgDurationMs }
 * @param {object|null|undefined} meta — { requiresConfirm } (or null/undefined)
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateSlot(slot, meta) {
    if (!slot) return { valid: true, issues: [] }   // no data is always valid
    const issues = []

    // Non-negative counts. If any of these fire, the aggregator has
    // a serious bug — counters are only ever `++`-ed.
    if (slot.click   < 0) issues.push(`click < 0 (${slot.click})`)
    if (slot.confirm < 0) issues.push(`confirm < 0 (${slot.confirm})`)
    if (slot.success < 0) issues.push(`success < 0 (${slot.success})`)
    if (slot.error   < 0) issues.push(`error < 0 (${slot.error})`)

    const requiresConfirm = !meta || meta.requiresConfirm !== false
    const terminals = (slot.success ?? 0) + (slot.error ?? 0)

    if (requiresConfirm) {
        if (slot.click < slot.confirm) {
            issues.push(`click (${slot.click}) < confirm (${slot.confirm})`)
        }
        if (slot.confirm < terminals) {
            issues.push(`confirm (${slot.confirm}) < success + error (${terminals})`)
        }
    } else {
        // 2-step funnel. We deliberately do NOT flag confirm > 0 here
        // because a developer toggling the policy mid-session could leave
        // a transient confirm count from before the change. Flagging it
        // would produce false positives. If you want to catch policy
        // drift, do it via a separate ratio-based hint.
        if (slot.click < terminals) {
            issues.push(`click (${slot.click}) < success + error (${terminals})`)
        }
    }

    // Duration sanity. NaN and Infinity creep in if a bug ever divides by
    // zero or carries a non-numeric value through the avg computation.
    for (const k of ['lastDurationMs', 'avgDurationMs']) {
        const v = slot[k]
        if (v !== null && v !== undefined) {
            if (!Number.isFinite(v) || v < 0) {
                issues.push(`${k} is not a finite non-negative number (${v})`)
            }
        }
    }

    return { valid: issues.length === 0, issues }
}

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
