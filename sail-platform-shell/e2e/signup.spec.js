// D-Finish Step 1 — Signup UI e2e (real browser → live backend).
// Verifies: existing logins unbroken; new owner can sign up → /provisioning → create school → admin dashboard.
// The created test user/school are captured for SQL cleanup (run after via Supabase MCP).
import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

const SIGNUP_EMAIL = process.env.SIGNUP_EMAIL || 'signup-e2e-fallback@sailtest.dev'
const SIGNUP_PW    = process.env.SIGNUP_PW    || 'E2eSignup!2026'

test('regression: existing admin (alice) login still works', async ({ page }) => {
    await signIn(page, 'alice')
    await expect(page.getByRole('button', { name: /Sign Out/i })).toBeVisible()
})

test('regression: existing student (bob) login still works', async ({ page }) => {
    await signIn(page, 'bob')
    await expect(page.getByRole('button', { name: /Sign Out/i })).toBeVisible()
})

// This test CREATES a real auth user + school and has no in-test teardown (auth-user
// deletion needs the service role). It is gated to run ONLY when SIGNUP_EMAIL is
// explicitly provided (manual/verification runs, with external SQL cleanup). In CI
// (no SIGNUP_EMAIL) it is skipped, so CI leaves no residue and never collides on re-run.
test('new owner: signup → provisioning → create school → admin dashboard', async ({ page }) => {
    test.skip(!process.env.SIGNUP_EMAIL, 'signup-creating test runs only with explicit SIGNUP_EMAIL + external cleanup')
    const consoleErrors = []
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message))

    await page.goto('/')

    // 1. Login page offers "Create account" → switch to signup mode
    await page.getByRole('button', { name: /Create account/i }).click()
    await expect(page.getByRole('heading', { name: /Create your account/i })).toBeVisible()

    // 2. Fill signup form (email, password, display name)
    await page.getByPlaceholder('First name').fill('E2E')
    await page.getByPlaceholder('Last name').fill('Owner')
    await page.getByPlaceholder('Email').fill(SIGNUP_EMAIL)
    await page.getByPlaceholder('Password').fill(SIGNUP_PW)

    // 3. Submit — email-confirm OFF means an immediate session
    await page.getByRole('button', { name: /^Sign up$/i }).click()

    // 4. New user has no school → routed into the EXISTING provisioning flow
    await expect(page.getByRole('heading', { name: /Provision a school/i })).toBeVisible({ timeout: 15_000 })

    // 5. Create the school → owner becomes admin (server-side via create_school_with_owner)
    await page.getByPlaceholder(/Roehampton Grammar/i).fill('E2E Signup Academy')
    await page.getByRole('button', { name: /Create school/i }).click()

    // 6. Wait for the create+reload to COMPLETE: provisioning gone AND a school-gated
    //    nav link present (Courses/Members only render with a school + staff role).
    //    This proves the school was actually created and the user is now its admin —
    //    NOT merely that they are signed in (Sign Out shows on /provisioning too).
    await expect(page.getByRole('heading', { name: /Provision a school/i })).toHaveCount(0, { timeout: 25_000 })
    await expect(page.getByRole('link', { name: /^Members$/i })).toBeVisible({ timeout: 25_000 })
    await expect(page.getByRole('link', { name: /^Courses$/i })).toBeVisible()
    await page.screenshot({ path: 'e2e-signup-dashboard.png', fullPage: true })

    // 7. No console errors during the whole flow
    expect(consoleErrors, 'console errors: ' + consoleErrors.join(' | ')).toEqual([])
})
