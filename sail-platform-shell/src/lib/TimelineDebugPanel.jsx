// ═══════════════════════════════════════════════════════════════════════════
// Timeline — dev-only debug overlay
// ─────────────────────────────────────────────────────────────────────────
// Reads from `window.__timelineMetrics` (populated by
// `logTimelineAction` in timelineTelemetry.js) and surfaces it
// live on screen so a dev can WATCH the action loop behave instead
// of inspecting a console blob between clicks.
//
// CONSTRAINTS:
//   * Production build: returns null. Gated on
//     `process.env.NODE_ENV !== 'production'` (Vite replaces this
//     with the literal at build time so it dead-codes cleanly).
//   * No props. No subscription. Just `setInterval` at 500ms +
//     `useState` to force re-render. The metrics aggregate is the
//     source of truth; this component is a window onto it.
//   * No styling polish. This is an instrument, not a feature —
//     a temporary overlay that exists to inform the next round of
//     iteration, not to look good in production.
//   * No persistence, no backend call, no new global state.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react'
import {
    getActionMeta,
    shouldHintConfirmRemoval,
    validateRowSlots,
    getRecentSlot,
    buildSessionSnapshot,
} from './timelineTelemetry'

// Module-level constant. Vite replaces `process.env.NODE_ENV` with
// the literal at build time → in a production bundle this becomes
// `const IS_DEV = !('production' === 'production')` → `false` → the
// component dead-codes to `return null` and the Hooks-rules concern
// (calling hooks conditionally) is moot because the early-return
// short-circuits before any hook runs.
const IS_DEV = !(typeof process !== 'undefined'
    && process.env?.NODE_ENV === 'production')

// Render order + display labels for the three action types. Closed
// list — when a fourth domain lands, add a row here. The `short`
// label feeds the compact "spam" buttons in the control strip.
const ACTION_LABELS = [
    { key: 'attendance.mark_present',     label: 'Mark present',   short: 'present' },
    { key: 'behaviour.resolve',           label: 'Resolve',        short: 'resolve' },
    { key: 'assignment.mark_submitted',   label: 'Mark submitted', short: 'submit'  },
]

// Stress-test parameters. Tuned empirically: 8 clicks at 80ms gives
// React a render cycle between each click while still feeling like
// a "rapid burst" — fast enough to test markingKey blocking but
// not so synchronous that all clicks see the same stale closure
// state. Tweak in source if the stress shape needs to change.
const SPAM_CLICK_COUNT      = 8
const SPAM_CLICK_INTERVAL_MS = 80

// Sliding-window for the "recent" line in each row. Matches the
// default in timelineTelemetry.js so the label stays honest if
// either side ever changes.
const RECENT_WINDOW_MS = 60_000

/**
 * Build the snapshot, JSON-encode it, and trigger a browser
 * download of `timeline-debug-<ts>.json`. Returns the snapshot
 * object so a console invocation
 * (`window.__SAIL_DEBUG_EXPORT__()`) can inspect inline as well
 * as save to disk.
 *
 * Module-scope so the function reference is stable across
 * renders — that's what lets the useEffect cleanup compare
 * `globalThis.__SAIL_DEBUG_EXPORT__ === downloadSessionSnapshot`
 * to safely unregister only the one this panel mounted.
 *
 * Defensive: if `document` or `URL` is missing (SSR, headless
 * test runner), the download is skipped but the snapshot is
 * still returned so callers can use it programmatically.
 */
function downloadSessionSnapshot() {
    const snap = buildSessionSnapshot()
    if (typeof document === 'undefined' || typeof URL === 'undefined') return snap
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `timeline-debug-${snap.ts}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return snap
}

const RECENT_ERROR_LIMIT = 5

export default function TimelineDebugPanel() {
    // Tick-based force re-render. We don't need to deep-copy the
    // metrics into local state — reading directly from globalThis
    // each render is fine (the panel is the only consumer, and the
    // tick gives React a reason to recompute).
    const [, setTick] = useState(0)
    useEffect(() => {
        if (!IS_DEV) return undefined
        const id = setInterval(() => setTick(t => t + 1), 500)
        return () => clearInterval(id)
    }, [])

    // Expose the export function on globalThis so a dev can
    // trigger a session snapshot download from the browser
    // console without touching the panel UI:
    //   `window.__SAIL_DEBUG_EXPORT__()`
    // The cleanup compares the registered reference against the
    // module-scope function so we never delete an export installed
    // by some other instance (e.g. during HMR re-mounts).
    useEffect(() => {
        if (!IS_DEV) return undefined
        if (typeof globalThis === 'undefined') return undefined
        globalThis.__SAIL_DEBUG_EXPORT__ = downloadSessionSnapshot
        return () => {
            if (globalThis.__SAIL_DEBUG_EXPORT__ === downloadSessionSnapshot) {
                delete globalThis.__SAIL_DEBUG_EXPORT__
            }
        }
    }, [])

    if (!IS_DEV) return null

    const metrics = (typeof globalThis !== 'undefined' && globalThis.__timelineMetrics) || null
    const byAction = metrics?.byAction || {}
    const recentErrors = (metrics?.recentErrors || []).slice(-RECENT_ERROR_LIMIT)

    // Per-action precompute once per render. Each row needs:
    //   * a recent slot for the recent-counts line and the
    //     friction-hint data source.
    //   * a combined validation (lifetime + recent) for the
    //     warning glyph.
    // Computing both at the top means the row map below reads
    // them from the precomputed map without repeating the
    // getRecentSlot iteration.
    //
    // Recent matters for validation now because it drives the
    // friction hint — a transient corruption in the recent window
    // (race conditions under spam clicks, partial updates during
    // async flows) would otherwise be invisible while still
    // influencing decisions. Each issue is prefixed `lifetime:` or
    // `recent:` by validateRowSlots so the tooltip pinpoints which
    // slot failed which invariant.
    const rowState = {}
    for (const { key } of ACTION_LABELS) {
        const lifetime = byAction[key]
        if (!lifetime) continue
        const recent = getRecentSlot(key, RECENT_WINDOW_MS)
        rowState[key] = {
            recent,
            validation: validateRowSlots(lifetime, recent, getActionMeta(key)),
        }
    }
    const validations = Object.fromEntries(
        Object.entries(rowState).map(([k, v]) => [k, v.validation]),
    )
    const anyInvalid = Object.values(validations).some(v => !v.valid)

    const handleReset = () => {
        if (typeof globalThis !== 'undefined') {
            globalThis.__timelineMetrics = undefined
            setTick(t => t + 1)   // immediate refresh, don't wait for the next tick
        }
    }

    // ── Stress controls ──────────────────────────────────────────
    //
    // Spam: target the FIRST visible button matching the action's
    // data attribute and click it N times with a small delay
    // between clicks. The delay lets React commit between clicks
    // so the test exercises the realistic "rapid clicks across
    // renders" path, not the unrealistic "all clicks in one tick"
    // edge case (which React's batching would defeat anyway).
    //
    // If no matching button is currently rendered, the spam silently
    // no-ops and emits a console warning — useful signal that the
    // dev needs to first scroll a relevant row into view.
    const spamAction = (actionId) => {
        const btn = document.querySelector(`[data-timeline-action="${actionId}"]`)
        if (!btn) {
            // eslint-disable-next-line no-console
            console.warn('[Timeline debug] no visible button for', actionId)
            return
        }
        let i = 0
        const fire = () => {
            if (i++ >= SPAM_CLICK_COUNT) return
            btn.click()
            setTimeout(fire, SPAM_CLICK_INTERVAL_MS)
        }
        fire()
    }

    // Toggles: flip a globalThis flag and force a re-render so the
    // toggle's visual state reflects reality immediately, not after
    // the next 500ms tick.
    const forceErrorOn  = !!(typeof globalThis !== 'undefined' && globalThis.__SAIL_FORCE_ERROR__)
    const slowNetworkOn = !!(typeof globalThis !== 'undefined' && globalThis.__SAIL_SLOW_NETWORK__)
    const toggleForceError = () => {
        if (typeof globalThis === 'undefined') return
        globalThis.__SAIL_FORCE_ERROR__ = !globalThis.__SAIL_FORCE_ERROR__
        setTick(t => t + 1)
    }
    const toggleSlowNetwork = () => {
        if (typeof globalThis === 'undefined') return
        globalThis.__SAIL_SLOW_NETWORK__ = !globalThis.__SAIL_SLOW_NETWORK__
        setTick(t => t + 1)
    }

    const ctrlButtonStyle = (active) => ({
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 3,
        border: `1px solid ${active ? '#ffd28a' : '#3d4756'}`,
        background: active ? '#3a2e1a' : 'transparent',
        color: active ? '#ffd28a' : '#cbd2dc',
        cursor: 'pointer',
    })

    return (
        <div
            aria-hidden
            style={{
                position: 'fixed',
                right: 12,
                bottom: 12,
                zIndex: 9999,
                background: 'rgba(15, 22, 33, 0.92)',
                color: '#cbd2dc',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
                lineHeight: 1.45,
                padding: '8px 10px',
                borderRadius: 6,
                maxWidth: 320,
                minWidth: 240,
                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
                pointerEvents: 'auto',
                userSelect: 'none',
            }}
        >
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
                color: '#e8edf3',
                fontWeight: 600,
            }}>
                <span>
                    Timeline · debug
                    {/* Integrity indicator. Tiny red glyph in the
                        header lights up whenever ANY action's slot
                        fails validation. Hovering shows a list of
                        the actions involved so the dev can scroll
                        to the offending row. */}
                    {anyInvalid && (
                        <span
                            style={{ marginLeft: 6, color: '#ff8a8a' }}
                            title={
                                'Telemetry integrity issue — see ⚠ rows below.\n' +
                                Object.entries(validations)
                                    .filter(([, v]) => !v.valid)
                                    .map(([k, v]) => `${k}: ${v.issues.join('; ')}`)
                                    .join('\n')
                            }
                        >
                            ⚠
                        </span>
                    )}
                </span>
                <div style={{ display: 'flex', gap: 4 }}>
                    <button
                        type="button"
                        onClick={downloadSessionSnapshot}
                        title={
                            'Download a JSON snapshot of the entire telemetry state ' +
                            '(lifetime + recent slots + recent events + flags). ' +
                            'Also available as window.__SAIL_DEBUG_EXPORT__().'
                        }
                        style={ctrlButtonStyle(false)}
                    >
                        Export
                    </button>
                    <button
                        type="button"
                        onClick={handleReset}
                        style={ctrlButtonStyle(false)}
                    >
                        Reset
                    </button>
                </div>
            </div>

            {/* Stress controls — three "spam" buttons (one per
                action) and two global toggles (force error / slow
                network). Compact layout: title row + button row.
                Toggles are visibly active when their flag is on
                (warm border + warm text + dim background) so the
                state is unambiguous at a glance. */}
            <div style={{ marginBottom: 6 }}>
                <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 2 }}>
                    stress
                </div>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 4,
                    alignItems: 'center',
                }}>
                    {ACTION_LABELS.map(({ key, short }) => (
                        <button
                            key={`spam-${key}`}
                            type="button"
                            onClick={() => spamAction(key)}
                            title={`Spam ${SPAM_CLICK_COUNT} clicks at ${SPAM_CLICK_INTERVAL_MS}ms intervals on the first visible "${key}" button.`}
                            style={ctrlButtonStyle(false)}
                        >
                            spam {short}
                        </button>
                    ))}
                    <span style={{ opacity: 0.4, padding: '0 2px' }}>·</span>
                    <button
                        type="button"
                        onClick={toggleForceError}
                        title="When ON, every action handler throws a synthetic error before its RPC. Validates that error telemetry increments and UI recovers."
                        style={ctrlButtonStyle(forceErrorOn)}
                    >
                        err {forceErrorOn ? 'ON' : 'off'}
                    </button>
                    <button
                        type="button"
                        onClick={toggleSlowNetwork}
                        title="When ON, every action handler awaits ~1s before its RPC. Validates duration metrics and loading-state stability."
                        style={ctrlButtonStyle(slowNetworkOn)}
                    >
                        slow {slowNetworkOn ? 'ON' : 'off'}
                    </button>
                </div>
            </div>

            {ACTION_LABELS.every(({ key }) => !byAction[key]) ? (
                <div style={{ opacity: 0.6 }}>(no actions yet — click a row to start)</div>
            ) : (
                <div>
                    {ACTION_LABELS.map(({ key, label }) => {
                        const slot = byAction[key]
                        if (!slot) return null
                        // Branch the funnel display on the action's
                        // policy. The metadata lives in the telemetry
                        // module — same module that owns the
                        // aggregate — so the *interpretation* of the
                        // data lives next to the data, decoupled from
                        // the *resolver* that decided the policy.
                        //
                        //   requiresConfirm = true (3-step funnel):
                        //     click → confirm → success
                        //     show: Nc Nf Ns Ne · X% confirm · Y% succ
                        //     where Y = success / confirm.
                        //
                        //   requiresConfirm = false (2-step funnel):
                        //     click → success
                        //     show: Nc Ns Ne · Y% succ
                        //     where Y = success / click. The confirm
                        //     count + rate are dropped entirely —
                        //     never part of this action's flow.
                        const requiresConfirm = getActionMeta(key).requiresConfirm
                        const conv = (requiresConfirm && slot.click > 0)
                            ? Math.round((slot.confirm / slot.click) * 100)
                            : null
                        const succDenom = requiresConfirm ? slot.confirm : slot.click
                        const succ = succDenom > 0
                            ? Math.round((slot.success / succDenom) * 100)
                            : null
                        const countsLine = requiresConfirm
                            ? `${slot.click}c ${slot.confirm}f ${slot.success}s ${slot.error}e`
                            : `${slot.click}c ${slot.success}s ${slot.error}e`
                        const countsTitle = requiresConfirm
                            ? 'click / confirm / success / error'
                            : 'click / success / error  (single-click action — no confirm step)'
                        // Recent-window slot — precomputed at the top
                        // of the render and reused here. Same shape
                        // as the lifetime slot but only counting
                        // events from the last RECENT_WINDOW_MS
                        // milliseconds. Lifetime answers "what has
                        // happened since the page loaded?"; recent
                        // answers "is this still true right now?".
                        // Big divergence between the two reveals
                        // trends the lifetime average smooths over.
                        const recent = rowState[key]?.recent
                            ?? { click: 0, confirm: 0, success: 0, error: 0 }
                        const hasRecentActivity =
                            recent.click + recent.confirm + recent.success + recent.error > 0
                        const recentCounts = requiresConfirm
                            ? `${recent.click}c ${recent.confirm}f ${recent.success}s ${recent.error}e`
                            : `${recent.click}c ${recent.success}s ${recent.error}e`
                        // Friction hint — only meaningful for actions
                        // that currently HAVE a confirm step.
                        //
                        // Data source: prefer the recent slot so hints
                        // reflect *current* behaviour. Fall back to
                        // lifetime when recent.click === 0 so the hint
                        // isn't blank on idle pages — but flag the
                        // source in the label so the dev knows which
                        // numbers drove the suggestion. (When recent
                        // and lifetime contradict each other, the
                        // label is what disambiguates.)
                        const hintSourceIsRecent = recent.click > 0
                        const hintSlot           = hintSourceIsRecent ? recent : slot
                        // Pass actionId so the heuristic picks up any
                        // per-action threshold override from
                        // ACTION_THRESHOLDS (e.g. attendance.mark_present
                        // uses 90%/10% instead of the global 95%/5%).
                        // Other actions still get the global defaults
                        // until evidence supports overriding them.
                        const hintRemoveConfirm  = requiresConfirm
                            && shouldHintConfirmRemoval(hintSlot, { actionId: key })
                        const hintSourceLabel = hintSourceIsRecent ? 'recent' : 'lifetime'
                        return (
                            <div key={key} style={{ marginBottom: 6 }}>
                                <div style={{ color: '#e8edf3' }}>{label}</div>
                                <div>
                                    <span title={countsTitle}>{countsLine}</span>
                                    {conv !== null && (
                                        <span style={{ marginLeft: 8, opacity: 0.75 }}>
                                            {conv}% confirm
                                        </span>
                                    )}
                                    <span style={{
                                        marginLeft: 8,
                                        // Dimmer for the no-data
                                        // placeholder so the eye
                                        // reads "yet to happen"
                                        // rather than "0%".
                                        opacity: succ === null ? 0.5 : 0.75,
                                    }}>
                                        {succ === null ? '—' : `${succ}%`} success
                                    </span>
                                </div>
                                {slot.avgDurationMs !== null && (
                                    <div style={{ opacity: 0.75 }}>
                                        avg {Math.round(slot.avgDurationMs)}ms
                                        {' · '}last {Math.round(slot.lastDurationMs)}ms
                                    </div>
                                )}
                                {/* Sliding-window recent line. Hides
                                    entirely when no recent activity —
                                    keeps the row compact when only the
                                    lifetime slot has data. The label
                                    bakes in the window size so a viewer
                                    knows what "recent" means without
                                    hovering. */}
                                {hasRecentActivity && (
                                    <div
                                        title={`Events in the last ${Math.round(RECENT_WINDOW_MS/1000)}s, aggregated. Compares with the lifetime line above to reveal trends.`}
                                        style={{ opacity: 0.6 }}
                                    >
                                        recent {Math.round(RECENT_WINDOW_MS/1000)}s: {recentCounts}
                                    </div>
                                )}
                                {hintRemoveConfirm && (
                                    <div
                                        title={
                                            `Heuristic over ${hintSourceLabel} slot: ` +
                                            'click ≥ 5, success/confirm ≥ 95%, error = 0. ' +
                                            'The confirm step looks like friction without ' +
                                            'safety value at this point. ' +
                                            (hintSourceIsRecent
                                                ? '(Based on the last 60s of activity.)'
                                                : '(Recent slot is empty; using lifetime.)')
                                        }
                                        style={{
                                            // Warm tone to differentiate from
                                            // the neutral metric rows. Not a
                                            // warning — this is advisory.
                                            color: '#ffd28a',
                                            opacity: 0.85,
                                            marginTop: 2,
                                        }}
                                    >
                                        ⚡ consider removing confirm ({hintSourceLabel})
                                    </div>
                                )}
                                {/* Integrity warning — fires whenever the
                                    slot fails any monotonicity invariant.
                                    Distinct from the friction hint: red
                                    tone, blunt label. The title attribute
                                    enumerates the specific issues so the
                                    dev can pinpoint the bug without
                                    opening the source. */}
                                {validations[key] && !validations[key].valid && (
                                    <div
                                        title={validations[key].issues.join('\n')}
                                        style={{
                                            color: '#ff8a8a',
                                            opacity: 0.95,
                                            marginTop: 2,
                                        }}
                                    >
                                        ⚠ inconsistent telemetry
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {recentErrors.length > 0 && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #2c3340' }}>
                    <div style={{ color: '#e8edf3', marginBottom: 2 }}>recent errors</div>
                    {recentErrors.map((e, i) => (
                        <div key={`${e.ts}-${i}`} style={{ opacity: 0.75 }} title={e.ts}>
                            • {(e.action || '').split('.').slice(-1)[0]}: {e.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
