// ═══════════════════════════════════════════════════════════════════════════
// Timeline — primary-action resolver
// ─────────────────────────────────────────────────────────────────────────
// Pure function. Given a row + interaction state + domain handlers, returns
// the single primary action that should render on that row, or null.
//
// PRODUCT RULE: at most ONE primary action per row. The resolver enforces
// this structurally (returns at most one action) AND with a dev-only
// console.warn when multiple branches could match — which shouldn't happen,
// but the guardrail is here so the system stays clean as more domains land.
//
// CONTRACT INVARIANTS:
//   * Pure: no side effects beyond the dev-only warn. Same inputs → same
//     output. Safe to call from a render path.
//   * Decoupled: action handlers are passed in, never imported. The
//     resolver knows nothing about Supabase, RPCs, fetching, or refetch
//     orchestration. That's why it's testable without mocks.
//   * Mutually exclusive: branches are written to be non-overlapping.
//     First match wins; the dev warn fires if more than one would have
//     matched.
//
// EXTENSION SHAPE:
//   New domain action = one new `if` block in this function + one new
//   handler key in the `handlers` object. Service wrapper + page-level
//   handler still live elsewhere; only the *decision logic* lives here.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the single primary action for a timeline row.
 *
 * @param {object} row
 *   @param {string} row.kind — 'single' | 'group'
 *   @param {string} row.type — 'attendance' | 'behaviour' | 'assignment_*'
 *   @param {string} row.key  — stable row anchor used by interaction state
 *                              slots (matches markingKey/confirmingKey).
 *   @param {object} row.meta — server-supplied event meta.
 *   @param {string=} row.title — single rows only.
 *   @param {number=} row.runSize — group rows only (cluster size).
 * @param {object} state
 *   @param {string|null} state.markingKey
 *   @param {string|null} state.confirmingKey
 * @param {object} handlers
 *   @param {Function=} handlers.onMarkPresent
 *   @param {Function=} handlers.onResolveBehaviour
 *   @param {Function=} handlers.onMarkAssignmentSubmitted
 *
 * @returns {null | {
 *   key: string,
 *   label: string,
 *   onClick: Function,
 *   disabled: boolean,
 *   variant: 'default' | 'confirming',
 * }}
 */
export function resolvePrimaryAction(row, state, handlers) {
    if (!row) return null
    const markingKey    = state?.markingKey    ?? null
    const confirmingKey = state?.confirmingKey ?? null
    const h             = handlers || {}

    // Collect all branches that match. Production read-out is the first
    // entry; the array exists so the dev-warn below can report when the
    // mutual-exclusion rule has been broken by a new branch.
    const matched = []

    // ── Branch: grouped attendance whose final status is not 'present'
    if (row.kind === 'group'
        && row.type === 'attendance'
        && row.meta?.status
        && String(row.meta.status).toLowerCase() !== 'present'
        && typeof h.onMarkPresent === 'function') {
        matched.push(buildMarkPresentAction(row, { markingKey, confirmingKey }, h.onMarkPresent))
    }

    // ── Branch: behaviour single with status='open'
    if (row.kind === 'single'
        && row.type === 'behaviour'
        && String(row.meta?.status ?? '').toLowerCase() === 'open'
        && typeof h.onResolveBehaviour === 'function') {
        matched.push(buildResolveBehaviourAction(row, { markingKey, confirmingKey }, h.onResolveBehaviour))
    }

    // ── Branch: assignment_assigned single with status='assigned'
    // Lifecycle: assigned → submitted → graded. Action only applies
    // to the first state; once submitted/graded the gate fails and
    // the affordance disappears on next render.
    if (row.kind === 'single'
        && row.type === 'assignment_assigned'
        && String(row.meta?.status ?? '').toLowerCase() === 'assigned'
        && typeof h.onMarkAssignmentSubmitted === 'function') {
        matched.push(buildMarkAssignmentSubmittedAction(row, { markingKey, confirmingKey }, h.onMarkAssignmentSubmitted))
    }

    // Dev-only guardrail — this should NEVER fire in production. If it
    // does, a new branch was added that can co-match with an existing
    // one and the one-action-per-row rule is at risk. The warn names
    // the labels so the offending pair is obvious in the console.
    if (matched.length > 1) {
        // eslint-disable-next-line no-console
        console.warn(
            '[Timeline] Multiple primary actions resolved for row — only the first is rendered. ' +
            'Tighten the resolver branches so they are mutually exclusive.',
            { row, candidates: matched.map(a => a.label) },
        )
    }

    return matched[0] ?? null
}

// ── Branch builders ────────────────────────────────────────────────────────
// Kept as small private helpers so each branch's label cascade lives next
// to its onClick wrapper. Keeping them inside the module (no export)
// preserves "the resolver is a single function" from the call-site's
// perspective.

function cascadeLabel({ markingKey, confirmingKey, key, marking, confirming, idle }) {
    const isMarking    = markingKey    === key
    const isConfirming = !isMarking && confirmingKey === key
    const label = isMarking ? marking : (isConfirming ? confirming : idle)
    return {
        label,
        disabled: isMarking,
        variant:  isConfirming ? 'confirming' : 'default',
    }
}

function buildMarkPresentAction(row, state, onMarkPresent) {
    const { label, disabled, variant } = cascadeLabel({
        markingKey:    state.markingKey,
        confirmingKey: state.confirmingKey,
        key:           row.key,
        marking:       'Marking…',
        confirming:    'Confirm',
        idle:          'Mark present',
    })
    return {
        key: row.key,
        label,
        disabled,
        variant,
        onClick: () => onMarkPresent({
            runSize:           row.runSize ?? 0,
            latestTs:          row.key,
            latestStatus:      row.meta?.status ?? null,
            latestClassId:     row.meta?.class_id ?? null,
            latestClassName:   row.meta?.class_name ?? null,
            latestSessionDate: row.meta?.session_date ?? null,
            latestActorId:     row.meta?.actor_id ?? null,
        }),
    }
}

function buildMarkAssignmentSubmittedAction(row, state, onMarkAssignmentSubmitted) {
    const { label, disabled, variant } = cascadeLabel({
        markingKey:    state.markingKey,
        confirmingKey: state.confirmingKey,
        key:           row.key,
        marking:       'Submitting…',
        confirming:    'Confirm',
        idle:          'Mark submitted',
    })
    return {
        key: row.key,
        label,
        disabled,
        variant,
        onClick: () => onMarkAssignmentSubmitted({
            studentAssignmentId: row.meta?.student_assignment_id ?? null,
            assignmentId:        row.meta?.assignment_id        ?? null,
            eventTs:             row.key,
            classId:             row.meta?.class_id   ?? null,
            className:           row.meta?.class_name ?? null,
        }),
    }
}

function buildResolveBehaviourAction(row, state, onResolveBehaviour) {
    const { label, disabled, variant } = cascadeLabel({
        markingKey:    state.markingKey,
        confirmingKey: state.confirmingKey,
        key:           row.key,
        marking:       'Resolving…',
        confirming:    'Confirm',
        idle:          'Resolve',
    })
    return {
        key: row.key,
        label,
        disabled,
        variant,
        onClick: () => onResolveBehaviour({
            eventId:    row.meta?.event_id ?? null,
            eventTs:    row.key,
            eventTitle: row.title ?? null,
            classId:    row.meta?.class_id ?? null,
            className:  row.meta?.class_name ?? null,
            note:       row.meta?.note ?? null,
        }),
    }
}
