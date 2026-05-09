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
 * OR when the action fails OFTEN ENOUGH that the confirm catches
 * something. When BOTH of those are absent — high confirm rate,
 * low error rate, enough volume to trust the signal — the
 * confirm step is friction without safety value.
 *
 * Pure over a slot. The caller decides whether to feed lifetime
 * or recent data; this function doesn't care. The panel feeds
 * `getRecentSlot(actionId)` so hints reflect *current* behaviour
 * rather than session-long blended history.
 *
 * Thresholds (all exported for the CLI to display alongside the
 * verdict; tests cover boundary behaviour at each):
 *   * click >= MIN_HINT_CLICKS (5) — volume guard. Recent windows
 *                     can be tiny; this prevents single-click
 *                     noise from firing the hint.
 *   * confirm >= 1  — ratio safety. Without at least one confirm,
 *                     `success / confirm` is NaN, and `error /
 *                     confirm` would be Infinity for any non-zero
 *                     error count.
 *   * error / confirm <= MAX_ERROR_RATE (0.05) — error rate gate.
 *                     REPLACES the previous strict `error === 0`
 *                     check. The strict zero was over-conservative:
 *                     it treated 1/100 errors (1%) and 5/10 errors
 *                     (50%) as identical "block hint" cases. The
 *                     rate-based gate distinguishes them, so a
 *                     near-perfect run with one statistical blip
 *                     still surfaces the friction-removal hint
 *                     while a real failure mode keeps the confirm
 *                     in place. 5% chosen as a reasonable starting
 *                     threshold; tweak in source if it proves too
 *                     loose / too strict in practice.
 *   * success / confirm >= 0.95 — near-certain follow-through
 *                     after confirming. The two ratio gates
 *                     together carve out a "near-perfect"
 *                     operating envelope where the confirm step
 *                     adds friction without safety value.
 *
 * The thresholds are deliberately simple constants — no config,
 * no tuning, no time decay. If they prove wrong, change them in
 * this one place; the CLI simulation suite + node:test boundary
 * cases will surface the impact within seconds.
 *
 * @param {{click,confirm,success,error}|null|undefined} slot
 * @returns {boolean}
 */
export const MIN_HINT_CLICKS  = 5
export const MAX_ERROR_RATE   = 0.05   // 5%   — global default
export const MIN_SUCCESS_RATE = 0.95   // 95%  — global default

/**
 * Per-action threshold overrides. Empirically grounded — derived
 * from running the CLI sweep against representative event traces
 * and noticing which actions are "outside the global hint envelope"
 * for non-policy reasons (i.e. the action is genuinely lower-stakes
 * and tolerates a different success/error mix).
 *
 * Resolution order (in shouldHintConfirmRemoval):
 *   1. Explicit opts.minSuccessRate / opts.maxErrorRate (sweep mode)
 *   2. ACTION_THRESHOLDS[opts.actionId] (this map)
 *   3. Global defaults (MIN_SUCCESS_RATE, MAX_ERROR_RATE)
 *
 * Entry shape:
 *   {
 *     minSuccessRate: number,    // required — drives the heuristic
 *     maxErrorRate:   number,    // required — drives the heuristic
 *     rationale?:     string,    // human-readable WHY (CLI displays it)
 *     decidedAt?:     string,    // ISO date the override was set
 *   }
 *
 * `rationale` + `decidedAt` are metadata only — never read by the
 * heuristic. They exist so the override is defensible and reviewable
 * months later: "why is attendance at 90/10?" gets a real answer
 * inline with the entry, not a git-blame archaeology dig. Without
 * them, overrides slowly become "mysterious constants nobody wants
 * to touch".
 *
 * Why per-action and not per-domain or per-row:
 *   * Per-domain ('attendance' vs 'behaviour') would couple the
 *     policy to the event-type taxonomy. The action is the actual
 *     thing being decided; tying thresholds to it is more honest.
 *   * Per-row would be over-engineering — there's no signal that
 *     individual rows behave differently from their action class.
 */
export const ACTION_THRESHOLDS = Object.freeze({
    'attendance.mark_present': Object.freeze({
        minSuccessRate: 0.90,
        maxErrorRate:   0.10,
        rationale:      '2D sweep: low-error scenario (90% success, 10% error) flips at (90%, 10%); action is reversible state-correction, low-stakes',
        decidedAt:      '2026-05-09',
    }),
    // 'behaviour.resolve' and 'assignment.mark_submitted' fall
    // through to global defaults. Add an entry here when the sweep
    // surfaces evidence for a different policy on a specific action.
})

/**
 * Resolve effective thresholds for a given action — explicit
 * override falls back to global defaults. Useful for the CLI's
 * "effective thresholds" display and for any consumer that needs
 * to know what gates the heuristic will use.
 *
 * Returns numeric thresholds always; passes through `rationale`
 * + `decidedAt` only when an override entry exists. Consumers
 * that don't care about metadata can safely ignore the extra
 * fields — they're undefined for non-overridden actions.
 */
export function getActionThresholds(actionId) {
    const override = ACTION_THRESHOLDS[actionId] || {}
    return {
        minSuccessRate: override.minSuccessRate ?? MIN_SUCCESS_RATE,
        maxErrorRate:   override.maxErrorRate   ?? MAX_ERROR_RATE,
        rationale:      override.rationale,    // undefined when no override
        decidedAt:      override.decidedAt,    // undefined when no override
    }
}

export function shouldHintConfirmRemoval(slot, opts = {}) {
    if (!slot) return false
    // Defensive defaults: callers may pass partial fixtures (tests,
    // experimental aggregator changes). Treat missing as zero so
    // every gate checks a real number rather than silently passing
    // an `undefined < 5` (false) comparison.
    const click   = slot.click   ?? 0
    const confirm = slot.confirm ?? 0
    const success = slot.success ?? 0
    const error   = slot.error   ?? 0
    // Three-tier threshold resolution:
    //   1. Explicit opts.* — sweep CLI uses this to explore the
    //      decision surface without committing to a policy change.
    //   2. ACTION_THRESHOLDS[opts.actionId] — per-action policy,
    //      empirically grounded by sweep findings.
    //   3. Global defaults — safe fallback when no per-action
    //      override exists.
    // The cascade keeps production callers (panel) honest by
    // automatically picking up per-action policy when they pass
    // `actionId`, while leaving the sweep mode able to override
    // the policy for parameter exploration.
    const actionDefaults = opts.actionId
        ? getActionThresholds(opts.actionId)
        : null
    const maxErrorRate   = opts.maxErrorRate
        ?? actionDefaults?.maxErrorRate
        ?? MAX_ERROR_RATE
    const minSuccessRate = opts.minSuccessRate
        ?? actionDefaults?.minSuccessRate
        ?? MIN_SUCCESS_RATE
    if (click   < MIN_HINT_CLICKS) return false
    if (confirm < 1)               return false   // ratio safety
    const errorRate = error / confirm
    if (errorRate > maxErrorRate) return false
    return (success / confirm) >= minSuccessRate
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
 * Combine validation results from a lifetime slot and a recent slot
 * into a single verdict, prefixing each issue with its source so the
 * panel's tooltip can show exactly which slot failed.
 *
 * Why this exists as a separate function:
 *   * The panel was previously only validating lifetime, which left
 *     transient corruption in the recent window invisible (a race
 *     condition under spam clicks could show up in recent metrics
 *     and influence hints, but never trigger a warning).
 *   * Mixing the two issue lists without prefixes would be
 *     ambiguous when a single counter goes wrong in only one slot.
 *   * Keeping it a pure function (rather than inlining in the panel)
 *     makes the combination logic testable without rendering React.
 *
 * @param {object|null|undefined} lifetime
 * @param {object|null|undefined} recent
 * @param {object|null|undefined} meta
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateRowSlots(lifetime, recent, meta) {
    const l = validateSlot(lifetime, meta)
    const r = validateSlot(recent,   meta)
    return {
        valid: l.valid && r.valid,
        issues: [
            ...l.issues.map(s => `lifetime: ${s}`),
            ...r.issues.map(s => `recent: ${s}`),
        ],
    }
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
            // Per-action sliding window of timestamped events
            // (`{phase, ts}`) used by `getRecentSlot`. Pruned on
            // every write so memory stays bounded by the current
            // window size, not session length.
            recentEvents: Object.create(null),
        }
    }
    // Backwards-compat: pre-existing aggregates (from a session
    // started before this slice landed) didn't have `recentEvents`.
    // Add it lazily so the module never crashes on a stale shape.
    if (!globalThis.__timelineMetrics.recentEvents) {
        globalThis.__timelineMetrics.recentEvents = Object.create(null)
    }
    return globalThis.__timelineMetrics
}

const _RECENT_ERROR_CAPACITY = 25
const _RECENT_WINDOW_MS      = 60_000   // 60s sliding window

/**
 * Append one timestamped event to the per-action window and prune
 * entries older than `_RECENT_WINDOW_MS`. Pruning on write means
 * memory is bounded by event rate × window size, not by session
 * length. The list stays approximately sorted because we always
 * push to the end with monotonic wall-clock time.
 */
function _pushRecentEvent(action, phase) {
    const m = _ensureMetrics()
    if (!m) return
    if (!m.recentEvents[action]) m.recentEvents[action] = []
    const list = m.recentEvents[action]
    const now    = Date.now()
    const cutoff = now - _RECENT_WINDOW_MS
    list.push({ phase, ts: now })
    // Prune old entries. The list is ordered (we only ever push
    // to the end with monotonic time), so we can drop a contiguous
    // prefix in one splice.
    let pruneCount = 0
    while (pruneCount < list.length && list[pruneCount].ts < cutoff) {
        pruneCount++
    }
    if (pruneCount > 0) list.splice(0, pruneCount)
}

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
    _pushRecentEvent(event.action, event.phase)
    _emit(enriched)
}

/**
 * Compute a {click, confirm, success, error} slot from the last
 * `windowMs` (default 60s) of timestamped events for one action.
 *
 * Filters fresh on every call — we don't trust prune-on-write to
 * have run recently enough. Idle sessions could leave events that
 * were valid at the last write but have aged out by now; this
 * filter catches them.
 *
 * Returns the zero slot when no events match — never null. The
 * panel can compare a recent slot against a lifetime slot without
 * special-casing absence.
 *
 * @param {string} action
 * @param {number=} windowMs
 * @returns {{ click: number, confirm: number, success: number, error: number }}
 */
export function getRecentSlot(action, windowMs = _RECENT_WINDOW_MS) {
    const slot = { click: 0, confirm: 0, success: 0, error: 0 }
    const m = (typeof globalThis !== 'undefined' && globalThis.__timelineMetrics) || null
    const list = m?.recentEvents?.[action]
    if (!list || list.length === 0) return slot
    const cutoff = Date.now() - windowMs
    for (const e of list) {
        if (e.ts < cutoff) continue
        if      (e.phase === 'click')   slot.click++
        else if (e.phase === 'confirm') slot.confirm++
        else if (e.phase === 'success') slot.success++
        else if (e.phase === 'error')   slot.error++
    }
    return slot
}

/**
 * Build a JSON-serialisable snapshot of the entire telemetry state
 * for offline analysis or bug-report sharing. Pure read — never
 * mutates the aggregate or the flags. Safe to call any time.
 *
 * Shape:
 *   {
 *     ts:  numeric ms-since-epoch,
 *     iso: ISO 8601 string (human-readable, same instant as `ts`),
 *     actions: {
 *       [actionId]: {
 *         lifetime: { click, confirm, success, error,
 *                     totalDurationMs, lastDurationMs, avgDurationMs },
 *         recent:   { click, confirm, success, error },
 *         recentEvents: [ {phase, ts}, ... ],   // last ~60s of events
 *       },
 *     },
 *     recentErrors: [ {action, message, ts}, ... ],
 *     flags: {
 *       forceError:  boolean,   // __SAIL_FORCE_ERROR__
 *       slowNetwork: boolean,   // __SAIL_SLOW_NETWORK__
 *     },
 *   }
 *
 * Why a snapshot, not a stream:
 *   * The session aggregate is already bounded by lifetime counters
 *     + a 60s recent-events window + a 25-entry recent-errors ring,
 *     so a one-shot dump is small and self-contained.
 *   * No backend, no schema migration, no infra debate. Two
 *     snapshots from different sessions can be diffed manually.
 *   * Reproducibility: the flags field captures whether the
 *     captured state was produced under stress conditions (force
 *     error / slow network), so a shared report is interpretable.
 *
 * @returns {object} the snapshot
 */
export function buildSessionSnapshot() {
    const now = Date.now()
    const m   = (typeof globalThis !== 'undefined' && globalThis.__timelineMetrics) || null
    const byAction = m?.byAction || {}

    const actions = {}
    for (const actionId of Object.keys(byAction)) {
        actions[actionId] = {
            // Shallow clone so consumers can't mutate the live
            // aggregate by accident.
            lifetime:     { ...byAction[actionId] },
            recent:       getRecentSlot(actionId),
            recentEvents: (m?.recentEvents?.[actionId] || []).map(e => ({ ...e })),
        }
    }

    return {
        ts:  now,
        iso: new Date(now).toISOString(),
        actions,
        recentErrors: (m?.recentErrors || []).map(e => ({ ...e })),
        flags: {
            forceError:  !!(typeof globalThis !== 'undefined' && globalThis.__SAIL_FORCE_ERROR__),
            slowNetwork: !!(typeof globalThis !== 'undefined' && globalThis.__SAIL_SLOW_NETWORK__),
        },
    }
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
