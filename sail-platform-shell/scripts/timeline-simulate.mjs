#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// timeline-simulate — CLI dev tool for testing product decisions without UI
// ─────────────────────────────────────────────────────────────────────────
// Drives the SAME analysis pipeline the live debug panel uses (telemetry
// → aggregate → recent slot → invariant validation → friction heuristic
// → snapshot) with hand-crafted event traces matching what each scenario
// WOULD produce if a user ran it against the live dev server.
//
// What this is for:
//   * Fast iteration on heuristic thresholds without clicking through
//     the UI for an hour to accumulate enough data.
//   * Reproducibility: the same scenario always produces the same
//     verdict, so policy decisions can be re-evaluated against the
//     same baseline later.
//   * Decision-focused output — every run prints a 'DECISION SIGNAL'
//     block answering 'should confirm exist?' for that scenario.
//
// What this is NOT:
//   * A replacement for live-UI testing. The simulation can't validate
//     React 18 batching under real onClick events, real Supabase RPC
//     behaviour, network jitter, or DOM-level interactions. Those
//     require a human at the dev server.
//
// Usage:
//   node scripts/timeline-simulate.mjs <scenario>
//   npm run simulate:timeline -- <scenario>     (or `npm run simulate:timeline <scenario>` on npm 7+)
//
// Scenarios:
//   normal           10 clean cycles. Baseline.
//   stress-slow      5 cycles with 1100ms RPC latency (slow-network sim).
//   stress-error     5 cycles all failing.
//   mixed-outcome    10 cycles with 8 success + 2 errors interleaved.
//   all              Run every scenario in sequence, print deltas.
//
// Output:
//   scripts/snapshots/<scenario>.json  — snapshot in buildSessionSnapshot() shape.
// ═══════════════════════════════════════════════════════════════════════════

// Suppress the telemetry module's dev-mode console.log of every event.
// The module gates its output on NODE_ENV === 'production'; setting that
// here keeps the CLI output clean while still updating the in-memory
// aggregate (only the log emission is gated, not the bookkeeping).
process.env.NODE_ENV = 'production'

import {
    logTimelineAction,
    _resetTimelineMetrics,
    buildSessionSnapshot,
    validateRowSlots,
    shouldHintConfirmRemoval,
    getActionMeta,
    TIMELINE_ACTIONS,
    TIMELINE_PHASES,
    MAX_ERROR_RATE,
    MIN_SUCCESS_RATE,
} from '../src/lib/timelineTelemetry.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR   = path.join(__dirname, 'snapshots')
fs.mkdirSync(OUT_DIR, { recursive: true })

// All scenarios target the attendance action. Other actions can be
// added later by extending the SCENARIOS map; the analysis layer is
// already action-agnostic.
const ATTENDANCE = TIMELINE_ACTIONS.MARK_PRESENT

// ── Time control ──────────────────────────────────────────────────────────
const _origNow = Date.now
function withFixedNow(ms, fn) {
    Date.now = () => ms
    try { return fn() } finally { Date.now = _origNow }
}
function emit(action, phase, ms, extra = {}) {
    withFixedNow(ms, () => {
        logTimelineAction({
            action, phase,
            rowType: 'attendance',
            rowKey:  `simulated-${ms}`,
            ...extra,
        })
    })
}

// ── Scenario implementations ──────────────────────────────────────────────
//
// Each returns the snapshot at scenario end, computed via
// buildSessionSnapshot() with the simulator's clock advanced past the
// last event so the snapshot's `ts` is the "now" the panel would see.

function simulateNormal() {
    _resetTimelineMetrics()
    const base = 100_000
    for (let i = 0; i < 10; i++) {
        const t = base + i * 3000
        emit(ATTENDANCE, TIMELINE_PHASES.CLICK,   t)
        emit(ATTENDANCE, TIMELINE_PHASES.CONFIRM, t + 800)
        emit(ATTENDANCE, TIMELINE_PHASES.SUCCESS, t + 1050, { durationMs: 250 })
    }
    return withFixedNow(base + 10 * 3000 + 2000, buildSessionSnapshot)
}

function simulateStressSlow() {
    _resetTimelineMetrics()
    const base = 200_000
    // 5 bursts. Each click→confirm pair represents the surviving pair
    // from a spam burst (markingKey blocks the rest in the live handler).
    // Slow network adds ~1.1s to each RPC.
    for (let i = 0; i < 5; i++) {
        const t = base + i * 5000
        emit(ATTENDANCE, TIMELINE_PHASES.CLICK,   t)
        emit(ATTENDANCE, TIMELINE_PHASES.CONFIRM, t + 80)
        emit(ATTENDANCE, TIMELINE_PHASES.SUCCESS, t + 1180, { durationMs: 1100 })
    }
    return withFixedNow(base + 5 * 5000 + 2000, buildSessionSnapshot)
}

function simulateStressError() {
    _resetTimelineMetrics()
    const base = 300_000
    for (let i = 0; i < 5; i++) {
        const t = base + i * 3000
        emit(ATTENDANCE, TIMELINE_PHASES.CLICK,   t)
        emit(ATTENDANCE, TIMELINE_PHASES.CONFIRM, t + 200)
        emit(ATTENDANCE, TIMELINE_PHASES.ERROR,   t + 350, {
            error: '[dev] forced error via __SAIL_FORCE_ERROR__',
        })
    }
    return withFixedNow(base + 5 * 3000 + 2000, buildSessionSnapshot)
}

function simulateMixedOutcome() {
    _resetTimelineMetrics()
    const base = 400_000
    // 10 cycles, 8 success + 2 errors. Errors live at indices 2 and 6
    // so they're INTERLEAVED with successes (the most realistic shape —
    // a pure trailing-failures pattern would be too clean to test the
    // recent-window invariants properly). Cycles spaced 3s apart, all
    // within the 60s recent window.
    const failures = new Set([2, 6])
    for (let i = 0; i < 10; i++) {
        const t = base + i * 3000
        emit(ATTENDANCE, TIMELINE_PHASES.CLICK,   t)
        emit(ATTENDANCE, TIMELINE_PHASES.CONFIRM, t + 200)
        if (failures.has(i)) {
            emit(ATTENDANCE, TIMELINE_PHASES.ERROR, t + 350, {
                error: 'rls denied',
            })
        } else {
            emit(ATTENDANCE, TIMELINE_PHASES.SUCCESS, t + 350, { durationMs: 200 })
        }
    }
    return withFixedNow(base + 10 * 3000 + 2000, buildSessionSnapshot)
}

function simulateLowError() {
    _resetTimelineMetrics()
    const base = 500_000
    // 10 cycles, 9 success + 1 error → 10% error rate.
    // Currently above the 5% threshold, so the hint should be OFF and
    // the recommendation should KEEP CONFIRM. If the threshold is ever
    // tuned to 10% or higher, this scenario flips to REMOVE — and the
    // CLI will surface that change instantly. The single failure sits
    // in the middle of the trace (index 4), not trailing.
    const failures = new Set([4])
    for (let i = 0; i < 10; i++) {
        const t = base + i * 3000
        emit(ATTENDANCE, TIMELINE_PHASES.CLICK,   t)
        emit(ATTENDANCE, TIMELINE_PHASES.CONFIRM, t + 200)
        if (failures.has(i)) {
            emit(ATTENDANCE, TIMELINE_PHASES.ERROR, t + 350, {
                error: 'transient network error',
            })
        } else {
            emit(ATTENDANCE, TIMELINE_PHASES.SUCCESS, t + 350, { durationMs: 200 })
        }
    }
    return withFixedNow(base + 10 * 3000 + 2000, buildSessionSnapshot)
}

const SCENARIOS = {
    'normal':         { run: simulateNormal,       description: '10 clean cycles' },
    'stress-slow':    { run: simulateStressSlow,   description: '5 cycles at 1100ms latency' },
    'stress-error':   { run: simulateStressError,  description: '5 cycles all failing' },
    'mixed-outcome':  { run: simulateMixedOutcome, description: '10 cycles, 8 success + 2 errors interleaved' },
    'low-error':      { run: simulateLowError,     description: '10 cycles, 9 success + 1 error (10% error rate)' },
}

// ── Decision signal ───────────────────────────────────────────────────────
//
// Reduces the snapshot to a single recommendation. The recommendation is
// what an operator actually wants to know — "should confirm exist?" —
// derived from the same heuristic the live panel uses, plus a couple of
// safety branches for edge cases the heuristic doesn't cover (e.g. low
// volume, recent-error suppression with explicit reason).

function computeDecisionSignal(snap, action) {
    const slot = snap.actions[action]
    if (!slot) {
        return {
            empty: true,
            recommendation: 'NO DATA',
        }
    }
    const recent      = slot.recent
    const lifetime    = slot.lifetime
    const meta        = getActionMeta(action)
    const validation  = validateRowSlots(lifetime, recent, meta)
    // Panel logic: prefer recent if there's data, else fall back to lifetime.
    const slotForHint = recent.click > 0 ? recent : lifetime
    const hintFires   = shouldHintConfirmRemoval(slotForHint)
    const total       = recent.click
    const successRate = total > 0 ? recent.success / total : null
    const errorRate   = total > 0 ? recent.error   / total : null

    // Recommendation reason — picks the FIRST gate that blocks the
    // hint, mirroring the order in `shouldHintConfirmRemoval`. Keeps
    // the message specific so the dev knows which threshold to look
    // at if they disagree with the verdict.
    let recommendation
    const errRate = recent.confirm > 0 ? recent.error / recent.confirm : 0
    const sucRate = recent.confirm > 0 ? recent.success / recent.confirm : 0
    if (total < 5) {
        recommendation = 'INSUFFICIENT DATA'
    } else if (hintFires) {
        recommendation = 'REMOVE CONFIRM (heuristic fires; click-confirm friction without safety value)'
    } else if (errRate > MAX_ERROR_RATE) {
        recommendation = `KEEP CONFIRM (error rate ${(errRate * 100).toFixed(1)}% above ${(MAX_ERROR_RATE * 100).toFixed(1)}% threshold)`
    } else if (recent.confirm > 0 && sucRate < 0.95) {
        recommendation = `KEEP CONFIRM (success rate ${(sucRate * 100).toFixed(1)}% below 95% threshold)`
    } else {
        recommendation = 'KEEP CONFIRM (heuristic silent; reason unclear — inspect manually)'
    }

    return {
        empty: false,
        recent, lifetime,
        validation,
        successRate, errorRate, total,
        hintFires,
        recommendation,
    }
}

function fmtRate(r) {
    if (r === null || r === undefined) return '—'
    return `${(r * 100).toFixed(1)}%`
}
function fmtDelta(curr, prev) {
    if (curr === null || prev === null) return '—'
    const d = curr - prev
    const sign = d > 0 ? '+' : ''
    return `${sign}${(d * 100).toFixed(1)}pt`
}

function printDecisionSignal(label, signal, prevSignal = null) {
    console.log(`\n=== DECISION SIGNAL — ${label} ===`)
    if (signal.empty) {
        console.log('  (no data)')
        return
    }
    const r = signal.recent
    console.log(`  recent: ${r.click}c ${r.confirm}f ${r.success}s ${r.error}e`)
    console.log(`  recent success rate: ${fmtRate(signal.successRate)} (${r.success}/${r.click})  [threshold ≥ 95.0%]`)
    console.log(`  recent error rate:   ${fmtRate(signal.errorRate)} (${r.error}/${r.click})  [threshold ≤ ${(MAX_ERROR_RATE * 100).toFixed(1)}%]`)
    console.log(`  invariants:          ${signal.validation.valid ? 'valid' : 'INVALID'}`)
    if (!signal.validation.valid) {
        for (const issue of signal.validation.issues) console.log(`    - ${issue}`)
    }
    console.log(`  hint:                ${signal.hintFires ? 'ON' : 'OFF'}`)
    console.log(`  recommendation:      ${signal.recommendation}`)
    if (prevSignal && !prevSignal.empty) {
        console.log(`  ─ vs previous ──────────────────────────`)
        console.log(`    success Δ: ${fmtDelta(signal.successRate, prevSignal.successRate)}`)
        console.log(`    error   Δ: ${fmtDelta(signal.errorRate,   prevSignal.errorRate)}`)
        console.log(`    hint    Δ: ${prevSignal.hintFires ? 'ON' : 'OFF'} → ${signal.hintFires ? 'ON' : 'OFF'}`)
    }
}

function runOne(name, prevSignal = null) {
    const def = SCENARIOS[name]
    const snap = def.run()
    const signal = computeDecisionSignal(snap, ATTENDANCE)
    const outPath = path.join(OUT_DIR, `${name}.json`)
    fs.writeFileSync(outPath, JSON.stringify(snap, null, 2))
    printDecisionSignal(`${name}  (${def.description})`, signal, prevSignal)
    console.log(`  → wrote ${path.relative(process.cwd(), outPath)}`)
    return signal
}

// ── Sweep mode (2D: success threshold × error threshold) ─────────────────
//
// Iterates over both `minSuccessRate` AND `maxErrorRate` to map the
// decision surface, not just one axis. Surfaces flip points per
// success-threshold band — and where there's no flip, names the
// binding gate so the dev can see WHICH lever to pull next.
//
// The 1D sweep was useful but stalled: in the existing scenarios
// (low-error, mixed-outcome) the success-rate gate dominates the
// error-rate gate at higher error thresholds, so error-axis tuning
// alone never flips the verdict. The 2D sweep exposes that hierarchy
// directly — same data, two axes, full picture.

const ERROR_SWEEP_THRESHOLDS   = [0, 0.02, 0.05, 0.10, 0.15, 0.20]
const SUCCESS_SWEEP_THRESHOLDS = [0.90, 0.92, 0.95, 0.98]

// Re-implements the gate-evaluation order from
// timelineTelemetry.shouldHintConfirmRemoval so the sweep can name
// WHICH gate is blocking at each (errorRate, successRate) pair.
// Stays in sync via the node:test boundary tests on each gate.
function describeGateAt(slot, errThreshold, succThreshold) {
    const click   = slot.click   ?? 0
    const confirm = slot.confirm ?? 0
    const success = slot.success ?? 0
    const error   = slot.error   ?? 0
    if (click   < 5)  return `click ${click} < 5 (volume)`
    if (confirm < 1)  return 'confirm = 0 (ratio safety)'
    const errorRate = error / confirm
    if (errorRate > errThreshold) {
        return `error ${(errorRate * 100).toFixed(1)}% > ${(errThreshold * 100).toFixed(1)}%`
    }
    const successRate = success / confirm
    if (successRate < succThreshold) {
        return `success ${(successRate * 100).toFixed(1)}% < ${(succThreshold * 100).toFixed(1)}%`
    }
    return 'all gates pass'
}

function runErrorSweepRow(slot, succThreshold, errThresholds) {
    return errThresholds.map(t => ({
        errThreshold: t,
        hint: shouldHintConfirmRemoval(slot, {
            maxErrorRate:   t,
            minSuccessRate: succThreshold,
        }),
        reason: null,
    })).map(v => ({
        ...v,
        reason: v.hint ? 'all gates pass' : describeGateAt(slot, v.errThreshold, succThreshold),
    }))
}

function describeFlip(verdicts, succThreshold) {
    const firstOnIdx = verdicts.findIndex(v => v.hint)
    if (firstOnIdx === -1) {
        const loosest = verdicts[verdicts.length - 1]
        return `no flip — binding at error ${(loosest.errThreshold * 100).toFixed(1)}%: ${loosest.reason}`
    }
    if (firstOnIdx === 0) {
        return `no flip — already ON at error 0%`
    }
    const flipT = verdicts[firstOnIdx].errThreshold
    return `flip at error ${(flipT * 100).toFixed(1)}%`
}

function runSweep(name) {
    const def = SCENARIOS[name]
    if (!def) {
        console.error(`Unknown scenario for sweep: ${name}`)
        process.exit(1)
    }
    const snap = def.run()
    const slot = snap.actions[ATTENDANCE]?.recent
    if (!slot || slot.click === 0) {
        console.log(`\n=== SWEEP — ${name} ===\n  (no recent activity for ${ATTENDANCE})`)
        return
    }
    const successPct = slot.confirm > 0 ? (slot.success / slot.confirm) * 100 : 0
    const errorPct   = slot.confirm > 0 ? (slot.error   / slot.confirm) * 100 : 0

    console.log(`\n=== SWEEP (2D) — ${name}  (${def.description}) ===`)
    console.log(`  recent: ${slot.click}c ${slot.confirm}f ${slot.success}s ${slot.error}e`
        + ` (success ${successPct.toFixed(1)}%, error ${errorPct.toFixed(1)}%)`)

    const summaries = []
    for (const succ of SUCCESS_SWEEP_THRESHOLDS) {
        const isSuccDefault = Math.abs(succ - MIN_SUCCESS_RATE) < 1e-9
        const succLabel = `${(succ * 100).toFixed(1)}%${isSuccDefault ? '  (default)' : ''}`
        console.log(`\n  ── success threshold ≥ ${succLabel} ──`)
        const verdicts = runErrorSweepRow(slot, succ, ERROR_SWEEP_THRESHOLDS)
        for (const v of verdicts) {
            const padded     = `${(v.errThreshold * 100).toFixed(1)}%`.padStart(7)
            const hintStr    = v.hint ? 'ON ' : 'OFF'
            const isErrDflt  = Math.abs(v.errThreshold - MAX_ERROR_RATE) < 1e-9
            const dfltTag    = (isErrDflt && isSuccDefault) ? '   ← current defaults' : ''
            console.log(`    ${padded}    ${hintStr}    ${v.reason}${dfltTag}`)
        }
        summaries.push({ succ, summary: describeFlip(verdicts, succ) })
    }

    console.log('')
    console.log('  ── 2D summary ──')
    for (const s of summaries) {
        const isDefault = Math.abs(s.succ - MIN_SUCCESS_RATE) < 1e-9
        const tag = isDefault ? '  (current default)' : ''
        console.log(`    success ≥ ${(s.succ * 100).toFixed(1)}%${tag.padEnd(20)}: ${s.summary}`)
    }
    console.log('')

    // Highest-level diagnosis: does ANY combination flip the verdict?
    // If yes, name the cheapest combination (lowest success threshold
    // that produces a flip + the smallest error threshold at which it
    // flips). If no, the action is genuinely outside the hint space —
    // tuning either dimension alone won't help.
    const anyOnAcrossAll = summaries.some(s => !s.summary.startsWith('no flip'))
    if (anyOnAcrossAll) {
        const firstFlippable = summaries.find(s => !s.summary.startsWith('no flip'))
        console.log(`  → cheapest flip: relax success threshold to ${(firstFlippable.succ * 100).toFixed(1)}% (${firstFlippable.summary}).`)
    } else {
        console.log(`  → no combination of (success, error) thresholds in tested range surfaces the hint.`)
    }
}

// ── Main ──────────────────────────────────────────────────────────────────
const arg = process.argv[2]

function usage(code = 0) {
    console.log('Usage: node scripts/timeline-simulate.mjs <command>')
    console.log('       npm run simulate:timeline -- <command>')
    console.log('')
    console.log('Commands:')
    for (const [name, def] of Object.entries(SCENARIOS)) {
        console.log(`  ${name.padEnd(15)} ${def.description}`)
    }
    console.log(`  ${'all'.padEnd(15)} Run every scenario in sequence with deltas`)
    console.log(`  ${'sweep [scn]'.padEnd(15)} Sweep MAX_ERROR_RATE thresholds across one scenario`)
    console.log(`                   (default scn: low-error;`)
    console.log(`                    use 'sweep all' to sweep every scenario)`)
    process.exit(code)
}

if (!arg || arg === '--help' || arg === '-h') usage(0)

if (arg === 'all') {
    let prev = null
    for (const name of Object.keys(SCENARIOS)) {
        prev = runOne(name, prev)
    }
} else if (arg === 'sweep') {
    const scenario = process.argv[3] || 'low-error'
    if (scenario === 'all') {
        for (const name of Object.keys(SCENARIOS)) runSweep(name)
    } else {
        runSweep(scenario)
    }
} else if (SCENARIOS[arg]) {
    runOne(arg)
} else {
    console.error(`Unknown command: ${arg}`)
    usage(1)
}

console.log('')
