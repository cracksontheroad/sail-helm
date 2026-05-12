// Flow F — /my-assignments (PR B smoke).
//
// Verifies the student-facing assignments view renders for a student
// (bob), tolerates BOTH the empty and non-empty data states (the
// fixture DB accumulates and depopulates assignments across runs), and
// is structurally hidden from staff users (alice).
//
// We intentionally do NOT assert "at least one row exists" — that
// would be a data-volume test, which is exactly the kind of flake we
// just diagnosed on the assignments lifecycle suite. This is a
// render + auth + wiring smoke.

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

test('student sees My Assignments page (renders in either empty or non-empty state)', async ({ page }) => {
    await signIn(page, 'bob')

    // Default route for students is now /my-assignments — verify the
    // page is the landing surface.
    await expect(page).toHaveURL(/\/my-assignments(\?.*)?$/, { timeout: 10_000 })

    await expect(page.getByRole('heading', { name: 'My Assignments' })).toBeVisible()

    // Resilient assertion: the page is in a valid render state when
    // EITHER (a) at least one assignment row exists OR (b) the
    // empty-state copy is visible. Both are first-class states.
    const rowLocator       = page.locator('div', { hasText: 'not submitted' }).or(
                              page.locator('div', { hasText: '✓ submitted' }))
    const emptyStateLocator = page.getByText(/No assignments yet/i)

    // One of the two must be present within the timeout.
    await expect(rowLocator.first().or(emptyStateLocator)).toBeVisible({ timeout: 10_000 })
})

test('staff user does not see the My Assignments nav link', async ({ page }) => {
    await signIn(page, 'alice')

    // CAN.viewOwnAssignments is student-only; nav link is conditionally
    // hidden for staff. Confirm it's not in the DOM.
    await expect(
        page.getByRole('link', { name: /^My Assignments$/ }),
    ).toHaveCount(0)
})
