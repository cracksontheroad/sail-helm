import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getStudentTimeline } from '../services/timeline'
import { markAttendancePresent } from '../services/attendance'
import { resolveBehaviourEvent } from '../services/behaviour'
import { markSubmissionReceived } from '../services/assignments'
import { resolvePrimaryAction } from '../lib/resolvePrimaryAction'

/**
 * /schools/:schoolId/students/:studentId/timeline — Phase D
 *
 * Read-only unified timeline for a single student. Pulls from
 * SAIL-core via bridge_get_student_timeline, which UNIONs:
 *   * attendance (attendance_records)
 *   * behaviour (behaviour_events)
 *   * assignment_assigned (student_assignments.created_at)
 *   * assignment_graded   (student_assignments.ai_graded_at, when set)
 *
 * Each row carries `{type, ts, title, meta}`. Titles are
 * human-readable and generated server-side — the UI renders them
 * verbatim with a per-type icon + a single subtle secondary line
 * combining contextual subtext, actor attribution, and timestamp.
 *
 * Actor enrichment (Phase D actor pass):
 *   * `meta.actor_name` is the resolved full name (or email fallback)
 *     of the user who recorded each event. Null when the source row
 *     has no recorded actor (e.g. legacy assignments with
 *     `created_by IS NULL`, or `assignment_graded` which has no
 *     `ai_graded_by` column). The UI omits the "by …" prefix in
 *     that case rather than block the row — matches the planner
 *     directive: leave actor null where missing.
 *
 * Density control (Phase D follow-up):
 *   * Consecutive `attendance` events on the same calendar day
 *     collapse into a single rendered cluster. UI-only — no
 *     RPC, schema, or service layer change. Other event types
 *     are never grouped, even when they fall on the same day.
 *     Grouping is purely a presentation concern; the underlying
 *     `events` array is unchanged, so pagination/cursor semantics
 *     keep working untouched.
 *
 * Strict scope (Timeline v1 contract):
 *   * No filters, pagination beyond a single limit, editing,
 *     analytics, or tooltips.
 *   * Two states: loading, error, empty, or list.
 *   * One central timestamp formatter — no per-row date math
 *     scattered through the JSX.
 */

const TYPE_DECORATION = {
    attendance:          { icon: '📋', color: '#3b6cd8' },
    behaviour:           { icon: '⚠️', color: '#a04545' },
    assignment_assigned: { icon: '📝', color: '#5b6877' },
    assignment_graded:   { icon: '✅', color: '#1f8a4d' },
}

// ────────────────────────────────────────────────────────────────────
// Hover affordance — CSS-only, no React state.
//
// Two effects when a row carries an `action`:
//   1. Action button sits at 0.65 opacity at rest, 1.0 on row hover.
//      Signals "this row does something" before interaction without
//      shouting on every row.
//   2. Subtle neutral-gray background tint on row hover. Distinct
//      from the pale-green "just-changed" highlight (`#e6f5ea`) so
//      hover and confirmed-action states never read the same.
//
// Why a `<style>` tag and not inline:
//   * `:hover` can't be expressed in inline `style={}` without
//     adding mouse-tracking React state — which the spec forbids.
//   * One static stylesheet per page mount is essentially free; the
//     browser deduplicates re-inserted identical style content.
//
// Why the inline highlight still wins:
//   * Inline styles trump CSS class rules on specificity. When
//     `highlighted=true`, the row sets `backgroundColor: #e6f5ea`
//     inline, which beats the CSS hover background. When
//     `highlighted=false`, the row OMITS the backgroundColor inline
//     so the CSS hover rule can take effect — that's why the row
//     style below uses a conditional spread, not `: 'transparent'`.
// ────────────────────────────────────────────────────────────────────
const TIMELINE_HOVER_CSS = `
.timeline-row-actionable:hover {
    background-color: #f7f8fa;
}
.timeline-row-actionable .timeline-row-action {
    opacity: 0.65;
}
.timeline-row-actionable:hover .timeline-row-action {
    opacity: 1;
}
/* ─────────────────────────────────────────────────────────────────
   Vertical rhythm — chunk groups, breathe singles.

   Grouped rows sit tighter (3px below) so consecutive clusters
   stack as a visual chunk; single rows get a touch more space
   (7px below) so each standalone event feels distinct.

   :last-child zeroes the margin so the bottom-most row sits flush
   against the container's bottom border — no orphaned gap.

   Pure margin, no separators or connectors. The existing borderTop
   between rows still draws the dividing line; the margin creates
   the rhythm in the negative space above each border.
─────────────────────────────────────────────────────────────────── */
.timeline-row-grouped {
    margin-bottom: 3px;
}
.timeline-row-single {
    margin-bottom: 7px;
}
.timeline-row-grouped:last-child,
.timeline-row-single:last-child {
    margin-bottom: 0;
}
`

function ErrorBox({ error }) {
    if (!error) return null
    return (
        <div style={{
            padding: '8px 12px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 4,
            color: '#991b1b',
            fontSize: 13,
            margin: '8px 0',
        }}>
            {error.message || String(error)}
        </div>
    )
}

function formatTimestamp(iso) {
    if (!iso) return ''
    try {
        const d = new Date(iso)
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        })
    } catch {
        return iso
    }
}

/**
 * Local-calendar-day key for an ISO timestamp. Used to decide
 * whether two consecutive attendance events should collapse into
 * a single grouped row. Local — not UTC — because the operator's
 * mental model of "same day" is the school's wall-clock day.
 */
function localDayKey(iso) {
    if (!iso) return null
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * Walk the (DESC-sorted) `events` list and produce a list of
 * display items, collapsing runs of consecutive same-day
 * `attendance` events into a single grouped item.
 *
 * Output items:
 *   { kind: 'single', event }   — render as a single row
 *   { kind: 'group',  events }  — render as one collapsed row
 *
 * Constraints (locked):
 *   * Only `type === 'attendance'` is grouped. All other types
 *     pass through as singles even if they share a day.
 *   * Only consecutive same-day attendance events collapse.
 *     A non-attendance event between two attendance events on
 *     the same day breaks the run — the post-break attendance
 *     events form a new candidate run.
 *   * A run of length 1 stays a single (no point collapsing one
 *     event — would just rename "Marked late" to "Attendance
 *     (1 update)" with no readability gain).
 */
function buildDisplayItems(events) {
    const items = []
    let i = 0
    while (i < events.length) {
        const head = events[i]
        if (head.type !== 'attendance') {
            items.push({ kind: 'single', event: head })
            i += 1
            continue
        }
        const day = localDayKey(head.ts)
        let j = i
        const run = []
        while (
            j < events.length &&
            events[j].type === 'attendance' &&
            localDayKey(events[j].ts) === day
        ) {
            run.push(events[j])
            j += 1
        }
        if (run.length >= 2) {
            items.push({ kind: 'group', events: run })
        } else {
            items.push({ kind: 'single', event: head })
        }
        i = j
    }
    return items
}

/**
 * Per-event subtext. Pulled from `meta` per the locked spec — never
 * required for a row to render its primary line. Behaviour notes get
 * surfaced because they're the most operationally useful detail;
 * attendance shows the session_date for context.
 */
function eventSubtext(event) {
    const m = event.meta || {}
    const cls = m.class_name ? `${m.class_name}` : null
    if (event.type === 'attendance') {
        return [m.session_date, cls].filter(Boolean).join(' · ')
    }
    if (event.type === 'behaviour') {
        return [m.note, cls].filter(Boolean).join(' — ')
    }
    if (event.type === 'assignment_assigned' || event.type === 'assignment_graded') {
        return cls
    }
    return null
}

// Page size — kept modest so first-page latency stays low. Operators
// who want more click "Load more"; the cursor scheme below pages
// monotonically backwards in time without overlap or duplicates.
const PAGE_SIZE = 50

/**
 * Resolve the "by …" actor label for a single event.
 * Resolution rules (locked):
 *   1. `meta.actor_name` populated → "by {actor_name}".
 *   2. Else if `type === 'assignment_graded'` → "by AI".
 *   3. Else → null (segment omitted at the call site).
 */
function actorLabelFor(event) {
    if (event?.meta?.actor_name) return `by ${event.meta.actor_name}`
    if (event?.type === 'assignment_graded') return 'by AI'
    return null
}

/**
 * Severity ordering for attendance status, used by the grouped-row
 * trend indicator. Lower index = better; higher = worse. Statuses
 * not in the map are treated as unranked → no trend arrow rendered
 * (safer than guessing a position for unfamiliar values like
 * "excused" if the schema ever adds one).
 */
const ATTENDANCE_SEVERITY = {
    present: 0,
    late:    1,
    absent:  2,
}

/**
 * Compare two attendance statuses (first → last) and return the
 * trend arrow:
 *   ↑ — final is more severe than first (worsened)
 *   ↓ — final is less severe than first (improved)
 *  null — equal, missing, or either is unranked
 */
function attendanceTrend(first, last) {
    if (!first || !last) return null
    const a = ATTENDANCE_SEVERITY[String(first).toLowerCase()]
    const b = ATTENDANCE_SEVERITY[String(last).toLowerCase()]
    if (a === undefined || b === undefined) return null
    if (b > a) return '↑'
    if (b < a) return '↓'
    return null
}

/**
 * Shared row chrome — icon column + flex content column +
 * optional right-aligned action slot. Both single and grouped
 * renderers share this scaffold so the visual rhythm of the
 * list stays uniform; only the content column and the presence
 * of the action vary between the two.
 *
 * `action` (optional) shape: `{ label, onClick, disabled?, variant? }`.
 *   * Renders as a small button on the right side of the row.
 *   * Omitted entirely when null/undefined — no empty slot.
 *   * Click handling and any side-effects belong to the caller.
 *     This component only handles presentation.
 *   * `disabled` (optional bool) is honoured by the button — a
 *     caller wires this true while a request is in-flight to
 *     prevent double-clicks and to swap the label to "Marking…"
 *     or similar.
 *   * `variant` (optional 'default' | 'confirming') tweaks the
 *     button styling without adding new components. The
 *     'confirming' variant is the second-step affordance for the
 *     two-click confirmation flow: amber border + bolder text +
 *     pale-amber background, signalling "this click executes".
 *     Disabled state still wins visually — a button that's both
 *     confirming and disabled is impossible by design.
 *   * Designed as the foundation for "action from context" — a
 *     row can offer one obvious next step. Multi-action rows or
 *     menus are explicitly out of scope here; if that's ever
 *     needed, replace `action` with `actions: []` and grow the
 *     slot, but defer until there's real demand.
 *
 * `highlighted` (optional bool) marks the row as "just changed
 * by your action". When true, the row paints with a soft pale-
 * green background; when subsequently flipped to false (after
 * the page-level timeout clears `recentlyUpdatedKey`) the
 * background transitions back to transparent over ~1.2s,
 * producing a fade-out without any animation library. No
 * fade-IN — the row appears already highlighted on mount,
 * which is the desired "your change is right here" cue.
 *
 * `isGrouped` (optional bool) signals that the row represents
 * a collapsed cluster of events (currently: same-day attendance
 * runs of length ≥2). When true, the row gets a thin low-
 * contrast left accent so groups visually chunk apart from
 * singles when scanning. The accent is structure, not signal —
 * intentionally desaturated and at the same hue as the body
 * palette so it never reads as status. Padding-left compensates
 * by 3px so grouped and single rows keep identical content
 * indentation; only the border itself is the visual difference.
 */
function TimelineRow({ icon, ariaLabel, isFirst, isGrouped, action, highlighted, children }) {
    // Class composition (page-level <style> handles the rules):
    //   * `timeline-row-grouped` / `timeline-row-single` — vertical
    //      rhythm. Consecutive grouped rows stack tightly (3px
    //      gap); singles get a touch more breathing room (7px).
    //      Both reset to 0 on :last-child so the bordered container
    //      doesn't end with an orphaned gap.
    //   * `timeline-row-actionable` — opt-in hover affordance for
    //      rows that carry an action.
    // Class assembly is done as a filtered join so absent variants
    // don't leak `undefined` into the className string.
    const className = [
        isGrouped ? 'timeline-row-grouped' : 'timeline-row-single',
        action ? 'timeline-row-actionable' : null,
    ].filter(Boolean).join(' ')
    return (
        <div
            className={className}
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                // Compensate left padding by 3px when the border is
                // present so the icon column lands at the same x
                // coordinate regardless of grouping. Top/right/bottom
                // padding stays constant; only left varies.
                padding: isGrouped ? '10px 14px 10px 11px' : '10px 14px',
                borderTop: isFirst ? 'none' : '1px solid #e3e6eb',
                // Subtle structural accent for grouped rows. Same
                // hue family as the body neutral (#3a4654) but at
                // 8% opacity — visible enough to chunk groups apart
                // when scanning, quiet enough to never read as
                // status or signal. No status-coloured variants;
                // grouping is structural, not semantic.
                borderLeft: isGrouped
                    ? '3px solid rgba(58, 70, 84, 0.08)'
                    : undefined,
                fontSize: 13,
                // Inline backgroundColor only when highlighted — this
                // is intentional. Setting `transparent` inline would
                // beat the CSS hover background; omitting it lets the
                // hover rule take effect for actionable rows. Inline
                // wins for highlighted rows so the success colour
                // never gets clobbered by hover.
                ...(highlighted ? { backgroundColor: '#e6f5ea' } : {}),
                transition: 'background-color 1.2s ease-out',
            }}
        >
            <span
                aria-hidden
                title={ariaLabel}
                style={{
                    fontSize: 14,
                    lineHeight: '1.4',
                    flexShrink: 0,
                    userSelect: 'none',
                }}
            >
                {icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
            {action && (() => {
                // Style resolution: disabled wins, then confirming,
                // then default. Keeping the cascade in one place
                // means every button state is fully described by a
                // single style object — no className gymnastics.
                const isConfirming = action.variant === 'confirming' && !action.disabled
                return (
                    <button
                        type="button"
                        // `timeline-row-action` hooks the button into
                        // the page-level hover affordance: 0.65 opacity
                        // at rest, 1.0 when the parent row is hovered.
                        // No JS needed.
                        className="timeline-row-action"
                        onClick={action.onClick}
                        disabled={Boolean(action.disabled)}
                        style={{
                            flexShrink: 0,
                            fontSize: 11.5,
                            padding: '4px 10px',
                            borderRadius: 4,
                            border: isConfirming
                                ? '1px solid #e1a648'
                                : '1px solid #d4d8de',
                            background: isConfirming
                                ? '#fff7ec'
                                : '#fff',
                            color: action.disabled
                                ? '#7a8290'
                                : (isConfirming ? '#7a4f00' : '#3a4654'),
                            fontWeight: isConfirming ? 500 : 400,
                            cursor: action.disabled ? 'wait' : 'pointer',
                            whiteSpace: 'nowrap',
                            // Centered against the multi-line content
                            // column so the affordance reads as "row-
                            // level", not "title-level". When singles
                            // eventually get their own actions, the
                            // same vertical center looks right against
                            // a 1- or 2-line row too.
                            alignSelf: 'center',
                            transition: 'background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out, opacity 150ms ease-out',
                        }}
                    >
                        {action.label}
                    </button>
                )
            })()}
        </div>
    )
}

// ── Visual hierarchy primitives ──────────────────────────────────
//
// The timeline lives or dies on scan-ability. Every row carries a
// primary signal (what happened) and 1–2 secondary lines (where,
// when, by whom). Rendering those at the same weight defeats the
// scan — operators end up reading instead of glancing.
//
// `RowTitle`     — primary event label. Type-color from
//                  TYPE_DECORATION provides the accent (blue for
//                  attendance, red for behaviour, etc.); weight 600
//                  separates it from the surrounding muted body.
// `SubtleLine`   — secondary metadata. Already muted via colour;
//                  the additional 0.85 opacity nudges it further
//                  down the visual hierarchy without introducing
//                  a new colour token.
//
// Both are used by both row renderers (single + group), so the
// hierarchy rules live in one place rather than scattered across
// inline styles.

function RowTitle({ color, children }) {
    return (
        <div style={{
            fontWeight: 600,
            color: color ?? '#3a4654',
        }}>
            {children}
        </div>
    )
}

function SubtleLine({ children }) {
    return (
        <div style={{
            fontSize: 11.5,
            color: '#7a8290',
            opacity: 0.85,
            marginTop: 2,
            whiteSpace: 'pre-wrap',
        }}>
            {children}
        </div>
    )
}

function renderSingle(
    e, i, isFirst,
    recentlyUpdatedKey, handlers, markingKey, confirmingKey,
) {
    const decor = TYPE_DECORATION[e.type] || { icon: '·', color: '#5b6877' }
    const subline = [
        eventSubtext(e),
        actorLabelFor(e),
        formatTimestamp(e.ts),
    ].filter(Boolean).join(' · ')
    // Primary action resolution is delegated to `resolvePrimaryAction` —
    // the single decision point that enforces "one primary action per
    // row" structurally and emits a dev warn if branches ever overlap.
    // To add a new action type for a row kind, edit the resolver, not
    // this call site. `handlers` is the page-level handler bag passed
    // straight through; the resolver picks the relevant one per branch.
    const primaryAction = resolvePrimaryAction(
        {
            kind:  'single',
            type:  e.type,
            key:   e.ts,
            title: e.title,
            meta:  e.meta,
        },
        { markingKey, confirmingKey },
        handlers,
    )
    return (
        <TimelineRow
            key={`single-${e.type}-${e.ts}-${i}`}
            icon={decor.icon}
            ariaLabel={e.type}
            isFirst={isFirst}
            action={primaryAction}
            highlighted={recentlyUpdatedKey === e.ts}
        >
            <RowTitle color={decor.color}>{e.title}</RowTitle>
            {subline && <SubtleLine>{subline}</SubtleLine>}
        </TimelineRow>
    )
}

/**
 * Render a collapsed cluster of consecutive same-day attendance
 * events. Receives the run pre-sorted DESC (newest first), per
 * the upstream timeline ordering.
 *
 * Layout (intentionally one extra subtle line than singles, to
 * visually telegraph "this is a cluster, not a single event"):
 *   📋  Attendance (N updates)
 *       Now {final_status} (was {prev_status} [→ ...])[ — class] [↑↓]
 *       by {newest_actor} · {newest_ts}
 *
 * Edge cases:
 *   * Status summary is state-oriented, not log-oriented: it
 *     leads with the current/final status and demotes the change
 *     path to a parenthetical. Matches the operator's question
 *     ("what is the student now?") rather than narrating
 *     bookkeeping. Previous statuses appear in chronological
 *     order (oldest → most recent prior) so the history reads
 *     left-to-right toward the current state.
 *   * Trend arrow (↑ / ↓) is appended at the end of the status
 *     line whenever the run involved a directional change in
 *     attendance severity. Lets an operator scan the timeline
 *     and see "stable / worsening / improving" without reading
 *     the parenthetical. Severity ordering: present < late <
 *     absent. Unknown statuses are unranked → no arrow rather
 *     than guess.
 *   * Class context is appended only when uniform across the
 *     run; mixed classes (rare but possible across multiple
 *     periods in a day) drop the suffix to avoid implying one.
 *   * Actor + timestamp use the newest event in the run — that's
 *     the most recent operator action and the right anchor for
 *     "when did this last change".
 */
function renderGroup(
    runDesc, i, isFirst,
    onMarkPresent, markingKey, recentlyUpdatedKey, confirmingKey,
) {
    const decor = TYPE_DECORATION.attendance
    const newest = runDesc[0]
    const chronological = [...runDesc].reverse()
    const statuses = chronological
        .map(ev => ev?.meta?.status)
        .filter(Boolean)
    // State-oriented summary: lead with the final (current) status,
    // demote everything before it to a parenthetical change path.
    // Joined with " → " so the history reads left-to-right toward
    // the current state. Defensive fallback to a bare "Now {final}"
    // if for some reason no previous statuses are recoverable —
    // shouldn't happen under the length≥2 group-formation guard,
    // but keeps the line non-empty either way.
    //
    // Trend arrow (↑/↓) appended at the end based on first vs last
    // status rank in `ATTENDANCE_SEVERITY` (present < late < absent).
    // Unknown statuses are unranked → no arrow. The trend reads
    // "first→last", same chronological direction as the parenthetical
    // history, so a worsening change always points up regardless of
    // how many intermediate statuses sit in between.
    let statusLine = null
    if (statuses.length >= 1) {
        const final = statuses[statuses.length - 1]
        const previous = statuses.slice(0, -1)
        statusLine = previous.length === 0
            ? `Now ${final}`
            : `Now ${final} (was ${previous.join(' → ')})`
        const trend = attendanceTrend(statuses[0], final)
        if (trend) statusLine = `${statusLine} ${trend}`
    }
    const classNames = new Set(
        runDesc.map(ev => ev?.meta?.class_name).filter(Boolean)
    )
    const uniformClass = classNames.size === 1 ? [...classNames][0] : null
    const contextLine = [statusLine, uniformClass].filter(Boolean).join(' — ')

    const actorAndTs = [
        actorLabelFor(newest),
        formatTimestamp(newest.ts),
    ].filter(Boolean).join(' · ')

    // Primary action resolution is delegated to `resolvePrimaryAction` —
    // the single decision point that enforces "one primary action per
    // row" structurally. This call site only assembles the row-shape
    // input; the resolver owns the branch decisions, label cascade,
    // and onClick wiring.
    const primaryAction = resolvePrimaryAction(
        {
            kind:    'group',
            type:    'attendance',
            key:     newest.ts,
            meta:    newest?.meta ?? {},
            runSize: runDesc.length,
        },
        { markingKey, confirmingKey },
        { onMarkPresent },
    )

    return (
        <TimelineRow
            key={`group-attendance-${newest.ts}-${runDesc.length}-${i}`}
            icon={decor.icon}
            ariaLabel="attendance"
            isFirst={isFirst}
            isGrouped
            action={primaryAction}
            highlighted={recentlyUpdatedKey === newest.ts}
        >
            <RowTitle color={decor.color}>
                Attendance ({runDesc.length} updates)
            </RowTitle>
            {contextLine && <SubtleLine>{contextLine}</SubtleLine>}
            {actorAndTs && <SubtleLine>{actorAndTs}</SubtleLine>}
        </TimelineRow>
    )
}

export default function StudentTimelinePage() {
    const { schoolId, studentId } = useParams()

    const [events,      setEvents]      = useState([])
    const [loading,     setLoading]     = useState(true)   // initial load
    const [loadingMore, setLoadingMore] = useState(false)  // subsequent pages
    const [error,       setError]       = useState(null)
    // hasMore is set after each fetch: true iff the server returned a full
    // page. A short page means we hit the bottom of the timeline; the
    // "Load more" button hides.
    const [hasMore,     setHasMore]     = useState(true)
    // markingKey = the run anchor (newest event ts) of the grouped
    // attendance row currently being mark-presented. Null when no
    // request is in flight. Single string instead of a set because
    // the action is per-row and we don't currently support
    // overlapping concurrent marks across rows; the second click
    // is no-op'd via the same key check.
    const [markingKey,  setMarkingKey]  = useState(null)
    // recentlyUpdatedKey = the run anchor (newest event ts) of the
    // row to highlight as "just changed by your action". Set after
    // a successful mark-present + refetch by scanning the refetched
    // events for the matching (class_id, session_date) attendance
    // row and capturing its post-update ts (which is `now()` from
    // the RPC). Cleared after a short timeout so the highlight
    // fades away. Same shape as `markingKey` so the row renderers
    // can use a single equality check against either.
    const [recentlyUpdatedKey, setRecentlyUpdatedKey] = useState(null)

    // confirmingKey = the run anchor of the row currently in the
    // "armed for confirmation" state. First click on Mark present
    // sets this; second click within ~3s executes the mutation.
    // No third state needed — once execution starts, `markingKey`
    // takes over and `confirmingKey` clears. Same identity shape
    // as the others, so the renderer's equality checks are
    // uniform: marking > confirming > default.
    const [confirmingKey, setConfirmingKey] = useState(null)

    // Auto-clear the highlight after a brief window. Using an effect
    // tied to the key means: if a second mark-present completes
    // before the previous fade finishes, the previous timer is
    // cleared via the cleanup and a new one starts — no overlap,
    // no stale clears, no leaked timers on unmount.
    useEffect(() => {
        if (!recentlyUpdatedKey) return undefined
        const t = setTimeout(() => setRecentlyUpdatedKey(null), 2500)
        return () => clearTimeout(t)
    }, [recentlyUpdatedKey])

    // Auto-disarm confirmation if the operator doesn't follow
    // through. Same effect shape as the highlight clear — cleanup
    // cancels the previous timer if confirmation moves to a
    // different row before the timeout, so the new row's window
    // is full-length.
    useEffect(() => {
        if (!confirmingKey) return undefined
        const t = setTimeout(() => setConfirmingKey(null), 3000)
        return () => clearTimeout(t)
    }, [confirmingKey])

    // Initial-page load.
    useEffect(() => {
        let alive = true
        async function load() {
            if (!schoolId || !studentId) return
            setLoading(true); setError(null)
            try {
                const rows = await getStudentTimeline({
                    schoolId, studentId, limit: PAGE_SIZE,
                })
                if (alive) {
                    setEvents(rows)
                    setHasMore(rows.length >= PAGE_SIZE)
                }
            } catch (err) {
                if (alive) { setError(err); setEvents([]); setHasMore(false) }
            } finally {
                if (alive) setLoading(false)
            }
        }
        load()
        return () => { alive = false }
    }, [schoolId, studentId])

    // "Load more" — cursor = last visible event's ts. Strict "<" on the
    // server side, so the same row never appears in two pages. Append
    // results to the existing list (the page is monotonically older).
    const loadMore = async () => {
        if (loadingMore || loading || events.length === 0) return
        setLoadingMore(true); setError(null)
        try {
            const lastTs = events[events.length - 1].ts
            const rows = await getStudentTimeline({
                schoolId, studentId, limit: PAGE_SIZE, beforeTs: lastTs,
            })
            setEvents((prev) => [...prev, ...rows])
            setHasMore(rows.length >= PAGE_SIZE)
        } catch (err) {
            setError(err)
        } finally {
            setLoadingMore(false)
        }
    }

    // Action handler for grouped attendance rows — calls the
    // bridge_mark_attendance_present RPC, then refetches the
    // timeline so the just-marked row reflows through the same
    // grouping/state-summary path as a fresh load.
    //
    // Two-click confirmation flow:
    //   * First click on a row that isn't currently confirming →
    //     arm confirmation (set confirmingKey, button label flips
    //     to "Confirm"), and return without calling the RPC.
    //   * Second click on the SAME row while it's still armed →
    //     clear confirmingKey, set markingKey, fire the RPC.
    //   * Click on a DIFFERENT row while another row is armed →
    //     the new row arms; the old row's confirmation drops via
    //     the equality check (only the row whose key matches
    //     confirmingKey shows "Confirm").
    //   * Auto-disarm timer (3s) reverts to "Mark present" if the
    //     operator doesn't follow through.
    //
    // Concurrency: a second click on the same (or any) row while
    // a request is in flight is a no-op. The disabled state on the
    // button is the primary block; the early-return is belt-and-
    // braces in case state hasn't propagated yet.
    //
    // Recovery: refetch is the source of truth — no optimistic
    // update of `events`. The grouping logic, trend arrow, etc.
    // all derive from `events`, and refetching avoids the trap of
    // hand-editing one event in the middle of a sorted UNION.
    // Action handler for assignment_assigned rows — flips a
    // student_assignment from 'assigned' to 'submitted' via the
    // existing bridge_mark_submission_received RPC, then refetches.
    //
    // Same state machine + pre-highlight + re-anchor pattern as the
    // other handlers. Re-anchor matches by student_assignment_id
    // (stable across the status change; created_at doesn't shift on
    // submission, same as behaviour resolve).
    //
    // Notable: this handler reuses the existing
    // `markSubmissionReceived` service wrapper rather than introducing
    // a new RPC — `bridge_mark_submission_received` already implements
    // the same SECURITY DEFINER + permission gate (`is_staff_of_school
    // OR has_permission('assignments.write')`) + audit pattern as the
    // other quick-actions, so a duplicate would be dead weight. The
    // audit surface tag in that RPC defaults to 'helm.assignments';
    // attribution from the timeline is captured via the semantic
    // 'submission.received' event regardless of surface.
    const onMarkAssignmentSubmitted = async (context) => {
        if (markingKey) return
        if (!context?.studentAssignmentId) {
            // eslint-disable-next-line no-console
            console.error('[Timeline] Mark submitted: missing student_assignment_id', context)
            return
        }
        const key = context.eventTs
        if (confirmingKey !== key) {
            setConfirmingKey(key)
            return
        }
        setConfirmingKey(null)
        setMarkingKey(key)
        setRecentlyUpdatedKey(key)
        try {
            await markSubmissionReceived(context.studentAssignmentId)
            const rows = await getStudentTimeline({
                schoolId, studentId, limit: PAGE_SIZE,
            })
            setEvents(rows)
            setHasMore(rows.length >= PAGE_SIZE)
            // Re-anchor by student_assignment_id. The row's ts is
            // unchanged (created_at doesn't shift on submission), so
            // the matched row's ts == the pre-highlight key. Setting
            // it again restarts the highlight effect's timer cleanly.
            const updated = (rows || []).find(r =>
                r.type === 'assignment_assigned' &&
                r.meta?.student_assignment_id === context.studentAssignmentId &&
                String(r.meta?.status).toLowerCase() === 'submitted'
            )
            if (updated?.ts) setRecentlyUpdatedKey(updated.ts)
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[Timeline] Mark submitted failed:', err)
        } finally {
            setMarkingKey(null)
        }
    }

    // Real action handler for behaviour rows — replaces the earlier
    // "Add note" placeholder. Resolves an open behaviour event via
    // bridge_resolve_behaviour_event, then refetches the timeline.
    //
    // Reuses the SAME state slots as onMarkPresent — no new state.
    // Each slot is keyed by row anchor (`context.eventTs`), so the
    // confirming/marking/recentlyUpdated cascade works identically.
    // The two handlers are parallel because each domain owns its
    // own RPC call + post-refetch matching, but they share the
    // interaction system completely (cascade, pre-highlight, refetch,
    // re-anchor).
    //
    // Behaviour timestamp semantics: behaviour_events.created_at is
    // WHEN the incident happened, not WHEN it was last touched.
    // Resolving doesn't change created_at, so the row keeps its
    // position in the timeline AND its `ts` value. The post-refetch
    // re-anchor matches by event_id (carried in meta) — id-based
    // match is the only honest re-anchor when ts is stable.
    const onResolveBehaviour = async (context) => {
        if (markingKey) return
        if (!context?.eventId) {
            // eslint-disable-next-line no-console
            console.error('[Timeline] Resolve behaviour: missing event_id', context)
            return
        }
        const key = context.eventTs
        // First click → arm.
        if (confirmingKey !== key) {
            setConfirmingKey(key)
            return
        }
        // Second click → execute.
        setConfirmingKey(null)
        setMarkingKey(key)
        // Pre-highlight (same pattern as mark-present): immediate
        // visual ack, not optimistic data.
        setRecentlyUpdatedKey(key)
        try {
            await resolveBehaviourEvent({ eventId: context.eventId })
            const rows = await getStudentTimeline({
                schoolId, studentId, limit: PAGE_SIZE,
            })
            setEvents(rows)
            setHasMore(rows.length >= PAGE_SIZE)
            // Re-anchor by event_id. Behaviour rows keep their ts on
            // resolve (created_at doesn't shift), so the matched
            // row's ts is == the pre-highlight key. The set is still
            // performed so the highlight effect's cleanup-canceling
            // timer restarts cleanly with a fresh 2.5s window.
            const updated = (rows || []).find(r =>
                r.type === 'behaviour' &&
                r.meta?.event_id === context.eventId &&
                String(r.meta?.status).toLowerCase() === 'resolved'
            )
            if (updated?.ts) setRecentlyUpdatedKey(updated.ts)
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[Timeline] Resolve behaviour failed:', err)
        } finally {
            setMarkingKey(null)
        }
    }

    const onMarkPresent = async (context) => {
        if (markingKey) return                        // already marking another row
        if (!context?.latestClassId || !context?.latestSessionDate) {
            // Defensive — under normal flow the timeline always
            // carries class_id + session_date for attendance events.
            // Logging without throwing keeps the UI responsive.
            // eslint-disable-next-line no-console
            console.error('[Timeline] Mark present: missing class_id or session_date', context)
            return
        }
        const key = context.latestTs
        // First click on this row → arm confirmation, don't fire.
        if (confirmingKey !== key) {
            setConfirmingKey(key)
            return
        }
        // Second click on the same row → clear confirmation and
        // proceed. Clearing here (not in the .finally) means the
        // button visually flips out of the "Confirm" state the
        // moment the request starts; the disabled "Marking…"
        // state takes over without a flash of "Mark present".
        setConfirmingKey(null)
        setMarkingKey(key)
        // Pre-highlight (optimistic VISUAL only, not optimistic
        // DATA). Anchors the green highlight on the same row the
        // operator just clicked, so they get an immediate "we
        // heard you" cue without waiting on the round-trip.
        //
        // What this is NOT:
        //   * Not an optimistic data update — `events` is still
        //     refetched from the server as the source of truth.
        //   * Not a skip-refetch — every other code path stays
        //     identical.
        //
        // What happens after the RPC returns:
        //   * Success → the post-refetch logic below finds the
        //     just-updated row (by class_id + session_date +
        //     status='present') and re-anchors `recentlyUpdatedKey`
        //     to its NEW ts. The cleanup-canceling effect on
        //     `recentlyUpdatedKey` cancels the pre-highlight timer
        //     and starts a fresh 2.5s window from the post-refetch
        //     moment. The transition is visually seamless because
        //     React batches both state updates into one render.
        //   * Failure → no re-anchor happens; the pre-highlight's
        //     timer fires after 2.5s and clears naturally. No
        //     stale highlight, no inconsistency, no manual
        //     rollback path.
        setRecentlyUpdatedKey(key)
        try {
            await markAttendancePresent({
                studentId,
                classId:     context.latestClassId,
                sessionDate: context.latestSessionDate,
            })
            // Refetch (replace, reset cursor + hasMore). Same shape
            // as initial load — the just-marked row will collapse
            // into its same-day cluster and the trend arrow will
            // re-derive automatically.
            const rows = await getStudentTimeline({
                schoolId, studentId, limit: PAGE_SIZE,
            })
            setEvents(rows)
            setHasMore(rows.length >= PAGE_SIZE)
            // Visual confirmation — find the just-updated attendance
            // event in the refetched list (matched on the action's
            // (class_id, session_date) pair, with status='present')
            // and stash its new ts as the highlight key. The grouping
            // walker uses `newest.ts` as a group's identity, and a
            // single non-grouped event uses its own ts, so the same
            // key drives both render paths via the equality checks
            // in renderSingle / renderGroup.
            //
            // We use the FIRST matching event because the post-RPC
            // `recorded_at = now()` puts it at the top of any same-
            // day cluster — equivalent to `runDesc[0]` for the run
            // that newly contains it. If no match is found (RLS
            // filter, pagination edge), the highlight is silently
            // skipped — the action still landed.
            const updated = (rows || []).find(r =>
                r.type === 'attendance' &&
                r.meta?.class_id     === context.latestClassId &&
                r.meta?.session_date === context.latestSessionDate &&
                String(r.meta?.status).toLowerCase() === 'present'
            )
            if (updated?.ts) setRecentlyUpdatedKey(updated.ts)
        } catch (err) {
            // No toast system yet — surface to console so dev/QA
            // can see RLS/permission rejections, missing-session
            // (P0002), etc. The button re-enables via the finally
            // clause regardless.
            // eslint-disable-next-line no-console
            console.error('[Timeline] Mark present failed:', err)
        } finally {
            setMarkingKey(null)
        }
    }

    return (
        <div style={{ padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
            {/* Page-scoped hover affordance rules. Injected once per
                mount; the browser dedupes identical content across
                rerenders. See TIMELINE_HOVER_CSS for the rationale on
                why hover is CSS-only and how it composes with the
                inline highlight. */}
            <style>{TIMELINE_HOVER_CSS}</style>
            <div style={{ marginBottom: 12 }}>
                {/* Phase D pair-route — deterministic Back to the
                    student parent page. Works on hard refresh /
                    deep-link without relying on browser history. */}
                <Link
                    to={`/schools/${schoolId}/students/${studentId}`}
                    style={{ fontSize: 12, color: '#5b6877' }}
                >
                    ← Back to student
                </Link>
            </div>
            <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Student timeline</h1>
            <div style={{ fontSize: 13, color: '#5b6877', marginBottom: 16 }}>
                Unified view of attendance, behaviour, and assignment events.
            </div>

            <ErrorBox error={error} />

            {loading ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>Loading timeline…</div>
            ) : events.length === 0 ? (
                <div style={{ color: '#7a8290', fontSize: 13 }}>
                    No activity yet for this student.
                </div>
            ) : (
                <div style={{ border: '1px solid #e3e6eb', borderRadius: 6 }}>
                    {buildDisplayItems(events).map((item, i) => {
                        const isFirst = i === 0
                        if (item.kind === 'group') {
                            return renderGroup(
                                item.events, i, isFirst,
                                onMarkPresent, markingKey, recentlyUpdatedKey, confirmingKey,
                            )
                        }
                        // Single-row handlers travel as a bag so the
                        // resolver can pick the one matching the
                        // branch. Adding a fourth single-row action
                        // type adds one entry here, plus the matching
                        // entries in the resolver and a service
                        // wrapper — no other plumbing.
                        return renderSingle(
                            item.event, i, isFirst,
                            recentlyUpdatedKey,
                            { onResolveBehaviour, onMarkAssignmentSubmitted },
                            markingKey, confirmingKey,
                        )
                    })}
                </div>
            )}

            {/* Load more — visible only when:
                - the initial page loaded successfully
                - the most recent fetch returned a full page (so there
                  may be more events older than the current bottom row).
                Hides when we've drained the timeline. */}
            {!loading && events.length > 0 && hasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                    <button
                        type="button"
                        onClick={loadMore}
                        disabled={loadingMore}
                        style={{
                            fontSize: 12.5,
                            padding: '6px 14px',
                            borderRadius: 4,
                            border: '1px solid #d4d8de',
                            background: '#fff',
                            color: '#3a4654',
                            cursor: loadingMore ? 'wait' : 'pointer',
                        }}
                    >
                        {loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                </div>
            )}
        </div>
    )
}
