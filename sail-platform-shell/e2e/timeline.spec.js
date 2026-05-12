// Flow H — /timeline (PR D smoke).
//
// Verifies the per-student timeline page renders for staff (with class
// + student selectors) and for students (read-only own view). Both
// paths tolerate empty + populated event states. The fixture test
// class has real timeline events (attendance + assignments + behaviour)
// accumulated across runs, so the populated state will usually fire —
// but the spec is resilient either way.
//
// Anchored selectors throughout. The page introduces a "Timeline" nav
// link, which would collide with `/Timeline/i`-style regex selectors
// in any future test that does substring matching.

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

const CLASS_ID = 'eeeeeeee-0000-0000-0000-000000000002'

test('staff user sees Timeline with class + student selectors', async ({ page }) => {
    await signIn(page, 'alice')

    await page.getByRole('link', { name: /^Timeline$/ }).click()
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible()

    // Both selectors must render with the same id contract as
    // /behaviour (consistency with PR C).
    await expect(page.locator('#timeline-class')).toBeVisible()
    await expect(page.locator('#timeline-student')).toBeVisible()

    // Switch to the lifecycle test class. Student selector auto-picks
    // the first student (bob).
    await page.locator('#timeline-class').selectOption(CLASS_ID)

    // Valid render state: EITHER an event row exists OR the empty-state
    // copy is visible. (The fixture has events; both branches kept for
    // resilience.)
    const eventRow       = page.locator('text=/^Attendance$|^Behaviour$|^Assignment$|^Graded$/i').first()
    const emptyStateCopy = page.getByText(/No timeline events yet/i)
    await expect(eventRow.or(emptyStateCopy)).toBeVisible({ timeout: 10_000 })
})

test('student sees own Timeline read-only (no selectors)', async ({ page }) => {
    await signIn(page, 'bob')

    await page.getByRole('link', { name: /^Timeline$/ }).click()
    await expect(page.getByRole('heading', { name: 'My Timeline' })).toBeVisible()

    // Student view: NO class selector, NO student selector.
    await expect(page.locator('#timeline-class')).toHaveCount(0)
    await expect(page.locator('#timeline-student')).toHaveCount(0)

    // Valid render state.
    const eventRow       = page.locator('text=/^Attendance$|^Behaviour$|^Assignment$|^Graded$/i').first()
    const emptyStateCopy = page.getByText(/No timeline events yet/i)
    await expect(eventRow.or(emptyStateCopy)).toBeVisible({ timeout: 10_000 })
})
