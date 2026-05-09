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
// Boundary tests around the three thresholds (confirm>=5, success/confirm>=0.95, error===0).
// The ratio-vs-strict-zero distinction matters: errors are signal, not noise.

test('hint — null/undefined slot → false (defensive)', () => {
    assert.equal(shouldHintConfirmRemoval(null),      false)
    assert.equal(shouldHintConfirmRemoval(undefined), false)
})

test('hint — confirm < 5 → false (insufficient sample)', () => {
    assert.equal(shouldHintConfirmRemoval({ confirm: 4, success: 4, error: 0 }), false)
    assert.equal(shouldHintConfirmRemoval({ confirm: 0, success: 0, error: 0 }), false)
})

test('hint — boundary at confirm = 5 (exact threshold passes)', () => {
    assert.equal(shouldHintConfirmRemoval({ confirm: 5, success: 5, error: 0 }), true)
})

test('hint — error > 0 → false (errors are signal, not noise)', () => {
    // Even one error blocks the hint, regardless of how many successes precede it.
    assert.equal(shouldHintConfirmRemoval({ confirm: 100, success: 99, error: 1 }), false)
    assert.equal(shouldHintConfirmRemoval({ confirm: 5,   success: 5,  error: 1 }), false)
})

test('hint — success/confirm < 0.95 → false (rate threshold)', () => {
    // 4/5 = 0.8 → no hint
    assert.equal(shouldHintConfirmRemoval({ confirm: 5, success: 4, error: 0 }), false)
    // 18/20 = 0.9 → no hint
    assert.equal(shouldHintConfirmRemoval({ confirm: 20, success: 18, error: 0 }), false)
})

test('hint — success/confirm >= 0.95 → true (with sufficient volume + zero errors)', () => {
    // 19/20 = 0.95 exact
    assert.equal(shouldHintConfirmRemoval({ confirm: 20, success: 19, error: 0 }), true)
    // 100/100 = 1.0
    assert.equal(shouldHintConfirmRemoval({ confirm: 100, success: 100, error: 0 }), true)
})

test('hint — typical "should hint" case (8 confirms, all succeed, no errors)', () => {
    assert.equal(shouldHintConfirmRemoval({ click: 10, confirm: 8, success: 8, error: 0 }), true)
})

test('hint — typical "should NOT hint" case (mid-confidence)', () => {
    // 6 confirms, 5 succeed, 1 error → real failure mode, confirm is doing work
    assert.equal(shouldHintConfirmRemoval({ click: 10, confirm: 6, success: 5, error: 1 }), false)
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
