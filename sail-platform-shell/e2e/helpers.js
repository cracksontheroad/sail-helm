// Test helpers for Helm E2E.
//
// These functions know about the Login page's DOM (placeholder text on
// inputs) and the auth flow's redirect-after-signin behaviour. Each
// test starts by signing in fresh; tests do not share browser state.

import { expect } from '@playwright/test'

// Test-user password. The literal default matches the fixture seed in
// SAIL-core; CI overrides via the `E2E_TEST_PASSWORD` environment
// variable so the credential can be rotated as a GitHub secret without
// editing this file. The literal is NOT a production credential —
// fixture-only test users in the test school.
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'E2eHelmTest!2026'

export const TEST_USERS = {
    alice:   { email: 'alice@test.com', role: 'admin'   },
    bob:     { email: 'bob@test.com',   role: 'student' },
}

export const TEST_SCHOOL_ID = 'eeeeeeee-0000-0000-0000-000000000001'

/**
 * Sign in as a test user. Asserts that the dashboard (or appropriate
 * landing page) renders. Does NOT depend on prior state — call at the
 * start of each test.
 */
export async function signIn(page, who) {
    const user = TEST_USERS[who]
    if (!user) throw new Error(`unknown test user: ${who}`)

    await page.goto('/')
    // Login page placeholders: "Email" and "Password"
    await page.getByPlaceholder('Email').fill(user.email)
    await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: /Sign In/i }).click()

    // Post-login: admin lands on /, student on /my-grades. Either way
    // the top bar should show the user's email or role pill.
    // Wait for the SAIL Platform header to be visible (it's only there
    // post-login because pre-login uses an h1 "SAIL Platform" too — so
    // we instead wait for the role pill which is post-login only).
    await expect(page.getByRole('button', { name: /Sign Out/i })).toBeVisible({ timeout: 10_000 })
}

/** Sign out via the top-right button. */
export async function signOut(page) {
    await page.getByRole('button', { name: /Sign Out/i }).click()
    // After signout the Login screen renders.
    await expect(page.getByPlaceholder('Email')).toBeVisible({ timeout: 5_000 })
}
