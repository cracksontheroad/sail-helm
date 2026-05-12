-- ─────────────────────────────────────────────────────────────────────────────
-- Phase B1 — Enable ai_grading for the remaining 4 schools
--
-- Stage 2 Helm stabilisation, 2026-05-07.
--
-- Status: APPLIED to gidyonbzxjorrgpicctt on 2026-05-07 (Supabase migration
--         name: phase_b1_enable_ai_grading_remaining_schools).
--
-- Why this exists in the Helm repo: the SAIL-core monorepo records every
-- migration via the Supabase migration history (`supabase migration list`),
-- but the file artifact lives here next to the consumer (Helm) so that
-- a fresh Helm checkout has a record of which DB-side prerequisites the
-- app depends on. Re-applying is a no-op (idempotent ON CONFLICT).
--
-- Stage-1 audit (sail_memory ids 81159673 / 22129652) found:
--   3 of 7 schools enabled: Aurora Primary, Greenfield International, Northwood Academy
--   4 of 7 NOT enabled:    Best School, Kunming Number 1, SAIL, Test School
-- (SAIL itself — the test school used by all live members — was the worst
-- offender. Most live AI usage was hitting the Netlify fallback → no
-- consent gate, no audit trail, separate API key.)
--
-- This migration enables ai_grading for all 4 remaining schools in one
-- atomic write. After it lands, ai-proxy v8 stops returning APP_NOT_ENABLED
-- for any legitimate caller, the strict-mode flag (Phase B2) becomes safe
-- to flip, and the Netlify fallback (Phase B4) becomes safe to delete.
--
-- Rollback path: DELETE FROM public.school_apps
--                WHERE app_id = '4de6a63e-c951-4fe1-bc30-5c7ef9bac4ee'::uuid
--                  AND metadata->>'source' = 'phase_b1_stage2_helm_stabilisation';
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.school_apps (school_id, app_id, metadata)
SELECT
  s.id,
  '4de6a63e-c951-4fe1-bc30-5c7ef9bac4ee'::uuid AS app_id,            -- apps.slug='ai_grading'
  jsonb_build_object(
    'source',  'phase_b1_stage2_helm_stabilisation',
    'reason',  'complete_ai_grading_rollout_pre_strict_mode',
    'enabled_at_iso', '2026-05-07'
  ) AS metadata
FROM public.schools s
WHERE s.name IN ('Best School', 'Kunming Number 1', 'SAIL', 'Test School')
ON CONFLICT (school_id, app_id) DO NOTHING;

-- Document the rollout completion on the table itself so a future audit
-- (or a fresh reader) doesn't have to retrace the sail_memory chain.
COMMENT ON TABLE public.school_apps IS
  'Phase 0.6 Slice 7+9 introduced this table for app enablement gating. Phase B1 (2026-05-07) completed the ai_grading rollout for all 7 schools; the Helm Netlify-function fallback path (services/ai.js APP_NOT_ENABLED branch) is now unreachable for legitimate callers in strict mode.';
