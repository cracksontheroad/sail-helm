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
                        // Funnel rates — both percent integers, both
                        // null when their denominator is zero so the
                        // panel never lies about no-data states.
                        //   confirm rate = confirm / click
                        //     → "did the user follow through after
                        //        clicking the first time?"
                        //   success rate = success / confirm
                        //     → "did the RPC + refetch actually
                        //        complete after the user committed?"
                        // Together they decompose the loop:
                        //   high confirm + low success  → system issue
                        //   low confirm + high success  → UX hesitation
                        //   both high                   → healthy
                        const conv = slot.click   > 0
                            ? Math.round((slot.confirm / slot.click)   * 100)
                            : null
                        const succ = slot.confirm > 0
                            ? Math.round((slot.success / slot.confirm) * 100)
                            : null
                        return (
                            <div key={key} style={{ marginBottom: 6 }}>
                                <div style={{ color: '#e8edf3' }}>{label}</div>
                                <div>
                                    <span title="click / confirm / success / error">
                                        {slot.click}c {slot.confirm}f {slot.success}s {slot.error}e
                                    </span>
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
