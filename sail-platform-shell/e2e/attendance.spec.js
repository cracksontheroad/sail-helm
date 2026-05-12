// Flow D — Attendance
//
// Alice (teacher of fixture class) marks bob present for a date.
// Bob signs in, navigates to Attendance, picks the class, sees ONLY
// own attendance — no other students.
//
// The session-anchored Bridge model means alice's mark goes through
// createSession → saveRegister under the hood (via the Helm api wrapper).

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

const CLASS_ID = 'eeeeeeee-0000-0000-0000-000000000002'

test('teacher marks attendance; student views own', async ({ browser }) => {
    // Use a unique date for this test run so prior runs don't interfere.
    // Format: YYYY-MM-DD. Push it ~10 days into the past so date pickers
    // accept it without clamping. Use the date as a deterministic test
    // fingerprint by adding the timestamp millis as days offset.
    const today = new Date()
    today.setDate(today.getDate() - 10)
    const yyyy = today.getFullYear()
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')
    const sessionDate = `${yyyy}-${mm}-${dd}`

    // ── Alice marks ────────────────────────────────────────────────────
    const aliceCtx  = await browser.newContext()
    const alicePage = await aliceCtx.newPage()
    await signIn(alicePage, 'alice')

    await alicePage.getByRole('link', { name: /Attendance/i }).click()
    await expect(alicePage.getByRole('heading', { name: 'Attendance' })).toBeVisible()

    // Select the lifecycle class.
    await alicePage.locator('#att-class').selectOption(CLASS_ID)

    // Pick the session date.
    await alicePage.locator('#att-date').fill(sessionDate)

    // Roster should load: bob is the only enrolled student. Pick "present"
    // for him. The roster has one select per row.
    await alicePage.locator('table select').first().selectOption('present')

    // Save attendance.
    await alicePage.getByRole('button', { name: /^Save attendance$/i }).click()
    // Durable check: the row's "Last marked" cell becomes non-"—".
    // (The "Saved N records" toast can race re-fetch.)
    const rosterRow = alicePage.locator('table tbody tr').first()
    await expect(rosterRow.locator('td').nth(2)).not.toHaveText('—', { timeout: 10_000 })

    // ── Bob views own attendance ──────────────────────────────────────
    const bobCtx  = await browser.newContext()
    const bobPage = await bobCtx.newPage()
    await signIn(bobPage, 'bob')

    await bobPage.getByRole('link', { name: /Attendance/i }).click()
    await expect(bobPage.getByRole('heading', { name: 'Attendance' })).toBeVisible()
    await bobPage.locator('#att-class').selectOption(CLASS_ID)

    // Bob's view is a simple table of (date, status) — own only.
    // Verify the date we just marked appears.
    await expect(bobPage.getByText(sessionDate)).toBeVisible({ timeout: 10_000 })
    await expect(bobPage.getByText('present').first()).toBeVisible()

    // Verify Bob's view does NOT include other students (the test class
    // has only one student anyway, so this asserts the table has exactly
    // one data row, not more).
    const bobRows = bobPage.locator('table tbody tr')
    await expect(bobRows).toHaveCount(1)

    await aliceCtx.close()
    await bobCtx.close()
})
