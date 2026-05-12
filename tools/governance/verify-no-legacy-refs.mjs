/**
 * verify-no-legacy-refs — CI gate that prevents legacy Supabase project
 * refs from sneaking back into Helm source.
 *
 * Consumes `governance.config.json.legacySupabaseProjectRefs` (the
 * declarative blocklist that was previously documentation-only) and
 * scans every tracked source file for any occurrence. Fails CI on any
 * match — except in files where the legacy ref is legitimately
 * referenced (the config itself, the system manifest, this verifier).
 *
 * Why this exists:
 *   The Helm app's runtime guard in `sail-platform-shell/src/lib/supabaseClient.js`
 *   is the last line of defence against a misconfigured deploy. This
 *   verifier is the FIRST line — it prevents the legacy ref from
 *   ever being committed to a tracked file in the first place
 *   (a hardcoded URL in a helper, a stale comment with the wrong ref,
 *   a forgotten staging env file, etc.).
 *
 * What's exempt:
 *   - `tools/governance/governance.config.json` — the blocklist itself
 *   - the system manifest (path from config.manifestPath) — explicitly
 *     declares the legacy ref as "Legacy/transitional"
 *   - this verifier (it references the constant by name in its message
 *     copy, which would otherwise self-trigger)
 *   - any path under `node_modules/` or `dist/` or `playwright-report/`
 *     or `test-results/` (build artefacts / vendor — never tracked
 *     by git anyway, but defence-in-depth for the worktree case)
 *
 * Source enumeration: uses `git ls-files` (via node:child_process's
 * execFileSync — no shell interpolation, no injection vector). Only
 * tracked source is scanned; anything untracked (dist/, .env,
 * node_modules) is automatically out of scope.
 */

import { execFileSync } from 'node:child_process';
import { loadConfig, readText, pass, fail, printResults, exitCodeFor, ROOT } from './lib.mjs';

const config = loadConfig();
const results = [];

const legacyRefs = Array.isArray(config.legacySupabaseProjectRefs)
  ? config.legacySupabaseProjectRefs
  : [];

if (legacyRefs.length === 0) {
  // Empty blocklist = nothing to enforce. PASS with explanatory message.
  results.push(
    pass(
      'no_legacy_refs.config',
      'governance.config.json has no legacySupabaseProjectRefs — nothing to scan.',
    ),
  );
  printResults('No-Legacy-Refs Verification', results);
  process.exit(exitCodeFor(results));
}

results.push(
  pass(
    'no_legacy_refs.config',
    `Scanning for ${legacyRefs.length} legacy ref(s): ${legacyRefs.join(', ')}`,
  ),
);

// ─── Build the exemption list ────────────────────────────────────────────────
// These paths are allowed to mention the legacy ref. Anything else
// triggering on a legacy-ref match is a real violation.
//
// Keep this list as small as possible. Every entry is a known,
// audited exception where the legacy ref appears for a deliberate
// reason. Adding a new file here should be a conscious decision in
// code review, not a quick fix.
const EXEMPT_PATHS = new Set([
  // The blocklist itself necessarily contains the ref.
  'tools/governance/governance.config.json',
  // The manifest explicitly documents what's legacy. Path is configurable
  // via config.manifestPath in case it ever moves.
  config.manifestPath || 'SAIL_SYSTEM_MANIFEST.md',
  // This verifier doesn't currently mention the ref by literal string
  // (it reads it from config) — but defensively exempt it in case a
  // future maintainer adds an example comment.
  'tools/governance/verify-no-legacy-refs.mjs',
  // The Helm runtime project-isolation guard. The guard MUST hold the
  // legacy ref as a comparison constant (`LEGACY_PROJECT_REF`) — that
  // IS the safety mechanism. Exempting it here is intentional and
  // tightly scoped to this one file; any other source file mentioning
  // the legacy ref is a real violation.
  'sail-platform-shell/src/lib/supabaseClient.js',
]);

const EXEMPT_PREFIXES = ['node_modules/', 'dist/', 'playwright-report/', 'test-results/'];

function isExempt(relPath) {
  if (EXEMPT_PATHS.has(relPath)) return true;
  return EXEMPT_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

// ─── Enumerate tracked source via `git ls-files` ─────────────────────────────
// execFileSync runs the binary directly with an argv array — no shell, no
// injection surface. Output is newline-separated relative paths.
let trackedFiles;
try {
  const output = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  trackedFiles = output.split('\n').filter(Boolean);
} catch (err) {
  results.push(
    fail(
      'no_legacy_refs.git_ls_files',
      `git ls-files failed: ${err.message}. Run from a git checkout.`,
    ),
  );
  printResults('No-Legacy-Refs Verification', results);
  process.exit(exitCodeFor(results));
}

results.push(
  pass(
    'no_legacy_refs.enumerate',
    `Enumerated ${trackedFiles.length} tracked files.`,
  ),
);

// ─── Scan ────────────────────────────────────────────────────────────────────
const violations = [];

for (const relPath of trackedFiles) {
  if (isExempt(relPath)) continue;

  // Skip unreadable / binary files defensively. We're only interested
  // in text content where a project ref might be embedded.
  let body;
  try {
    body = readText(relPath);
  } catch {
    continue;
  }

  for (const ref of legacyRefs) {
    if (body.includes(ref)) {
      violations.push({ path: relPath, ref });
    }
  }
}

if (violations.length === 0) {
  results.push(
    pass(
      'no_legacy_refs.scan',
      `No legacy Supabase project refs found in any tracked file ` +
        `(excluding ${EXEMPT_PATHS.size} exempt path(s)).`,
    ),
  );
} else {
  // Group by ref for a clean failure message.
  const byRef = {};
  for (const v of violations) {
    byRef[v.ref] = byRef[v.ref] || [];
    byRef[v.ref].push(v.path);
  }
  for (const [ref, paths] of Object.entries(byRef)) {
    results.push(
      fail('no_legacy_refs.scan', `Legacy ref "${ref}" found in tracked source.`, {
        ref,
        count: paths.length,
        files: paths,
      }),
    );
  }
}

printResults('No-Legacy-Refs Verification', results);
process.exit(exitCodeFor(results));
