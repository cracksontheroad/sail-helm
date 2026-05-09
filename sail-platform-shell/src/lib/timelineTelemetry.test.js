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
