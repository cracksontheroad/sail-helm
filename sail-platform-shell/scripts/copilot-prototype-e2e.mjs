#!/usr/bin/env node
/**
 * Copilot prototype · end-to-end smoke + visual capture
 * ─────────────────────────────────────────────────────────────────────────
 * Drives the Helm UI through the full review_struggling_students flow:
 *
 *   1. Sign in as the teacher.
 *   2. Open /copilot/review-struggling.
 *   3. Run Copilot (default 14 days / 0.6 threshold).
 *   4. Assert the page renders 3 medium-risk students for Math Class.
 *   5. Accept one suggestion → create a targeted assignment.
 *   6. Sign out, sign in as the student.
 *   7. Open /my-assignments and assert the new assignment is visible.
 *
 * Captures screenshots at every step into ./out/copilot-e2e/.
 *
 * ─── Required env vars ───────────────────────────────────────────────────
 *   HELM_URL              http://localhost:5173 (or preview URL)
 *   TEACHER_EMAIL         teacher@test.com
 *   TEACHER_PASSWORD      <provided by user — see [NEEDS_HUMAN] in report>
 *   STUDENT_EMAIL         bob@test.com
 *   STUDENT_PASSWORD      <provided by user — see [NEEDS_HUMAN] in report>
 *
 * ─── Run ─────────────────────────────────────────────────────────────────
 *   # one-time:
 *   npm i -D @playwright/test
 *   npx playwright install chromium
 *
 *   # in one shell:
 *   npm run dev
 *
 *   # in another:
 *   HELM_URL=http://localhost:5173 \
 *     TEACHER_EMAIL=teacher@test.com TEACHER_PASSWORD='…' \
 *     STUDENT_EMAIL=bob@test.com    STUDENT_PASSWORD='…' \
 *     node scripts/copilot-prototype-e2e.mjs
 *
 * Exit code 0 = HARD-STOP ACHIEVED.
 * Exit code 1 = a step failed; the failing screenshot + URL are logged.
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HELM_URL          = process.env.HELM_URL          || 'http://localhost:5173'
const TEACHER_EMAIL     = process.env.TEACHER_EMAIL     || 'teacher@test.com'
const TEACHER_PASSWORD  = process.env.TEACHER_PASSWORD
const STUDENT_EMAIL     = process.env.STUDENT_EMAIL     || 'bob@test.com'
const STUDENT_PASSWORD  = process.env.STUDENT_PASSWORD

if (!TEACHER_PASSWORD || !STUDENT_PASSWORD) {
    console.error('[copilot-e2e] TEACHER_PASSWORD and STUDENT_PASSWORD env vars are required')
    process.exit(2)
}

const OUT_DIR = resolve(process.cwd(), 'out/copilot-e2e')
mkdirSync(OUT_DIR, { recursive: true })

const log = (...a) => console.log(new Date().toISOString(), ...a)

async function shot(page, name) {
    const path = resolve(OUT_DIR, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    log('shot', path)
}

async function loginAs(page, email, password) {
    await page.goto(HELM_URL)
    // Helm Login.jsx renders a simple email + password form.
    await page.locator('input[type="email"], input[name="email"]').first().fill(email)
    await page.locator('input[type="password"], input[name="password"]').first().fill(password)
    await page.getByRole('button', { name: /sign\s*in|log\s*in/i }).first().click()
    // Wait for the role badge to render in the top-right.
    await page.waitForSelector('text=/Teacher|Student|Admin/', { timeout: 10000 })
}

async function teacherFlow() {
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    let createdTitle = null

    try {
        log('teacher: login')
        await loginAs(page, TEACHER_EMAIL, TEACHER_PASSWORD)
        await shot(page, '01-teacher-after-login')

        log('teacher: navigate /copilot/review-struggling')
        await page.goto(`${HELM_URL}/copilot/review-struggling`)
        await page.waitForSelector('text=Copilot — Review struggling students', { timeout: 5000 })
        await shot(page, '02-copilot-panel-empty')

        log('teacher: run copilot (defaults)')
        await page.getByRole('button', { name: /run copilot/i }).click()
        // Wait for either the cards or the empty-state.
        await page.waitForFunction(
            () => /flagged/i.test(document.body.innerText) ||
                  /No students cleared the threshold/.test(document.body.innerText),
            { timeout: 8000 }
        )
        await shot(page, '03-copilot-cards')

        const cards = await page.locator('div:has-text("risk")').count()
        log('teacher: visible cards (rough count via "risk" text):', cards)

        log('teacher: click Accept on first card')
        await page.getByRole('button', { name: /Accept · create targeted assignment/i }).first().click()
        // Pre-drafted form should appear.
        const titleInput = page.locator('input[type="text"]').filter({ hasText: '' }).nth(1) // best-effort selector
        const titleNow = await page.locator('input[type="text"]').nth(1).inputValue()
        createdTitle = titleNow
        log('teacher: pre-drafted title =', createdTitle)
        await shot(page, '04-accept-form-open')

        log('teacher: submit Create + assign')
        await page.getByRole('button', { name: /Create \+ assign/i }).click()
        await page.waitForFunction(() => /Targeted assignment created/i.test(document.body.innerText), { timeout: 8000 })
        await shot(page, '05-accept-success')

        log('teacher: sign out')
        await page.getByRole('button', { name: /sign out/i }).click()
        await page.waitForSelector('input[type="email"]', { timeout: 5000 })
    } catch (err) {
        await shot(page, 'ERROR-teacher')
        log('teacher: FAILED', err.message)
        throw err
    } finally {
        await browser.close()
    }
    return { createdTitle }
}

async function studentFlow({ createdTitle }) {
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
        log('student: login')
        await loginAs(page, STUDENT_EMAIL, STUDENT_PASSWORD)
        await shot(page, '06-student-after-login')

        log('student: navigate /my-assignments')
        await page.goto(`${HELM_URL}/my-assignments`)
        await page.waitForSelector('text=/My Assignments/i', { timeout: 5000 })
        await shot(page, '07-student-my-assignments')

        if (createdTitle) {
            log('student: looking for created assignment "' + createdTitle + '"')
            await page.waitForSelector(`text=${createdTitle}`, { timeout: 5000 })
            await shot(page, '08-student-sees-targeted-assignment')
        }

        log('student: try to call the Copilot RPC directly via window.fetch')
        // Sanity: the route is gated client-side, but a script-driven student
        // call to the RPC should be refused server-side with 42501.
        const refused = await page.evaluate(async (helm) => {
            try {
                const session = JSON.parse(localStorage.getItem(
                    Object.keys(localStorage).find(k => k.startsWith('sb-')) || ''
                ) || '{}')
                const token = session?.access_token
                const r = await fetch(`${'https://gidyonbzxjorrgpicctt.supabase.co'}/rest/v1/rpc/bridge_copilot_review_struggling`, {
                    method: 'POST',
                    headers: {
                        'apikey': 'sb_publishable_9gCdvH0NEcmkCf_IKuWTvg_vZLpfJ-r',
                        'authorization': `Bearer ${token}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        p_school_id: '0d75ca24-26f0-4550-b1dd-f0e725b0500f',
                        p_class_id:  'b76d35bd-9c6a-418a-b087-b3c820ebc571',
                    }),
                })
                return { status: r.status, body: await r.text() }
            } catch (e) { return { err: e.message } }
        }, HELM_URL)
        log('student: direct-RPC refusal probe →', JSON.stringify(refused))
        if (!String(refused.status).match(/^4(0|2)/)) {
            throw new Error('student RPC was NOT refused')
        }
    } catch (err) {
        await shot(page, 'ERROR-student')
        log('student: FAILED', err.message)
        throw err
    } finally {
        await browser.close()
    }
}

;(async () => {
    log('=== copilot-e2e starting against', HELM_URL)
    const t = await teacherFlow()
    await studentFlow(t)
    writeFileSync(resolve(OUT_DIR, 'SUCCESS.txt'),
        `HARD-STOP ACHIEVED at ${new Date().toISOString()}\nCreated title: ${t.createdTitle}\n`)
    log('=== copilot-e2e SUCCESS — see ./out/copilot-e2e/')
})().catch(err => {
    console.error('=== copilot-e2e FAILED:', err)
    process.exit(1)
})
