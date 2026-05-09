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
    onMarkPresent:             () => {},
    onResolveBehaviour:        () => {},
    onMarkAssignmentSubmitted: () => {},
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

// ── Assignments ────────────────────────────────────────────────────────────

test('assignment_assigned single with status=assigned → Mark submitted', () => {
    const row = {
        kind: 'single',
        type: 'assignment_assigned',
        key:  '2026-05-01T07:09:52Z',
        meta: { status: 'assigned', student_assignment_id: 'sa1', assignment_id: 'a1', class_id: 'c1' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.ok(action)
    assert.equal(action.label, 'Mark submitted')
    assert.equal(action.disabled, false)
    assert.equal(action.variant, 'default')
})

test('assignment_assigned with status=submitted → null', () => {
    const row = {
        kind: 'single',
        type: 'assignment_assigned',
        key:  '2026-05-01T07:09:52Z',
        meta: { status: 'submitted', student_assignment_id: 'sa1', assignment_id: 'a1' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

test('assignment_assigned with status=graded → null', () => {
    const row = {
        kind: 'single',
        type: 'assignment_assigned',
        key:  '2026-05-01T07:09:52Z',
        meta: { status: 'graded', student_assignment_id: 'sa1', assignment_id: 'a1' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

test('assignment_GRADED row type → null (no overlap with assignment_assigned)', () => {
    const row = {
        kind: 'single',
        type: 'assignment_graded',
        key:  '2026-05-08T10:00:00Z',
        meta: { status: 'graded', student_assignment_id: 'sa1', assignment_id: 'a1' },
    }
    assert.equal(resolvePrimaryAction(row, NO_STATE, handlers), null)
})

test('assignment cascade — markingKey match → "Submitting…"', () => {
    const row = {
        kind: 'single', type: 'assignment_assigned', key: 'sa-row-1',
        meta: { status: 'assigned', student_assignment_id: 'sa1', assignment_id: 'a1' },
    }
    const action = resolvePrimaryAction(row, { markingKey: 'sa-row-1', confirmingKey: null }, handlers)
    assert.equal(action.label, 'Submitting…')
    assert.equal(action.disabled, true)
})

// Note: an earlier "assignment cascade — confirmingKey match → 'Confirm'"
// test was deleted when assignment moved to requiresConfirm=false. The
// "assignment cascade — confirmingKey match is IGNORED" test below
// covers the new (correct) behaviour for that input.

test('assignment onClick → handler receives expected payload (studentAssignmentId is the action key)', () => {
    let captured = null
    const row = {
        kind: 'single', type: 'assignment_assigned', key: '2026-05-01T07:09:52Z',
        meta: {
            status: 'assigned',
            student_assignment_id: 'sa-uuid',
            assignment_id: 'a-uuid',
            class_id: 'c-uuid',
            class_name: 'English',
        },
    }
    const action = resolvePrimaryAction(row, NO_STATE, {
        onMarkAssignmentSubmitted: (ctx) => { captured = ctx },
    })
    action.onClick()
    assert.deepEqual(captured, {
        studentAssignmentId: 'sa-uuid',
        assignmentId:        'a-uuid',
        eventTs:             '2026-05-01T07:09:52Z',
        classId:             'c-uuid',
        className:           'English',
    })
})

test('cross-domain isolation — open behaviour row does not match assignment branch', () => {
    const row = {
        kind: 'single', type: 'behaviour', key: 'b1',
        meta: { status: 'open', event_id: 'b1' },   // status=open is real for behaviour
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.ok(action)
    assert.equal(action.label, 'Resolve')   // not "Mark submitted"
})

test('cross-domain isolation — attendance group does not match assignment branch', () => {
    const row = {
        kind: 'group', type: 'attendance', key: 'k1', runSize: 2,
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.equal(action.label, 'Mark present')
})

// ── requiresConfirm (per-domain policy) ────────────────────────────────────

test('attendance branch advertises requiresConfirm=true', () => {
    const row = {
        kind: 'group', type: 'attendance', key: 'k1', runSize: 2,
        meta: { status: 'late', class_id: 'c1', session_date: '2026-05-09' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.equal(action.requiresConfirm, true)
})

test('behaviour branch advertises requiresConfirm=true', () => {
    const row = {
        kind: 'single', type: 'behaviour', key: 'b1',
        meta: { status: 'open', event_id: 'b1' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.equal(action.requiresConfirm, true)
})

test('assignment branch advertises requiresConfirm=false (data-driven policy)', () => {
    const row = {
        kind: 'single', type: 'assignment_assigned', key: 'sa-row-1',
        meta: { status: 'assigned', student_assignment_id: 'sa1', assignment_id: 'a1' },
    }
    const action = resolvePrimaryAction(row, NO_STATE, handlers)
    assert.equal(action.requiresConfirm, false)
})

test('assignment cascade — confirmingKey match is IGNORED (no "Confirm" label)', () => {
    // Defensive: even if confirmingKey somehow matches this row's key
    // (it shouldn't, since the handler never sets it for this domain),
    // the resolver suppresses the confirming branch for actions whose
    // policy is requiresConfirm=false.
    const row = {
        kind: 'single', type: 'assignment_assigned', key: 'sa-row-1',
        meta: { status: 'assigned', student_assignment_id: 'sa1', assignment_id: 'a1' },
    }
    const action = resolvePrimaryAction(
        row,
        { markingKey: null, confirmingKey: 'sa-row-1' },
        handlers,
    )
    assert.equal(action.label, 'Mark submitted')   // NOT 'Confirm'
    assert.equal(action.variant, 'default')
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
