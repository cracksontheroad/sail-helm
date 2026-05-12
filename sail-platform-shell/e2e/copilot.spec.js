// Flow E — Copilot Review Struggling (PR A smoke).
//
// Verifies the page at `/copilot/review-struggling` renders for a staff
// user, the Run Copilot button is wired, and clicking Run produces
// either the empty-state card ("No students cleared the threshold")
// or at least one suggestion card without a runtime error. The
// fixture test class has only bob enrolled with no behaviour /
// unsubmitted-work signals, so the expected path is the empty-state
// card.
//
// This is intentionally a *smoke* spec — it doesn't assert the
// suggestion shape or the accept-create-distribute flow. Those land
// in a future test pass alongside the seeded "struggling student"
// fixture.

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

const CLASS_ID = 'eeeeeeee-0000-0000-0000-000000000002'

test('staff user sees Copilot panel and Run button is wired', async ({ page }) => {
    await signIn(page, 'alice')

    // Nav link is the staff-only "Copilot" pill in the top bar.
    await page.getByRole('link', { name: /^Copilot$/ }).click()

    // Page renders with the documented heading + the request_id is not
    // yet visible (only appears after Run).
    await expect(
        page.getByRole('heading', { name: 'Copilot — Review struggling students' }),
    ).toBeVisible()

    // Pick the fixture class explicitly (the page auto-selects the first
    // class, which may not be the lifecycle test class on a fresh
    // database).
    await page.locator('#copilot-class').selectOption(CLASS_ID)

    // Click Run. The RPC will succeed with 0 rows on fixture data
    // (no students hit the threshold).
    await page.getByRole('button', { name: /^Run Copilot$/ }).click()

    // After Run, the request_id stamp appears (a 36-char uuid in
    // monospace). The empty-state card also appears.
    await expect(page.getByText(/request_id:/)).toBeVisible({ timeout: 10_000 })
    await expect(
        page.getByText(/No students cleared the threshold/i),
    ).toBeVisible({ timeout: 10_000 })
})

test('student user cannot see the Copilot nav link', async ({ page }) => {
    await signIn(page, 'bob')

    // Bob is a student; CAN.useCopilot returns false; the nav link
    // is conditionally hidden. Confirm it's not in the DOM at all.
    await expect(
        page.getByRole('link', { name: /^Copilot$/ }),
    ).toHaveCount(0)
})
