/**
 * PermissionsProvider — Helm's DB-backed permission cache (FOUNDATION step).
 *
 * Ported from the helm/refactor-in-progress branch on 2026-05-16 as a
 * standalone foundation. INSTALL but DO NOT ACTIVATE:
 *   - this provider runs at app root and fetches the live permission
 *     catalog so consumers can call `can(name)` from anywhere
 *   - existing CAN.X(role) usage in App.jsx and pages is untouched —
 *     this is "install the new engine without turning it on"
 *
 * Contract (matches Bridge's PermissionsProvider so future consumers
 * can read either app's docs):
 *   {
 *     role         : string | null         — school-scoped role
 *     schoolId     : string | null         — the school id `role` belongs to
 *     permissions  : Set<string>           — DB-backed `helm.*` permission set
 *                                            (from helm_get_my_school_permissions)
 *     CAN          : { [predicateKey]: boolean }
 *                                          — pre-computed semantic gates
 *                                            derived from the STATIC predicate
 *                                            map in lib/permissions.js. Kept
 *                                            for grep-friendly UI gates;
 *                                            decisions still flow from
 *                                            `permissions` for can(name).
 *     loading      : boolean
 *     error        : { message, code, kind } | null
 *     can(name)    : boolean               — DB-first with static fallback
 *                                            during initial load (see below)
 *     canStrict(name): boolean             — DB-only, never falls back; use
 *                                            this for Bridge-equivalent
 *                                            strictness when consumers can
 *                                            tolerate `false` during loading
 *     refresh()    : Promise<void>
 *     defaultRoute : string                — role-default landing path
 *   }
 *
 * ── can(name) semantics — the "safe fallback" layer (FOUNDATION step) ──
 *   - When `loading` is true OR `error` is non-null AND a static fallback
 *     mapping exists for `name`, returns `PREDICATE_MAP[fallbackKey](authRole)`
 *     where `authRole` comes from `useAuth()` — NOT the provider's own
 *     `role` state (which lags by one RPC roundtrip).
 *     Rationale: during the initial network roundtrip (or after a transient
 *     RPC failure) we don't want every gate in the UI to read "false" and
 *     blink elements in/out — fall back to the existing static predicate
 *     so the UI behaves IDENTICALLY to the pre-refactor code path. Using
 *     AuthContext's role is what makes that guarantee meaningful — it's
 *     populated before the permissions fetch even starts.
 *   - Otherwise (DB fetch completed successfully — even with an empty
 *     set), returns `permissions.has(name)`. The DB is authoritative once
 *     it has spoken.
 *   - Names not in the fallback map fall through to `permissions.has(name)`
 *     even during loading — that path returns `false` until DB loads,
 *     which is correct fail-closed behavior for unmapped names.
 *
 * Per-call opt-out: `canStrict(name)` skips the fallback. Use it where a
 * page genuinely wants to wait for the DB before showing/hiding an
 * affordance.
 *
 * Fail-closed by design:
 *   - Initial state: empty permission set, loading=true → fallback engages
 *   - On error: empty set, error populated → fallback engages
 *   - On RPC fail-closed envelope ({role: null, permissions: []}) → empty
 *     set, loading=false, no error → can() returns false (no fallback)
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import { useAuth } from '../../lib/AuthContext';
import { permissionsService } from '../../services/permissions';
import { CAN as PREDICATE_MAP } from '../../lib/permissions';

const PermissionsContext = createContext(null);

const EMPTY_SET = new Set();

/**
 * Map DB permission names → static predicate keys in `lib/permissions.js`.
 *
 * Used ONLY as a fallback path inside `can(name)` while the DB fetch is
 * in flight or has errored. Names not in this map have no fallback; they
 * resolve via `permissions.has(name)` directly (which returns false
 * during loading — safe fail-closed default for unmapped names).
 *
 * This is a small, hand-maintained table — 10 entries today, one per
 * permission currently in `public.school_role_permissions`. Easy to
 * extend as new permissions are added; missing entries are harmless
 * (just lose the during-loading-visible UI affordance).
 */
const PERMISSION_TO_CAN_KEY = {
  'helm.assignments.view':       'viewAssignments',
  'helm.assignments.create':     'createAssignment',
  'helm.assignments.submit':     'submitAssignment',
  'helm.dashboard.view':         'viewDashboard',
  'helm.gradebook.view':         'viewGradebook',
  'helm.grades.view_own':        'viewOwnAssignments',
  'helm.members.view':           'viewMembers',
  'helm.school.manage':          'manageSchool',
  'helm.submissions.grade':      'gradeSubmission',
  'helm.submissions.grade_batch':'batchGrade',
};

/** Empty CAN — every gate `false`. Frozen so consumers can't mutate it. */
const EMPTY_CAN = Object.freeze(
  Object.fromEntries(Object.keys(PREDICATE_MAP).map((k) => [k, false])),
);

function buildCan(role) {
  if (!role) return EMPTY_CAN;
  const out = {};
  for (const [key, predicate] of Object.entries(PREDICATE_MAP)) {
    out[key] = typeof predicate === 'function' ? Boolean(predicate(role)) : false;
  }
  return Object.freeze(out);
}

// ── Debug logging (FOUNDATION step — temporary) ─────────────────────────
// The brief asks for visibility while we validate the new layer in production
// without enforcing it anywhere. Logs are gated on a single module-level
// flag so they can be flipped off in one place once we're confident the
// foundation is correct. Remove this block when migrating off the
// transitional layer (see CAN coexistence note in the header).
const PERMISSIONS_DEBUG = true;
function debugLog(...args) {
  if (PERMISSIONS_DEBUG && typeof console !== 'undefined') {
    console.log('[PermissionsProvider]', ...args);
  }
}

export function PermissionsProvider({ children }) {
  const auth = useAuth();
  const authLoading  = auth?.loading  ?? true;
  const authUserId   = auth?.userId   ?? null;
  const authSchoolId = auth?.schoolId ?? null;
  // AuthContext is the truth source for the school-scoped role during
  // the in-flight window. The provider also tracks its own `role` state
  // (set from the RPC response), but that lags AuthContext by one
  // roundtrip — using it inside the fallback path means the fallback
  // evaluates against `role=null` during the most important window
  // (between SIGNED_IN and the RPC returning), which defeats the
  // "no UI blink" guarantee. `authRole` is populated by AuthContext's
  // own profile resolution before fetchPermissions is even called.
  const authRole = auth?.role ?? null;

  const [role,         setRole]         = useState(null);
  const [schoolId,     setSchoolId]     = useState(null);
  const [permissions,  setPermissions]  = useState(EMPTY_SET);
  const [defaultRoute, setDefaultRoute] = useState('/');
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);

  // Cancellation token so a fast session/school swap doesn't apply a stale fetch.
  const fetchIdRef = useRef(0);

  const fetchPermissions = useCallback(async () => {
    if (!authUserId) {
      setRole(null);
      setSchoolId(null);
      setPermissions(EMPTY_SET);
      setDefaultRoute('/');
      setError(null);
      setLoading(false);
      return;
    }
    const myFetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    const { data, error: err } = await permissionsService.getMyPermissions(authSchoolId);
    if (myFetchId !== fetchIdRef.current) return; // superseded
    if (err) {
      debugLog('fetch ERROR — fallback layer will engage for mapped names', err);
      setRole(null);
      setSchoolId(null);
      setPermissions(EMPTY_SET);
      setDefaultRoute('/');
      setError(err);
      setLoading(false);
      return;
    }
    const loadedPerms = new Set(data?.permissions || []);
    debugLog('fetch OK', {
      role:          data?.role,
      schoolId:      data?.school_id,
      permissionCount: loadedPerms.size,
      permissions:   Array.from(loadedPerms),
      defaultRoute:  data?.default_route,
    });
    setRole(data?.role ?? null);
    setSchoolId(data?.school_id ?? null);
    setPermissions(loadedPerms);
    setDefaultRoute(data?.default_route ?? '/');
    setLoading(false);
  }, [authUserId, authSchoolId]);

  // Initial fetch + re-fetch on auth.userId or auth.schoolId change.
  useEffect(() => {
    if (authLoading) return;
    fetchPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId, authSchoolId, authLoading]);

  // ── can(name) with safe fallback ────────────────────────────────────
  // DB authoritative once loaded; fallback to static predicate while
  // loading or errored AND only for names with an explicit mapping.
  // See PERMISSION_TO_CAN_KEY above + header comment for full semantics.
  //
  // NB: the fallback uses `authRole` from AuthContext, NOT the provider's
  // own `role` state. The provider's `role` is derived from the RPC
  // response, so during the most important fallback window (initial
  // load, between SIGNED_IN and the RPC returning) it is still null —
  // evaluating the static predicate against null defeats the entire
  // point of the fallback ("no UI blink during load"). AuthContext's
  // role resolves earlier and is the right truth source for this path.
  const can = useCallback(
    (name) => {
      const useFallback = (loading || !!error);
      if (useFallback) {
        const fallbackKey = PERMISSION_TO_CAN_KEY[name];
        if (fallbackKey) {
          const predicate = PREDICATE_MAP[fallbackKey];
          const result = typeof predicate === 'function' ? Boolean(predicate(authRole)) : false;
          debugLog(`can("${name}") → ${result} (fallback via CAN.${fallbackKey})`);
          return result;
        }
        // No fallback mapping; fall through to the DB lookup (which is
        // an empty Set during loading → false). Safe fail-closed default.
      }
      const result = permissions.has(name);
      debugLog(`can("${name}") → ${result} (DB)`);
      return result;
    },
    [permissions, loading, error, authRole],
  );

  // Strict variant for consumers that explicitly want Bridge-equivalent
  // semantics (no fallback). Not used by anyone today; exposed for the
  // future migration when individual pages want to opt out of the
  // fallback path one at a time.
  const canStrict = useCallback(
    (name) => permissions.has(name),
    [permissions],
  );

  const CAN = useMemo(() => buildCan(role), [role]);

  const value = useMemo(
    () => ({
      role,
      schoolId,
      permissions,
      CAN,
      loading,
      error,
      can,
      canStrict,
      refresh: fetchPermissions,
      defaultRoute,
    }),
    [role, schoolId, permissions, CAN, loading, error, can, canStrict, fetchPermissions, defaultRoute],
  );

  return (
    <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (ctx === null) {
    throw new Error('usePermissions must be used inside <PermissionsProvider>');
  }
  return ctx;
}
