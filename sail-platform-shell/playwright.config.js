// @ts-check
import { defineConfig } from '@playwright/test'

/**
 * Playwright config for Helm E2E.
 *
 * Runs against a `vite preview` server on port 4173 (Vite's default
 * preview port). Tests sign in as the existing test users
 * `alice@test.com` (admin) and `bob@test.com` (student) — both have
 * been password-reset to the value below and added to the test
 * school `eeeeeeee-0000-0000-0000-000000000001`.
 *
 * Real Supabase backend; no mocking. See README in this folder for
 * setup expectations.
 */
export default defineConfig({
    testDir:    './e2e',
    testMatch:  /.*\.spec\.(js|ts)/,
    timeout:    30_000,
    fullyParallel: false,  // sequential — tests share state in the live DB
    workers:    1,
    retries:    0,
    reporter:   [['list']],

    use: {
        baseURL:        'http://localhost:4173',
        actionTimeout:  10_000,
        trace:          'retain-on-failure',
        screenshot:     'only-on-failure',
        // We're headless by default — no display in this env.
        headless:       true,
        viewport:       { width: 1200, height: 800 },
    },

    projects: [
        {
            name: 'chromium',
            use:  { browserName: 'chromium' },
        },
    ],

    webServer: {
        command:           'npm run preview -- --port 4173 --strictPort',
        url:               'http://localhost:4173',
        reuseExistingServer: true,
        timeout:           30_000,
    },
})
