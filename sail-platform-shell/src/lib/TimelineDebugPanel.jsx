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
import { getActionMeta, shouldHintConfirmRemoval } from './timelineTelemetry'

// Module-level constant. Vite replaces `process.env.NODE_ENV` with
// the literal at build time → in a production bundle this becomes
// `const IS_DEV = !('production' === 'production')` → `false` → the
// component dead-codes to `return null` and the Hooks-rules concern
// (calling hooks conditionally) is moot because the early-return
// short-circuits before any hook runs.
const IS_DEV = !(typeof process !== 'undefined'
    && process.env?.NODE_ENV === 'production')

// Render order + display labels for the three action types. Closed
// list — when a fourth domain lands, add a row here.
const ACTION_LABELS = [
    { key: 'attendance.mark_present',     label: 'Mark present' },
    { key: 'behaviour.resolve',           label: 'Resolve' },
    { key: 'assignment.mark_submitted',   label: 'Mark submitted' },
]

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

    if (!IS_DEV) return null

    const metrics = (typeof globalThis !== 'undefined' && globalThis.__timelineMetrics) || null
    const byAction = metrics?.byAction || {}
    const recentErrors = (metrics?.recentErrors || []).slice(-RECENT_ERROR_LIMIT)

    const handleReset = () => {
        if (typeof globalThis !== 'undefined') {
            globalThis.__timelineMetrics = undefined
            setTick(t => t + 1)   // immediate refresh, don't wait for the next tick
        }
    }

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
                <span>Timeline · debug</span>
                <button
                    type="button"
                    onClick={handleReset}
                    style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 3,
                        border: '1px solid #3d4756',
                        background: 'transparent',
                        color: '#cbd2dc',
                        cursor: 'pointer',
                    }}
                >
                    Reset
                </button>
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
                        // Friction hint — only meaningful for actions
                        // that currently HAVE a confirm step. The
                        // heuristic itself is in timelineTelemetry.js
                        // so it stays testable; this site just wires
                        // the boolean to render.
                        const hintRemoveConfirm =
                            requiresConfirm && shouldHintConfirmRemoval(slot)
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
                                {hintRemoveConfirm && (
                                    <div
                                        title={
                                            'Heuristic: confirm ≥ 5, success/confirm ≥ 95%, ' +
                                            'error = 0. The confirm step looks like friction ' +
                                            'without safety value at this point.'
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
                                        ⚡ consider removing confirm
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
