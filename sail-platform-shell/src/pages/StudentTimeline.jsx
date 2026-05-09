import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getStudentTimeline } from '../services/timeline'

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
 * `action` (optional) shape: `{ label: string, onClick: fn }`.
 *   * Renders as a small button on the right side of the row.
 *   * Omitted entirely when null/undefined — no empty slot.
 *   * Click handling and any side-effects belong to the caller.
 *     This component only handles presentation.
 *   * Designed as the foundation for "action from context" — a
 *     row can offer one obvious next step. Multi-action rows or
 *     menus are explicitly out of scope here; if that's ever
 *     needed, replace `action` with `actions: []` and grow the
 *     slot, but defer until there's real demand.
 */
function TimelineRow({ icon, ariaLabel, isFirst, action, children }) {
    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '10px 14px',
                borderTop: isFirst ? 'none' : '1px solid #e3e6eb',
                fontSize: 13,
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
            {action && (
                <button
                    type="button"
                    onClick={action.onClick}
                    style={{
                        flexShrink: 0,
                        fontSize: 11.5,
                        padding: '4px 10px',
                        borderRadius: 4,
                        border: '1px solid #d4d8de',
                        background: '#fff',
                        color: '#3a4654',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        // Centered against the multi-line content column
                        // so the affordance reads as "row-level", not
                        // "title-level". When singles eventually get
                        // their own actions, the same vertical center
                        // looks right against a 1- or 2-line row too.
                        alignSelf: 'center',
                    }}
                >
                    {action.label}
                </button>
            )}
        </div>
    )
}

function SubtleLine({ children }) {
    return (
        <div style={{
            fontSize: 11.5,
            color: '#7a8290',
            marginTop: 2,
            whiteSpace: 'pre-wrap',
        }}>
            {children}
        </div>
    )
}

function renderSingle(e, i, isFirst) {
    const decor = TYPE_DECORATION[e.type] || { icon: '·', color: '#5b6877' }
    const subline = [
        eventSubtext(e),
        actorLabelFor(e),
        formatTimestamp(e.ts),
    ].filter(Boolean).join(' · ')
    return (
        <TimelineRow
            key={`single-${e.type}-${e.ts}-${i}`}
            icon={decor.icon}
            ariaLabel={e.type}
            isFirst={isFirst}
        >
            <div style={{ fontWeight: 500, color: decor.color }}>{e.title}</div>
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
function renderGroup(runDesc, i, isFirst, onMarkPresent) {
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

    // Action affordance — "Mark present" only when:
    //   (a) the page passed a handler (no handler = no slot),
    //   (b) the current/final status isn't already 'present' (no
    //       point offering an action that's a no-op).
    // Context payload is intentionally lean — just enough that a
    // future real-action wiring can reconstruct the operation
    // without re-querying. When the action is wired to a real
    // RPC, the caller will use `latestClassId`/`latestSessionDate`
    // to identify the session and `studentId` (closure-bound at
    // page level) to scope the write.
    const finalStatus = newest?.meta?.status
    const showMarkPresent =
        typeof onMarkPresent === 'function' &&
        finalStatus &&
        String(finalStatus).toLowerCase() !== 'present'
    const action = showMarkPresent
        ? {
            label: 'Mark present',
            onClick: () => onMarkPresent({
                runSize:           runDesc.length,
                latestTs:          newest.ts,
                latestStatus:      finalStatus,
                latestClassId:     newest?.meta?.class_id ?? null,
                latestClassName:   newest?.meta?.class_name ?? null,
                latestSessionDate: newest?.meta?.session_date ?? null,
                latestActorId:     newest?.meta?.actor_id ?? null,
            }),
        }
        : null

    return (
        <TimelineRow
            key={`group-attendance-${newest.ts}-${runDesc.length}-${i}`}
            icon={decor.icon}
            ariaLabel="attendance"
            isFirst={isFirst}
            action={action}
        >
            <div style={{ fontWeight: 500, color: decor.color }}>
                Attendance ({runDesc.length} updates)
            </div>
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

    // Placeholder action handler — wired from grouped attendance
    // rows via the row-level `action` slot. Logs only. The signature
    // and call-site shape are intentionally what a future real
    // implementation will need: studentId + schoolId from page
    // closure, plus a row-derived `context` payload (latest class,
    // latest session_date, etc.) that's enough to identify the
    // session without a re-fetch.
    //
    // When the real "mark present" RPC is wired, this is the one
    // function that needs to change — every grouped row passes
    // through it. No JSX, no row plumbing, no service-layer code
    // gets touched here.
    const onMarkPresent = (context) => {
        // eslint-disable-next-line no-console
        console.log('[Timeline] Mark present (placeholder — no backend wired yet)', {
            studentId,
            schoolId,
            ...context,
        })
    }

    return (
        <div style={{ padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
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
                            return renderGroup(item.events, i, isFirst, onMarkPresent)
                        }
                        return renderSingle(item.event, i, isFirst)
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
