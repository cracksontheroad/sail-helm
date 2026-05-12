// Flow C — Assignments lifecycle
//
// Alice (admin/teacher of the fixture test class) creates + distributes
// an assignment. Bob (the enrolled student) submits. Alice grades.
// Bob verifies they only see their own row, and only when graded.
//
// Pre-conditions (set up via MCP before this file runs):
//   - test school eeeeeeee-0000-0000-0000-000000000001
//   - test class  eeeeeeee-0000-0000-0000-000000000002 "TEST — E2E Lifecycle Class"
//   - alice enrolled as 'teacher'
//   - bob   enrolled as 'student'

import { test, expect } from '@playwright/test'
import { signIn } from './helpers.js'
import { cleanupTestAssignments } from './cleanup-fixtures.js'

const TEST_CLASS_ID   = 'eeeeeeee-0000-0000-0000-000000000002'
const TEST_CLASS_NAME = 'TEST — E2E Lifecycle Class'
const ASSIGNMENT_TITLE_PREFIX = 'TEST — E2E Asgn '
const assignmentTitle = `${ASSIGNMENT_TITLE_PREFIX}${Date.now()}`
const submissionText  = 'My E2E test submission, with substance.'
const gradeValue      = 'A-'

// Pre-test fixture cleanup: delete TEST-titled assignments accumulated
// from prior runs against the live DB. Without this, the Assignments
// page slows to a crawl rendering 100+ rows and the lifecycle test's
// `tr` row scan can blow past the 30 s budget. Cleanup is best-effort
// (failures are logged + swallowed) so it never blocks the actual
// test — the test creates a uniquely-titled row regardless.
test.beforeAll(async () => {
    const { deleted, scanned } = await cleanupTestAssignments({
        classId:     TEST_CLASS_ID,
        titlePrefix: ASSIGNMENT_TITLE_PREFIX,
    })
    // eslint-disable-next-line no-console
    console.log(`[assignments.spec.js] pre-test cleanup: deleted ${deleted}/${scanned} TEST rows`)
})

test('full assignment lifecycle: create → distribute → submit → grade', async ({ browser }) => {
    // ── Alice's session ────────────────────────────────────────────────
    const aliceCtx  = await browser.newContext()
    const alicePage = await aliceCtx.newPage()
    await signIn(alicePage, 'alice')

    // Navigate to Assignments
    await alicePage.getByRole('link', { name: /Assignments/i }).click()
    await expect(alicePage.getByRole('heading', { name: 'Assignments' })).toBeVisible()

    // Select the lifecycle class (Assignments.jsx auto-selects first; if
    // alice has multiple classes pick the lifecycle one explicitly).
    await alicePage.locator('#att-class, #class-select, select').first()
        .selectOption('eeeeeeee-0000-0000-0000-000000000002')

    // Wait for assignments listing (or empty-state) to settle.
    await expect(alicePage.getByText(/Loading assignments|No assignments yet|Create an assignment/i))
        .toBeVisible()

    // Create the assignment via the bottom form.
    await alicePage.getByPlaceholder('Title').fill(assignmentTitle)
    await alicePage.getByPlaceholder('Description (optional)').fill('E2E description')
    await alicePage.getByRole('button', { name: /^Create assignment$/i }).click()

    // The new row should appear in the table.
    const row = alicePage.locator('tr', { hasText: assignmentTitle })
    await expect(row).toBeVisible({ timeout: 10_000 })

    // Open its detail row and distribute.
    await row.getByRole('button', { name: /^Details$/i }).click()
    await alicePage.getByRole('button', { name: /^Distribute to enrolled students$/i }).click()
    // The success toast can race the re-fetch; assert on the durable
    // state — the row's Distributed cell becomes ≥ 1.
    await expect(row.locator('td').nth(2)).toHaveText(/^[1-9]\d*$/, { timeout: 10_000 })

    // ── Bob's session ──────────────────────────────────────────────────
    const bobCtx  = await browser.newContext()
    const bobPage = await bobCtx.newPage()
    await signIn(bobPage, 'bob')

    // Bob navigates to Assignments (the staff/student class-listing
    // surface) and selects the same class. Use `exact: true` so the
    // regex doesn't also match the student-only "My Assignments" link
    // PR B added to bob's nav.
    await bobPage.getByRole('link', { name: 'Assignments', exact: true }).click()
    await bobPage.locator('select').first()
        .selectOption('eeeeeeee-0000-0000-0000-000000000002')

    const bobRow = bobPage.locator('tr', { hasText: assignmentTitle })
    await expect(bobRow).toBeVisible({ timeout: 10_000 })

    // Bob's status should be 'assigned' (distributed but not yet submitted).
    await expect(bobRow).toContainText(/assigned/i)

    // Submit.
    await bobRow.getByRole('button', { name: /^Details$/i }).click()
    await bobPage.getByRole('textbox').last().fill(submissionText)
    await bobPage.getByRole('button', { name: /^Submit$/i }).click()

    // After re-fetch the my_status should flip to 'submitted'.
    await expect(bobPage.locator('tr', { hasText: assignmentTitle })).toContainText(/submitted/i, { timeout: 10_000 })

    // ── Alice grades in Gradebook ─────────────────────────────────────
    await alicePage.getByRole('link', { name: /Gradebook/i }).click()
    await expect(alicePage.getByRole('heading', { name: 'Gradebook' })).toBeVisible()

    await alicePage.locator('#gb-class').selectOption('eeeeeeee-0000-0000-0000-000000000002')
    await alicePage.locator('#gb-assignment').selectOption({ label: assignmentTitle })

    // Alice sees bob's submission row.
    await expect(alicePage.getByText('bob@test.com')).toBeVisible({ timeout: 10_000 })
    await expect(alicePage.getByText(submissionText)).toBeVisible()

    // Grade it.
    const gradeInput = alicePage.locator('input[placeholder*="A /"]').first()
    await gradeInput.fill(gradeValue)
    await alicePage.getByRole('button', { name: /^Save grade$/i }).click()
    // The "Saved." indicator can race the data re-fetch — assert on the
    // durable state instead: the row's status pill is now "graded".
    await expect(alicePage.getByText('graded').first()).toBeVisible({ timeout: 10_000 })

    // ── Bob sees the grade ───────────────────────────────────────────
    await bobPage.getByRole('link', { name: /Gradebook/i }).click()
    await expect(bobPage.getByRole('heading', { name: 'Gradebook' })).toBeVisible()
    await bobPage.locator('#gb-class').selectOption('eeeeeeee-0000-0000-0000-000000000002')
    await bobPage.locator('#gb-assignment').selectOption({ label: assignmentTitle })

    // Bob sees own grade panel — the grade and feedback (if any).
    await expect(bobPage.getByText(gradeValue, { exact: true })).toBeVisible({ timeout: 10_000 })

    await aliceCtx.close()
    await bobCtx.close()
})
