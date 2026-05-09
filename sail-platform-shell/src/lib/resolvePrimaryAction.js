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
 *   actionId: string,            // stable enum id for telemetry/DOM hooks
 *   label: string,
 *   onClick: Function,
 *   disabled: boolean,
 *   variant: 'default' | 'confirming',
 *   requiresConfirm: boolean,
 * }}
 *
 * `requiresConfirm` declares the action's *policy*, not its current
 * state:
 *   * true   — the page-level handler runs the two-click arm/execute
 *              flow. Cascade labels: idle → confirming → marking.
 *   * false  — the page-level handler executes immediately on first
 *              click. Cascade labels: idle → marking (no
 *              "Confirm" intermediate). Per the data-driven policy
 *              decision: assignment submission is non-destructive
 *              and reversible, so the confirm step is friction
 *              without safety value.
 *
 * The flag is exposed on the action object (rather than buried in
 * the handler) so it's testable, declarative, and one place to
 * change the policy per domain. Handlers still own their own RPC
 * + matching, but their arming logic is gated on this flag.
 */

// Stable action identifiers — duplicated as string literals here
// (rather than imported from the telemetry module) to keep the
// resolver decoupled from React-adjacent code. The strings must
// stay in sync with TIMELINE_ACTIONS in timelineTelemetry.js;
// resolver tests assert each branch's value, so a divergence
// fails the test suite immediately.
const ACTION_ID_MARK_PRESENT      = 'attendance.mark_present'
const ACTION_ID_RESOLVE_BEHAVIOUR = 'behaviour.resolve'
const ACTION_ID_MARK_ASSIGNMENT   = 'assignment.mark_submitted'
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

function cascadeLabel({
    markingKey, confirmingKey, key,
    marking, confirming, idle,
    requiresConfirm = true,
}) {
    const isMarking    = markingKey === key
    // When the action skips the confirm step, the confirming branch
    // is unreachable by design — `confirmingKey` will never be set
    // to this row's key by the handler. Gating the branch here is
    // defensive: even if some other code path set the key, we never
    // flash "Confirm" on an action that doesn't have a confirm step.
    const isConfirming = !isMarking && requiresConfirm && confirmingKey === key
    const label = isMarking ? marking : (isConfirming ? confirming : idle)
    return {
        label,
        disabled: isMarking,
        variant:  isConfirming ? 'confirming' : 'default',
    }
}

function buildMarkPresentAction(row, state, onMarkPresent) {
    // Attendance correction is destructive (overwrites a recorded
    // status). Two-click confirm stays as a safety net.
    const requiresConfirm = true
    const { label, disabled, variant } = cascadeLabel({
        markingKey:    state.markingKey,
        confirmingKey: state.confirmingKey,
        key:           row.key,
        marking:       'Marking…',
        confirming:    'Confirm',
        idle:          'Mark present',
        requiresConfirm,
    })
    return {
        key: row.key,
        actionId: ACTION_ID_MARK_PRESENT,
        label,
        disabled,
        variant,
        requiresConfirm,
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
    // Assignment submission is non-destructive (acknowledgement,
    // not state correction) and reversible via Assignments page /
    // admin. Per the data-driven policy decision: skip the confirm
    // step. Friction without safety value.
    const requiresConfirm = false
    const { label, disabled, variant } = cascadeLabel({
        markingKey:    state.markingKey,
        confirmingKey: state.confirmingKey,
        key:           row.key,
        marking:       'Submitting…',
        confirming:    'Confirm',   // unreachable when requiresConfirm=false
        idle:          'Mark submitted',
        requiresConfirm,
    })
    return {
        key: row.key,
        actionId: ACTION_ID_MARK_ASSIGNMENT,
        label,
        disabled,
        variant,
        requiresConfirm,
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
    // Behaviour resolution closes a workflow item. Two-click confirm
    // stays as a safety net for now — once telemetry shows steady
    // success and rare reversals, this can revisit.
    const requiresConfirm = true
    const { label, disabled, variant } = cascadeLabel({
        markingKey:    state.markingKey,
        confirmingKey: state.confirmingKey,
        key:           row.key,
        marking:       'Resolving…',
        confirming:    'Confirm',
        idle:          'Resolve',
        requiresConfirm,
    })
    return {
        key: row.key,
        actionId: ACTION_ID_RESOLVE_BEHAVIOUR,
        label,
        disabled,
        variant,
        requiresConfirm,
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
