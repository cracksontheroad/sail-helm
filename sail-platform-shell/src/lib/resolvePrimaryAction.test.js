// Run with: `node --test src/lib/resolvePrimaryAction.test.js`
// Pure JS, no JSX, no bundler — tests the resolver directly.
//
// We deliberately test the BRANCH SELECTION + LABEL CASCADE behaviour,
// not the action contract shape (that's the renderer's concern). If a
// branch matches with an unexpected label, this catches it; if a row
// shape doesn't match any branch, we assert null; if the cascade priority
// (marking > confirming > default) drifts, we catch that too.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrimaryAction } from './resolvePrimaryAction.js'

const handlers = {
    onMarkPresent:      () => {},
    onResolveBehaviour: () => {},
}

const NO_STATE = { markingKey: null, confirmingKey: null }

// ── Attendance ─────────────────────────────────────────────────────────────

test('grouped attendance with non-present final status → Mark present', () => {
    const row = {
        kind: 'group',
        type: 'attendance',
        key:  '2026-05-09T14:00:00Z',
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
        runSize: 3,
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.ok(action)
    assert.equal(action.label, 'Mark present')
    assert.equal(action.disabled, false)
    assert.equal(action.variant, 'default')
    assert.equal(action.key, row.key)
})

test('grouped attendance with status=present → null (no-op affordance suppressed)', () => {
    const row = {
        kind: 'group',
        type: 'attendance',
        key:  '2026-05-09T14:00:00Z',
        meta: { status: 'present', class_id: 'c1', session_date: '2026-05-09' },
        runSize: 3,
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

test('attendance SINGLE (kind=single) → null (only groups get the affordance today)', () => {
    const row = {
        kind: 'single',
        type: 'attendance',
        key:  '2026-05-09T14:00:00Z',
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

// ── Behaviour ──────────────────────────────────────────────────────────────

test('behaviour single with status=open → Resolve', () => {
    const row = {
        kind: 'single',
        type: 'behaviour',
        key:  '2026-05-09T11:00:00Z',
        meta: { status: 'open', event_id: 'b1', class_id: 'c1' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.ok(action)
    assert.equal(action.label, 'Resolve')
    assert.equal(action.disabled, false)
    assert.equal(action.variant, 'default')
})

test('behaviour single with status=resolved → null', () => {
    const row = {
        kind: 'single',
        type: 'behaviour',
        key:  '2026-05-09T11:00:00Z',
        meta: { status: 'resolved', event_id: 'b1' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

test('behaviour single with no status → null (defensive)', () => {
    const row = {
        kind: 'single',
        type: 'behaviour',
        key:  '2026-05-09T11:00:00Z',
        meta: { event_id: 'b1' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

// ── State cascade (marking > confirming > default) ─────────────────────────

test('attendance cascade — confirmingKey match → label "Confirm" + variant=confirming', () => {
    const row = {
        kind: 'group', type: 'attendance', key: 'k1', runSize: 2,
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    const action = resolvePrimaryAction(row, { markingKey: null, confirmingKey: 'k1' }, handlers)
    assert.equal(action.label, 'Confirm')
    assert.equal(action.variant, 'confirming')
    assert.equal(action.disabled, false)
})

test('attendance cascade — markingKey wins over confirmingKey for the same row', () => {
    const row = {
        kind: 'group', type: 'attendance', key: 'k1', runSize: 2,
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    const action = resolvePrimaryAction(row, { markingKey: 'k1', confirmingKey: 'k1' }, handlers)
    assert.equal(action.label, 'Marking…')
    assert.equal(action.variant, 'default')   // disabled overrides variant rendering
    assert.equal(action.disabled, true)
})

test('behaviour cascade — markingKey match → "Resolving…"', () => {
    const row = {
        kind: 'single', type: 'behaviour', key: 'b1',
        meta: { status: 'open', event_id: 'b1' },
    }
    const action = resolvePrimaryAction(row, { markingKey: 'b1', confirmingKey: null }, handlers)
    assert.equal(action.label, 'Resolving…')
    assert.equal(action.disabled, true)
})

test('cascade keys for OTHER rows do not affect this row', () => {
    const row = {
        kind: 'group', type: 'attendance', key: 'k1', runSize: 2,
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    const action = resolvePrimaryAction(
        row,
        { markingKey: 'OTHER_ROW', confirmingKey: 'OTHER_ROW' },
        handlers,
    )
    assert.equal(action.label, 'Mark present')
    assert.equal(action.disabled, false)
    assert.equal(action.variant, 'default')
})

// ── Handler decoupling ─────────────────────────────────────────────────────

test('missing handler → null (the branch is not eligible if no handler)', () => {
    const row = {
        kind: 'group', type: 'attendance', key: 'k1', runSize: 2,
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    // No onMarkPresent passed → branch is gated off
    assert.equal(resolvePrimaryAction(row, NO_STATE, {}), null)
})

test('action.onClick invokes the passed handler with the expected context shape', () => {
    let captured = null
    const row = {
        kind: 'group', type: 'attendance', key: '2026-05-09T14:00Z', runSize: 4,
        meta: { status: 'late', class_id: 'c1', class_name: 'Maths', session_date: '2026-05-09', actor_id: 'u1' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, {
        onMarkPresent: (ctx) => { captured = ctx },
    })
    action.onClick()
    assert.deepEqual(captured, {
        runSize:           4,
        latestTs:          '2026-05-09T14:00Z',
        latestStatus:      'late',
        latestClassId:     'c1',
        latestClassName:   'Maths',
        latestSessionDate: '2026-05-09',
        latestActorId:     'u1',
    })
})

// ── Defensive ──────────────────────────────────────────────────────────────

test('null row → null (no crash on missing input)', () => {
    assert.equal(resolvePrimaryAction(null, NO_STATE, handlers), null)
})

test('row with no matching branch → null', () => {
    const row = {
        kind: 'single', type: 'assignment_assigned', key: 't1',
        meta: { class_id: 'c1' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})
