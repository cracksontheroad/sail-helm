/**
 * PermissionsProvider — Helm's DB-backed permission cache.
 *
 * Fetches the live permission catalog from
 * `helm_get_my_school_permissions(p_school_id)` on mount and on auth
 * identity change, then exposes a single `can(name: string): boolean`
 * function (plus a few convenience fields) for consumers to gate UI
 * + side effects.
 *
 * ══════════════════════════════════════════════════════════════════
 * ARCHITECTURAL INVARIANTS (do not break — hard-earned, see PR #12)
 * ══════════════════════════════════════════════════════════════════
 *
 *   I. `can()` IS THE ONLY ACCESS API.
 *      All UI access decisions go through `can('permission.key')`.
 *      Direct role checks (`role === 'admin'`, `isStaff(role)`) are
 *      for DATA FILTERING and UX BRANCHING ONLY — never for gating
 *      capabilities. See `src/lib/permissions.js` header for the
 *      full rule + the documented exceptions.
 *
 *  II. `can()` IS ASYNC-RESOLVED. Routes must NOT render until
 *      permissions resolve.
 *      During the in-flight window between auth resolving and the
 *      permissions fetch completing, `can()` returns `false` for
 *      everything (the shadow gate hasn't bound to the current
 *      authKey yet). Code paths that compute against `can()` during
 *      that window will see false negatives. App.jsx gates the main
 *      render on `permissionsLoading` for exactly this reason —
 *      deep-link to a permission-gated route would otherwise
 *      silently catch-all-redirect to the role-default route.
 *
 * III. FRONTEND MAY NARROW SCOPE, NEVER EXPAND IT.
 *      RPCs are scope-enforced server-side (RLS / SECDEF). The
 *      frontend may filter results client-side to a smaller set
 *      (e.g. show student's own grades from a returned row list),
 *      but must NEVER call an RPC the current role isn't admitted
 *      to in hopes of getting wider data — the server will deny,
 *      noise the console, and signal a frontend bug. See
 *      `api.assignments.listForGradebook` for a working example of
 *      role-aware RPC dispatch.
 *
 * Contract:
 *   {
 *     role         : string | null         — school-scoped role (from RPC)
 *     schoolId     : string | null         — school id the role belongs to
 *     permissions  : Set<string>           — DB-backed `helm.*` permission set
 *     loading      : boolean               — true while shadow state hasn't
 *                                            caught up to auth identity
 *     error        : { message, code, kind } | null
 *     can(name)    : boolean               — permissions.has(name) under the
 *                                            auth gate (see invariant below)
 *     refresh()    : Promise<void>         — force a re-fetch
 *     defaultRoute : string                — role-default landing path
 *   }
 *
 * ── Invariant: permissions never lead OR outlive auth ──────────────
 *
 * Two-layer state model. The `shadow*` family is the async source of
 * truth — written only by `fetchPermissions` when the RPC resolves —
 * and carries `shadowAuthKey`, the auth identity it was loaded for.
 * The effective values exposed via context are pure render-time
 * derivations gated on `shadowAuthKey === current authKey`. When the
 * shadow wasn't loaded for the current auth identity (initial mount,
 * mid-fetch, user-switch), every field collapses to its safe default;
 * otherwise shadow values pass through.
 *
 * This closes both the sign-out race (stale permissions appearing for
 * one render after sign-out before the effect-driven clear fires) AND
 * the user-switch leak (one user's permissions visible to the next
 * user during the new fetch's in-flight window). Both were observed
 * during the migration and resolved by this design — see commit log
 * `abd8c1d` for the analysis.
 *
 * ── History ────────────────────────────────────────────────────────
 *
 * This provider previously carried a "safe fallback" layer that
 * consulted a static `PERMISSION_TO_CAN_KEY` map and the predicate
 * map in `lib/permissions.js` while the DB fetch was in flight, so
 * that UI gates wouldn't "blink" during initial load. After all
 * migrated permissions soaked cleanly through the drift-probe phase
 * (see commit history), the fallback layer was removed in favor of
 * the simpler single-source model. Consumers that depend on stability
 * during the brief in-flight window should consult `loading` and
 * defer their render decision until it settles.
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

const PermissionsContext = createContext(null);

const EMPTY_SET = new Set();

export function PermissionsProvider({ children }) {
  const auth = useAuth();
  const authLoading  = auth?.loading  ?? true;
  const authUserId   = auth?.userId   ?? null;
  const authSchoolId = auth?.schoolId ?? null;

  // Shadow state — async source of truth, written only by fetchPermissions.
  // `shadowAuthKey` carries the auth identity the rest of the shadow was
  // loaded for; render-time gating consults it to decide trust.
  const [shadowAuthKey,      setShadowAuthKey]      = useState(null);
  const [shadowRole,         setShadowRole]         = useState(null);
  const [shadowSchoolId,     setShadowSchoolId]     = useState(null);
  const [shadowPermissions,  setShadowPermissions]  = useState(EMPTY_SET);
  const [shadowDefaultRoute, setShadowDefaultRoute] = useState('/');
  const [shadowLoading,      setShadowLoading]      = useState(false);
  const [shadowError,        setShadowError]        = useState(null);

  const isAuthed = Boolean(authUserId && authSchoolId);
  const authKey  = isAuthed ? `${authUserId}:${authSchoolId}` : null;
  const shadowMatches = isAuthed && shadowAuthKey === authKey;

  // Effective values exposed to consumers. Pure derivations — no setState,
  // no useEffect — so the invariant is true by construction in every render
  // a child observes.
  const role         = shadowMatches ? shadowRole         : null;
  const schoolId     = shadowMatches ? shadowSchoolId     : null;
  const permissions  = shadowMatches ? shadowPermissions  : EMPTY_SET;
  const defaultRoute = shadowMatches ? shadowDefaultRoute : '/';
  const error        = shadowMatches ? shadowError        : null;
  // `loading` is true whenever auth is present but the shadow hasn't caught
  // up to it (RPC in flight, or shadow loaded for a different identity).
  // `false` on no-auth signals "nothing to load" rather than perpetual loading.
  const loading      = isAuthed && (shadowLoading || !shadowMatches);

  // Cancellation token so a fast session/school swap doesn't apply a stale fetch.
  const fetchIdRef = useRef(0);

  const fetchPermissions = useCallback(async () => {
    if (!authUserId || !authSchoolId) {
      // No-op. We deliberately do NOT touch shadow here — leaving
      // shadowAuthKey unchanged means the gate stays "stale, don't
      // trust" until a real fetch binds shadow to a current authKey.
      return;
    }
    const myFetchId = ++fetchIdRef.current;
    const myAuthKey = `${authUserId}:${authSchoolId}`;
    setShadowLoading(true);
    setShadowError(null);
    const { data, error: err } = await permissionsService.getMyPermissions(authSchoolId);
    if (myFetchId !== fetchIdRef.current) return; // superseded
    if (err) {
      // Bind shadow to this authKey even on error so consumers see the
      // error state (not perpetual "loading") for the current identity.
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
    setShadowAuthKey(myAuthKey);
    setShadowRole(data?.role ?? null);
    setShadowSchoolId(data?.school_id ?? null);
    setShadowPermissions(loadedPerms);
    setShadowDefaultRoute(data?.default_route ?? '/');
    setShadowLoading(false);
  }, [authUserId, authSchoolId]);

  // Re-fetch on auth identity change. No special timing needed — the auth
  // gate above already guarantees consumers see safe defaults until shadow
  // state catches up.
  useEffect(() => {
    if (authLoading) return;
    fetchPermissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId, authSchoolId, authLoading]);

  const can = useCallback(
    (name) => permissions.has(name),
    [permissions],
  );

  const value = useMemo(
    () => ({
      role,
      schoolId,
      permissions,
      loading,
      error,
      can,
      refresh: fetchPermissions,
      defaultRoute,
    }),
    [role, schoolId, permissions, loading, error, can, fetchPermissions, defaultRoute],
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
