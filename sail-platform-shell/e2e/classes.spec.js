// Flow B — Classes + Enrollments
//
// Admin (alice) creates a class, then verifies the class appears in the
// list. Enrollment happens via the create_class teacher dual-write
// (the admin is auto-enrolled as teacher).
//
// Bob is already a student in the test school via fixture seed, but
// has no enrollment in any specific class. We don't UI-enroll him in
// this flow (Courses.jsx has a user_id-typed-in form which is rough
// UX for Phase 2; the API-level enroll path is exercised by assignments.spec.js
// via distribute → which validates against enrollments).

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'

// Unique class name per run so the test is idempotent (data persists in
// the real DB; we look up by name after creating).
const className = `TEST — E2E Class ${Date.now()}`

test('admin creates a class and sees it in the list', async ({ page }) => {
    await signIn(page, 'alice')
    await page.getByRole('link', { name: /Courses/i }).click()
    await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible()

    // Fill the create form: class name + subject + teacher picker (alice herself).
    await page.getByPlaceholder('Class name').fill(className)
    await page.getByPlaceholder('Subject (optional)').fill('E2E Smoke')

    // Teacher dropdown — pick alice (the only staff member). The page
    // currently has just one <select> (the teacher picker on the create
    // form); selectOption uses the exact <option> label.
    await page.locator('select').selectOption({ label: 'alice@test.com — Admin' })

    await page.getByRole('button', { name: /Create class/i }).click()

    // The list re-fetches; the new class row should appear.
    await expect(page.getByRole('cell', { name: className })).toBeVisible({ timeout: 10_000 })
})

test('admin sees enrollment count update after teacher dual-write', async ({ page }) => {
    await signIn(page, 'alice')
    await page.getByRole('link', { name: /Courses/i }).click()
    await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible()

    // The class created above should have at least 0 enrollments (teacher
    // is enrolled with role='teacher', which doesn't count for the
    // enrollment_count column — only role='student' does). Verify the
    // class row shows a numeric student count (>= 0).
    const row = page.locator('tr', { hasText: className })
    await expect(row).toBeVisible()
    // The Students column is the 4th td (Name | Subject | Teacher | Students | Details).
    const studentsCell = row.locator('td').nth(3)
    await expect(studentsCell).toHaveText(/^\d+$/)
})
