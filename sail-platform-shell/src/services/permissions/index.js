/**
 * permissionsService — Helm's client-side permission API surface.
 *
 * Phase 8 (2026-05-14): DB-BACKED. Reads from the live Supabase catalog
 * via the `helm_get_my_school_permissions(p_school_id)` RPC introduced
 * by migrations/2026-05-14-helm-school-permissions.sql.
 *
 *   - Before Phase 8: synthesised the permission set client-side by
 *     calling get_effective_user_profile() and running the resulting
 *     role through a static predicate-name map. The map lived here.
 *   - After Phase 8: the catalog is the DB authority. The static
 *     predicate map (`CAN` in ../../lib/permissions.js) survives as the
 *     source of the CAN.* booleans the provider exposes for grep-friendly
 *     UI gates; the *permission name list* is now exclusively whatever
 *     the RPC returns.
 *
 * Contract (matches Bridge's permissionsService for cross-app uniformity):
 *
 *   getMyPermissions(schoolId)
 *     → { data: { role, school_id, permissions: string[], default_route }, error }
 *
 *   - `role` is the caller's effective school_members.role for that school
 *     (impersonation-aware via effective_user_id() server-side).
 *   - `permissions` is an array of `helm.*` permission names granted by
 *     the catalog. The provider wraps this in a Set<string> for O(1)
 *     `can(name)` lookups; this layer stays array-shaped to match
 *     Bridge's `bridge_get_my_permissions` envelope.
 *   - `default_route` is computed client-side via `getDefaultRoute(role)`
 *     from `lib/permissions.js` — kept here (not in the RPC) because it's
 *     a UX routing decision, not an authority decision.
 *   - `error` follows the canonical `{ message, code, kind }` shape with
 *     `kind ∈ 'not_configured' | 'forbidden' | 'auth' | 'network' | 'other'`.
 *
 * Fail-closed at every layer:
 *   - Missing schoolId → return empty perm set without calling the RPC
 *     (saves a roundtrip; same fail-closed outcome the RPC would yield).
 *   - RPC error → return null data + classified error; PermissionsProvider
 *     already treats any non-null error as an empty Set, so misconfigured
 *     env / network blips degrade the UI to "no access" rather than
 *     crashing.
 *   - RPC fail-closed envelope ({role: null, permissions: []}) →
 *     forwarded as-is.
 */

import { supabase } from '../../lib/supabaseClient';
import { getDefaultRoute } from '../../lib/permissions';

function classifyError(err) {
  if (!err) return null;
  const code = err.code || err.status || null;
  let kind = 'other';
  if (code === '42501' || /forbidden|permission denied|rls/i.test(err.message || '')) kind = 'forbidden';
  else if (code === 'PGRST301' || code === 401) kind = 'auth';
  else if (/network|fetch|timeout/i.test(err.message || '')) kind = 'network';
  return { message: err.message || 'Unknown error', code, kind };
}

export const permissionsService = {
  /**
   * Fetch the calling user's school-scoped role + permission set for a
   * given school. Returns `{ data | null, error }` per the contract above.
   *
   * @param {string | null | undefined} schoolId the school the caller
   *   is currently scoped to. Sourced from AuthContext.schoolId by the
   *   provider. If null/undefined, the function short-circuits and
   *   returns an empty fail-closed envelope without calling the RPC.
   */
  async getMyPermissions(schoolId) {
    // Short-circuit when no school is in scope. Equivalent to the
    // server-side fail-closed branch but skips the network roundtrip.
    if (!schoolId) {
      return {
        data: {
          role:          null,
          school_id:     null,
          permissions:   [],
          default_route: getDefaultRoute(null),
        },
        error: null,
      };
    }

    try {
      const { data, error } = await supabase.rpc(
        'helm_get_my_school_permissions',
        { p_school_id: schoolId },
      );
      if (error) return { data: null, error: classifyError(error) };

      // The RPC returns jsonb (supabase-js surfaces as a plain object).
      // PostgREST can also wrap single-row scalar returns in an array;
      // normalise both shapes defensively.
      const row = data && typeof data === 'object' && !Array.isArray(data)
        ? data
        : Array.isArray(data) ? data[0] : null;

      if (!row) {
        return {
          data: {
            role:          null,
            school_id:     schoolId,
            permissions:   [],
            default_route: getDefaultRoute(null),
          },
          error: null,
        };
      }

      const role = row.role ?? null;
      return {
        data: {
          role,
          school_id:     row.school_id ?? schoolId,
          // RPC guarantees an array under the `permissions` key (it
          // builds via array_agg + to_jsonb). Defensive default in case
          // shape ever drifts.
          permissions:   Array.isArray(row.permissions) ? row.permissions : [],
          default_route: getDefaultRoute(role),
        },
        error: null,
      };
    } catch (e) {
      return { data: null, error: classifyError(e) };
    }
  },
};
