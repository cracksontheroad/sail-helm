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

  // ── Two-layer state model: shadow (async source-of-truth) + effective
  // (render-time, auth-gated) ─────────────────────────────────────────
  //
  // INVARIANT: permission state must never outlive (or lead) auth state.
  // When the authenticated identity changes — sign-out, sign-in, OR
  // user-switch within the same school — consumers must NEVER observe
  // the previous user's permissions attributed to the new identity,
  // not even for a single render.
  //
  // Earlier attempts to enforce this via effect timing failed: useEffect
  // runs after commit and children-first, so any provider-side reset
  // effect always fires AFTER child drift-checks have already observed
  // the stale state. A previous fix used React's "adjusting state
  // during render" pattern to discard the in-progress render — it
  // worked but is brittle and unconventional.
  //
  // The right shape: split state into two layers.
  //
  //   shadow*       — async source of truth, written by fetchPermissions
  //                   when the RPC resolves. Carries `shadowAuthKey` —
  //                   the auth identity it was loaded for — so render-
  //                   time gating can tell whether the cached shadow is
  //                   still valid for the current auth.
  //
  //   effective     — what consumers see via context. Pure derivation,
  //                   gated on `shadowMatches` (shadowAuthKey === current
  //                   authKey). When the shadow wasn't loaded for the
  //                   current auth identity (initial mount, mid-fetch,
  //                   user-switch), every field collapses to its safe
  //                   default; otherwise shadow values pass through.
  //
  // Why bind shadow to authKey, not just isAuthed: a naive `isAuthed`
  // gate works for sign-in/sign-out but leaks across user-switches —
  // bob signing in after alice (same school) would see alice's perms
  // until his fetch resolves. Tracking the auth identity the shadow
  // was loaded for closes that leak too.
  //
  // Because the gate is a render-time derivation (no setState, no
  // useEffect), the invariant is true by construction in every render
  // a child observes — no race possible regardless of effect ordering.
  const [shadowAuthKey,      setShadowAuthKey]      = useState(null);
  const [shadowRole,         setShadowRole]         = useState(null);
  const [shadowSchoolId,     setShadowSchoolId]     = useState(null);
  const [shadowPermissions,  setShadowPermissions]  = useState(EMPTY_SET);
  const [shadowDefaultRoute, setShadowDefaultRoute] = useState('/');
  const [shadowLoading,      setShadowLoading]      = useState(false);
  const [shadowError,        setShadowError]        = useState(null);

  const isAuthed = Boolean(authUserId && authSchoolId);
  // Single composite identity used to gate the shadow. `null` when not
  // authed so any cached shadow auth-key (which is also null on initial
  // mount, or some prior `user:school` after sign-out) cannot match.
  const authKey = isAuthed ? `${authUserId}:${authSchoolId}` : null;
  // Strict equality on a string composite is enough; null !== null in
  // the no-auth case (because we explicitly disallow it above via the
  // `isAuthed` short-circuit) prevents an uninitialised shadow from
  // accidentally being treated as valid.
  const shadowMatches = isAuthed && shadowAuthKey === authKey;

  // Auth-gated effective values exposed to consumers. The DB-authoritative
  // path inside can() also reads `permissions` and `loading` from these.
  const role         = shadowMatches ? shadowRole         : null;
  const schoolId     = shadowMatches ? shadowSchoolId     : null;
  const permissions  = shadowMatches ? shadowPermissions  : EMPTY_SET;
  const defaultRoute = shadowMatches ? shadowDefaultRoute : '/';
  const error        = shadowMatches ? shadowError        : null;
  // `loading` is true whenever auth is present but the shadow hasn't
  // caught up to it — either the RPC is in flight (shadowLoading) OR
  // the cached shadow was loaded for a different identity (!shadowMatches).
  // The latter case is what makes the fallback layer engage immediately
  // on sign-in / user-switch, before the fetch even starts, so consumers
  // get the role-correct answer via PREDICATE_MAP[k](authRole) instead
  // of a misleading `false` from an empty Set.
  // `false` on no-auth is intentional: it prevents the fallback layer
  // from being trapped in "loading" forever on the signed-out path.
  const loading      = isAuthed && (shadowLoading || !shadowMatches);

  // Cancellation token so a fast session/school swap doesn't apply a stale fetch.
  const fetchIdRef = useRef(0);

  const fetchPermissions = useCallback(async () => {
    if (!authUserId || !authSchoolId) {
      // No-op: the auth gate above already makes effective state safe.
      // We deliberately do NOT touch shadow here — leaving shadowAuthKey
      // unchanged means the gate stays "stale, don't trust" until a real
      // fetch binds shadow to a current authKey. Setting shadow values
      // (especially shadowLoading=false) on no-user would falsely tell
      // the next sign-in's render that the shadow is settled.
      return;
    }
    const myFetchId = ++fetchIdRef.current;
    const myAuthKey = `${authUserId}:${authSchoolId}`;
    setShadowLoading(true);
    setShadowError(null);
    const { data, error: err } = await permissionsService.getMyPermissions(authSchoolId);
    if (myFetchId !== fetchIdRef.current) return; // superseded
    if (err) {
      debugLog('fetch ERROR — fallback layer will engage for mapped names', err);
      // Bind shadow to this authKey even on error so consumers see the
      // error state (not a perpetual "loading") for the current identity.
      setShadowAuthKey(myAuthKey);
      setShadowRole(null);
      setShadowSchoolId(null);
      setShadowPermissions(EMPTY_SET);
      setShadowDefaultRoute('/');
      setShadowError(err);
      setShadowLoading(false);
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
    setShadowAuthKey(myAuthKey);
    setShadowRole(data?.role ?? null);
    setShadowSchoolId(data?.school_id ?? null);
    setShadowPermissions(loadedPerms);
    setShadowDefaultRoute(data?.default_route ?? '/');
    setShadowLoading(false);
  }, [authUserId, authSchoolId]);

  // Initial fetch + re-fetch on auth.userId or auth.schoolId change.
  // No special timing needed — the auth gate above already guarantees
  // consumers see safe defaults until shadow state catches up.
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
