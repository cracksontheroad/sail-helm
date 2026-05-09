// Run with: `node --test src/lib/timelineTelemetry.test.js`
// Tests the structured-event shape, the metrics aggregator, and the
// duration/error bookkeeping. Console output isn't asserted — we
// silence it during tests so the runner stays clean.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
    logTimelineAction,
    _resetTimelineMetrics,
    TIMELINE_ACTIONS,
    TIMELINE_PHASES,
    TIMELINE_ACTION_META,
    getActionMeta,
    shouldHintConfirmRemoval,
    validateSlot,
    validateRowSlots,
    getRecentSlot,
    buildSessionSnapshot,
    ACTION_THRESHOLDS,
    getActionThresholds,
    MAX_ERROR_RATE,
    MIN_SUCCESS_RATE,
} from './timelineTelemetry.js'

// Silence console output during tests — the module logs via
// console.log/console.warn, which would clutter the test runner.
const _origLog  = console.log
const _origWarn = console.warn
console.log  = () => {}
console.warn = () => {}

beforeEach(() => {
    _resetTimelineMetrics()
})

test('action constants — closed enum of three action types', () => {
    assert.equal(TIMELINE_ACTIONS.MARK_PRESENT,      'attendance.mark_present')
    assert.equal(TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR, 'behaviour.resolve')
    assert.equal(TIMELINE_ACTIONS.MARK_ASSIGNMENT,   'assignment.mark_submitted')
})

test('phase constants — closed enum of four phases', () => {
    assert.equal(TIMELINE_PHASES.CLICK,   'click')
    assert.equal(TIMELINE_PHASES.CONFIRM, 'confirm')
    assert.equal(TIMELINE_PHASES.SUCCESS, 'success')
    assert.equal(TIMELINE_PHASES.ERROR,   'error')
})

test('action meta — encodes requiresConfirm per action', () => {
    assert.equal(TIMELINE_ACTION_META[TIMELINE_ACTIONS.MARK_PRESENT].requiresConfirm,      true)
    assert.equal(TIMELINE_ACTION_META[TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR].requiresConfirm, true)
    assert.equal(TIMELINE_ACTION_META[TIMELINE_ACTIONS.MARK_ASSIGNMENT].requiresConfirm,   false)
})

test('action meta — frozen at top level (no mutation)', () => {
    assert.throws(() => { TIMELINE_ACTION_META.foo = 'bar' })
})

test('getActionMeta — unknown action falls back to requiresConfirm=true (conservative)', () => {
    const m = getActionMeta('nope.unknown')
    assert.equal(m.requiresConfirm, true)
})

test('getActionMeta — known action returns the frozen entry', () => {
    const m = getActionMeta(TIMELINE_ACTIONS.MARK_ASSIGNMENT)
    assert.equal(m.requiresConfirm, false)
})

// ── shouldHintConfirmRemoval ───────────────────────────────────────────────
// Boundary tests around the four gates: click>=5 (volume), confirm>=1 (ratio
// safety), error===0 (strict), success/confirm>=0.95 (rate). All fixtures
// now include explicit `click` values consistent with funnel monotonicity
// (click >= confirm). The previous tests omitted click; that worked under
// the old `confirm>=5` gate but underspecifies behaviour under the new
// click-volume gate.

test('hint — null/undefined slot → false (defensive)', () => {
    assert.equal(shouldHintConfirmRemoval(null),      false)
    assert.equal(shouldHintConfirmRemoval(undefined), false)
})

test('hint — click < MIN (5) → false (insufficient volume)', () => {
    assert.equal(shouldHintConfirmRemoval({ click: 4, confirm: 4, success: 4, error: 0 }), false)
    assert.equal(shouldHintConfirmRemoval({ click: 0, confirm: 0, success: 0, error: 0 }), false)
})

test('hint — click = MIN (5) with clean funnel → true (boundary passes)', () => {
    assert.equal(shouldHintConfirmRemoval({ click: 5, confirm: 5, success: 5, error: 0 }), true)
})

test('hint — click = MIN-1 (4) is below threshold even with perfect rate', () => {
    // Fast-feedback recent windows often start small. The 5-click
    // gate prevents 1c-1f-1s flapping into a hint.
    assert.equal(shouldHintConfirmRemoval({ click: 4, confirm: 4, success: 4, error: 0 }), false)
})

test('hint — confirm = 0 with click >= 5 → false (ratio safety)', () => {
    // Defensive: a slot with click but no confirm is either a no-confirm
    // action mid-flight or genuinely degenerate. Either way we can't
    // compute a meaningful success/confirm ratio.
    assert.equal(shouldHintConfirmRemoval({ click: 10, confirm: 0, success: 0, error: 0 }), false)
})

test('hint — confirm = 0 but success > 0 (corrupt) → false (Infinity ratio gated)', () => {
    // success / confirm = Infinity, which would trivially pass >= 0.95.
    // The confirm >= 1 gate blocks this corruption-driven false positive.
    assert.equal(shouldHintConfirmRemoval({ click: 10, confirm: 0, success: 5, error: 0 }), false)
})

test('hint — error rate ABOVE threshold (5%) → false', () => {
    // 1/5 errors = 20% → above threshold, hint blocked.
    // (4/5 success = 80%, also fails the success-rate gate, but the
    //  error gate fires first. Either is sufficient to block.)
    assert.equal(shouldHintConfirmRemoval({ click: 5, confirm: 5, success: 4, error: 1 }), false)
    // 1/15 = 6.67% → just above 5% threshold.
    assert.equal(shouldHintConfirmRemoval({ click: 15, confirm: 15, success: 14, error: 1 }), false)
})

test('hint — error rate BELOW threshold (5%) with high success rate → true', () => {
    // 1/100 errors = 1%, 99/100 success = 99% → both pass; hint fires.
    // Under the OLD strict `error === 0` rule, this returned false even
    // though the error rate was negligible. The rate-based gate fixes
    // the over-conservatism.
    assert.equal(shouldHintConfirmRemoval({ click: 100, confirm: 100, success: 99, error: 1 }), true)
})

test('hint — error rate exactly AT threshold (5%) → true (strict-greater gate)', () => {
    // 1/20 errors = 5% exactly. The gate is `errorRate > MAX_ERROR_RATE`
    // (strict greater), so the boundary is INCLUDED in the hint.
    // Verifies the boundary doesn't silently flip when the rate is at
    // the documented threshold. (Still requires success rate ≥ 0.95;
    // 19/20 = 95% exact.)
    assert.equal(shouldHintConfirmRemoval({ click: 20, confirm: 20, success: 19, error: 1 }), true)
})

test('hint — opts.maxErrorRate override applies (no behavior change at default)', () => {
    // Same slot tested under different thresholds. Demonstrates the
    // sweep mode's mechanic: change the threshold, verdict shifts.
    // Choosing 19s+1e in 20 cycles (success 95%, error 5%) so the
    // success-rate gate never blocks; only the error gate moves.
    const slot = { click: 20, confirm: 20, success: 19, error: 1 }
    assert.equal(shouldHintConfirmRemoval(slot),                            true)   // default 5% → ON (boundary)
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 0.04 }),    false)  // tighter → OFF (the flip)
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 0.10 }),    true)   // looser → still ON
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 0 }),       false)  // strictest → OFF
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 1.0 }),     true)   // anything goes → ON
})

test('hint — opts.maxErrorRate alone cannot flip when success rate is the binding gate', () => {
    // 9s + 1e in 10 cycles → success 90%, error 10%.
    // Even a generous error threshold can't make the hint fire because
    // the success-rate gate (95%) is binding. The sweep CLI uses this
    // pattern to surface "binding constraint" diagnostics.
    const slot = { click: 10, confirm: 10, success: 9, error: 1 }
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 0.05 }), false)
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 0.10 }), false)
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 0.50 }), false)
    assert.equal(shouldHintConfirmRemoval(slot, { maxErrorRate: 1.00 }), false)
})

test('hint — opts.minSuccessRate override applies (the second sweep axis)', () => {
    // Same low-error slot. With both gates at default, both block.
    // Lowering ONLY the success gate doesn't help — error gate still blocks.
    // Lowering BOTH gates correctly flips to ON.
    const slot = { click: 10, confirm: 10, success: 9, error: 1 }
    assert.equal(shouldHintConfirmRemoval(slot),                                                false)  // both default → blocks
    assert.equal(shouldHintConfirmRemoval(slot, { minSuccessRate: 0.90 }),                      false)  // success passes (90%≥90%) but error still blocks
    assert.equal(shouldHintConfirmRemoval(slot, { minSuccessRate: 0.90, maxErrorRate: 0.10 }),  true)   // both pass → ON
})

test('hint — minSuccessRate boundary (success rate exactly at threshold)', () => {
    // 19s + 1e in 20 cycles → success 95%, error 5%.
    // At default minSuccessRate=0.95, success exact = 95% → passes.
    // At override 0.96, fails (95% < 96%).
    // At override 0.94, trivially passes.
    const slot = { click: 20, confirm: 20, success: 19, error: 1 }
    assert.equal(shouldHintConfirmRemoval(slot),                              true)   // 95%≥95% boundary
    assert.equal(shouldHintConfirmRemoval(slot, { minSuccessRate: 0.96 }),    false)
    assert.equal(shouldHintConfirmRemoval(slot, { minSuccessRate: 0.94 }),    true)
})

// ── Per-action threshold overrides ─────────────────────────────────────────

test('ACTION_THRESHOLDS — attendance.mark_present has the (0.90, 0.10) override', () => {
    const override = ACTION_THRESHOLDS[TIMELINE_ACTIONS.MARK_PRESENT]
    assert.ok(override)
    assert.equal(override.minSuccessRate, 0.90)
    assert.equal(override.maxErrorRate,   0.10)
})

test('ACTION_THRESHOLDS — top-level frozen + entry frozen (no mutation)', () => {
    assert.throws(() => { ACTION_THRESHOLDS.foo = 'bar' })
    assert.throws(() => { ACTION_THRESHOLDS[TIMELINE_ACTIONS.MARK_PRESENT].minSuccessRate = 0 })
})

test('ACTION_THRESHOLDS — other actions are NOT overridden (fall to global defaults)', () => {
    assert.equal(ACTION_THRESHOLDS[TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR],   undefined)
    assert.equal(ACTION_THRESHOLDS[TIMELINE_ACTIONS.MARK_ASSIGNMENT],     undefined)
})

test('getActionThresholds — known action returns the override', () => {
    const t = getActionThresholds(TIMELINE_ACTIONS.MARK_PRESENT)
    assert.equal(t.minSuccessRate, 0.90)
    assert.equal(t.maxErrorRate,   0.10)
})

test('getActionThresholds — unknown action returns global defaults', () => {
    const t = getActionThresholds('nope.unknown')
    assert.equal(t.minSuccessRate, MIN_SUCCESS_RATE)
    assert.equal(t.maxErrorRate,   MAX_ERROR_RATE)
})

test('getActionThresholds — non-overridden action returns global defaults', () => {
    const t = getActionThresholds(TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR)
    assert.equal(t.minSuccessRate, MIN_SUCCESS_RATE)
    assert.equal(t.maxErrorRate,   MAX_ERROR_RATE)
})

// ── 3-tier resolution in shouldHintConfirmRemoval ──────────────────────────

test('hint — opts.actionId for OVERRIDDEN action uses per-action thresholds', () => {
    // 9s + 1e in 10 cycles → success 90%, error 10%.
    // Without actionId: defaults 95%/5% → blocks (success 90% < 95%).
    // With actionId='attendance.mark_present': uses 90%/10% → passes.
    const slot = { click: 10, confirm: 10, success: 9, error: 1 }
    assert.equal(
        shouldHintConfirmRemoval(slot),
        false,
        'no actionId → global defaults block',
    )
    assert.equal(
        shouldHintConfirmRemoval(slot, { actionId: TIMELINE_ACTIONS.MARK_PRESENT }),
        true,
        'attendance actionId → per-action override surfaces the hint',
    )
})

test('hint — opts.actionId for NON-OVERRIDDEN action uses global defaults', () => {
    const slot = { click: 10, confirm: 10, success: 9, error: 1 }
    assert.equal(
        shouldHintConfirmRemoval(slot, { actionId: TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR }),
        false,
        'behaviour actionId → no override → global defaults block (90% < 95%)',
    )
    assert.equal(
        shouldHintConfirmRemoval(slot, { actionId: TIMELINE_ACTIONS.MARK_ASSIGNMENT }),
        false,
        'assignment actionId → no override → global defaults block',
    )
})

test('hint — explicit opts.* overrides per-action override (sweep precedence)', () => {
    // Same low-error slot. With per-action override (90%/10%): hint = ON.
    // With explicit minSuccessRate: 0.95 OVERRIDING the per-action 0.90:
    //   success 90% < 95% → blocks. Sweep can force stricter than per-action.
    const slot = { click: 10, confirm: 10, success: 9, error: 1 }
    assert.equal(
        shouldHintConfirmRemoval(slot, { actionId: TIMELINE_ACTIONS.MARK_PRESENT }),
        true,
    )
    assert.equal(
        shouldHintConfirmRemoval(slot, {
            actionId:       TIMELINE_ACTIONS.MARK_PRESENT,
            minSuccessRate: 0.95,   // explicit overrides per-action 0.90
        }),
        false,
    )
    assert.equal(
        shouldHintConfirmRemoval(slot, {
            actionId:     TIMELINE_ACTIONS.MARK_PRESENT,
            maxErrorRate: 0.05,     // explicit overrides per-action 0.10
        }),
        false,   // error 10% > 5% explicit override → blocks
    )
})

test('hint — backward compat: no actionId in opts → global defaults (existing behaviour)', () => {
    // Sanity check that adding actionId resolution didn't break the
    // panel-style call site (which won't pass actionId until updated).
    const slot = { click: 5, confirm: 5, success: 5, error: 0 }
    assert.equal(shouldHintConfirmRemoval(slot), true)  // clean → ON under defaults
})

test('hint — success/confirm < 0.95 → false (rate threshold)', () => {
    // 4/5 = 0.8 → no hint
    assert.equal(shouldHintConfirmRemoval({ click: 5, confirm: 5, success: 4, error: 0 }), false)
    // 18/20 = 0.9 → no hint
    assert.equal(shouldHintConfirmRemoval({ click: 20, confirm: 20, success: 18, error: 0 }), false)
})

test('hint — success/confirm >= 0.95 → true (with sufficient volume + zero errors)', () => {
    // 19/20 = 0.95 exact
    assert.equal(shouldHintConfirmRemoval({ click: 20, confirm: 20, success: 19, error: 0 }), true)
    // 100/100 = 1.0
    assert.equal(shouldHintConfirmRemoval({ click: 100, confirm: 100, success: 100, error: 0 }), true)
})

test('hint — typical "should hint" case (10 clicks, 8 confirms, all succeed)', () => {
    assert.equal(shouldHintConfirmRemoval({ click: 10, confirm: 8, success: 8, error: 0 }), true)
})

test('hint — typical "should NOT hint" case (mid-confidence with one error)', () => {
    // 10 clicks, 6 confirms, 5 succeed, 1 error → real failure mode, confirm doing work
    assert.equal(shouldHintConfirmRemoval({ click: 10, confirm: 6, success: 5, error: 1 }), false)
})

test('hint — recent-volume scenario (small but sufficient window)', () => {
    // Realistic: recent 60s window has 5 clicks, all confirmed and successful.
    // Under the OLD `confirm >= 5` gate this passed too; the new explicit
    // `click >= 5` gate reads more honestly when the panel feeds recent data.
    assert.equal(shouldHintConfirmRemoval({ click: 5, confirm: 5, success: 5, error: 0 }), true)
})

test('hint — recent-volume below threshold (panel will fall back to lifetime)', () => {
    // 3 clicks recent → no hint. The PANEL handles the fallback to lifetime
    // when recent.click === 0; this test only documents that the heuristic
    // itself stays strict on small samples.
    assert.equal(shouldHintConfirmRemoval({ click: 3, confirm: 3, success: 3, error: 0 }), false)
})

// ── validateSlot — funnel monotonicity invariants ──────────────────────────

const META_REQUIRES_CONFIRM = { requiresConfirm: true  }
const META_NO_CONFIRM       = { requiresConfirm: false }

const ZERO_COUNTS = {
    click: 0, confirm: 0, success: 0, error: 0,
    lastDurationMs: null, avgDurationMs: null,
}

test('validateSlot — null slot is valid (no data)', () => {
    const r = validateSlot(null, META_REQUIRES_CONFIRM)
    assert.equal(r.valid, true)
    assert.deepEqual(r.issues, [])
})

test('validateSlot — happy path 3-step (click ≥ confirm ≥ success + error)', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 5, confirm: 4, success: 3, error: 1 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, true)
})

test('validateSlot — equal counts at each level pass (click=confirm=success)', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 3, confirm: 3, success: 3, error: 0 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, true)
})

test('validateSlot — click < confirm flagged (3-step)', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 2, confirm: 3, success: 0, error: 0 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('click') && s.includes('confirm')))
})

test('validateSlot — confirm < success + error flagged (3-step)', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 5, confirm: 2, success: 2, error: 1 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('confirm') && s.includes('success + error')))
})

test('validateSlot — happy path 2-step (click ≥ success + error)', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 5, confirm: 0, success: 4, error: 1 },
        META_NO_CONFIRM,
    )
    assert.equal(r.valid, true)
})

test('validateSlot — 2-step click < success + error flagged', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 3, confirm: 0, success: 3, error: 1 },
        META_NO_CONFIRM,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('click') && s.includes('success + error')))
})

test('validateSlot — 2-step confirm > 0 is allowed (no false positive on policy drift)', () => {
    // Mid-session policy change could leave a stale confirm; we don't flag it.
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 5, confirm: 2, success: 5, error: 0 },
        META_NO_CONFIRM,
    )
    assert.equal(r.valid, true)
})

test('validateSlot — negative counts flagged', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: -1, confirm: 0, success: 0, error: 0 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('click < 0')))
})

test('validateSlot — NaN duration flagged', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 1, confirm: 1, success: 1, error: 0,
          lastDurationMs: NaN, avgDurationMs: 100 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('lastDurationMs')))
})

test('validateSlot — Infinity duration flagged', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 1, confirm: 1, success: 1, error: 0,
          lastDurationMs: 100, avgDurationMs: Infinity },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('avgDurationMs')))
})

test('validateSlot — null duration is allowed (not yet computed)', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 1, confirm: 1, success: 0, error: 0 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, true)
})

test('validateSlot — accumulates multiple issues', () => {
    const r = validateSlot(
        { ...ZERO_COUNTS, click: -1, confirm: 5, success: 10, error: 0,
          lastDurationMs: NaN, avgDurationMs: -5 },
        META_REQUIRES_CONFIRM,
    )
    assert.equal(r.valid, false)
    // negative click + click<confirm + confirm<success+error + bad lastDur + bad avgDur
    assert.ok(r.issues.length >= 4)
})

test('validateSlot — meta missing defaults to requiresConfirm=true', () => {
    // Same behaviour as getActionMeta — conservative default.
    const r = validateSlot(
        { ...ZERO_COUNTS, click: 2, confirm: 3, success: 0, error: 0 },
        null,
    )
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.includes('click') && s.includes('confirm')))
})

// ── validateRowSlots — lifetime + recent combined verdict ──────────────────
//
// The panel needs ONE call to learn whether a row should show the warning
// glyph. Combining lifetime + recent here (rather than at the panel call
// site) keeps the prefix-formatting logic testable.

test('validateRowSlots — both valid → valid + empty issues', () => {
    const lifetime = { ...ZERO_COUNTS, click: 5, confirm: 5, success: 5, error: 0 }
    const recent   = { ...ZERO_COUNTS, click: 2, confirm: 2, success: 2, error: 0 }
    const r = validateRowSlots(lifetime, recent, META_REQUIRES_CONFIRM)
    assert.equal(r.valid, true)
    assert.deepEqual(r.issues, [])
})

test('validateRowSlots — only LIFETIME invalid → issues prefixed "lifetime:"', () => {
    const lifetime = { ...ZERO_COUNTS, click: 2, confirm: 3, success: 0, error: 0 }  // click<confirm
    const recent   = { ...ZERO_COUNTS, click: 5, confirm: 5, success: 5, error: 0 }
    const r = validateRowSlots(lifetime, recent, META_REQUIRES_CONFIRM)
    assert.equal(r.valid, false)
    assert.ok(r.issues.length >= 1)
    assert.ok(r.issues.every(s => s.startsWith('lifetime:')))
})

test('validateRowSlots — only RECENT invalid → issues prefixed "recent:"', () => {
    const lifetime = { ...ZERO_COUNTS, click: 5, confirm: 5, success: 5, error: 0 }
    const recent   = { ...ZERO_COUNTS, click: 5, confirm: 2, success: 2, error: 1 }  // confirm<succ+err
    const r = validateRowSlots(lifetime, recent, META_REQUIRES_CONFIRM)
    assert.equal(r.valid, false)
    assert.ok(r.issues.length >= 1)
    assert.ok(r.issues.every(s => s.startsWith('recent:')))
})

test('validateRowSlots — both invalid → issues from each, prefixed', () => {
    const lifetime = { ...ZERO_COUNTS, click: 2, confirm: 3, success: 0, error: 0 }
    const recent   = { ...ZERO_COUNTS, click: 5, confirm: 2, success: 2, error: 1 }
    const r = validateRowSlots(lifetime, recent, META_REQUIRES_CONFIRM)
    assert.equal(r.valid, false)
    assert.ok(r.issues.some(s => s.startsWith('lifetime:')))
    assert.ok(r.issues.some(s => s.startsWith('recent:')))
    // Lifetime-prefixed issues come first (left-to-right narrative).
    assert.ok(r.issues[0].startsWith('lifetime:'))
})

test('validateRowSlots — null slots are valid (no data, no warning)', () => {
    const r = validateRowSlots(null, null, META_REQUIRES_CONFIRM)
    assert.equal(r.valid, true)
    assert.deepEqual(r.issues, [])
})

// ── getRecentSlot — sliding window aggregation ─────────────────────────────
//
// Time control via Date.now monkey-patch. Restored after each test (the
// beforeEach hook resets metrics; we restore the function inline).

const _origDateNow = Date.now
function withMockedNow(seq, fn) {
    let i = 0
    Date.now = () => seq[Math.min(i++, seq.length - 1)]
    try { fn() } finally { Date.now = _origDateNow }
}

test('getRecentSlot — empty metrics → zero slot', () => {
    const slot = getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT)
    assert.deepEqual(slot, { click: 0, confirm: 0, success: 0, error: 0 })
})

test('getRecentSlot — single event aggregates correctly', () => {
    // Each call: logTimelineAction (writes), getRecentSlot (reads).
    // Mock now() returns the same value for both so the event
    // is in-window when read.
    withMockedNow([100_000, 100_000], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    withMockedNow([100_010], () => {
        const slot = getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT)
        assert.equal(slot.click,   1)
        assert.equal(slot.confirm, 0)
        assert.equal(slot.success, 0)
        assert.equal(slot.error,   0)
    })
})

test('getRecentSlot — events older than window excluded', () => {
    // Push event at t=0, read at t=70_000 (10s past the 60s window).
    withMockedNow([0], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    withMockedNow([70_000], () => {
        const slot = getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT)
        assert.deepEqual(slot, { click: 0, confirm: 0, success: 0, error: 0 })
    })
})

test('getRecentSlot — boundary at exactly 60s (still excluded)', () => {
    // Event at t=0; read at t=60_000 → cutoff = 0 → e.ts (0) < cutoff (0) is false → INCLUDED.
    // Event at t=0; read at t=60_001 → cutoff = 1 → e.ts (0) < cutoff (1) is true  → EXCLUDED.
    withMockedNow([0], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    withMockedNow([60_000], () => {
        // Exactly at window edge — included (cutoff is strict less-than).
        assert.equal(getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT).click, 1)
    })
    withMockedNow([60_001], () => {
        // 1ms past the edge — excluded.
        assert.equal(getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT).click, 0)
    })
})

test('getRecentSlot — aggregates multiple phases in window', () => {
    withMockedNow([10_000], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    withMockedNow([10_100], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'confirm' })
    })
    withMockedNow([10_500], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'success', durationMs: 400 })
    })
    withMockedNow([10_500], () => {
        const slot = getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT)
        assert.equal(slot.click,   1)
        assert.equal(slot.confirm, 1)
        assert.equal(slot.success, 1)
        assert.equal(slot.error,   0)
    })
})

test('getRecentSlot — different actions tracked independently', () => {
    withMockedNow([5000], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,    phase: 'click' })
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_ASSIGNMENT, phase: 'click' })
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_ASSIGNMENT, phase: 'click' })
    })
    withMockedNow([5500], () => {
        assert.equal(getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT).click,    1)
        assert.equal(getRecentSlot(TIMELINE_ACTIONS.MARK_ASSIGNMENT).click, 2)
    })
})

test('getRecentSlot — custom windowMs param honoured', () => {
    withMockedNow([0], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    withMockedNow([5_000], () => {
        // 5s window; event at t=0 read at t=5000 → at the edge but
        // strict less-than means cutoff (5000-5000=0) ≤ ts (0), so included.
        assert.equal(getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT, 5_000).click, 1)
        // 1s window; same event is now 5s old → excluded.
        assert.equal(getRecentSlot(TIMELINE_ACTIONS.MARK_PRESENT, 1_000).click, 0)
    })
})

test('prune-on-write — old events drop from the in-memory log', () => {
    withMockedNow([0], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    withMockedNow([100_000], () => {
        // Write a new event 100s later. The first event was 100s
        // ago — outside the 60s window — so the prune should drop it.
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    // Confirm via internals — only the recent (second) event remains.
    const list = globalThis.__timelineMetrics.recentEvents[TIMELINE_ACTIONS.MARK_PRESENT]
    assert.equal(list.length, 1)
    assert.equal(list[0].ts, 100_000)
})

test('reset — clears recent events alongside aggregate', () => {
    withMockedNow([0], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    assert.ok(globalThis.__timelineMetrics.recentEvents[TIMELINE_ACTIONS.MARK_PRESENT])
    _resetTimelineMetrics()
    assert.equal(globalThis.__timelineMetrics, undefined)
    // After a fresh log, the recent events are starting from zero too.
    withMockedNow([1000], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    })
    const list = globalThis.__timelineMetrics.recentEvents[TIMELINE_ACTIONS.MARK_PRESENT]
    assert.equal(list.length, 1)
})

// ── buildSessionSnapshot ───────────────────────────────────────────────────

test('snapshot — empty metrics produce a well-formed empty snapshot', () => {
    const snap = buildSessionSnapshot()
    assert.ok(typeof snap.ts === 'number')
    assert.ok(typeof snap.iso === 'string')
    assert.deepEqual(snap.actions, {})
    assert.deepEqual(snap.recentErrors, [])
    assert.equal(snap.flags.forceError,  false)
    assert.equal(snap.flags.slowNetwork, false)
})

test('snapshot — captures lifetime + recent + recentEvents per action', () => {
    withMockedNow([1000], () => {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'confirm' })
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'success', durationMs: 250 })
    })
    withMockedNow([1500], () => {
        const snap = buildSessionSnapshot()
        const slot = snap.actions[TIMELINE_ACTIONS.MARK_PRESENT]
        assert.ok(slot)
        // Lifetime counters
        assert.equal(slot.lifetime.click,   1)
        assert.equal(slot.lifetime.confirm, 1)
        assert.equal(slot.lifetime.success, 1)
        assert.equal(slot.lifetime.error,   0)
        assert.equal(slot.lifetime.lastDurationMs, 250)
        // Recent slot (within window)
        assert.deepEqual(slot.recent, { click: 1, confirm: 1, success: 1, error: 0 })
        // Recent events list (3 entries)
        assert.equal(slot.recentEvents.length, 3)
        assert.equal(slot.recentEvents[0].phase, 'click')
    })
})

test('snapshot — flags reflect current global state', () => {
    globalThis.__SAIL_FORCE_ERROR__  = true
    globalThis.__SAIL_SLOW_NETWORK__ = false
    try {
        const snap = buildSessionSnapshot()
        assert.equal(snap.flags.forceError,  true)
        assert.equal(snap.flags.slowNetwork, false)
    } finally {
        delete globalThis.__SAIL_FORCE_ERROR__
        delete globalThis.__SAIL_SLOW_NETWORK__
    }
})

test('snapshot — captures recent errors ring', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'error', error: 'rls denied' })
    const snap = buildSessionSnapshot()
    assert.equal(snap.recentErrors.length, 1)
    assert.equal(snap.recentErrors[0].message, 'rls denied')
})

test('snapshot — JSON-serialisable (no functions, no circular refs)', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    const snap = buildSessionSnapshot()
    const json = JSON.stringify(snap)   // throws on circular / function values
    const round = JSON.parse(json)
    assert.deepEqual(round.actions, snap.actions)
})

test('snapshot — clones live data (consumer mutation cannot corrupt aggregate)', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    const snap = buildSessionSnapshot()
    // Mutate the snapshot's lifetime + recentEvents
    snap.actions[TIMELINE_ACTIONS.MARK_PRESENT].lifetime.click = 999
    snap.actions[TIMELINE_ACTIONS.MARK_PRESENT].recentEvents.push({ phase: 'fake', ts: 0 })
    // The live aggregate must be unchanged.
    assert.equal(globalThis.__timelineMetrics.byAction[TIMELINE_ACTIONS.MARK_PRESENT].click, 1)
    assert.equal(globalThis.__timelineMetrics.recentEvents[TIMELINE_ACTIONS.MARK_PRESENT].length, 1)
})

test('logTimelineAction — initialises window.__timelineMetrics on first call', () => {
    assert.equal(globalThis.__timelineMetrics, undefined)
    logTimelineAction({
        action: TIMELINE_ACTIONS.MARK_PRESENT,
        phase:  TIMELINE_PHASES.CLICK,
        rowKey: 'k1',
    })
    assert.ok(globalThis.__timelineMetrics)
    assert.ok(globalThis.__timelineMetrics.byAction)
    assert.deepEqual(
        Object.keys(globalThis.__timelineMetrics.byAction),
        [TIMELINE_ACTIONS.MARK_PRESENT],
    )
})

test('phase counts — click / confirm / success / error increment per action', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,      phase: 'click',   rowKey: 'k1' })
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,      phase: 'click',   rowKey: 'k2' })
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,      phase: 'confirm', rowKey: 'k1' })
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,      phase: 'success', rowKey: 'k1', durationMs: 100 })
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,      phase: 'error',   rowKey: 'k2', error: 'boom' })
    const slot = globalThis.__timelineMetrics.byAction[TIMELINE_ACTIONS.MARK_PRESENT]
    assert.equal(slot.click,   2)
    assert.equal(slot.confirm, 1)
    assert.equal(slot.success, 1)
    assert.equal(slot.error,   1)
})

test('duration — last + average tracked across multiple successes', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR, phase: 'success', durationMs: 100 })
    logTimelineAction({ action: TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR, phase: 'success', durationMs: 200 })
    logTimelineAction({ action: TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR, phase: 'success', durationMs: 300 })
    const slot = globalThis.__timelineMetrics.byAction[TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR]
    assert.equal(slot.success,         3)
    assert.equal(slot.lastDurationMs,  300)
    assert.equal(slot.totalDurationMs, 600)
    assert.equal(slot.avgDurationMs,   200)
})

test('different actions tracked independently', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT,      phase: 'click' })
    logTimelineAction({ action: TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR, phase: 'click' })
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_ASSIGNMENT,   phase: 'click' })
    const m = globalThis.__timelineMetrics.byAction
    assert.equal(m[TIMELINE_ACTIONS.MARK_PRESENT].click,      1)
    assert.equal(m[TIMELINE_ACTIONS.RESOLVE_BEHAVIOUR].click, 1)
    assert.equal(m[TIMELINE_ACTIONS.MARK_ASSIGNMENT].click,   1)
})

test('errors — ring buffer captures recent error messages', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'error', error: 'first' })
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'error', error: 'second' })
    const errors = globalThis.__timelineMetrics.recentErrors
    assert.equal(errors.length, 2)
    assert.equal(errors[0].message, 'first')
    assert.equal(errors[1].message, 'second')
    assert.ok(errors[0].ts)
})

test('errors — ring buffer capped (no unbounded growth)', () => {
    for (let i = 0; i < 50; i++) {
        logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'error', error: `err-${i}` })
    }
    const errors = globalThis.__timelineMetrics.recentErrors
    // Capacity is 25 by design; oldest should have been dropped.
    assert.equal(errors.length, 25)
    assert.equal(errors[0].message,  'err-25')
    assert.equal(errors[24].message, 'err-49')
})

test('malformed events are silently dropped', () => {
    logTimelineAction(null)
    logTimelineAction(undefined)
    logTimelineAction({})                  // missing action + phase
    logTimelineAction({ action: 'foo' })   // missing phase
    logTimelineAction({ phase: 'click' })  // missing action
    // Metrics should still be uninitialised — no event was recorded.
    assert.equal(globalThis.__timelineMetrics, undefined)
})

test('_resetTimelineMetrics — clears the aggregate', () => {
    logTimelineAction({ action: TIMELINE_ACTIONS.MARK_PRESENT, phase: 'click' })
    assert.ok(globalThis.__timelineMetrics)
    _resetTimelineMetrics()
    assert.equal(globalThis.__timelineMetrics, undefined)
})

// Restore console at end of suite (best-effort; node:test doesn't have afterAll-level hooks
// at the top level, so we leave the silencers in place — they only affect this test process).
void _origLog; void _origWarn
