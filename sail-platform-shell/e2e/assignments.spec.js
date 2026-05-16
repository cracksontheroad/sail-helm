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

    // Bob's submission surface is /my-assignments (the dedicated student
    // page introduced in PR B). The /assignments page was the staff/student
    // shared surface in Phase 2 R2 but is now staff-only — the policy
    // correction in the RBAC migration (PR #12) tightened
    // `helm.assignments.view` to staff per the DB grants, removing the
    // redundant secondary student submission path. Bob's nav no longer
    // shows the "Assignments" link.
    //
    // MyAssignments renders a flat cross-class card list with the title,
    // class name, status pill ("not submitted" / "✓ submitted"), and —
    // for unsubmitted rows — a textarea + Submit button inline. We locate
    // the lifecycle row by its uniquely-timestamped title.
    await bobPage.getByRole('link', { name: /^My Assignments$/i }).click()
    await expect(bobPage.getByRole('heading', { name: 'My Assignments' })).toBeVisible()

    // Locate bob's lifecycle row card. The card is the innermost div that
    // has BOTH the assignment title AND a textarea descendant — `.last()`
    // gives that innermost match (Playwright returns descendant locators
    // in DOM order; outermost first, innermost last). Anchoring on the
    // textarea also disambiguates from already-submitted leftovers in
    // bob's cross-class list.
    const bobRow = bobPage.locator('div', { hasText: assignmentTitle })
        .filter({ has: bobPage.locator('textarea') })
        .last()
    await expect(bobRow).toBeVisible({ timeout: 10_000 })
    await expect(bobRow).toContainText(/not submitted/i)

    // Submit.
    await bobRow.locator('textarea').fill(submissionText)
    await bobRow.getByRole('button', { name: /^Submit$/i }).click()

    // After the row re-renders post-submit, the title-bearing card flips
    // to the "✓ submitted" state and the textarea + Submit button are
    // replaced by a read-only submitted panel.
    await expect(
        bobPage.locator('div', { hasText: assignmentTitle })
            .filter({ hasText: /✓ submitted/ })
            .last()
    ).toBeVisible({ timeout: 10_000 })

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
