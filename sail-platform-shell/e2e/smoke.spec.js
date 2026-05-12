// Smoke test — verifies the framework itself works:
//   - dev server boots
//   - Login page renders
//   - alice can sign in and lands on Dashboard
//
// If this passes, the deeper flow tests have a chance.
import { test, expect } from '@playwright/test'
import { signIn, signOut } from './helpers.js'

test('login page renders', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'SAIL Platform' })).toBeVisible()
    await expect(page.getByPlaceholder('Email')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: /Sign In/i })).toBeVisible()
})

test('alice (admin) can sign in and lands on Dashboard', async ({ page }) => {
    await signIn(page, 'alice')
    // Dashboard should show the school name (the M7 get_school result).
    await expect(page.getByText('TEST — E2E Helm Suite')).toBeVisible({ timeout: 10_000 })
    // Identity strip should show admin role label.
    await expect(page.getByText(/Role:/)).toBeVisible()
    await signOut(page)
})

test('bob (student) can sign in', async ({ page }) => {
    await signIn(page, 'bob')
    // Student gets routed to /my-grades stub by App.jsx's defaultRoute.
    await expect(page).toHaveURL(/\/(my-grades|$)/)
    await signOut(page)
})
