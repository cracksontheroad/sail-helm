// Flow G — /behaviour (PR C smoke).
//
// Verifies the Behaviour page renders for both staff (with selectors +
// log form) and students (read-only own view), tolerates BOTH empty
// and non-empty event states, and the staff-only Log button is hidden
// from students.
//
// Like /my-assignments, we intentionally do NOT assert "an event
// exists". The fixture has none seeded; render + auth + wiring is
// what we're protecting.

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

const CLASS_ID = 'eeeeeeee-0000-0000-0000-000000000002'

test('staff user lands on Behaviour with class + student selectors and a log form', async ({ page }) => {
    await signIn(page, 'alice')

    await page.getByRole('link', { name: /^Behaviour$/ }).click()
    await expect(page.getByRole('heading', { name: 'Behaviour' })).toBeVisible()

    // Both selectors must render. The page auto-selects the first class
    // and the first student in that class.
    await expect(page.locator('#behaviour-class')).toBeVisible()
    await expect(page.locator('#behaviour-student')).toBeVisible()

    // Switch to the lifecycle test class (which has bob enrolled).
    await page.locator('#behaviour-class').selectOption(CLASS_ID)

    // The Log button (staff only) must be present.
    await expect(page.getByRole('button', { name: /^Log$/ })).toBeVisible({ timeout: 10_000 })

    // The events list is in a valid render state when EITHER one or
    // more event cards exist OR the empty-state copy shows.
    //
    // Scope the event-card locator to <span> elements: the TypePill
    // inside an event card renders as <span>Positive</span> (etc.),
    // while the staff LogForm's type-picker uses the same labels but
    // as <button> elements that are ALWAYS visible for staff. The
    // earlier broader `text=/.../i` locator matched both, which made
    // the `.or()` union resolve to 2 elements when no events were
    // present (button visible + empty-state paragraph visible) and
    // tripped Playwright strict mode. Scoping to <span> makes the two
    // halves of the union mutually exclusive: pills only render with
    // events, the empty paragraph only renders without — never both.
    const eventCard       = page.locator('span', { hasText: /^(Positive|Negative|Note)$/ }).first()
    const emptyStateCopy  = page.getByText(/No behaviour events recorded yet/i)
    await expect(eventCard.or(emptyStateCopy)).toBeVisible({ timeout: 10_000 })
})

test('student sees own Behaviour log read-only (no selectors, no log form)', async ({ page }) => {
    await signIn(page, 'bob')

    await page.getByRole('link', { name: /^Behaviour$/ }).click()
    await expect(page.getByRole('heading', { name: 'My Behaviour Log' })).toBeVisible()

    // Student view has NO class selector, NO student selector, and NO
    // log form. Each of these locators should match 0 elements.
    await expect(page.locator('#behaviour-class')).toHaveCount(0)
    await expect(page.locator('#behaviour-student')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Log$/ })).toHaveCount(0)

    // Events list is in a valid render state when EITHER cards exist
    // OR the empty-state copy is visible. Same span-scoped locator
    // as the staff test above — the student view has no LogForm
    // buttons today so this wouldn't currently false-positive, but
    // keeping the two tests symmetric reduces the chance of a future
    // student-side LogForm (or any other Positive/Negative/Note
    // <button>) reintroducing the same ambiguity.
    const eventCard      = page.locator('span', { hasText: /^(Positive|Negative|Note)$/ }).first()
    const emptyStateCopy = page.getByText(/No behaviour events recorded yet/i)
    await expect(eventCard.or(emptyStateCopy)).toBeVisible({ timeout: 10_000 })
})
